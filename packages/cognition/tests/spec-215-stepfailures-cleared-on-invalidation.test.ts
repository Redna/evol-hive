/**
 * Spec 215, item 1 (issue #215) — clear `stepFailures` on the stale-target
 * invalidation path.
 *
 * The step-skip livelock guard keys its deviation counter on the step
 * *description* (`stepKey = step.description`). The spec-059 R3 invalidation
 * path returns early — correctly without *registering* a failure (a stale
 * target is not the agent's fault) — but it used to keep the agent's previous
 * counter entry. A later plan whose current step reuses that description then
 * skipped one attempt early: its first rejection was counted as the second
 * consecutive failure.
 *
 * This test drives the exact sequence:
 *   1. one non-invalidating deviation on step "Water the greenhouse" → count 1
 *   2. a stale-target rejection of the same step → plan invalidated (R3)
 *   3. a NEW plan whose current step reuses the same description → the counter
 *      must be clean, so it gets the FULL two attempts before the skip fires.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type {
  Affordance,
  AffordanceResult,
  AgentInternalState,
  AgentPlan,
  ExecuteDataProvider,
  PlanStep,
} from '@evol-hive/shared';
import { ExecuteServiceImpl } from '../src/pper/execute-service.js';
import { GuardrailEngineImpl } from '../src/guardrails/index.js';

const AGENT_ID = 'iris-1';
const ROOM = 'garden';
const STEP_DESCRIPTION = 'Water the greenhouse';
const STEP_AFFORDANCE = 'water_plants';

const GUARDRAIL_CONFIG = {
  affordanceMasking: true,
  contextualForcing: true,
  planValidation: true,
};

/**
 * A plan whose current step binds a *different* affordance than the step the
 * provider reports, so `GuardrailEngineImpl.validateAction` returns a plain
 * `deviation` (R4 path) whenever the affordance guard says the target is still
 * eligible.
 */
function makeDeviatingPlan(id: string): AgentPlan {
  return {
    id,
    description: 'Water the greenhouse',
    steps: [{ description: STEP_DESCRIPTION, completed: false, targetAffordance: 'never_matches' }],
    currentStepIndex: 0,
    createdAt: 1,
  };
}

/**
 * Fake `ExecuteDataProvider` with a wired `invalidatePlan` (R3 path). The
 * affordance guard's eligibility is driven by `eligible`: `true` → the
 * guardrail falls through to the plan-alignment deviation (R4); `false` → the
 * guardrail rejects with `reasonCode: 'stale-target'` and Execute invalidates
 * the plan.
 */
class FakeProvider implements ExecuteDataProvider {
  plan: AgentPlan | null;
  eligible = true;
  invalidateCalls: string[] = [];
  advanceStepCalls: string[] = [];

  constructor(plan: AgentPlan) {
    this.plan = plan;
  }

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
    return {
      description: STEP_DESCRIPTION,
      completed: false,
      targetAffordance: STEP_AFFORDANCE,
    };
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
    return { satisfied: true, failed: [] };
  }

  async executeAffordance(): Promise<AffordanceResult> {
    return { success: true };
  }

  advanceStep(agentId: string): void {
    this.advanceStepCalls.push(agentId);
    if (this.plan !== null) this.plan.currentStepIndex += 1;
  }

  applyDriveChanges(): void {}

  setSystemFeedback(): void {}

  setThinking(): void {}

  invalidatePlan(agentId: string): void {
    this.invalidateCalls.push(agentId);
    this.plan = null;
  }
}

function makeService(provider: FakeProvider): ExecuteServiceImpl {
  return new ExecuteServiceImpl({
    dataProvider: provider,
    guardrail: new GuardrailEngineImpl(GUARDRAIL_CONFIG),
    affordanceGuard: {
      isAffordanceAvailableInRoom: () => true,
      isAffordanceEligibleForAgent: () => provider.eligible,
    },
  });
}

describe('spec 215: stepFailures are cleared on the invalidation path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a new plan reusing the invalidated step description gets the full two attempts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = new FakeProvider(makeDeviatingPlan('plan_1'));
    const service = makeService(provider);

    // 1. Non-invalidating deviation → counter = 1 for STEP_DESCRIPTION.
    const firstOffence = await service.execute(AGENT_ID);
    expect(firstOffence.deviationRejected).toBe(true);
    expect(firstOffence.planInvalidated).toBeUndefined();
    expect(firstOffence.stepSkipped).toBeUndefined();
    expect(provider.advanceStepCalls).toEqual([]);

    // 2. Same step, now a stale target → plan invalidated (R3), no advance.
    provider.eligible = false;
    const invalidated = await service.execute(AGENT_ID);
    expect(invalidated.planInvalidated).toBe(true);
    expect(provider.invalidateCalls).toEqual([AGENT_ID]);
    expect(provider.plan).toBeNull();
    expect(provider.advanceStepCalls).toEqual([]);

    // 3. NEW plan, current step reuses the same description. The invalidation
    //    must have cleared the counter: attempt 1 must NOT skip.
    provider.plan = makeDeviatingPlan('plan_2');
    provider.eligible = true;
    const attemptOne = await service.execute(AGENT_ID);
    expect(attemptOne.deviationRejected).toBe(true);
    expect(attemptOne.stepSkipped).toBeUndefined();
    expect(provider.advanceStepCalls).toEqual([]);

    // Attempt 2 exhausts MAX_STEP_FAILURES → the guard fires normally.
    const attemptTwo = await service.execute(AGENT_ID);
    expect(attemptTwo.stepSkipped).toBe(true);
    expect(provider.advanceStepCalls).toEqual([AGENT_ID]);
  });
});
