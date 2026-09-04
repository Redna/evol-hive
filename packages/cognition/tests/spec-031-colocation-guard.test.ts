/**
 * Tests for spec 031 — Execute-Time Co-Location Guard & Stale Plan Re-Validation
 * (issue #121) — cognition layer.
 *
 * Covers:
 * - AC-3 (Req 4): a co-location failure flows into the action feedback loop —
 *   system feedback + isThinking(false) + { success: false, planComplete: false },
 *   no step advance, stepSkipped unset. The skip path for unresolvable
 *   affordances is NOT reachable for co-location failures.
 * - AC-4 (Req 3, 4): a mid-compound relocation aborts the compound at that
 *   sub-step with the compound-aware co-location message; no drive changes,
 *   no plan advance, remaining sub-steps not attempted.
 * - AC-6 (Req 5, 6): validateAction rejects stale steps via the context's
 *   affordanceGuard; ExecuteServiceImpl surfaces deviationRejected.
 * - AC-7 (Req 6): an available affordance is not rejected on this dimension.
 * - AC-8 (Req 6): cognitive tools and movement actions are never rejected by
 *   the affordance guard; movement gating stays TopologyGuard-only.
 * - AC-9 (Req 7): rejection is advisory-grade — no plan mutation.
 * - AC-11 (Req 9): topology-parity regression (spec 030 Req 10 unchanged).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Affordance,
  AffordanceResult,
  AgentInternalState,
  AgentPlan,
  CompoundAction,
  ExecuteDataProvider,
  PlanStep,
  TopologyGuard,
  AffordanceGuard,
} from '@evol-hive/shared';
import { ExecuteServiceImpl } from '../src/pper/execute-service.js';
import { GuardrailEngineImpl } from '../src/guardrails/index.js';
import type { GuardrailConfig } from '@evol-hive/shared';

const AGENT_ID = 'gardener-1';
const GARDEN = 'garden';
const WORKSHOP = 'workshop';

const COLOCATION_REASON = 'The Toolbox (toolbox-1) is no longer here — it moved to the workshop.';

const takeTool: Affordance = {
  id: 'take_tool',
  label: 'Take the tool',
  engineEffect: 'take_tool',
  preconditions: [],
  effects: {},
};

const tightenBolt: Affordance = {
  id: 'tighten_bolt',
  label: 'Tighten the bolt',
  engineEffect: 'tighten_bolt',
  preconditions: [],
  effects: {},
};

const repairCompound: CompoundAction = {
  id: 'repair_sequence',
  label: 'Repair the fence',
  steps: [
    { affordanceId: 'take_tool', description: 'Take the tool' },
    { affordanceId: 'tighten_bolt', description: 'Tighten the bolt' },
  ],
};

function makeAgentState(overrides: Partial<AgentInternalState> = {}): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    currentGoal: 'fix the fence',
    currentPlan: null,
    isThinking: false,
    location: GARDEN,
    lastPerceptionTick: 0,
    ...overrides,
  };
}

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    description: 'Take the tool',
    completed: false,
    targetAffordance: 'take_tool',
    ...overrides,
  };
}

function makePlan(targetAffordance = 'take_tool'): AgentPlan {
  return {
    id: 'plan-1',
    description: 'Fix the fence',
    steps: [{ description: 'Take the tool', completed: false, targetAffordance }],
    currentStepIndex: 0,
    createdAt: 0,
  };
}

/**
 * Fake ExecuteDataProvider with spec-031 knobs: `resolveAffordanceAnywhere`
 * (the optional global lookup) and a mid-compound `moved` flag that simulates
 * the world changing between sub-steps.
 */
class FakeExecuteDataProvider implements ExecuteDataProvider {
  agentState: AgentInternalState | null = makeAgentState();
  currentStep: PlanStep | null = makeStep();
  planComplete = false;
  /** Resolution template: objectId + affordance shape returned for room-scoped hits. */
  resolvedAffordance: { objectId: string; affordance: Affordance } | null = {
    objectId: 'toolbox-1',
    affordance: takeTool,
  };
  /** Affordance IDs currently resolvable in the agent's room (live view). */
  roomAffordanceIds: Set<string> = new Set(['take_tool']);
  compoundAction: { objectId: string; compoundAction: CompoundAction } | null = null;
  preconditionResult: { satisfied: boolean; failed: string[] } = { satisfied: true, failed: [] };
  affordanceResult: AffordanceResult = { success: true, driveChanges: { energy: 5 } };
  /** Global (any-room) lookup result — `undefined` = provider without the method. */
  anywhereResult: { objectId: string; objectName: string; roomId: string } | null = null;
  /** When true, room-scoped resolution fails (the object left the room). */
  moved = false;
  /** When true, executeAffordance simulates a mid-compound move after the first sub-step. */
  moveAfterFirstExecution = false;

  getAgentStateCalls: string[] = [];
  advanceStepCalls: string[] = [];
  applyDriveChangesCalls: { agentId: string; changes: Partial<Record<string, number>> }[] = [];
  setSystemFeedbackCalls: { agentId: string; feedback: string }[] = [];
  setThinkingCalls: { agentId: string; isThinking: boolean }[] = [];
  executeAffordanceCalls: { objectId: string; affordanceId: string; agentId: string }[] = [];

  getAgentState(agentId: string): AgentInternalState | null {
    this.getAgentStateCalls.push(agentId);
    return this.agentState;
  }
  getCurrentStep(agentId: string): PlanStep | null {
    void agentId;
    return this.currentStep;
  }
  isPlanComplete(agentId: string): boolean {
    void agentId;
    return this.planComplete;
  }
  resolveAffordance(
    roomId: string,
    affordanceId: string,
  ): { objectId: string; affordance: Affordance } | null {
    void roomId;
    if (this.moved || this.resolvedAffordance === null) return null;
    if (!this.roomAffordanceIds.has(affordanceId)) return null;
    return {
      objectId: this.resolvedAffordance.objectId,
      affordance: { ...this.resolvedAffordance.affordance, id: affordanceId },
    };
  }
  resolveCompoundAction(
    roomId: string,
    compoundActionId: string,
  ): { objectId: string; compoundAction: CompoundAction } | null {
    void roomId;
    void compoundActionId;
    return this.moved ? null : this.compoundAction;
  }
  resolveAffordanceAnywhere(
    affordanceId: string,
  ): { objectId: string; objectName: string; roomId: string } | null {
    void affordanceId;
    return this.anywhereResult;
  }
  checkPreconditions(
    affordanceId: string,
    objectId: string,
  ): { satisfied: boolean; failed: string[] } {
    void affordanceId;
    void objectId;
    return this.preconditionResult;
  }
  async executeAffordance(
    objectId: string,
    affordanceId: string,
    agentId: string,
  ): Promise<AffordanceResult> {
    this.executeAffordanceCalls.push({ objectId, affordanceId, agentId });
    // Simulate a mid-compound move_object mutation: after the first sub-step
    // runs, the object is no longer in the agent's room.
    if (this.moveAfterFirstExecution && this.executeAffordanceCalls.length === 1) {
      this.moved = true;
    }
    return this.affordanceResult;
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
  }
}

const GUARDRAIL_CONFIG: GuardrailConfig = {
  affordanceMasking: true,
  contextualForcing: true,
  planValidation: true,
};

// ── AC-3 — plain-path co-location failure (Req 4) ────────────────────────────

describe('ExecuteServiceImpl co-location failure (spec 031, Req 4 — AC-3)', () => {
  let provider: FakeExecuteDataProvider;
  let service: ExecuteServiceImpl;

  beforeEach(() => {
    provider = new FakeExecuteDataProvider();
    provider.roomAffordanceIds = new Set(); // room-scoped resolution fails…
    provider.anywhereResult = {
      objectId: 'toolbox-1',
      objectName: 'Toolbox',
      roomId: WORKSHOP, // …because the object is now in the workshop
    };
    provider.compoundAction = null;
    provider.agentState = makeAgentState({ currentPlan: makePlan() });
    service = new ExecuteServiceImpl({ dataProvider: provider });
  });

  it('returns { success: false, planComplete: false } with the co-location failureReason and no stepSkipped', async () => {
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe(COLOCATION_REASON);
    expect(result.planComplete).toBe(false);
    expect(result.stepSkipped).toBeUndefined();
  });

  it('sets system feedback to the failureReason and unfreezes the agent (isThinking false)', async () => {
    await service.execute(AGENT_ID);

    expect(provider.setSystemFeedbackCalls).toEqual([
      { agentId: AGENT_ID, feedback: COLOCATION_REASON },
    ]);
    expect(provider.setThinkingCalls).toEqual([{ agentId: AGENT_ID, isThinking: false }]);
  });

  it('does not advance the plan step', async () => {
    await service.execute(AGENT_ID);
    expect(provider.advanceStepCalls).toEqual([]);
  });

  it('skip path stays reachable for truly-unresolvable affordances (not a co-location failure)', async () => {
    provider.anywhereResult = null; // the affordance exists nowhere
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.stepSkipped).toBe(true);
    expect(provider.advanceStepCalls).toHaveLength(1);
  });

  it('compound fallback runs before the skip path when the compound is still in the room', async () => {
    // Compound still present: roomAffordanceIds empty, compound resolvable.
    provider.roomAffordanceIds = new Set(['take_tool', 'tighten_bolt']);
    provider.moved = false;
    provider.currentStep = makeStep({ targetAffordance: 'repair_sequence' });
    provider.compoundAction = { objectId: 'toolbox-1', compoundAction: repairCompound };
    provider.anywhereResult = null;
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(provider.executeAffordanceCalls).toHaveLength(2);
    expect(provider.advanceStepCalls).toEqual([AGENT_ID]);
  });
});

// ── AC-4 — compound abort on mid-compound relocation (Req 3, 4) ──────────────

describe('Compound action aborts on mid-compound co-location failure (spec 031, Req 3/4 — AC-4)', () => {
  let provider: FakeExecuteDataProvider;
  let service: ExecuteServiceImpl;

  beforeEach(() => {
    provider = new FakeExecuteDataProvider();
    // The compound step target does NOT resolve room-scoped (it is a
    // compound, not a plain affordance); its sub-steps do — until the
    // mid-compound mutation moves the owning object.
    provider.roomAffordanceIds = new Set(['take_tool', 'tighten_bolt']);
    provider.currentStep = makeStep({ targetAffordance: 'repair_sequence' });
    provider.compoundAction = { objectId: 'toolbox-1', compoundAction: repairCompound };
    // Sub-step 1 resolves while the object is still here (moved flips to true
    // after the first executeAffordance call — the mid-compound mutation).
    provider.moved = false;
    provider.anywhereResult = {
      objectId: 'toolbox-1',
      objectName: 'Toolbox',
      roomId: WORKSHOP,
    };
    provider.agentState = makeAgentState({ currentPlan: makePlan('repair_sequence') });
    // The world moves mid-compound: after sub-step 1 executes, the owning
    // object is relocated to the workshop.
    provider.moveAfterFirstExecution = true;
    service = new ExecuteServiceImpl({ dataProvider: provider });
  });

  it('aborts at the moved sub-step with the compound-aware co-location message', async () => {
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.planComplete).toBe(false);
    expect(result.error).toBe(
      "Compound action 'repair_sequence' aborted at step 2/2 ('tighten_bolt'): " +
        'The Toolbox (toolbox-1) is no longer here — it moved to the workshop.',
    );
    expect(provider.setSystemFeedbackCalls).toEqual([
      {
        agentId: AGENT_ID,
        feedback:
          "Compound action 'repair_sequence' aborted at step 2/2 ('tighten_bolt'): " +
          'The Toolbox (toolbox-1) is no longer here — it moved to the workshop.',
      },
    ]);
    expect(provider.setThinkingCalls).toEqual([{ agentId: AGENT_ID, isThinking: false }]);
  });

  it('does not attempt remaining sub-steps, apply drive changes, or advance the plan step', async () => {
    await service.execute(AGENT_ID);

    // Exactly one sub-step executed (the first); the second never ran.
    expect(provider.executeAffordanceCalls).toHaveLength(1);
    // Sub-step 1's drive changes were accumulated but NOT applied.
    expect(provider.applyDriveChangesCalls).toEqual([]);
    // The plan step is not advanced.
    expect(provider.advanceStepCalls).toEqual([]);
  });
});

// ── AC-6 — plan-time stale-step validation (Req 5, 6) ────────────────────────

describe('GuardrailEngineImpl affordanceGuard validation (spec 031, Req 6 — AC-6, AC-7, AC-8)', () => {
  const plan = makePlan();
  const rejectingGuard: AffordanceGuard = {
    isAffordanceAvailableInRoom: () => false,
  };
  const allowingGuard: AffordanceGuard = {
    isAffordanceAvailableInRoom: () => true,
  };

  it('AC-6: rejects with a stale-plan reason naming the affordance and the room', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const result = engine.validateAction('take_tool', plan, {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
      affordanceGuard: rejectingGuard,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('take_tool');
    expect(result.reason).toContain('garden');
    expect(result.reason).toContain('stale');
  });

  it('AC-6: the reason matches the spec template', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const result = engine.validateAction('take_tool', plan, {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
      affordanceGuard: rejectingGuard,
    });

    expect(result.reason).toBe(
      "The 'take_tool' target is no longer in 'garden'. The plan is stale — reflect and choose a different action.",
    );
  });

  it('AC-7: does not reject when the affordance is still available in the room', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const result = engine.validateAction('take_tool', plan, {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
      affordanceGuard: allowingGuard,
    });

    expect(result.valid).toBe(true);
  });

  it('AC-7: no affordanceGuard in context — existing plan-alignment behavior unchanged', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const result = engine.validateAction('take_tool', plan, {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
    });

    expect(result.valid).toBe(true); // action matches the current step target
  });

  it('AC-8: cognitive tools are never rejected by the affordance guard', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const result = engine.validateAction('formulate_plan', plan, {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
      affordanceGuard: rejectingGuard,
    });

    expect(result.valid).toBe(true);
  });

  it('AC-8: movement actions are never rejected by the affordance guard', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const movementPlan = makePlan('go_to_workshop');
    const result = engine.validateAction('go_to_workshop', movementPlan, {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
      affordanceGuard: rejectingGuard,
    });

    expect(result.valid).toBe(true);
  });

  it('AC-11 (regression): movement gating remains exclusively TopologyGuard — closed connection still rejects go_to_workshop', () => {
    const topologyGuard: TopologyGuard = {
      isMovementBlocked(_agentId, action, fromRoom): boolean {
        return action === 'go_to_workshop' && fromRoom === GARDEN;
      },
    };
    const engine = new GuardrailEngineImpl({ config: GUARDRAIL_CONFIG, topologyGuard });

    const blocked = engine.validateAction('go_to_workshop', makePlan('go_to_workshop'), {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
      affordanceGuard: allowingGuard,
    });
    expect(blocked.valid).toBe(false);
    expect(blocked.reason).toContain('go_to_workshop');
    expect(blocked.reason).toContain('blocked');
  });

  it('AC-9: validateAction does not mutate the plan (advisory-grade, Req 7)', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const planCopy = makePlan();
    const snapshot = JSON.parse(JSON.stringify(planCopy)) as AgentPlan;

    engine.validateAction('take_tool', planCopy, {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
      affordanceGuard: rejectingGuard,
    });

    expect(planCopy).toEqual(snapshot);
    expect(planCopy.currentStepIndex).toBe(0);
    expect(planCopy.steps[0]!.completed).toBe(false);
  });
});

// ── AC-6 (second half) — ExecuteServiceImpl surfaces deviationRejected ───────

describe('ExecuteServiceImpl stale-step rejection via affordanceGuard (spec 031, Req 6 — AC-6)', () => {
  it('returns { success: false, deviationRejected: true } and sets system feedback', async () => {
    const provider = new FakeExecuteDataProvider();
    provider.agentState = makeAgentState({ currentPlan: makePlan() });
    const guardrail = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail,
      affordanceGuard: { isAffordanceAvailableInRoom: () => false },
    });

    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.deviationRejected).toBe(true);
    expect(result.error).toContain('take_tool');
    expect(result.error).toContain('garden');
    expect(provider.setSystemFeedbackCalls).toHaveLength(1);
    expect(provider.setSystemFeedbackCalls[0]!.feedback).toContain('stale');
    expect(provider.advanceStepCalls).toEqual([]);
  });

  it('executes normally when the guard reports the affordance available', async () => {
    const provider = new FakeExecuteDataProvider();
    provider.agentState = makeAgentState({ currentPlan: makePlan() });
    const guardrail = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail,
      affordanceGuard: { isAffordanceAvailableInRoom: () => true },
    });

    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.deviationRejected).toBeUndefined();
    expect(provider.advanceStepCalls).toEqual([AGENT_ID]);
  });
});