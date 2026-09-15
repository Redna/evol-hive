/**
 * Spec 056 follow-up (issue #201) — the `[plan-memory]` render diagnostic
 * ──────────────────────────────────────────────────────────────────────────
 * The plan-memory line lives in the plan PROMPT, which is never logged — so
 * the #201 "0 renders" live reading could not be verified from run logs. This
 * diagnostic emits one stderr line per FORMULATION that carries a
 * `lastPlanOutcome`, with the builder's own verdict vocabulary.
 *
 * Coverage:
 * - verdict trichotomy mirrors the builder (`superseded` / `succeeded` / `failed`)
 * - `steps=N/M` only for superseded outcomes (the only verdict with counts)
 * - `reflected` pass-through
 * - `undefined` outcome → no line (cycle 1 / legacy saves: builder renders none)
 * - one line per formulation, never per cycle (stickiness short-circuit is
 *   upstream of the call site — asserted on the line count)
 * - zero LLM calls (pure string arithmetic — no client is constructed here)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  Affordance,
  AgentInternalState,
  AgentPlan,
  FormulatePlanResult,
  LastPlanOutcome,
  PerceptionResult,
  PlanDataProvider,
} from '@evol-hive/shared';
import {
  logPlanMemory,
  planMemoryDiagnosticLine,
  planMemoryVerdict,
} from '../src/pper/plan-memory-diagnostic.js';
import { PlanServiceImpl } from '../src/pper/plan-service.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import type { LLMClient } from '../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function outcome(overrides: Partial<LastPlanOutcome> = {}): LastPlanOutcome {
  return {
    planDescription: 'Morning greenhouse round',
    steps: ['go_to_greenhouse', 'water_plants'],
    success: true,
    reflected: true,
    ...overrides,
  };
}

describe('spec 056 follow-up — [plan-memory] verdict trichotomy (issue #201)', () => {
  it('maps superseded → superseded, success → succeeded, failure → failed', () => {
    expect(planMemoryVerdict(outcome({ superseded: true, success: false }))).toBe('superseded');
    expect(planMemoryVerdict(outcome({ success: true }))).toBe('succeeded');
    expect(planMemoryVerdict(outcome({ success: false }))).toBe('failed');
  });

  it('superseded wins over a success flag (the engine stamps success: false)', () => {
    expect(planMemoryVerdict(outcome({ superseded: true, success: true }))).toBe('superseded');
  });
});

describe('spec 056 follow-up — [plan-memory] line format (issue #201)', () => {
  it('renders the superseded line with N of M steps', () => {
    const line = planMemoryDiagnosticLine(
      'gardener-1',
      outcome({
        superseded: true,
        success: false,
        stepsCompleted: 1,
        stepsTotal: 3,
        reflected: false,
      }),
    );
    expect(line).toBe(
      '[plan-memory] agent=gardener-1 verdict=superseded steps=1/3 reflected=false',
    );
  });

  it('renders completion lines with steps=-', () => {
    expect(planMemoryDiagnosticLine('iris-1', outcome({ success: true }))).toBe(
      '[plan-memory] agent=iris-1 verdict=succeeded steps=- reflected=true',
    );
    expect(planMemoryDiagnosticLine('iris-1', outcome({ success: false, reflected: false }))).toBe(
      '[plan-memory] agent=iris-1 verdict=failed steps=- reflected=false',
    );
  });

  it('missing step counts on a superseded outcome degrade to 0/0, never NaN', () => {
    expect(planMemoryDiagnosticLine('a', outcome({ superseded: true, success: false }))).toContain(
      'steps=0/0',
    );
  });
});

describe('spec 056 follow-up — [plan-memory] emission (issue #201)', () => {
  it('emits exactly one line per formulation with an outcome', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logPlanMemory('gardener-1', outcome());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toContain('[plan-memory] agent=gardener-1');
  });

  it('emits nothing when there is no outcome (cycle 1 / legacy saves)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logPlanMemory('gardener-1', undefined);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── Production-path wiring: the real PlanServiceImpl emits the line ──────────

const AGENT_ID = 'gardener-1';
const ROOM_ID = 'garden';

const affordances: Affordance[] = [
  {
    id: 'brew_coffee',
    label: 'Brew coffee',
    engineEffect: 'brew_coffee',
    preconditions: [],
    effects: { energy: 10 },
  },
];

function makePerceptionResult(lastPlanOutcome?: LastPlanOutcome): PerceptionResult {
  return {
    passive: {
      roomId: ROOM_ID,
      objectsPresent: [{ objectId: 'machine-1', name: 'Coffee machine', type: 'furniture' }],
      drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    },
    prunedAffordances: affordances,
    primaryDriveLabel: 'low energy, need to restore energy',
    ...(lastPlanOutcome !== undefined ? { lastPlanOutcome } : {}),
  };
}

function makeStoredPlan(): AgentPlan {
  return {
    id: `plan_${AGENT_ID}_123`,
    description: 'Restore energy by brewing coffee',
    steps: [
      { description: 'Go to the machine', targetAffordance: 'brew_coffee', completed: false },
    ],
    currentStepIndex: 0,
    createdAt: 100,
  };
}

/** Minimal PlanDataProvider — no currentPlan, so the stickiness guard passes. */
class FakePlanDataProvider implements PlanDataProvider {
  readonly getStateCalls: string[] = [];
  readonly storePlanCalls: string[] = [];
  readonly thinkingCalls: string[] = [];

  getAgentState(agentId: string): AgentInternalState | null {
    this.getStateCalls.push(agentId);
    return {
      agentId,
      drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
      currentGoal: 'stay alive',
      currentPlan: null,
      isThinking: false,
      location: ROOM_ID,
      lastPerceptionTick: 0,
    };
  }
  storePlan(agentId: string, result: FormulatePlanResult): AgentPlan {
    this.storePlanCalls.push(`${agentId}:${result.steps.length}`);
    return makeStoredPlan();
  }
  setThinking(agentId: string, isThinking: boolean): void {
    this.thinkingCalls.push(`${agentId}:${isThinking}`);
  }
}

function makeLLMClient(): LLMClient {
  return {
    completeStructured: vi.fn(),
    completeReflection: vi.fn(),
    completePlan: vi.fn().mockResolvedValue({
      description: 'Restore energy by brewing coffee',
      steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
    } satisfies FormulatePlanResult),
  } as unknown as LLMClient;
}

function makePlanService(): PlanServiceImpl {
  return new PlanServiceImpl({
    planBuilder: new PlanBuilderImpl(),
    llmClient: makeLLMClient(),
    dataProvider: new FakePlanDataProvider(),
  });
}

describe('spec 056 follow-up — [plan-memory] through the real PlanServiceImpl (issue #201)', () => {
  it('logs the verdict when the perception carries a last-plan outcome', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = makePlanService();
    const result = await service.plan(
      AGENT_ID,
      makePerceptionResult(
        outcome({
          superseded: true,
          success: false,
          stepsCompleted: 1,
          stepsTotal: 3,
          reflected: false,
        }),
      ),
    );
    expect(result.success).toBe(true);
    const lines = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('[plan-memory]'));
    expect(lines).toEqual([
      '[plan-memory] agent=gardener-1 verdict=superseded steps=1/3 reflected=false',
    ]);
  });

  it('logs nothing on a formulation with no prior plan (cycle 1)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = makePlanService();
    await service.plan(AGENT_ID, makePerceptionResult());
    expect(
      spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[plan-memory]')),
    ).toEqual([]);
  });

  it('logs nothing when the plan service short-circuits on an active plan', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: makeLLMClient(),
      dataProvider: {
        ...new FakePlanDataProvider(),
        getAgentState: () => ({
          agentId: AGENT_ID,
          drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
          currentGoal: 'stay alive',
          currentPlan: makeStoredPlan(),
          isThinking: false,
          location: ROOM_ID,
          lastPerceptionTick: 0,
        }),
      } as PlanDataProvider,
    });
    const result = await service.plan(
      AGENT_ID,
      makePerceptionResult(
        outcome({ superseded: true, success: false, stepsCompleted: 1, stepsTotal: 3 }),
      ),
    );
    expect(result.success).toBe(true);
    expect(
      spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[plan-memory]')),
    ).toEqual([]);
  });

  it('a throwing diagnostic never breaks the plan phase (spec-049 discipline)', async () => {
    // Only the [plan-memory] line throws — the other diagnostics (e.g.
    // [plan-bind]) keep their existing unguarded behavior; the wrapped call
    // must swallow its own failure and the plan phase must still succeed.
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('[plan-memory]')) throw new Error('stderr exploded');
    });
    const service = makePlanService();
    const result = await service.plan(AGENT_ID, makePerceptionResult(outcome()));
    expect(result.success).toBe(true);
    spy.mockRestore();
  });
});
