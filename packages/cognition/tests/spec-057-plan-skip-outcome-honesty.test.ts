/**
 * Spec 057 — Plan Skip Honesty (issue #204)
 * ────────────────────────────────────────────────────────────────────────────
 * A plan that reaches its end by advancing past repeatedly-failing steps
 * (the spec-037 step-skip livelock guard) is currently stamped `success: true`
 * and rendered to the agent as an unqualified "it succeeded" — the skipped
 * steps are invisible. This spec repairs the reporting (never the skip
 * semantics): the per-plan skip count rides `ExecuteResult.stepsSkipped` from
 * Execute into the Reflect stamp, the plan prompt renders it honestly, and the
 * `[plan-memory]` diagnostic exposes it to run logs.
 *
 * AC coverage:
 * - AC-1 (R1): per-plan skip accumulation across a 3-step plan; intermediate
 *   result after the first skip carries stepsSkipped=1; final carries 2.
 * - AC-2 (R1): skip-free plans omit the field; a new plan id resets the count.
 * - AC-3 (R1, R6): the spec-037 livelock guard is unchanged — 2 consecutive
 *   failures, `stepSkipped: true`, `[step-skip]` format, skip-free shapes.
 * - AC-5 (R3): the Reflect stamp carries stepsSkipped when > 0, omits otherwise.
 * - AC-6 (R4): the plan prompt's skipped verdict (dynamic section only).
 * - AC-7 (R5): the `[plan-memory]` line gains ` skipped=<N>` when defined.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  Affordance,
  AffordanceResult,
  AgentInternalState,
  AgentPlan,
  ExecuteDataProvider,
  ExecuteResult,
  FormulatePlanResult,
  LastPlanOutcome,
  PlanStep,
  PerceptionResult,
  ReflectDataProvider,
} from '@evol-hive/shared';
import { ExecuteServiceImpl } from '../src/pper/execute-service.js';
import { ReflectServiceImpl } from '../src/pper/reflect-service.js';
import { ReflectBuilderImpl } from '../src/pper/reflect-builder.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { planMemoryDiagnosticLine } from '../src/pper/plan-memory-diagnostic.js';
import type { LLMClient } from '../src/index.js';

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Execute phase: per-plan skip accumulation (AC-1, AC-2, AC-3) ─────────────

/**
 * Stateful ExecuteDataProvider driven by an AgentPlan: `advanceStep` moves the
 * plan's cursor, `isPlanComplete` reads it, and execution fails for every
 * affordance in `failingAffordances`. This is the real multi-cycle shape the
 * production loop presents to `ExecuteServiceImpl`.
 */
class SkipScenarioProvider implements ExecuteDataProvider {
  plan: AgentPlan;
  currentStepIndex = 0;
  readonly failingAffordances: Set<string>;
  advanced = 0;
  readonly advanceStepCalls: string[] = [];
  readonly setSystemFeedbackCalls: { agentId: string; feedback: string }[] = [];
  readonly setThinkingCalls: { agentId: string; isThinking: boolean }[] = [];

  constructor(plan: AgentPlan, failingAffordances: string[] = []) {
    this.plan = plan;
    this.failingAffordances = new Set(failingAffordances);
  }

  getAgentState(agentId: string): AgentInternalState | null {
    return {
      agentId,
      drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
      currentGoal: 'test goal',
      currentPlan: this.plan,
      isThinking: false,
      location: ROOM_ID,
      lastPerceptionTick: 0,
    };
  }
  getCurrentStep(): PlanStep | null {
    return this.plan.steps[this.currentStepIndex] ?? null;
  }
  isPlanComplete(): boolean {
    return this.currentStepIndex >= this.plan.steps.length;
  }
  resolveAffordance(
    _roomId: string,
    affordanceId: string,
  ): { objectId: string; affordance: Affordance } | null {
    return {
      objectId: `obj-${affordanceId}`,
      affordance: {
        id: affordanceId,
        label: affordanceId,
        engineEffect: affordanceId,
        preconditions: [],
        effects: {},
      },
    };
  }
  checkPreconditions(): { satisfied: boolean; failed: string[] } {
    return { satisfied: true, failed: [] };
  }
  async executeAffordance(
    _objectId: string,
    affordanceId: string,
  ): Promise<AffordanceResult> {
    if (this.failingAffordances.has(affordanceId)) {
      return { success: false, failureReason: `'${affordanceId}' failed.` };
    }
    return { success: true, driveChanges: { energy: 5 } };
  }
  advanceStep(agentId: string): void {
    this.advanceStepCalls.push(agentId);
    this.currentStepIndex += 1;
    this.advanced += 1;
  }
  applyDriveChanges(): void {}
  setSystemFeedback(agentId: string, feedback: string): void {
    this.setSystemFeedbackCalls.push({ agentId, feedback });
  }
  setThinking(agentId: string, isThinking: boolean): void {
    this.setThinkingCalls.push({ agentId, isThinking });
  }
}

function threeStepPlan(id = 'plan-a'): AgentPlan {
  return {
    id,
    description: 'Farm round',
    steps: [
      { description: 'Plant seeds', targetAffordance: 'plant_seeds', completed: false },
      { description: 'Brew coffee', targetAffordance: 'brew_coffee', completed: false },
      { description: 'Harvest', targetAffordance: 'harvest', completed: false },
    ],
    currentStepIndex: 0,
    createdAt: 1,
  };
}

describe('spec 057 Req 1 / AC-1: per-plan skip count in ExecuteResult', () => {
  it('accumulates skips across a plan and reports the cumulative count on every later result', async () => {
    const provider = new SkipScenarioProvider(threeStepPlan(), ['plant_seeds', 'harvest']);
    const service = new ExecuteServiceImpl({ dataProvider: provider });

    // Step 0, failure #1: normal failure — no skip yet, no count.
    const f1 = await service.execute(AGENT_ID);
    expect(f1.success).toBe(false);
    expect(f1.stepsSkipped).toBeUndefined();
    expect(provider.advanceStepCalls).toHaveLength(0);

    // Step 0, failure #2: livelock guard skips the step → count 1.
    const s1 = await service.execute(AGENT_ID);
    expect(s1.success).toBe(true);
    expect(s1.stepSkipped).toBe(true);
    expect(s1.planComplete).toBe(false);
    expect(s1.stepsSkipped).toBe(1);

    // Step 1 executes successfully: the per-plan total is NOT reset.
    const ok = await service.execute(AGENT_ID);
    expect(ok.success).toBe(true);
    expect(ok.planComplete).toBe(false);
    expect(ok.stepsSkipped).toBe(1);

    // Step 2, failure #1: still 1 (no new skip).
    const f2 = await service.execute(AGENT_ID);
    expect(f2.success).toBe(false);
    expect(f2.stepsSkipped).toBe(1);

    // Step 2, failure #2: second skip → count 2 and the plan completes.
    const s2 = await service.execute(AGENT_ID);
    expect(s2.success).toBe(true);
    expect(s2.stepSkipped).toBe(true);
    expect(s2.planComplete).toBe(true);
    expect(s2.stepsSkipped).toBe(2);

    expect(provider.advanceStepCalls).toHaveLength(3);
  });
});

describe('spec 057 Req 1 / AC-2: skip-free plans and plan-id reset', () => {
  it('a skip-free plan never carries stepsSkipped', async () => {
    const provider = new SkipScenarioProvider(threeStepPlan('plan-clean'));
    const service = new ExecuteServiceImpl({ dataProvider: provider });

    for (let i = 0; i < 3; i++) {
      const result = await service.execute(AGENT_ID);
      expect(result.success).toBe(true);
      expect(result.stepsSkipped).toBeUndefined();
      expect(Object.keys(result)).not.toContain('stepsSkipped');
    }
    expect(provider.advanceStepCalls).toHaveLength(3);
  });

  it('switching to a new plan id resets a previously accumulated count to 0', async () => {
    const provider = new SkipScenarioProvider(threeStepPlan('plan-old'), ['plant_seeds']);
    const service = new ExecuteServiceImpl({ dataProvider: provider });

    await service.execute(AGENT_ID); // failure 1
    const skipped = await service.execute(AGENT_ID); // failure 2 → skip → count 1
    expect(skipped.stepsSkipped).toBe(1);

    // A brand-new plan replaces the old one (new id).
    provider.plan = {
      id: 'plan-new',
      description: 'Fresh plan',
      steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee', completed: false }],
      currentStepIndex: 0,
      createdAt: 2,
    };
    provider.currentStepIndex = 0;

    const fresh = await service.execute(AGENT_ID);
    expect(fresh.success).toBe(true);
    expect(fresh.stepsSkipped).toBeUndefined();
  });
});

describe('spec 057 Req 1 & Req 6 / AC-3: spec-037 skip semantics unchanged', () => {
  it('advances a step only after 2 consecutive failures and keeps the [step-skip] format', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = new SkipScenarioProvider(threeStepPlan('plan-reg'), ['plant_seeds']);
    const service = new ExecuteServiceImpl({ dataProvider: provider });

    const first = await service.execute(AGENT_ID);
    expect(first.success).toBe(false);
    expect(provider.advanceStepCalls).toHaveLength(0);

    const second = await service.execute(AGENT_ID);
    expect(second.success).toBe(true);
    expect(second.stepSkipped).toBe(true);
    expect(provider.advanceStepCalls).toHaveLength(1);

    const skipLine = errSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('[step-skip]'));
    expect(skipLine).toBe(
      "[step-skip] agent=a1 step='Plant seeds' failed 2x consecutively — advancing past it",
    );
  });

  it('a skip-free execution result keeps its existing shape (no stepsSkipped key)', async () => {
    const provider = new SkipScenarioProvider(threeStepPlan('plan-shape'));
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);
    expect(result).toEqual({ success: true, result: { success: true, driveChanges: { energy: 5 } }, planComplete: false });
    expect('stepsSkipped' in result).toBe(false);
  });
});

// ─── Reflect stamp (AC-5) ────────────────────────────────────────────────────

function makeCompletedPlanState(): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { energy: 45, hunger: 50, social: 50, comfort: 50, curiosity: 60 },
    currentGoal: 'water the plants',
    currentPlan: {
      id: 'plan_a1_1',
      description: 'Water the greenhouse plants',
      steps: [
        { description: 'go to greenhouse', completed: false, targetAffordance: 'go_to_greenhouse' },
        { description: 'water the plants', completed: false, targetAffordance: 'water_plants' },
      ],
      currentStepIndex: 2, // already advanced by Execute → just completed
      createdAt: 0,
    },
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
  };
}

function makeReflectProvider(
  state: AgentInternalState,
  stamps: LastPlanOutcome[],
): ReflectDataProvider {
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
    stampLastPlanOutcome: (_agentId, outcome) => {
      stamps.push(outcome);
      state.lastPlanOutcome = outcome;
    },
  };
}

function makeReflectLLM(): LLMClient {
  return {
    completeReflect: async () => ({
      memoryContent: 'Watered the plants.',
      memoryImportance: 5,
      memoryType: 'action',
    }),
  } as unknown as LLMClient;
}

function makeReflectService(provider: ReflectDataProvider): ReflectServiceImpl {
  return new ReflectServiceImpl({
    reflectBuilder: new ReflectBuilderImpl(),
    llmClient: makeReflectLLM(),
    dataProvider: provider,
  });
}

describe('spec 057 Req 3 / AC-5: Reflect stamp carries the skip count', () => {
  it('stamps stepsSkipped when the ExecuteResult carries > 0', async () => {
    const state = makeCompletedPlanState();
    const stamps: LastPlanOutcome[] = [];
    const service = makeReflectService(makeReflectProvider(state, stamps));

    const executeResult: ExecuteResult = { success: true, planComplete: true, stepsSkipped: 2 };
    await service.reflect(AGENT_ID, executeResult);

    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.stepsSkipped).toBe(2);
    expect(state.lastPlanOutcome!.stepsSkipped).toBe(2);
  });

  it('omits stepsSkipped when the ExecuteResult has none (byte-identical stamp)', async () => {
    const state = makeCompletedPlanState();
    const stamps: LastPlanOutcome[] = [];
    const service = makeReflectService(makeReflectProvider(state, stamps));

    await service.reflect(AGENT_ID, { success: true, planComplete: true });

    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.stepsSkipped).toBeUndefined();
    expect(Object.keys(stamps[0]!)).not.toContain('stepsSkipped');
  });

  it('treats stepsSkipped: 0 as no skip (never stamps a zero-valued field)', async () => {
    const state = makeCompletedPlanState();
    const stamps: LastPlanOutcome[] = [];
    const service = makeReflectService(makeReflectProvider(state, stamps));

    await service.reflect(AGENT_ID, { success: true, planComplete: true, stepsSkipped: 0 });

    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.stepsSkipped).toBeUndefined();
  });
});

// ─── Plan prompt rendering (AC-6) ────────────────────────────────────────────

const drives = { energy: 45, hunger: 50, social: 50, comfort: 50, curiosity: 60 };

const prunedAffordances: Affordance[] = [
  {
    id: 'water_plants',
    label: 'Water the plants',
    engineEffect: 'water_plants',
    preconditions: [],
    effects: { curiosity: 10, comfort: 5 },
  },
];

function makePerception(overrides: Partial<PerceptionResult> = {}): PerceptionResult {
  return {
    passive: {
      roomId: 'garden',
      objectsPresent: [{ objectId: 'planter-1', name: 'Planter', type: 'furniture' }],
      drives,
    },
    prunedAffordances,
    primaryDriveLabel: 'low curiosity, need to restore curiosity',
    ...overrides,
  };
}

const builder = new PlanBuilderImpl();

/** Split the payload context into its stable (pre-`---`) and dynamic sections. */
function sections(context: string): { stable: string; dynamic: string } {
  const [stable, dynamic = ''] = context.split('\n---\n');
  return { stable: stable ?? '', dynamic };
}

const skippedOutcome: LastPlanOutcome = {
  planDescription: 'Morning greenhouse round',
  steps: ['a', 'b', 'c'],
  success: true,
  stepsSkipped: 2,
  reflected: false,
};

describe('spec 057 Req 4 / AC-6: skipped verdict in the plan prompt', () => {
  it('renders N of M steps were skipped', () => {
    const payload = builder.build(makePerception({ lastPlanOutcome: skippedOutcome }));
    expect(payload.perceptionContext).toContain(
      'Your last plan was "a, b, c" — 2 of 3 steps were skipped.',
    );
  });

  it('renders in the dynamic section only (stable prefix untouched)', () => {
    const payload = builder.build(makePerception({ lastPlanOutcome: skippedOutcome }));
    const { stable, dynamic } = sections(payload.perceptionContext);
    expect(dynamic).toContain('2 of 3 steps were skipped');
    expect(stable).not.toContain('steps were skipped');
  });

  it('appends drive deltas before the period and the reflection line after', () => {
    const payload = builder.build(
      makePerception({
        lastPlanOutcome: {
          ...skippedOutcome,
          driveChanges: { curiosity: 10 },
          reflected: true,
        },
      }),
    );
    expect(payload.perceptionContext).toContain(
      'Your last plan was "a, b, c" — 2 of 3 steps were skipped (curiosity +10).',
    );
    const lines = payload.perceptionContext.split('\n');
    const verdictIndex = lines.findIndex((line) => line.includes('2 of 3 steps were skipped'));
    expect(lines[verdictIndex + 1]).toBe(
      'You already reflected on that plan — what you learned is in your memory.',
    );
  });

  it('a superseded outcome still wins over a skip count', () => {
    const payload = builder.build(
      makePerception({
        lastPlanOutcome: {
          ...skippedOutcome,
          superseded: true,
          success: false,
          stepsCompleted: 1,
          stepsTotal: 3,
        },
      }),
    );
    expect(payload.perceptionContext).toContain('superseded after 1 of 3 steps');
    expect(payload.perceptionContext).not.toContain('steps were skipped');
  });

  it('an outcome without stepsSkipped renders the spec-055 verdict byte-identically', () => {
    const payload = builder.build(
      makePerception({
        lastPlanOutcome: {
          planDescription: 'Water the greenhouse plants',
          steps: ['go_to_greenhouse', 'water_plants'],
          success: true,
          driveChanges: { curiosity: 10 },
          reflected: true,
        },
      }),
    );
    expect(payload.perceptionContext).toContain(
      'Your last plan was "go_to_greenhouse, water_plants" — it succeeded (curiosity +10).',
    );
  });

  it('a stepsSkipped outcome with an empty step list falls back to the spec-055 verdict', () => {
    const payload = builder.build(
      makePerception({
        lastPlanOutcome: {
          planDescription: 'Empty',
          steps: [],
          success: false,
          stepsSkipped: 2,
          reflected: false,
        },
      }),
    );
    expect(payload.perceptionContext).toContain('Your last plan was "" — it failed.');
    expect(payload.perceptionContext).not.toContain('steps were skipped');
  });
});

// ─── Diagnostic (AC-7) ───────────────────────────────────────────────────────

function outcome(overrides: Partial<LastPlanOutcome> = {}): LastPlanOutcome {
  return {
    planDescription: 'Morning greenhouse round',
    steps: ['go_to_greenhouse', 'water_plants'],
    success: true,
    reflected: true,
    ...overrides,
  };
}

describe('spec 057 Req 5 / AC-7: [plan-memory] skipped diagnostic', () => {
  it('appends skipped=<N> when stepsSkipped is defined', () => {
    expect(planMemoryDiagnosticLine('iris-1', outcome({ stepsSkipped: 2 }))).toBe(
      '[plan-memory] agent=iris-1 verdict=succeeded steps=- skipped=2 reflected=true',
    );
  });

  it('renders byte-identically with no skipped= substring when stepsSkipped is absent', () => {
    const line = planMemoryDiagnosticLine('iris-1', outcome());
    expect(line).toBe('[plan-memory] agent=iris-1 verdict=succeeded steps=- reflected=true');
    expect(line).not.toContain('skipped=');
  });

  it('reports a skipped superseded line with both step counts and the skip count', () => {
    expect(
      planMemoryDiagnosticLine(
        'iris-1',
        outcome({ superseded: true, success: false, stepsCompleted: 1, stepsTotal: 3, stepsSkipped: 1 }),
      ),
    ).toBe('[plan-memory] agent=iris-1 verdict=superseded steps=1/3 skipped=1 reflected=true');
  });
});

// Keep a reference so the unused-import lint (noUnusedLocals in src only) does
// not flag the type-only imports used purely for the shared contract.
export type { FormulatePlanResult };
