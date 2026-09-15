/**
 * Spec 059 — Plan-Retention Re-Validation (issue #210) — Execute phase.
 *
 * AC-4 (R3): a stale-target rejection with `invalidatePlan` wired calls it
 * exactly once, returns `deviationRejected: true` + `planInvalidated: true`,
 * does not advance the step, and leaves `currentPlan === null`; a subsequent
 * `PlanService.plan()` does not return the invalidated plan and invokes the
 * LLM for a fresh formulation (stickiness bypassed).
 *
 * AC-6 (R3): with `invalidatePlan` unwired, a stale-target rejection does not
 * clear the plan, carries no `planInvalidated`, and falls through to R4.
 *
 * AC-7 (R4): guardrail deviations join the spec-037 step-skip guard — two
 * consecutive rejections of the same step advance it with `stepSkipped: true`
 * and a `[step-skip]` line; the counter resets on step change / success.
 *
 * AC-8 (R5): one `[plan-stale]` line per invalidation; a thrown diagnostic
 * never propagates; the `[execute]` line names the invalidated plan.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type {
  Affordance,
  AffordanceResult,
  AgentInternalState,
  AgentPlan,
  ExecuteDataProvider,
  FormulatePlanResult,
  LLMClient,
  LLMContextPayload,
  LLMActionResponse,
  PerceptionResult,
  PlanStep,
  TopologyGuard,
} from '@evol-hive/shared';
import { ExecuteServiceImpl } from '../src/pper/execute-service.js';
import { GuardrailEngineImpl } from '../src/guardrails/index.js';
import { PlanServiceImpl } from '../src/pper/plan-service.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';

const AGENT_ID = 'iris-1';
const ROOM = 'garden';

const GUARDRAIL_CONFIG = {
  affordanceMasking: true,
  contextualForcing: true,
  planValidation: true,
};

/** A 3-step plan whose current step (index 2) targets an affordance. */
function makePlan(target = 'water_plants'): AgentPlan {
  return {
    id: 'plan_iris-1_150.6_40',
    description: 'Water the greenhouse',
    steps: [
      { description: 'Walk', completed: true, targetAffordance: 'go_to_greenhouse' },
      { description: 'Prepare', completed: true, targetAffordance: 'prepare' },
      { description: 'Water', completed: false, targetAffordance: target },
    ],
    currentStepIndex: 2,
    createdAt: 150.6,
  };
}

/**
 * Fake ExecuteDataProvider with a mutable plan cursor. The base omits
 * `invalidatePlan` (legacy provider); {@link WiredProvider} adds it and
 * clears the plan exactly like the engine's `PlanManagerImpl`.
 */
class BaseProvider implements ExecuteDataProvider {
  plan: AgentPlan | null = makePlan();
  preconditionResult: { satisfied: boolean; failed: string[] } = { satisfied: true, failed: [] };
  affordanceResult: AffordanceResult = { success: true, driveChanges: { curiosity: 5 } };
  advanceStepCalls: string[] = [];
  setSystemFeedbackCalls: { agentId: string; feedback: string }[] = [];
  setThinkingCalls: { agentId: string; isThinking: boolean }[] = [];
  storePlanCalls: string[] = [];

  getAgentState(agentId: string): AgentInternalState | null {
    return {
      agentId,
      drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
      currentGoal: 'water the plants',
      currentPlan: this.plan,
      isThinking: true,
      location: ROOM,
      lastPerceptionTick: 0,
    };
  }
  getCurrentStep(): PlanStep | null {
    if (this.plan === null) return null;
    return this.plan.steps[this.plan.currentStepIndex] ?? null;
  }
  isPlanComplete(): boolean {
    return this.plan === null || this.plan.currentStepIndex >= this.plan.steps.length;
  }
  resolveAffordance(
    _roomId: string,
    affordanceId: string,
  ): { objectId: string; affordance: Affordance } | null {
    return {
      objectId: 'obj-1',
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
    return this.preconditionResult;
  }
  async executeAffordance(): Promise<AffordanceResult> {
    return this.affordanceResult;
  }
  advanceStep(agentId: string): void {
    this.advanceStepCalls.push(agentId);
    if (this.plan !== null) this.plan.currentStepIndex += 1;
  }
  applyDriveChanges(): void {}
  setSystemFeedback(agentId: string, feedback: string): void {
    this.setSystemFeedbackCalls.push({ agentId, feedback });
  }
  setThinking(agentId: string, isThinking: boolean): void {
    this.setThinkingCalls.push({ agentId, isThinking });
  }
  storePlan(_agentId: string, result: FormulatePlanResult): AgentPlan {
    this.storePlanCalls.push(result.description);
    this.plan = {
      id: 'plan_fresh_1',
      description: result.description,
      steps: result.steps.map((step) => {
        const planStep: PlanStep = { description: step.description, completed: false };
        if (step.targetAffordance !== undefined) planStep.targetAffordance = step.targetAffordance;
        return planStep;
      }),
      currentStepIndex: 0,
      createdAt: 1,
    };
    return this.plan;
  }
}

class WiredProvider extends BaseProvider {
  invalidateCalls: string[] = [];
  invalidatePlan(agentId: string): void {
    this.invalidateCalls.push(agentId);
    this.plan = null;
  }
}

const staleGuard = (): GuardrailEngineImpl =>
  new GuardrailEngineImpl(GUARDRAIL_CONFIG);

// ── AC-4/AC-6 — invalidation on a stale-target rejection (R3) ────────────────

describe('spec 059 AC-4: stale-target rejection invalidates the in-flight plan (R3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls invalidatePlan once, returns deviationRejected + planInvalidated, no advance, plan cleared', async () => {
    const provider = new WiredProvider();
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail: staleGuard(),
      affordanceGuard: {
        isAffordanceAvailableInRoom: () => true,
        isAffordanceEligibleForAgent: () => false,
      },
    });

    const result = await service.execute(AGENT_ID);

    expect(provider.invalidateCalls).toEqual([AGENT_ID]);
    expect(result.deviationRejected).toBe(true);
    expect(result.planInvalidated).toBe(true);
    expect(result.success).toBe(false);
    expect(result.planComplete).toBe(false);
    expect(provider.advanceStepCalls).toEqual([]);
    expect(provider.plan).toBeNull();
  });

  it('sets system feedback to the rejection reason and unfreezes the agent', async () => {
    const provider = new WiredProvider();
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail: staleGuard(),
      affordanceGuard: {
        isAffordanceAvailableInRoom: () => true,
        isAffordanceEligibleForAgent: () => false,
      },
    });

    await service.execute(AGENT_ID);

    expect(provider.setSystemFeedbackCalls).toHaveLength(1);
    expect(provider.setSystemFeedbackCalls[0]!.feedback).toContain('stale');
    expect(provider.setThinkingCalls).toEqual([{ agentId: AGENT_ID, isThinking: false }]);
  });

  it('a subsequent PlanService.plan() bypasses stickiness and invokes the LLM for a fresh plan', async () => {
    const provider = new WiredProvider();
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail: staleGuard(),
      affordanceGuard: {
        isAffordanceAvailableInRoom: () => true,
        isAffordanceEligibleForAgent: () => false,
      },
    });

    await service.execute(AGENT_ID);
    expect(provider.plan).toBeNull();

    const completePlan = vi.fn(
      async (): Promise<{ description: string; steps: { description: string; targetAffordance?: string }[] }> => ({
        description: 'Fresh plan',
        steps: [{ description: 'Rest', targetAffordance: 'rest' }],
      }),
    );
    const llmClient: LLMClient = {
      async completeStructured(_payload: LLMContextPayload): Promise<LLMActionResponse> {
        return { reasoning: '', action: 'wait' };
      },
      async completeReflection() {
        return { agentId: AGENT_ID, newMemories: [], consolidatedNodeIds: [] };
      },
      completePlan,
      async completeReflect() {
        return {};
      },
    };
    const planService = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient,
      dataProvider: provider,
    });

    const result = await planService.plan(AGENT_ID, makePerception());

    expect(completePlan).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.plan?.id).not.toBe('plan_iris-1_150.6_40');
    expect(result.plan?.description).toBe('Fresh plan');
  });
});

describe('spec 059 AC-6: unwired invalidatePlan falls through to R4 (R3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a stale-target rejection does not clear the plan and carries no planInvalidated', async () => {
    const provider = new BaseProvider(); // no invalidatePlan
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail: staleGuard(),
      affordanceGuard: {
        isAffordanceAvailableInRoom: () => true,
        isAffordanceEligibleForAgent: () => false,
      },
    });

    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.deviationRejected).toBe(true);
    expect(result.planInvalidated).toBeUndefined();
    expect(provider.plan).not.toBeNull();
    expect(provider.advanceStepCalls).toEqual([]); // R4: first offence — no skip yet
  });

  it('a legacy guard (no agent-scoped method) still rejects and falls through to R4', async () => {
    const provider = new BaseProvider();
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail: staleGuard(),
      affordanceGuard: { isAffordanceAvailableInRoom: () => false },
    });

    const result = await service.execute(AGENT_ID);

    expect(result.deviationRejected).toBe(true);
    expect(result.planInvalidated).toBeUndefined();
    expect(provider.plan).not.toBeNull();
  });
});

// ── AC-7 — guardrail deviations join the step-skip guard (R4) ────────────────

describe('spec 059 AC-7: guardrail deviations join the step-skip guard (R4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('movement-blocked: first rejection does not advance, second advances with stepSkipped + [step-skip]', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.map(String).join(' '));
    });
    const provider = new WiredProvider();
    provider.plan = makePlan('go_to_workshop');
    const topologyGuard: TopologyGuard = { isMovementBlocked: () => true };
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail: new GuardrailEngineImpl({ config: GUARDRAIL_CONFIG, topologyGuard }),
    });

    const first = await service.execute(AGENT_ID);
    expect(first.success).toBe(false);
    expect(first.deviationRejected).toBe(true);
    expect(provider.advanceStepCalls).toEqual([]);

    const second = await service.execute(AGENT_ID);
    expect(second.success).toBe(true);
    expect(second.stepSkipped).toBe(true);
    expect(provider.advanceStepCalls).toEqual([AGENT_ID]);
    expect(errors.some((l) => l.includes('[step-skip]'))).toBe(true);
  });

  it('generic deviation: two consecutive rejections advance the step', async () => {
    const provider = new BaseProvider();
    // The plan's current step binds 'sleep'; the executed step targets
    // 'brew_coffee' — the plan-alignment branch rejects as a deviation.
    provider.plan = makePlan('sleep');
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail: staleGuard(),
    });
    provider.getCurrentStep = () => ({
      description: 'Brew',
      completed: false,
      targetAffordance: 'brew_coffee',
    });

    const first = await service.execute(AGENT_ID);
    expect(first.success).toBe(false);
    expect(first.deviationRejected).toBe(true);
    expect(provider.advanceStepCalls).toEqual([]);

    const second = await service.execute(AGENT_ID);
    expect(second.success).toBe(true);
    expect(second.stepSkipped).toBe(true);
    expect(provider.advanceStepCalls).toEqual([AGENT_ID]);
  });

  it('counter resets on step change (a different step gets its own attempts)', async () => {
    const provider = new BaseProvider();
    provider.plan = makePlan();
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail: staleGuard(),
    });
    // Rejection via a mismatched plan binding, with a mutable current step.
    const stepA: PlanStep = { description: 'A', completed: false, targetAffordance: 'a' };
    const stepB: PlanStep = { description: 'B', completed: false, targetAffordance: 'b' };
    let current = stepA;
    provider.getCurrentStep = () => current;
    provider.plan = makePlan('never-matches');

    await service.execute(AGENT_ID); // A failure 1
    current = stepB;
    await service.execute(AGENT_ID); // B failure 1 — resets A's counter
    current = stepA;
    const r = await service.execute(AGENT_ID); // A failure 2? counter was reset
    expect(r.success).toBe(false);
    expect(r.stepSkipped).toBeUndefined();
    expect(provider.advanceStepCalls).toEqual([]);
  });

  it('a successful step resets the deviation counter', async () => {
    const provider = new BaseProvider();
    provider.plan = makePlan('water_plants');
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail: staleGuard(),
    });
    provider.getCurrentStep = () => ({
      description: 'Water',
      completed: false,
      targetAffordance: 'water_plants',
    });

    // Success (binding matches) — no counter state.
    const ok = await service.execute(AGENT_ID);
    expect(ok.success).toBe(true);
    expect(ok.stepSkipped).toBeUndefined();
    provider.advanceStepCalls.length = 0;

    // Now a mismatch: first offence must not skip.
    provider.getCurrentStep = () => ({
      description: 'Brew',
      completed: false,
      targetAffordance: 'brew_coffee',
    });
    provider.plan = makePlan('water_plants');
    const first = await service.execute(AGENT_ID);
    expect(first.success).toBe(false);
    expect(provider.advanceStepCalls).toEqual([]);
    const second = await service.execute(AGENT_ID);
    expect(second.stepSkipped).toBe(true);
    expect(provider.advanceStepCalls).toEqual([AGENT_ID]);
  });

  it('MAX_STEP_FAILURES is still 2 (second offence skips, first does not)', async () => {
    const provider = new BaseProvider();
    provider.plan = makePlan('water_plants');
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail: staleGuard(),
    });
    provider.getCurrentStep = () => ({
      description: 'Brew',
      completed: false,
      targetAffordance: 'brew_coffee',
    });
    // Override the plan's current step so validateAction rejects (deviation).
    const first = await service.execute(AGENT_ID);
    expect(first.deviationRejected).toBe(true);
    const second = await service.execute(AGENT_ID);
    expect(second.stepSkipped).toBe(true);
  });
});

// ── AC-8 — the [plan-stale] diagnostic (R5) ──────────────────────────────────

describe('spec 059 AC-8: [plan-stale] diagnostic (R5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function staleLines(errors: string[]): string[] {
    return errors.filter((l) => l.includes('[plan-stale]'));
  }

  it('emits exactly one line with agent id, plan id, step=i/N and the target', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.map(String).join(' '));
    });
    const provider = new WiredProvider();
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail: staleGuard(),
      affordanceGuard: {
        isAffordanceAvailableInRoom: () => true,
        isAffordanceEligibleForAgent: () => false,
      },
    });

    await service.execute(AGENT_ID);

    const lines = staleLines(errors);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`agent=${AGENT_ID}`);
    expect(lines[0]).toContain('plan=plan_iris-1_150.6_40');
    expect(lines[0]).toContain('step=3/3');
    expect(lines[0]).toContain("target='water_plants'");
    expect(lines[0]).toContain('not in eligible set');
  });

  it('the [execute] line names the invalidated plan (snapshot taken before invalidation)', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.map(String).join(' '));
    });
    const provider = new WiredProvider();
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail: staleGuard(),
      affordanceGuard: {
        isAffordanceAvailableInRoom: () => true,
        isAffordanceEligibleForAgent: () => false,
      },
    });

    await service.execute(AGENT_ID);

    const executeLine = errors.find((l) => l.startsWith('[execute]'));
    expect(executeLine).toContain('plan=plan_iris-1_150.6_40');
    expect(executeLine).not.toContain('plan=none');
  });

  it('a thrown diagnostic never propagates', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('stderr exploded');
    });
    const provider = new WiredProvider();
    const service = new ExecuteServiceImpl({
      dataProvider: provider,
      guardrail: staleGuard(),
      affordanceGuard: {
        isAffordanceAvailableInRoom: () => true,
        isAffordanceEligibleForAgent: () => false,
      },
    });

    await expect(service.execute(AGENT_ID)).resolves.toMatchObject({
      deviationRejected: true,
      planInvalidated: true,
    });
  });
});

// ── Fixture: minimal perception for the PlanService AC-4 check ───────────────

function makePerception(): PerceptionResult {
  return {
    passive: {
      roomId: ROOM,
      objectsPresent: [],
      drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    },
    prunedAffordances: [
      {
        id: 'rest',
        label: 'Rest',
        engineEffect: 'rest',
        preconditions: [],
        effects: {},
      },
    ],
    primaryDriveLabel: 'low energy, need to restore energy',
  };
}
