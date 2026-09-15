/**
 * Spec 058 follow-up — `[execute]` / `[reflect]` PPER observability lines.
 *
 * Origin: the #206 AC-7 40-minute live run stalled at ~t+3min. The log showed
 * 4,365 plan cycles, 34 affordance executions and 260+ minutes of silence from
 * the Execute phase — because the stall rode the ONE silent path: a completed
 * plan returning `{success: true, planComplete: true}` forever because nothing
 * cleared it. These lines make that path, the `navigating` path, and every
 * failing Reflect visible in run logs. Diagnostic-only (spec 049 discipline):
 * zero LLM calls, never throws, no behaviour change.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Affordance,
  AffordanceResult,
  AgentInternalState,
  AgentPlan,
  ExecuteDataProvider,
  PlanStep,
} from '@evol-hive/shared';
import { ExecuteServiceImpl } from '../src/pper/execute-service.js';
import {
  executeDiagnosticLine,
  executeOutcome,
  logReflectOutcome,
  reflectDiagnosticLine,
} from '../src/pper/execute-diagnostic.js';

const AGENT_ID = 'gardener-1';
const ROOM_ID = 'garden';

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── AC: the outcome vocabulary covers every silent path ─────────────────────

describe('spec 058 follow-up AC-1: executeOutcome names the silent paths', () => {
  it('maps the completed-but-uncleared plan to `complete`', () => {
    expect(executeOutcome({ success: true, planComplete: true })).toBe('complete');
  });

  it('maps the multi-tick navigation result to `navigating`', () => {
    expect(executeOutcome({ success: true, planComplete: false, navigating: true })).toBe(
      'navigating',
    );
  });

  it('maps a first-offence failure to `error:<reason>` (the pre-`[step-skip]` gap)', () => {
    expect(
      executeOutcome({
        success: false,
        error: 'Precondition failed: door_locked',
        planComplete: false,
      }),
    ).toBe('error:Precondition failed: door_locked');
  });

  it('maps the no-plan early return to `no-plan`', () => {
    expect(executeOutcome({ success: false, error: 'No active plan', planComplete: true })).toBe(
      'no-plan',
    );
  });

  it('tags a guardrail deviation distinctly — the stale-plan livelock signature', () => {
    expect(
      executeOutcome({
        success: false,
        error:
          "The 'pick_herbs' target is no longer in 'garden'. The plan is stale — reflect and choose a different action.",
        planComplete: false,
        deviationRejected: true,
      }),
    ).toBe(
      "deviation:The 'pick_herbs' target is no longer in 'garden'. The plan is stale — reflect a…",
    );
  });

  it('maps an ordinary executed step to `step-ok`', () => {
    expect(executeOutcome({ success: true, planComplete: false })).toBe('step-ok');
  });

  it('collapses multi-line error reasons into one word-safe line', () => {
    const outcome = executeOutcome({
      success: false,
      error: 'boom\n  at foo()\n  at bar()',
      planComplete: false,
    });
    expect(outcome).toBe('error:boom at foo() at bar()');
    expect(outcome).not.toContain('\n');
  });
});

// ─── AC: the line carries the plan the engine believed was active ────────────

describe('spec 058 follow-up AC-2: the line names plan, step and outcome', () => {
  it('renders the post-execute step index against the plan length', () => {
    const plan = { id: 'plan-7', steps: [{}, {}, {}], currentStepIndex: 1 };
    expect(executeDiagnosticLine(AGENT_ID, plan, { success: true, planComplete: false })).toBe(
      '[execute] agent=gardener-1 plan=plan-7 step=2/3 outcome=step-ok skipped=-',
    );
  });

  it('renders `plan=none step=-` when the agent has no plan', () => {
    expect(
      executeDiagnosticLine(AGENT_ID, null, {
        success: false,
        error: 'No active plan',
        planComplete: true,
      }),
    ).toBe('[execute] agent=gardener-1 plan=none step=- outcome=no-plan skipped=-');
  });

  it('rides the per-plan cumulative skip count when the result stamped one', () => {
    const plan = { id: 'plan-8', steps: [{}, {}], currentStepIndex: 2 };
    expect(
      executeDiagnosticLine(AGENT_ID, plan, {
        success: true,
        planComplete: true,
        stepSkipped: true,
        stepsSkipped: 3,
      }),
    ).toBe('[execute] agent=gardener-1 plan=plan-8 step=3/2 outcome=complete skipped=3');
  });
});

// ─── AC: reflect honesty (the phase that clears the plan) ────────────────────

describe('spec 058 follow-up AC-3: reflectDiagnosticLine reports failure loudly', () => {
  it('renders a successful reflect with its applied flags', () => {
    expect(
      reflectDiagnosticLine(AGENT_ID, true, undefined, { drivesUpdated: true, memoryStored: true }),
    ).toBe('[reflect] agent=gardener-1 outcome=ok drives=true memory=true');
  });

  it('renders a failed reflect with the error (the uncleared-plan precondition)', () => {
    expect(
      reflectDiagnosticLine(AGENT_ID, false, 'LLM response error: invalid JSON', {
        drivesUpdated: false,
        memoryStored: false,
      }),
    ).toBe(
      '[reflect] agent=gardener-1 outcome=error:LLM response error: invalid JSON drives=false memory=false',
    );
  });

  it('never throws when console.error throws (spec 049 discipline)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('stderr exploded');
    });
    expect(() => logReflectOutcome(AGENT_ID, true, undefined, {})).not.toThrow();
  });
});

// ─── AC: the production seam emits exactly one line per Execute call ─────────

/** Minimal ExecuteDataProvider whose plan cursor is set by the test. */
class DiagnosticProvider implements ExecuteDataProvider {
  constructor(
    public plan: AgentPlan,
    public currentStepIndex = 0,
  ) {}

  getAgentState(agentId: string): AgentInternalState | null {
    return {
      agentId,
      drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
      currentGoal: 'test goal',
      currentPlan: this.plan,
      isThinking: true,
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
  async executeAffordance(_objectId: string, affordanceId: string): Promise<AffordanceResult> {
    void affordanceId;
    return { success: true, driveChanges: { energy: 5 } };
  }
  advanceStep(): void {
    // The engine keeps the plan's own cursor authoritative — mirror that here.
    this.currentStepIndex += 1;
    this.plan.currentStepIndex = this.currentStepIndex;
  }
  applyDriveChanges(): void {}
  setSystemFeedback(): void {}
  setThinking(): void {}
}

function singleStepPlan(): AgentPlan {
  return {
    id: 'plan-stall',
    description: 'Water the seedlings',
    steps: [{ description: 'Water', targetAffordance: 'water', completed: false }],
    currentStepIndex: 0,
    createdAt: 1,
  };
}

function twoStepPlan(): AgentPlan {
  const plan = singleStepPlan();
  plan.id = 'plan-two';
  plan.steps = [
    { description: 'Water', targetAffordance: 'water', completed: false },
    { description: 'Rest', targetAffordance: 'rest', completed: false },
  ];
  return plan;
}

describe('spec 058 follow-up AC-4: ExecuteServiceImpl emits one [execute] line per call', () => {
  it('emits the executed step line', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = new DiagnosticProvider(twoStepPlan());
    const service = new ExecuteServiceImpl({ dataProvider: provider });

    await service.execute(AGENT_ID);

    const lines = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((l) => l.startsWith('[execute]'));
    expect(lines).toEqual([
      '[execute] agent=gardener-1 plan=plan-two step=2/2 outcome=step-ok skipped=-',
    ]);
  });

  it('emits `outcome=complete` on the silent completed-plan path (the stall signature)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const completed = singleStepPlan();
    completed.currentStepIndex = 1;
    const provider = new DiagnosticProvider(completed, 1);
    const service = new ExecuteServiceImpl({ dataProvider: provider });

    const result = await service.execute(AGENT_ID);

    expect(result).toEqual({ success: true, planComplete: true });
    const lines = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((l) => l.startsWith('[execute]'));
    expect(lines).toEqual([
      '[execute] agent=gardener-1 plan=plan-stall step=2/1 outcome=complete skipped=-',
    ]);
  });

  it('never throws when console.error throws (spec 049 discipline)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('stderr exploded');
    });
    const service = new ExecuteServiceImpl({
      dataProvider: new DiagnosticProvider(singleStepPlan()),
    });
    await expect(service.execute(AGENT_ID)).resolves.toMatchObject({ success: true });
  });
});
