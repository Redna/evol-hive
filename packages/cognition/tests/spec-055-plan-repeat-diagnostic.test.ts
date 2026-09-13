/**
 * Spec 055 — Consecutive-identical-plan diagnostic (`[plan-repeat]`, Req 7 —
 * issue #198, AC-7)
 * ────────────────────────────────────────────────────────────────────────────
 * Following the spec-049 discipline (orchestrator owns diagnostics; zero LLM
 * calls; never breaks a cycle), `PPEROrchestratorImpl` emits ONE `[plan-repeat]`
 * stderr line per cycle when the agent's plan fingerprint (sorted
 * `targetAffordance` sequence + description hash) matches the previous cycle's
 * FORMULATED plan, carrying the consecutive-identical count. This makes the
 * #191 signature (356× identical plans) auditable from logs.
 *
 * Emitted contract (pinned here):
 * - the first formulation of a plan emits NO line (nothing to compare against);
 * - a re-formulation with the same fingerprint emits exactly one line whose
 *   `count` is the consecutive-identical formulation count (2, 3, …);
 * - a changed plan resets the count silently (no line on the reset cycle);
 * - a plan that is still executing (same plan id — the plan-service
 *   short-circuit continuation) is NOT a re-formulation and never counts;
 * - per-agent state: two agents' plans never interfere;
 * - a diagnostic failure (here: a throwing console.error) can never break the
 *   cycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  PerceptionDataProvider,
  PlanDataProvider,
  ExecuteDataProvider,
  ReflectDataProvider,
  PerceptionResult,
  ExecuteResult,
  ReflectResult,
  AgentInternalState,
  AgentPlan,
  Affordance,
  FormulatePlanResult,
  ReflectLLMResponse,
  LLMActionResponse,
  ReflectionResult,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '../src/index.js';
import type { AffordanceClassifier } from '../src/classifier/index.js';
import {
  PPEROrchestratorImpl,
  PlanRepeatTracker,
  planFingerprint,
} from '../src/pper/orchestrator.js';

// ─── Fakes (the pper-orchestrator.test.ts fixture pattern) ──────────────────

function makeState(agentId = 'a1'): AgentInternalState {
  return {
    agentId,
    drives: { energy: 45, hunger: 50, social: 50, comfort: 50, curiosity: 60 },
    currentGoal: '',
    currentPlan: null,
    isThinking: false,
    location: 'garden',
    lastPerceptionTick: 0,
  };
}

const WATER_AFFORDANCE: Affordance = {
  id: 'water_plants',
  label: 'Water the plants',
  engineEffect: 'water_plants',
  preconditions: [],
  effects: { curiosity: 10, comfort: 5 },
};

function makePerceptionProvider(state: AgentInternalState): PerceptionDataProvider {
  return {
    getAgentLocation: () => state.location,
    getObjectsInRoom: () => [{ id: 'planter-1', name: 'Planter', type: 'furniture' }],
    getAffordancesInRoom: () => [WATER_AFFORDANCE],
    getAgentDrives: () => ({ ...state.drives }),
    getPrimaryDriveLabel: () => 'low curiosity, need to restore curiosity',
    getSystemFeedback: () => undefined,
  };
}

let planCounter = 0;

function makePlanProvider(state: AgentInternalState): PlanDataProvider {
  return {
    getAgentState: () => state,
    storePlan: (_id, result) => {
      // Unique ids per formulation — the real PlanManagerImpl contract.
      const plan: AgentPlan = {
        id: `plan_${state.agentId}_${planCounter++}`,
        description: result.description,
        steps: result.steps.map((s) => ({
          description: s.description,
          completed: false,
          ...(s.targetAffordance !== undefined ? { targetAffordance: s.targetAffordance } : {}),
        })),
        currentStepIndex: 0,
        createdAt: 0,
      };
      state.currentPlan = plan;
      return plan;
    },
    setThinking: () => {},
  };
}

function makeExecuteProvider(state: AgentInternalState): ExecuteDataProvider {
  return {
    getAgentState: () => state,
    getCurrentStep: () => state.currentPlan?.steps[state.currentPlan.currentStepIndex] ?? null,
    isPlanComplete: () =>
      state.currentPlan === null ||
      state.currentPlan.currentStepIndex >= state.currentPlan.steps.length,
    resolveAffordance: () => ({ objectId: 'planter-1', affordance: WATER_AFFORDANCE }),
    checkPreconditions: () => ({ satisfied: true, failed: [] }),
    executeAffordance: async () => ({ success: true, driveChanges: { curiosity: 10 } }),
    advanceStep: () => {
      if (state.currentPlan !== null) {
        state.currentPlan = {
          ...state.currentPlan,
          currentStepIndex: state.currentPlan.currentStepIndex + 1,
        };
      }
    },
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
    clearPlanIfComplete: () => {
      state.currentPlan = null;
      return true;
    },
    setThinking: () => {},
    getAgentProfile: () => null,
  };
}

/** Scripted LLM: serves plans in order; reflect/structured responses canned. */
class ScriptedPlanLLM implements LLMClient {
  private readonly queue: FormulatePlanResult[];
  private loop: FormulatePlanResult | undefined;
  constructor(...plans: FormulatePlanResult[]) {
    this.queue = [...plans];
  }
  static looping(plan: FormulatePlanResult): ScriptedPlanLLM {
    const llm = new ScriptedPlanLLM();
    llm.loop = plan;
    return llm;
  }
  async completeStructured(): Promise<LLMActionResponse> {
    return { reasoning: 'scripted', action: 'wait' };
  }
  async completeReflection(): Promise<ReflectionResult> {
    return { agentId: 'a1', newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(): Promise<FormulatePlanResult> {
    if (this.loop !== undefined) return this.loop;
    const next = this.queue.shift();
    if (next === undefined) throw new Error('ScriptedPlanLLM script exhausted');
    return next;
  }
  async completeReflect(): Promise<ReflectLLMResponse> {
    return {};
  }
}

function makeOrchestrator(state: AgentInternalState, llm: LLMClient): PPEROrchestratorImpl {
  return new PPEROrchestratorImpl({
    perceptionProvider: makePerceptionProvider(state),
    planProvider: makePlanProvider(state),
    executeProvider: makeExecuteProvider(state),
    reflectProvider: makeReflectProvider(state),
    classifier: { prune: async (_q, a) => a } as unknown as AffordanceClassifier,
    llmClient: llm,
  });
}

function plan(description: string, ...affordances: string[]): FormulatePlanResult {
  return {
    description,
    steps: affordances.map((a) => ({ description: `do ${a}`, targetAffordance: a })),
  };
}

const WATER_PLAN = plan('Water the greenhouse plants', 'water_plants');
const HARVEST_PLAN = plan('Harvest the vegetables', 'harvest');
const NAV_WATER_PLAN = plan('Go water the greenhouse', 'go_to_greenhouse', 'water_plants');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('spec 055 Req 7: plan fingerprint', () => {
  it('is order-insensitive over steps (sorted targetAffordance sequence) and description-sensitive', () => {
    const reordered = {
      description: 'Go water the greenhouse',
      steps: [...NAV_WATER_PLAN.steps].reverse(),
    };
    expect(planFingerprint(NAV_WATER_PLAN)).toBe(planFingerprint(reordered));
    expect(planFingerprint(NAV_WATER_PLAN)).not.toBe(planFingerprint(WATER_PLAN));
    expect(planFingerprint(WATER_PLAN)).not.toBe(planFingerprint(HARVEST_PLAN));
  });

  it('separates identical step sets with different descriptions', () => {
    expect(planFingerprint(WATER_PLAN)).not.toBe(
      planFingerprint({ ...WATER_PLAN, description: 'x' }),
    );
  });

  it('falls back to the step description when no targetAffordance is bound', () => {
    const described = {
      description: 'd',
      steps: [{ description: 'narrative step' }],
    };
    expect(planFingerprint(described)).toBe(planFingerprint(described));
    expect(planFingerprint(described)).not.toBe(planFingerprint(WATER_PLAN));
  });
});

describe('spec 055 Req 7: PlanRepeatTracker emitted contract', () => {
  it('first formulation emits no line; second identical emits count=2; third emits count=3', () => {
    const tracker = new PlanRepeatTracker();
    tracker.record('a1', { ...WATER_PLAN, id: 'p1' } as AgentPlan);
    expect(console.error).not.toHaveBeenCalled();

    tracker.record('a1', { ...WATER_PLAN, id: 'p2' } as AgentPlan);
    expect(console.error).toHaveBeenCalledTimes(1);
    const line1 = vi.mocked(console.error).mock.calls[0]!.map(String).join(' ');
    expect(line1).toContain('[plan-repeat]');
    expect(line1).toContain('agent=a1');
    expect(line1).toContain('count=2');

    tracker.record('a1', { ...WATER_PLAN, id: 'p3' } as AgentPlan);
    expect(console.error).toHaveBeenCalledTimes(2);
    const line2 = vi.mocked(console.error).mock.calls[1]!.map(String).join(' ');
    expect(line2).toContain('count=3');
  });

  it('a changed plan resets the count silently (no line on the reset cycle)', () => {
    const tracker = new PlanRepeatTracker();
    tracker.record('a1', { ...WATER_PLAN, id: 'p1' } as AgentPlan);
    tracker.record('a1', { ...WATER_PLAN, id: 'p2' } as AgentPlan);
    expect(console.error).toHaveBeenCalledTimes(1);
    vi.mocked(console.error).mockClear();

    tracker.record('a1', { ...HARVEST_PLAN, id: 'p3' } as AgentPlan);
    expect(console.error).not.toHaveBeenCalled();

    // Identical to p3's fingerprint → the counter restarts at 2.
    tracker.record('a1', { ...HARVEST_PLAN, id: 'p4' } as AgentPlan);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0]!.map(String).join(' ')).toContain('count=2');
  });

  it('the same plan id (short-circuit continuation) never counts as a re-formulation', () => {
    const tracker = new PlanRepeatTracker();
    const continuing = { ...WATER_PLAN, id: 'p1' } as AgentPlan;
    tracker.record('a1', continuing);
    tracker.record('a1', continuing);
    tracker.record('a1', continuing);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('per-agent state: two agents with identical plans never interfere', () => {
    const tracker = new PlanRepeatTracker();
    tracker.record('a1', { ...WATER_PLAN, id: 'p1' } as AgentPlan);
    tracker.record('b2', { ...WATER_PLAN, id: 'q1' } as AgentPlan);
    tracker.record('a1', { ...WATER_PLAN, id: 'p2' } as AgentPlan); // a1 count=2
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0]!.map(String).join(' ')).toContain('agent=a1');
  });

  it('the line is grep-able and carries the fingerprint and plan description', () => {
    const tracker = new PlanRepeatTracker();
    tracker.record('a1', { ...WATER_PLAN, id: 'p1' } as AgentPlan);
    tracker.record('a1', { ...WATER_PLAN, id: 'p2' } as AgentPlan);
    const line = vi.mocked(console.error).mock.calls[0]!.map(String).join(' ');
    expect(line).toContain('[plan-repeat]');
    expect(line).toContain('agent=a1');
    expect(line).toContain('count=2');
    expect(line).toContain(`fingerprint=${planFingerprint(WATER_PLAN)}`);
    expect(line).toContain('Water the greenhouse plants');
  });
});

describe('spec 055 Req 7 / AC-7: the orchestrator emits [plan-repeat] per cycle', () => {
  it('two consecutive cycles formulating identical plans emit exactly one line with count=2', async () => {
    const state = makeState();
    const orchestrator = makeOrchestrator(state, ScriptedPlanLLM.looping(WATER_PLAN));

    await orchestrator.runCycle('a1'); // formulate → no line
    expect(consoleLines('[plan-repeat]')).toHaveLength(0);

    await orchestrator.runCycle('a1'); // identical re-formulation → count=2
    const lines = consoleLines('[plan-repeat]');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('agent=a1');
    expect(lines[0]).toContain('count=2');
  });

  it('a changed plan resets the count — no new line on the reset cycle', async () => {
    const state = makeState();
    const orchestrator = makeOrchestrator(
      state,
      new ScriptedPlanLLM(WATER_PLAN, WATER_PLAN, HARVEST_PLAN),
    );
    await orchestrator.runCycle('a1');
    await orchestrator.runCycle('a1'); // count=2 line
    expect(consoleLines('[plan-repeat]')).toHaveLength(1);
    await orchestrator.runCycle('a1'); // changed → reset, silent
    expect(consoleLines('[plan-repeat]')).toHaveLength(1);
  });

  it('a plan still executing across cycles (same plan id) never emits the line', async () => {
    // Two-step plan: cycle 1 executes step 1 (plan continues), cycle 2
    // short-circuits plan() on the live plan — no re-formulation, no line.
    const state = makeState();
    const orchestrator = makeOrchestrator(state, new ScriptedPlanLLM(NAV_WATER_PLAN));
    await orchestrator.runCycle('a1');
    // Reset the plan index so cycle 2 still has a step to execute (the fake
    // execute provider advanced it) — the plan service then short-circuits.
    await orchestrator.runCycle('a1');
    expect(consoleLines('[plan-repeat]')).toHaveLength(0);
  });

  it('a diagnostic failure cannot break the cycle (AC-7 resilience)', async () => {
    const state = makeState();
    const orchestrator = makeOrchestrator(state, ScriptedPlanLLM.looping(WATER_PLAN));
    // A logging failure on the [plan-repeat] emission itself must not break
    // the cycle — other stderr lines ([plan-bind], [plan-create]) stay inert
    // so the cycle reaches its normal phases.
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
      if (args.some((a) => String(a).includes('[plan-repeat]'))) {
        throw new Error('logging blew up');
      }
    });
    await expect(orchestrator.runCycle('a1')).resolves.toEqual({
      appliedDriveChanges: true,
    });
    await expect(orchestrator.runCycle('a1')).resolves.toEqual({
      appliedDriveChanges: true,
    });
    // The cycle still formulated, executed, and reflected — the plan is stored
    // and cleared by reflect after completion.
    expect(state.currentPlan).toBeNull();
  });
});

function consoleLines(marker: string): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map((args) => args.map(String).join(' '))
    .filter((l) => l.includes(marker));
}
