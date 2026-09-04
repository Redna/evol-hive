/**
 * Tests for Compound Action Execution (spec 028, issue #108) — cognition layer.
 *
 * Covers the ExecuteServiceImpl compound fallback: when a plan step's target
 * does not resolve as a plain affordance but does resolve as a compound
 * action, the service runs the compound's sub-steps sequentially through the
 * existing single-affordance path, aggregates drive changes on success, and
 * aborts atomically on failure.
 *
 * Acceptance criteria covered: AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type {
  Affordance,
  AffordanceResult,
  AgentInternalState,
  CompoundAction,
  PlanStep,
} from '@evol-hive/shared';
import { ExecuteServiceImpl } from '../src/pper/execute-service.js';

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

// ─── Fixtures: the coffee-machine compound sequence (spec 018) ───────────────

const addWater: Affordance = {
  id: 'add_water',
  label: 'Add water',
  engineEffect: 'add_water',
  preconditions: [],
  effects: {},
};

const brewCoffee: Affordance = {
  id: 'brew_coffee',
  label: 'Brew coffee',
  engineEffect: 'brew_coffee',
  preconditions: ['has_water', 'has_beans'],
  effects: { energy: 20 },
};

const pourCup: Affordance = {
  id: 'pour_cup',
  label: 'Pour a cup',
  engineEffect: 'pour_cup',
  preconditions: ['has_cups'],
  effects: { comfort: 5 },
};

const brewCompound: CompoundAction = {
  id: 'brew_coffee_sequence',
  label: 'Brew a cup of coffee',
  steps: [
    { affordanceId: 'add_water', description: 'Add water to the machine' },
    { affordanceId: 'brew_coffee', description: 'Brew the coffee' },
    { affordanceId: 'pour_cup', description: 'Pour into a cup' },
  ],
};

/** Nested compound (AC-8) — a compound action whose sub-step is another compound. */
const nestedCompound: CompoundAction = {
  id: 'super_sequence',
  label: 'Super sequence',
  steps: [{ affordanceId: 'brew_coffee_sequence', description: 'Brew coffee (compound)' }],
};

function makeAgentState(overrides: Partial<AgentInternalState> = {}): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    currentGoal: 'make coffee',
    currentPlan: null,
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
    ...overrides,
  };
}

function makeCompoundPlan(): NonNullable<AgentInternalState['currentPlan']> {
  return {
    id: 'plan1',
    description: 'Brew a cup of coffee',
    steps: [
      {
        description: 'Brew a cup of coffee',
        targetAffordance: 'brew_coffee_sequence',
        completed: false,
      },
    ],
    currentStepIndex: 0,
    createdAt: 100,
  };
}

/**
 * Fake ExecuteDataProvider with compound-action support. Sub-step resolution,
 * preconditions, and execution are configured per affordance ID so tests can
 * stage per-step outcomes.
 */
class FakeExecuteDataProvider {
  agentState: AgentInternalState | null = makeAgentState({ currentPlan: makeCompoundPlan() });
  currentStep: PlanStep | null = makeCompoundPlan().steps[0]!;
  planComplete = false;
  isPlanCompleteFn: (() => boolean) | null = null;

  /** Plain-affordance lookup by ID. `null` value = unresolvable. */
  plainAffordances: Record<string, Affordance | null> = {
    add_water: addWater,
    brew_coffee: brewCoffee,
    pour_cup: pourCup,
  };

  /** Compound lookup by ID. `null` value = unresolvable as compound. */
  compounds: Record<string, { objectId: string; compoundAction: CompoundAction } | null> = {
    brew_coffee_sequence: { objectId: 'coffee-1', compoundAction: brewCompound },
    super_sequence: { objectId: 'coffee-1', compoundAction: nestedCompound },
  };

  /** Per-affordance precondition results (default: satisfied). */
  preconditionResults: Record<string, { satisfied: boolean; failed: string[] }> = {};

  /** Per-affordance execution results (default: success, no drive changes). */
  executionResults: Record<string, AffordanceResult> = {};

  /** Per-affordance thrown errors — executeAffordance rejects when set. */
  executionThrows: Record<string, Error> = {};

  // Call records
  resolveAffordanceCalls: { roomId: string; affordanceId: string }[] = [];
  resolveCompoundActionCalls: { roomId: string; compoundActionId: string }[] = [];
  checkPreconditionsCalls: { affordanceId: string; objectId: string }[] = [];
  executeAffordanceCalls: { objectId: string; affordanceId: string; agentId: string }[] = [];
  advanceStepCalls: string[] = [];
  applyDriveChangesCalls: { agentId: string; changes: Partial<Record<string, number>> }[] = [];
  setSystemFeedbackCalls: { agentId: string; feedback: string }[] = [];
  setThinkingCalls: { agentId: string; isThinking: boolean }[] = [];

  getAgentState(agentId: string): AgentInternalState | null {
    return this.agentState;
  }
  getCurrentStep(agentId: string): PlanStep | null {
    return this.currentStep;
  }
  isPlanComplete(agentId: string): boolean {
    if (this.isPlanCompleteFn) return this.isPlanCompleteFn();
    return this.planComplete;
  }
  resolveAffordance(
    roomId: string,
    affordanceId: string,
  ): { objectId: string; affordance: Affordance } | null {
    this.resolveAffordanceCalls.push({ roomId, affordanceId });
    const affordance = this.plainAffordances[affordanceId];
    if (affordance === undefined || affordance === null) return null;
    return { objectId: 'coffee-1', affordance };
  }
  checkPreconditions(
    affordanceId: string,
    objectId: string,
  ): { satisfied: boolean; failed: string[] } {
    this.checkPreconditionsCalls.push({ affordanceId, objectId });
    return this.preconditionResults[affordanceId] ?? { satisfied: true, failed: [] };
  }
  async executeAffordance(
    objectId: string,
    affordanceId: string,
    agentId: string,
  ): Promise<AffordanceResult> {
    this.executeAffordanceCalls.push({ objectId, affordanceId, agentId });
    const thrown = this.executionThrows[affordanceId];
    if (thrown) throw thrown;
    return this.executionResults[affordanceId] ?? { success: true };
  }
  advanceStep(agentId: string): void {
    this.advanceStepCalls.push(agentId);
  }
  applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void {
    this.applyDriveChangesCalls.push({ agentId, changes });
  }
  setSystemFeedback(agentId: string, feedback: string): void {
    this.setSystemFeedbackCalls.push({ agentId, feedback });
  }
  setThinking(agentId: string, isThinking: boolean): void {
    this.setThinkingCalls.push({ agentId, isThinking });
    if (this.agentState) {
      this.agentState = { ...this.agentState, isThinking };
    }
  }

  // spec 028: optional compound resolution. Defined as an instance property so
  // the backward-compatibility test (AC-7) can `delete` it.
  resolveCompoundAction?: (
    roomId: string,
    compoundActionId: string,
  ) => { objectId: string; compoundAction: CompoundAction } | null = (
    roomId: string,
    compoundActionId: string,
  ) => {
    this.resolveCompoundActionCalls.push({ roomId, compoundActionId });
    return this.compounds[compoundActionId] ?? null;
  };
}

// ─── AC-2 + AC-3: compound happy path ────────────────────────────────────────

describe('ExecuteServiceImpl compound happy path (AC-2, AC-3)', () => {
  let provider: FakeExecuteDataProvider;

  beforeEach(() => {
    provider = new FakeExecuteDataProvider();
  });

  it('executes all sub-steps in order and advances the plan exactly once (AC-2)', async () => {
    provider.executionResults = {
      add_water: { success: true },
      brew_coffee: { success: true, driveChanges: { energy: 20 } },
      pour_cup: { success: true, driveChanges: { comfort: 5 } },
    };
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    // Each sub-step's engine effect fired exactly once, in `steps` order.
    expect(provider.executeAffordanceCalls.map((c) => c.affordanceId)).toEqual([
      'add_water',
      'brew_coffee',
      'pour_cup',
    ]);
    expect(provider.executeAffordanceCalls.every((c) => c.objectId === 'coffee-1')).toBe(true);
    expect(provider.executeAffordanceCalls.every((c) => c.agentId === AGENT_ID)).toBe(true);
    // The plan advanced exactly one step for the whole compound.
    expect(provider.advanceStepCalls).toHaveLength(1);
  });

  it('attempts compound resolution only after plain resolution fails (AC-2)', async () => {
    await new ExecuteServiceImpl({ dataProvider: provider }).execute(AGENT_ID);

    // The step target was first attempted as a plain affordance...
    expect(provider.resolveAffordanceCalls[0]).toEqual({
      roomId: ROOM_ID,
      affordanceId: 'brew_coffee_sequence',
    });
    // ...then resolved as a compound action.
    expect(provider.resolveCompoundActionCalls).toEqual([
      { roomId: ROOM_ID, compoundActionId: 'brew_coffee_sequence' },
    ]);
  });

  it('applies merged drive changes once, returns the aggregate result, and sets no feedback on full success (AC-3)', async () => {
    provider.executionResults = {
      add_water: { success: true },
      brew_coffee: { success: true, driveChanges: { energy: 20 } },
      pour_cup: { success: true, driveChanges: { energy: 5, comfort: 5 } },
    };
    provider.isPlanCompleteFn = () => provider.advanceStepCalls.length > 0;
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    // Aggregated AffordanceResult: success + numeric sum of sub-step drive changes.
    expect(result.result).toEqual({ success: true, driveChanges: { energy: 25, comfort: 5 } });
    // Merged drive changes applied exactly once via applyDriveChanges.
    expect(provider.applyDriveChangesCalls).toHaveLength(1);
    expect(provider.applyDriveChangesCalls[0]?.changes).toEqual({ energy: 25, comfort: 5 });
    // planComplete reflects the post-advance plan state.
    expect(result.planComplete).toBe(true);
    // No system feedback on full success (parity with single-affordance success).
    expect(provider.setSystemFeedbackCalls).toHaveLength(0);
    // No setThinking call on success.
    expect(provider.setThinkingCalls).toHaveLength(0);
  });

  it('reports planComplete=false when the compound is not the last plan step (AC-3)', async () => {
    provider.isPlanCompleteFn = () => false;
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.planComplete).toBe(false);
    expect(provider.advanceStepCalls).toHaveLength(1);
  });

  it('prefers the plain affordance when an ID resolves as both plain affordance and compound (fallback ordering)', async () => {
    // Make the compound ID also resolve as a plain affordance.
    provider.plainAffordances['brew_coffee_sequence'] = brewCoffee;
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    // Plain-affordance fast path wins — compound resolution is never attempted.
    expect(result.success).toBe(true);
    expect(provider.executeAffordanceCalls.map((c) => c.affordanceId)).toEqual([
      'brew_coffee_sequence',
    ]);
    expect(provider.executeAffordanceCalls).toHaveLength(1);
    expect(provider.resolveCompoundActionCalls).toHaveLength(0);
    expect(provider.advanceStepCalls).toHaveLength(1);
  });
});

// ─── AC-4: precondition-failure abort ────────────────────────────────────────

describe('ExecuteServiceImpl precondition-failure abort (AC-4)', () => {
  let provider: FakeExecuteDataProvider;

  beforeEach(() => {
    provider = new FakeExecuteDataProvider();
    // Sub-step 2 of 3 fails its precondition check.
    provider.preconditionResults = {
      brew_coffee: { satisfied: false, failed: ['has_water'] },
    };
  });

  it('aborts at the failed sub-step, does not execute remaining sub-steps, and does not advance the plan (AC-4)', async () => {
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.planComplete).toBe(false);
    // Sub-step 1 executed; sub-step 3 never attempted.
    expect(provider.executeAffordanceCalls.map((c) => c.affordanceId)).toEqual(['add_water']);
    expect(provider.checkPreconditionsCalls.map((c) => c.affordanceId)).toEqual([
      'add_water',
      'brew_coffee',
    ]);
    // The plan step was not advanced — the compound step remains current.
    expect(provider.advanceStepCalls).toHaveLength(0);
  });

  it('sets system feedback naming the compound action and the failed sub-step (AC-4)', async () => {
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    await service.execute(AGENT_ID);

    expect(provider.setSystemFeedbackCalls).toHaveLength(1);
    expect(provider.setSystemFeedbackCalls[0]?.feedback).toBe(
      "Compound action 'brew_coffee_sequence' aborted at step 2/3 ('brew_coffee'): preconditions not met: has_water.",
    );
  });

  it('returns failure with the same reason in error and resets isThinking (AC-4)', async () => {
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain('preconditions not met: has_water');
    expect(result.planComplete).toBe(false);
    expect(provider.setThinkingCalls).toContainEqual({ agentId: AGENT_ID, isThinking: false });
    expect(provider.agentState?.isThinking).toBe(false);
  });

  it('does not apply any drive changes on abort (AC-4, Req 5/6)', async () => {
    provider.executionResults = {
      add_water: { success: true, driveChanges: { energy: 10 } },
    };
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    await service.execute(AGENT_ID);

    // Drive changes are all-or-nothing: nothing applied on abort.
    expect(provider.applyDriveChangesCalls).toHaveLength(0);
  });
});

// ─── AC-5: execution-failure abort ───────────────────────────────────────────

describe('ExecuteServiceImpl execution-failure abort (AC-5)', () => {
  let provider: FakeExecuteDataProvider;

  beforeEach(() => {
    provider = new FakeExecuteDataProvider();
    // Sub-step 2's execution fails.
    provider.executionResults = {
      add_water: { success: true, driveChanges: { energy: 10 } },
      brew_coffee: { success: false, failureReason: 'Machine is broken' },
    };
  });

  it('aborts when a sub-step execution returns success=false; remaining sub-steps are not attempted (AC-5)', async () => {
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.planComplete).toBe(false);
    // Sub-steps 1 and 2 were attempted (2 failed); sub-step 3 never attempted.
    expect(provider.executeAffordanceCalls.map((c) => c.affordanceId)).toEqual([
      'add_water',
      'brew_coffee',
    ]);
    expect(provider.advanceStepCalls).toHaveLength(0);
    expect(provider.applyDriveChangesCalls).toHaveLength(0);
  });

  it('sets system feedback containing the sub-step failureReason and the compound identity (AC-5)', async () => {
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    await service.execute(AGENT_ID);

    expect(provider.setSystemFeedbackCalls).toHaveLength(1);
    const feedback = provider.setSystemFeedbackCalls[0]?.feedback ?? '';
    expect(feedback).toContain("Compound action 'brew_coffee_sequence'");
    expect(feedback).toContain("step 2/3 ('brew_coffee')");
    expect(feedback).toContain('Machine is broken');
  });

  it('returns failure with the failureReason in error and resets isThinking (AC-5)', async () => {
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Machine is broken');
    expect(result.planComplete).toBe(false);
    expect(provider.setThinkingCalls).toContainEqual({ agentId: AGENT_ID, isThinking: false });
    expect(provider.agentState?.isThinking).toBe(false);
  });

  it('aborts when a sub-step execution throws — caught by the top-level try/catch (AC-5, Req 7)', async () => {
    provider.executionThrows = { brew_coffee: new Error('Physics exploded') };
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Physics exploded');
    expect(result.planComplete).toBe(false);
    expect(provider.setThinkingCalls).toContainEqual({ agentId: AGENT_ID, isThinking: false });
    expect(provider.agentState?.isThinking).toBe(false);
    // Sub-steps 1 and 2 were attempted (2 threw); sub-step 3 never attempted.
    expect(provider.executeAffordanceCalls.map((c) => c.affordanceId)).toEqual([
      'add_water',
      'brew_coffee',
    ]);
    expect(provider.advanceStepCalls).toHaveLength(0);
    expect(provider.applyDriveChangesCalls).toHaveLength(0);
  });
});

// ─── AC-6: skip fallback for unresolvable targets ────────────────────────────

describe('ExecuteServiceImpl skip fallback (AC-6)', () => {
  let provider: FakeExecuteDataProvider;

  beforeEach(() => {
    provider = new FakeExecuteDataProvider();
    // The target resolves as neither a plain affordance nor a compound action.
    provider.currentStep = {
      description: 'Do a mysterious thing',
      targetAffordance: 'teleport',
      completed: false,
    };
  });

  it('skips the step with the existing feedback and stepSkipped=true (AC-6)', async () => {
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.stepSkipped).toBe(true);
    expect(provider.setSystemFeedbackCalls).toHaveLength(1);
    expect(provider.setSystemFeedbackCalls[0]?.feedback).toContain('teleport');
    expect(provider.setSystemFeedbackCalls[0]?.feedback).toContain('not found in room');
    // The plan advanced (skip behavior), nothing executed.
    expect(provider.advanceStepCalls).toHaveLength(1);
    expect(provider.executeAffordanceCalls).toHaveLength(0);
    expect(provider.applyDriveChangesCalls).toHaveLength(0);
  });

  it('resolves as a compound action when one exists — skip is not used (AC-6)', async () => {
    provider.currentStep = makeCompoundPlan().steps[0]!;
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.stepSkipped).toBeUndefined();
    expect(provider.executeAffordanceCalls.length).toBe(3);
  });
});

// ─── AC-7: backward compatibility — provider without resolveCompoundAction ───

describe('ExecuteServiceImpl backward compatibility (AC-7)', () => {
  let provider: FakeExecuteDataProvider;

  beforeEach(() => {
    provider = new FakeExecuteDataProvider();
  });

  it('behaves identically to pre-change for resolvable plain affordances (AC-7)', async () => {
    delete provider.resolveCompoundAction;
    provider.currentStep = {
      description: 'Brew coffee',
      targetAffordance: 'brew_coffee',
      completed: false,
    };
    provider.plainAffordances['brew_coffee'] = brewCoffee;
    provider.executionResults = { brew_coffee: { success: true, driveChanges: { energy: 20 } } };
    provider.isPlanCompleteFn = () => provider.advanceStepCalls.length > 0;

    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ success: true, driveChanges: { energy: 20 } });
    expect(result.planComplete).toBe(true);
    expect(provider.applyDriveChangesCalls).toHaveLength(1);
    expect(provider.advanceStepCalls).toHaveLength(1);
    expect(provider.setSystemFeedbackCalls).toHaveLength(0);
  });

  it('behaves identically to pre-change for unresolvable targets — skip with feedback (AC-7)', async () => {
    delete provider.resolveCompoundAction;
    provider.currentStep = {
      description: 'Do a mysterious thing',
      targetAffordance: 'teleport',
      completed: false,
    };
    provider.isPlanCompleteFn = () => provider.advanceStepCalls.length > 0;

    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.stepSkipped).toBe(true);
    expect(provider.setSystemFeedbackCalls).toHaveLength(1);
    expect(provider.setSystemFeedbackCalls[0]?.feedback).toContain(
      "affordance 'teleport' not found in room",
    );
    expect(provider.advanceStepCalls).toHaveLength(1);
  });

  it('falls back to skip when resolveCompoundAction is defined but returns null (AC-6, AC-7)', async () => {
    provider.currentStep = {
      description: 'Do a mysterious thing',
      targetAffordance: 'teleport',
      completed: false,
    };
    provider.isPlanCompleteFn = () => provider.advanceStepCalls.length > 0;

    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.stepSkipped).toBe(true);
    // Compound resolution was attempted before skipping.
    expect(provider.resolveCompoundActionCalls).toEqual([
      { roomId: ROOM_ID, compoundActionId: 'teleport' },
    ]);
  });
});

// ─── AC-8: nested compound actions are not supported ─────────────────────────

describe('ExecuteServiceImpl nested compound actions (AC-8)', () => {
  let provider: FakeExecuteDataProvider;

  beforeEach(() => {
    provider = new FakeExecuteDataProvider();
    // The plan targets a compound whose only sub-step is itself a compound ID.
    provider.currentStep = {
      description: 'Run the super sequence',
      targetAffordance: 'super_sequence',
      completed: false,
    };
  });

  it('aborts with a clear failure message and does not recurse (AC-8)', async () => {
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.planComplete).toBe(false);
    // No sub-steps of the nested compound were executed.
    expect(provider.executeAffordanceCalls).toHaveLength(0);
    expect(provider.advanceStepCalls).toHaveLength(0);
    expect(provider.applyDriveChangesCalls).toHaveLength(0);
    // The failure message names the outer compound, the offending sub-step, and the reason.
    const feedback = provider.setSystemFeedbackCalls[0]?.feedback ?? '';
    expect(feedback).toContain("Compound action 'super_sequence'");
    expect(feedback).toContain("step 1/1 ('brew_coffee_sequence')");
    expect(feedback).toContain('nested compound');
    expect(provider.setThinkingCalls).toContainEqual({ agentId: AGENT_ID, isThinking: false });
  });

  it('does not recurse into compound resolution beyond the nested detection (AC-8)', async () => {
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    await service.execute(AGENT_ID);

    // One call for the plan step target, one for the nested sub-step check — no deeper.
    expect(provider.resolveCompoundActionCalls).toEqual([
      { roomId: ROOM_ID, compoundActionId: 'super_sequence' },
      { roomId: ROOM_ID, compoundActionId: 'brew_coffee_sequence' },
    ]);
  });
});
