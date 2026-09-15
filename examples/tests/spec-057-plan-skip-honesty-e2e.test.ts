/**
 * Spec 057 — Plan Skip Honesty full-cycle E2E (Req 1–R5 — issue #204, AC-8 gap-fill)
 * ────────────────────────────────────────────────────────────────────────────
 * The PR's unit suites pin each seam in isolation:
 *   - AC-1/AC-2 drive a MOCK `ExecuteDataProvider` through
 *     `ExecuteServiceImpl`'s skip accumulator;
 *   - AC-5 feeds a HAND-BUILT `ExecuteResult` into `ReflectServiceImpl`;
 *   - AC-6/AC-7 call the builder/diagnostic with HAND-BUILT outcomes.
 *
 * Nothing ran the cumulative count across the real package boundary — the
 * exact chain the live run (`AC-8`) rides:
 *
 *   real PlanManagerImpl (fake clock)  ←  the plan the accumulator is keyed on
 *     ↑ advanceStep
 *   real ExecuteServiceImpl            → ExecuteResult.stepsSkipped (1 → 2)
 *     ↓ final completing cycle
 *   real ReflectServiceImpl.stampPlanOutcome → AgentInternalState.lastPlanOutcome
 *     ↓ next cycle
 *   real PlanBuilderImpl prompt line + real PlanServiceImpl `[plan-memory]` line
 *
 * Deterministic, zero LLM calls, mirrored on the spec-056 E2E precedent
 * (`examples/tests/spec-056-batch-supersession-e2e.test.ts`). The skip-free
 * companion pins the additive/byte-identity property end-to-end.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  Affordance,
  AffordanceResult,
  AgentInternalState,
  ExecuteDataProvider,
  FormulatePlanResult,
  LastPlanOutcome,
  PerceptionResult,
  PlanDataProvider,
  ReflectDataProvider,
} from '@evol-hive/shared';
import { PlanManagerImpl } from '@evol-hive/engine';
import type { AgentManager } from '@evol-hive/engine';
import {
  ExecuteServiceImpl,
  PlanBuilderImpl,
  PlanServiceImpl,
  ReflectBuilderImpl,
  ReflectServiceImpl,
} from '@evol-hive/cognition';
import type { LLMClient } from '@evol-hive/cognition';

const AGENT_ID = 'gardener-1';
const FAKE_TIME = 12345;

const drives = { energy: 45, hunger: 50, social: 50, comfort: 50, curiosity: 60 };

// ── Real engine agent/plan state over a minimal map ──────────────────────────

class StateMapAgentManager {
  private readonly agents = new Map<string, AgentInternalState>();

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
      location: 'garden',
      currentGoal: '',
      lastPerceptionTick: 0,
      currentPlan: null,
      lastPlanOutcome: undefined,
      isThinking: false,
      drives,
    } as unknown as AgentInternalState);
  }
}

// ── Provider bridges (the seams the engine's production bridges implement) ───

function makeAffordance(id: string): Affordance {
  return { id, label: id, engineEffect: id, preconditions: [], effects: {} };
}

/** Execute bridge: plan navigation delegates to the REAL PlanManager; the
 *  listed affordances fail every execution (driving the spec-037 guard). */
function makeExecuteProvider(
  planManager: PlanManagerImpl,
  agentManager: StateMapAgentManager,
  failing: ReadonlySet<string>,
): ExecuteDataProvider {
  return {
    getAgentState: (agentId) => agentManager.getState(agentId),
    getCurrentStep: (agentId) => planManager.getCurrentStep(agentId),
    isPlanComplete: (agentId) => planManager.isComplete(agentId),
    resolveAffordance: (_roomId, affordanceId) => ({
      objectId: `obj-${affordanceId}`,
      affordance: makeAffordance(affordanceId),
    }),
    checkPreconditions: () => ({ satisfied: true, failed: [] }),
    executeAffordance: async (
      _objectId: string,
      affordanceId: string,
      _agentId: string,
    ): Promise<AffordanceResult> =>
      failing.has(affordanceId)
        ? { success: false, failureReason: `'${affordanceId}' is not possible right now.` }
        : { success: true },
    advanceStep: (agentId) => planManager.advanceStep(agentId),
    applyDriveChanges: () => {},
    setSystemFeedback: () => {},
    setThinking: (agentId, isThinking) => agentManager.updateState(agentId, { isThinking }),
  };
}

/** Reflect bridge: plan clearing + outcome stamping delegate to the REAL
 *  PlanManager / agent state. */
function makeReflectProvider(
  planManager: PlanManagerImpl,
  agentManager: StateMapAgentManager,
): ReflectDataProvider {
  return {
    getAgentState: (agentId) => agentManager.getState(agentId),
    applyDriveChanges: () => {},
    updateGoal: () => {},
    storeMemory: async () => {},
    clearPlanIfComplete: (agentId) => {
      if (!planManager.isComplete(agentId)) return false;
      planManager.clearPlan(agentId);
      return true;
    },
    setThinking: (agentId, isThinking) => agentManager.updateState(agentId, { isThinking }),
    getAgentProfile: () => null,
    stampLastPlanOutcome: (agentId, outcome) =>
      agentManager.updateState(agentId, { lastPlanOutcome: outcome }),
  };
}

function makePlanProvider(
  planManager: PlanManagerImpl,
  agentManager: StateMapAgentManager,
): PlanDataProvider {
  return {
    getAgentState: (agentId) => agentManager.getState(agentId),
    storePlan: (agentId, result) => planManager.createPlan(agentId, result),
    setThinking: (agentId, isThinking) => agentManager.updateState(agentId, { isThinking }),
  };
}

/** Scripted LLM: Reflect always stores a memory (so `reflected=true`); Plan
 *  returns the same valid wait-step plan. Zero network. */
function makeScriptedLLM(): LLMClient {
  return {
    completePlan: async (): Promise<FormulatePlanResult> => ({
      description: 'Follow-up plan',
      steps: [{ description: 'Wait and observe', targetAffordance: 'wait' }],
    }),
    completeReflect: async () => ({
      memoryContent: 'The plan ran.',
      memoryImportance: 5,
      memoryType: 'action',
    }),
  } as unknown as LLMClient;
}

// ── Perception fixtures ──────────────────────────────────────────────────────

const prunedAffordances: Affordance[] = ['plant_seeds', 'brew_coffee', 'harvest', 'wait'].map(
  makeAffordance,
);

function makePerception(lastPlanOutcome?: LastPlanOutcome): PerceptionResult {
  return {
    passive: {
      roomId: 'garden',
      objectsPresent: [{ objectId: 'planter-1', name: 'Planter', type: 'furniture' }],
      drives,
    },
    prunedAffordances,
    primaryDriveLabel: 'low curiosity, need to restore curiosity',
    ...(lastPlanOutcome !== undefined ? { lastPlanOutcome } : {}),
  };
}

/** Split the payload context into its stable (pre-`---`) and dynamic sections. */
function sections(context: string): { stable: string; dynamic: string } {
  const [stable, dynamic = ''] = context.split('\n---\n');
  return { stable: stable ?? '', dynamic };
}

function stderrLines(prefix: string): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map((call) => call.map(String).join(' '))
    .filter((line) => line.includes(prefix));
}

/** A 3-step plan whose steps 0 and 2 are bound to always-failing affordances
 *  and whose middle step succeeds — the live "ran out of runnable steps" shape. */
const threeStepPlan: FormulatePlanResult = {
  description: 'Farm round',
  steps: [
    { description: 'Plant seeds', targetAffordance: 'plant_seeds' },
    { description: 'Brew coffee', targetAffordance: 'brew_coffee' },
    { description: 'Harvest', targetAffordance: 'harvest' },
  ],
};

describe('spec 057 AC-8 gap-fill: skipped plan through the real Execute → Reflect → prompt chain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries 1→2 skips through Execute, stamps them in Reflect, and renders + logs them next cycle', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const agentManager = new StateMapAgentManager();
    agentManager.spawnAgent(AGENT_ID);
    const planManager = new PlanManagerImpl(
      agentManager as unknown as AgentManager,
      () => FAKE_TIME,
    );

    const failing = new Set(['plant_seeds', 'harvest']);
    const execute = new ExecuteServiceImpl({
      dataProvider: makeExecuteProvider(planManager, agentManager, failing),
    });
    const reflect = new ReflectServiceImpl({
      reflectBuilder: new ReflectBuilderImpl(),
      llmClient: makeScriptedLLM(),
      dataProvider: makeReflectProvider(planManager, agentManager),
    });

    planManager.createPlan(AGENT_ID, threeStepPlan);

    // Step 0: fail #1 (no count), then the livelock guard skips it → count 1.
    const f1 = await execute.execute(AGENT_ID);
    const skip1 = await execute.execute(AGENT_ID);
    // Step 1: succeeds; the per-plan total is NOT reset.
    const ok = await execute.execute(AGENT_ID);
    // Step 2: fail #1 (still 1), then skipped → count 2 and the plan completes.
    const f2 = await execute.execute(AGENT_ID);
    const skip2 = await execute.execute(AGENT_ID);

    expect(f1.stepsSkipped).toBeUndefined();
    expect(skip1).toMatchObject({
      success: true,
      stepSkipped: true,
      planComplete: false,
      stepsSkipped: 1,
    });
    expect(ok).toMatchObject({ success: true, planComplete: false, stepsSkipped: 1 });
    expect(f2.stepsSkipped).toBe(1);
    expect(skip2).toMatchObject({
      success: true,
      stepSkipped: true,
      planComplete: true,
      stepsSkipped: 2,
    });

    // Exactly two [step-skip] advances, spec-037 format unchanged (Req 6).
    const stepSkips = stderrLines('[step-skip]');
    expect(stepSkips).toHaveLength(2);
    expect(stepSkips[0]).toBe(
      "[step-skip] agent=gardener-1 step='Plant seeds' failed 2x consecutively — advancing past it",
    );
    expect(stepSkips[1]).toBe(
      "[step-skip] agent=gardener-1 step='Harvest' failed 2x consecutively — advancing past it",
    );

    // Reflect stamps the cumulative total on the real agent state (Req 3).
    await reflect.reflect(AGENT_ID, skip2);

    const outcome = agentManager.getState(AGENT_ID)?.lastPlanOutcome;
    expect(outcome).toBeDefined();
    expect(outcome).toMatchObject({
      planDescription: 'Farm round',
      steps: ['plant_seeds', 'brew_coffee', 'harvest'],
      success: true,
      stepsSkipped: 2,
      reflected: true,
    });
    // The plan was cleared by Reflect, ready for the next formulation.
    expect(agentManager.getState(AGENT_ID)?.currentPlan).toBeNull();

    // Next cycle: the plan prompt renders the skipped verdict (dynamic only).
    const perception = makePerception(outcome);
    const payload = new PlanBuilderImpl().build(perception);
    expect(payload.perceptionContext).toContain(
      'Your last plan was "plant_seeds, brew_coffee, harvest" — 2 of 3 steps were skipped.',
    );
    const { stable, dynamic } = sections(payload.perceptionContext);
    expect(dynamic).toContain('2 of 3 steps were skipped');
    expect(stable).not.toContain('steps were skipped');

    // ...and the real PlanService emits the [plan-memory] skipped diagnostic (Req 5).
    await new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: makeScriptedLLM(),
      dataProvider: makePlanProvider(planManager, agentManager),
    }).plan(AGENT_ID, perception);

    const memLines = stderrLines('[plan-memory]');
    expect(memLines).toHaveLength(1);
    expect(memLines[0]).toBe(
      '[plan-memory] agent=gardener-1 verdict=skipped steps=- skipped=2 reflected=true',
    );
  });

  it('a skip-free plan stays byte-identical: spec-055 verdict, no skipped=, no stepsSkipped key', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const agentManager = new StateMapAgentManager();
    agentManager.spawnAgent(AGENT_ID);
    const planManager = new PlanManagerImpl(
      agentManager as unknown as AgentManager,
      () => FAKE_TIME,
    );

    const execute = new ExecuteServiceImpl({
      dataProvider: makeExecuteProvider(planManager, agentManager, new Set()),
    });
    const reflect = new ReflectServiceImpl({
      reflectBuilder: new ReflectBuilderImpl(),
      llmClient: makeScriptedLLM(),
      dataProvider: makeReflectProvider(planManager, agentManager),
    });

    planManager.createPlan(AGENT_ID, {
      description: 'Plant and harvest',
      steps: [
        { description: 'Plant seeds', targetAffordance: 'plant_seeds' },
        { description: 'Harvest', targetAffordance: 'harvest' },
      ],
    });

    const r1 = await execute.execute(AGENT_ID);
    const r2 = await execute.execute(AGENT_ID);
    expect('stepsSkipped' in r1).toBe(false);
    expect('stepsSkipped' in r2).toBe(false);
    expect(r2.planComplete).toBe(true);

    await reflect.reflect(AGENT_ID, r2);

    const outcome = agentManager.getState(AGENT_ID)?.lastPlanOutcome;
    expect(outcome).toBeDefined();
    expect(outcome!.stepsSkipped).toBeUndefined();
    expect(Object.keys(outcome!)).not.toContain('stepsSkipped');

    const perception = makePerception(outcome);
    const payload = new PlanBuilderImpl().build(perception);
    expect(payload.perceptionContext).toContain(
      'Your last plan was "plant_seeds, harvest" — it succeeded.',
    );
    expect(payload.perceptionContext).not.toContain('steps were skipped');

    await new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: makeScriptedLLM(),
      dataProvider: makePlanProvider(planManager, agentManager),
    }).plan(AGENT_ID, perception);

    const memLines = stderrLines('[plan-memory]');
    expect(memLines).toHaveLength(1);
    expect(memLines[0]).toBe(
      '[plan-memory] agent=gardener-1 verdict=succeeded steps=- reflected=true',
    );
    expect(memLines[0]).not.toContain('skipped=');
  });
});
