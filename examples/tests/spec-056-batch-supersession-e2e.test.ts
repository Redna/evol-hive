/**
 * Spec 056 — batch-path supersession E2E (Req 7 gap-fill — issue #201, AC-8)
 * ────────────────────────────────────────────────────────────────────────────
 * The Req 7 live-run protocol expects `superseded after N of M steps` lines,
 * but the wired single-agent plan path early-returns on any `currentPlan`
 * (spec 002) and the Reflect phase clears only completed plans — so
 * `createPlan` only ever sees `currentPlan === null` there, and the
 * supersession seam (a plan REPLACED mid-flight) is reachable only via the
 * batch plan path (`BatchPlanService.processBatch` → `storePlan` →
 * `createPlan` unconditionally — the path the issue's live pathology rides).
 *
 * This test exercises that exact chain deterministically (zero LLM calls,
 * scripted batch client), mirroring the live run's evidence protocol:
 *
 *   real PlanManagerImpl (fake clock)         ← real engine code
 *     ↑ storePlan                    ↑ stampSupersededOutcome
 *   BatchPlanService.processBatch (scripted LLM)
 *     ↓                                       ↓
 *   agent state lastPlanOutcome  →  real PlanBuilderImpl prompt render
 *                                             ↓
 *   `Your last plan was "…" — superseded after N of M steps.` (dynamic only)
 *   + exactly one `[plan-superseded]` stderr diagnostic (Req 5)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  Affordance,
  AgentInternalState,
  FormulatePlanResult,
  MultiAgentPlanResponse,
  PerceptionResult,
  PlanDataProvider,
} from '@evol-hive/shared';
import { PlanManagerImpl } from '@evol-hive/engine';
import type { AgentManager } from '@evol-hive/engine';
import { BatchPlanService, PlanBuilderImpl } from '@evol-hive/cognition';
import type { PlanService } from '@evol-hive/cognition';
import type { LastPlanOutcome } from '@evol-hive/shared';

const AGENT_ID = 'gardener-1';
const FAKE_TIME = 12345;

const drives = { energy: 45, hunger: 50, social: 50, comfort: 50, curiosity: 60 };

const prunedAffordances: Affordance[] = [
  {
    id: 'water_plants',
    label: 'Water the plants',
    engineEffect: 'water_plants',
    preconditions: [],
    effects: { curiosity: 10, comfort: 5 },
  },
  {
    id: 'repot_seedlings',
    label: 'Repot the seedlings',
    engineEffect: 'repot_seedlings',
    preconditions: [],
    effects: { curiosity: 8 },
  },
];

function makePerception(overrides: Partial<PerceptionResult> = {}): PerceptionResult {
  return {
    passive: {
      roomId: 'greenhouse',
      objectsPresent: [{ objectId: 'planter-1', name: 'Planter', type: 'furniture' }],
      drives,
    },
    prunedAffordances,
    primaryDriveLabel: 'low curiosity, need to restore curiosity',
    ...overrides,
  };
}

// ── Real engine PlanManager over a minimal agent-state map ───────────────────

class StateMapAgentManager {
  private agents = new Map<string, AgentInternalState>();
  getState(agentId: string): AgentInternalState | null {
    return this.agents.get(agentId) ?? null;
  }
  updateState(agentId: string, updates: Partial<AgentInternalState>): void {
    const current = this.agents.get(agentId);
    if (current) this.agents.set(agentId, { ...current, ...updates });
  }
  spawnAgent(agentId: string): void {
    this.agents.set(agentId, {
      agentId,
      location: 'greenhouse',
      currentGoal: '',
      lastPerceptionTick: 0,
      currentPlan: null,
      lastPlanOutcome: undefined,
      isThinking: false,
      drives,
    } as unknown as AgentInternalState);
  }
}

/** A PlanDataProvider that delegates storage to the REAL engine PlanManager
 *  (the same seam the engine's `PlanDataProviderImpl` bridges). */
function makeRealDataProvider(
  planManager: PlanManagerImpl,
  agentManager: StateMapAgentManager,
): PlanDataProvider {
  return {
    getAgentState: (agentId) => agentManager.getState(agentId),
    storePlan: (agentId, result) => planManager.createPlan(agentId, result),
    setThinking: (agentId, isThinking) => agentManager.updateState(agentId, { isThinking }),
  };
}

// ── Scripted batch LLM client (zero LLM calls) ───────────────────────────────

function scriptedBatchClient(response: MultiAgentPlanResponse) {
  return {
    async completeBatchPlan(_payload: unknown): Promise<MultiAgentPlanResponse> {
      return response;
    },
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** The OLD plan, in flight: 3 steps, step 0 done (bound affordance), 2 remain. */
function seedInFlightPlan(planManager: PlanManagerImpl): void {
  const formulation: FormulatePlanResult = {
    description: 'Morning greenhouse round',
    steps: [
      { description: 'Water the plants at the planter', targetAffordance: 'water_plants' },
      { description: 'Repot the basil seedlings', targetAffordance: 'repot_seedlings' },
      { description: 'Eat a fresh herb', targetAffordance: 'eat_herbs' },
    ],
  };
  planManager.createPlan(AGENT_ID, formulation);
  planManager.advanceStep(AGENT_ID); // step 0 executes → index 1 of 3, in flight
}

/** The REPLACEMENT formulation the batch LLM returns mid-flight. */
const replacement: MultiAgentPlanResponse = {
  plans: [
    {
      agentId: AGENT_ID,
      description: 'Afternoon watering round',
      steps: [
        { description: 'Fill the watering can', targetAffordance: 'fill_watering_can' },
        { description: 'Water the planter again', targetAffordance: 'water_plants' },
      ],
    },
  ],
};

function supersededLines(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map((call) => call.map(String).join(' '))
    .filter((line) => line.includes('[plan-superseded]'));
}

/** Split the payload context into its stable (pre-`---`) and dynamic sections. */
function sections(context: string): { stable: string; dynamic: string } {
  const [stable, dynamic = ''] = context.split('\n---\n');
  return { stable: stable ?? '', dynamic };
}

describe('spec 056 Req 7 gap-fill / AC-8: batch-path supersession E2E', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stamps the replaced in-flight plan, emits the diagnostic, and the next prompt renders the verdict', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const agentManager = new StateMapAgentManager();
    agentManager.spawnAgent(AGENT_ID);
    const planManager = new PlanManagerImpl(
      agentManager as unknown as AgentManager,
      () => FAKE_TIME,
    );
    seedInFlightPlan(planManager);

    const dataProvider = makeRealDataProvider(planManager, agentManager);
    const planService = {} as PlanService; // fallback — never hit (valid scripted response)
    const service = new BatchPlanService({
      llmClient: scriptedBatchClient(replacement) as never,
      planBuilder: new PlanBuilderImpl(),
      dataProvider,
      planService,
      maxBatchSize: 5,
    });

    const results = await service.batchPlan([{ agentId: AGENT_ID, perception: makePerception() }]);

    // (1) The replacement plan is stored and is the agent's currentPlan.
    expect(results.get(AGENT_ID)?.success).toBe(true);
    const newPlan = agentManager.getState(AGENT_ID)?.currentPlan;
    expect(newPlan?.description).toBe('Afternoon watering round');
    expect(newPlan?.currentStepIndex).toBe(0);
    expect(newPlan?.steps).toHaveLength(2);
    expect(newPlan?.id).toBe(`plan_${AGENT_ID}_${FAKE_TIME}_1`); // injected clock (Req 4)

    // (2) The OLD plan was stamped superseded by the real engine stamp —
    //     per-step identities render targetAffordance-when-bound, in order.
    const stamped = agentManager.getState(AGENT_ID)?.lastPlanOutcome;
    if (!stamped) throw new Error('expected the supersession stamp to be written');
    const outcome: LastPlanOutcome = stamped;
    expect(outcome).toEqual({
      planDescription: 'Morning greenhouse round',
      steps: ['water_plants', 'repot_seedlings', 'eat_herbs'],
      success: false,
      superseded: true,
      stepsCompleted: 1,
      stepsTotal: 3,
      reflected: false,
    });

    // (3) Exactly one [plan-superseded] diagnostic (Req 5): agent id, N of M,
    //     the (untruncated-at-this-length) description.
    const lines = supersededLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`agent=${AGENT_ID}`);
    expect(lines[0]).toContain('superseded after 1 of 3 steps');
    expect(lines[0]).toContain('Morning greenhouse round');

    // (4) The NEXT cycle's plan prompt (real PlanBuilder) renders the verdict
    //     from the stamped outcome — the plan-memory line the live run counts.
    const builder = new PlanBuilderImpl();
    const payload = builder.build(makePerception({ lastPlanOutcome: outcome }));
    expect(payload.perceptionContext).toContain(
      'Your last plan was "water_plants, repot_seedlings, eat_herbs" — superseded after 1 of 3 steps.',
    );
    const { stable, dynamic } = sections(payload.perceptionContext);
    expect(dynamic).toContain('superseded after 1 of 3 steps');
    expect(stable).not.toContain('superseded');
  });
});
