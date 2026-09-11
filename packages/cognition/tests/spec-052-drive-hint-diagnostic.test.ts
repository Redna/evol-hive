/**
 * Spec 052 — Req 1: the per-cycle `[drive-hint]` perceive→plan diagnostic
 * (issue #183).
 *
 * Drive-hint behavior was unauditable from run logs — the exact diagnosis gap
 * spec 049 closed for social urges. The orchestrator (not the builders) owns
 * the diagnostic: exactly ONE grep-able line per cycle whenever any hintable
 * drive is below DRIVE_URGENCY_THRESHOLD, carrying:
 * - agent id, room id, primary drive label (the classifier's pruning query);
 * - the pruning funnel: affordances in room → after pruning → after masking
 *   (counts + final enum IDs);
 * - per urgent drive: hint-rendered flag + the restoring affordance IDs that
 *   exist in the room but were dropped by pruning;
 * - the plan's targetAffordance choices after the plan phase — "rendered but
 *   not chosen" vs "not rendered" vs "not present" is mechanically
 *   distinguishable from logs alone (AC-6).
 *
 * No line when all hintable drives are ≥ 40. Zero LLM calls; a logging
 * failure never breaks the cycle (spec-049 discipline).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Affordance,
  AgentInternalState,
  ExecuteDataProvider,
  PerceptionDataProvider,
  PlanDataProvider,
  ReflectDataProvider,
} from '@evol-hive/shared';
import type { LLMClient } from '../src/index.js';
import type { AffordanceClassifier } from '../src/classifier/index.js';
import { PPEROrchestratorImpl } from '../src/pper/orchestrator.js';

// ─── Fixtures: iris-1 in the greenhouse at low drives (#183) ─────────────────

const AGENT_ID = 'iris-1';
const ROOM_ID = 'greenhouse';
const TICK = 9000;

const PRIMARY_LABEL = 'low energy, need to restore energy';

/** The greenhouse's affordances — the restorers sit in the room. */
function greenhouseAffordances(): Affordance[] {
  return [
    {
      id: 'repot_seedlings',
      label: 'Repot seedlings',
      engineEffect: 'repot_seedlings',
      preconditions: [],
      effects: { curiosity: 12, comfort: 5 },
    },
    {
      id: 'rest_among_seedlings',
      label: 'Rest among the seedlings',
      engineEffect: 'rest_among_seedlings',
      preconditions: [],
      effects: { comfort: 15, energy: 4 },
    },
    {
      id: 'eat_herbs',
      label: 'Eat a fresh herb',
      engineEffect: 'eat_herbs',
      preconditions: [],
      effects: { hunger: 20 },
    },
    {
      id: 'go_to_garden',
      label: 'Go to garden',
      engineEffect: 'go_to_garden',
      preconditions: [],
      effects: {},
    },
    {
      id: 'observe',
      label: 'Observe',
      engineEffect: 'observe',
      preconditions: [],
      effects: {},
    },
  ];
}

function makeState(agentId: string, drives: Record<string, number>): AgentInternalState {
  return {
    agentId,
    drives,
    currentGoal: '',
    currentPlan: null,
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
  };
}

interface ProviderOptions {
  drives: Record<string, number>;
  /** What the System-0 classifier returns (the post-prune set). */
  pruned: string[];
}

function makePerceptionProvider(opts: ProviderOptions): PerceptionDataProvider {
  const state = makeState(AGENT_ID, opts.drives);
  return {
    getAgentLocation: () => ROOM_ID,
    getObjectsInRoom: () => [],
    getAffordancesInRoom: () => greenhouseAffordances(),
    getAgentDrives: () => opts.drives,
    getPrimaryDriveLabel: () => PRIMARY_LABEL,
    getSystemFeedback: () => undefined,
    getAgentState: () => state,
  };
}

function makePlanProvider(drives: Record<string, number>): PlanDataProvider {
  const state = makeState(AGENT_ID, drives);
  return {
    getAgentState: () => state,
    storePlan: (_id, result) => ({
      id: 'plan-1',
      description: result.description,
      steps: result.steps.map((s) => ({
        description: s.description,
        completed: false,
        ...(s.targetAffordance !== undefined ? { targetAffordance: s.targetAffordance } : {}),
      })),
      currentStepIndex: 0,
      createdAt: 0,
    }),
    setThinking: () => {},
  };
}

function makeExecuteProvider(state: AgentInternalState): ExecuteDataProvider {
  return {
    getAgentState: () => state,
    getCurrentStep: () => undefined,
    isPlanComplete: () => true,
    resolveAffordance: () => null,
    checkPreconditions: () => ({ satisfied: true, failed: [] }),
    executeAffordance: async () => ({ success: true }),
    advanceStep: () => {},
    applyDriveChanges: () => {},
    setSystemFeedback: () => {},
    setThinking: () => {},
  };
}

function makeReflectProvider(state: AgentInternalState): ReflectDataProvider {
  return {
    getAgentState: () => state,
    applyDriveChanges: () => {},
    updateGoal: () => {},
    storeMemory: async () => {},
    clearPlanIfComplete: () => true,
    setThinking: () => {},
  };
}

/** Classifier stub returning ONLY the affordance ids named in `pruned`. */
function makeDroppingClassifier(pruned: string[]): AffordanceClassifier {
  return {
    async prune(_drive, affordances) {
      return affordances.filter((a) => pruned.includes(a.id));
    },
  };
}

/** LLM returning a fixed plan (or an invalid one to fail the plan phase). */
function makePlanLLM(steps: { description: string; targetAffordance?: string }[]): LLMClient {
  return {
    async completeStructured() {
      return { reasoning: 'r', action: 'idle' };
    },
    async completeReflection() {
      return { agentId: AGENT_ID, newMemories: [], consolidatedNodeIds: [] };
    },
    async completePlan() {
      return { description: 'plan', steps };
    },
    async completeReflect() {
      return { memoryEntry: { content: 'x', importance: 5, type: 'action' } };
    },
  };
}

function makeOrchestrator(
  opts: ProviderOptions,
  planSteps: { description: string; targetAffordance?: string }[],
): PPEROrchestratorImpl {
  const state = makeState(AGENT_ID, opts.drives);
  return new PPEROrchestratorImpl({
    perceptionProvider: makePerceptionProvider(opts),
    planProvider: makePlanProvider(opts.drives),
    executeProvider: makeExecuteProvider(state),
    reflectProvider: makeReflectProvider(state),
    classifier: makeDroppingClassifier(opts.pruned),
    llmClient: makePlanLLM(planSteps),
  });
}

function driveHintLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((args) => args.map(String).join(' '))
    .filter((line) => line.includes('[drive-hint]'));
}

const URGENT_DRIVES = { energy: 12, hunger: 35, social: 50, comfort: 50, curiosity: 50 };
const HEALTHY_DRIVES = { energy: 55, hunger: 45, social: 50, comfort: 55, curiosity: 50 };

// ─── AC-3: emission, shape, and the funnel counts ────────────────────────────

describe('spec 052 R1 — [drive-hint] diagnostic (AC-3)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('emits exactly one [drive-hint] line per cycle when a hintable drive is urgent, with agent, room, primary label, funnel counts, hint flags, pruned-away IDs, and the chosen target', async () => {
    // Classifier drops BOTH restorers (the #183 failure mode) — the room
    // still contains them; the plan then picks 'observe'.
    const orch = makeOrchestrator({ drives: URGENT_DRIVES, pruned: ['go_to_garden', 'observe'] }, [
      { description: 'Look around', targetAffordance: 'observe' },
    ]);

    await orch.runCycle(AGENT_ID);

    const lines = driveHintLines(logSpy);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;

    // Agent id + room + the classifier's pruning query.
    expect(line).toContain(`agent=${AGENT_ID}`);
    expect(line).toContain(`room=${ROOM_ID}`);
    expect(line).toContain(`primary=${PRIMARY_LABEL}`);

    // The pruning funnel: inRoom → afterPrune → afterMask (no guardrail →
    // afterMask equals afterPrune).
    expect(line).toContain('inRoom=5');
    expect(line).toContain('afterPrune=2');
    expect(line).toContain('afterMask=2');
    expect(line).toContain('enum=[go_to_garden,observe]');

    // Per-urgent-drive entries: hint-rendered flag + the restorers the
    // funnel dropped.
    expect(line).toContain('energy=12');
    expect(line).toContain('hunger=35');
    expect(line).toMatch(/energy=12\|hint=false\|prunedAway=\[rest_among_seedlings\]/);
    expect(line).toMatch(/hunger=35\|hint=false\|prunedAway=\[eat_herbs\]/);

    // The choice side: the plan's targetAffordance values, post-plan-phase.
    expect(line).toContain('chosen=[observe]');
  });

  it('reports hint=true and prunedAway=[] when the restorers survive the funnel', async () => {
    const orch = makeOrchestrator(
      {
        drives: URGENT_DRIVES,
        pruned: ['rest_among_seedlings', 'eat_herbs', 'go_to_garden', 'observe'],
      },
      [{ description: 'Rest among the seedlings', targetAffordance: 'rest_among_seedlings' }],
    );

    await orch.runCycle(AGENT_ID);

    const lines = driveHintLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/energy=12\|hint=true\|prunedAway=\[\]/);
    expect(lines[0]).toMatch(/hunger=35\|hint=true\|prunedAway=\[\]/);
    expect(lines[0]).toContain('afterPrune=4');
    expect(lines[0]).toContain('enum=[rest_among_seedlings,eat_herbs,go_to_garden,observe]');
    expect(lines[0]).toContain('chosen=[rest_among_seedlings]');
  });

  it('emits no [drive-hint] line when all hintable drives are ≥ 40', async () => {
    const orch = makeOrchestrator({ drives: HEALTHY_DRIVES, pruned: ['go_to_garden', 'observe'] }, [
      { description: 'Look around', targetAffordance: 'observe' },
    ]);

    await orch.runCycle(AGENT_ID);

    expect(driveHintLines(logSpy)).toHaveLength(0);
  });

  it('emits exactly one line even when the plan phase fails (chosen=[none])', async () => {
    const orch = makeOrchestrator(
      { drives: URGENT_DRIVES, pruned: ['go_to_garden', 'observe'] },
      // Invalid plan (empty description) → PlanService returns success:false.
      [],
    );

    await orch.runCycle(AGENT_ID);

    const lines = driveHintLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('chosen=[none]');
    // The plan-failure line still rode console.error.
    expect(errSpy.mock.calls.some((args) => args.join(' ').includes('[plan-failed]'))).toBe(true);
  });

  it('afterMask reflects the masking stage when a guardrail masks affordances', async () => {
    // A no-plan agent with masking ON: masked = [] while pruned keeps the
    // classifier output — the funnel's third stage is visible in the counts.
    const state = makeState(AGENT_ID, URGENT_DRIVES);
    const provider: PerceptionDataProvider = {
      getAgentLocation: () => ROOM_ID,
      getObjectsInRoom: () => [],
      getAffordancesInRoom: () => greenhouseAffordances(),
      getAgentDrives: () => URGENT_DRIVES,
      getPrimaryDriveLabel: () => PRIMARY_LABEL,
      getSystemFeedback: () => undefined,
      getAgentState: () => state,
    };
    const orch = new PPEROrchestratorImpl({
      perceptionProvider: provider,
      planProvider: makePlanProvider(URGENT_DRIVES),
      executeProvider: makeExecuteProvider(state),
      reflectProvider: makeReflectProvider(state),
      classifier: makeDroppingClassifier(['go_to_garden', 'observe']),
      llmClient: makePlanLLM([{ description: 'Wait', targetAffordance: 'wait' }]),
      guardrail: {
        config: { affordanceMasking: true, contextualForcing: true, planValidation: true },
        maskAffordances: (affordances, hasPlan) => (hasPlan ? affordances : []),
        validateAction: () => ({ valid: true }),
      },
    });

    await orch.runCycle(AGENT_ID);

    const lines = driveHintLines(logSpy);
    expect(lines).toHaveLength(1);
    // pruned=2 → masked=[] (no plan + masking on) → the enum is empty.
    expect(lines[0]).toContain('afterPrune=2');
    expect(lines[0]).toContain('afterMask=0');
    expect(lines[0]).toContain('enum=[]');
  });
});
