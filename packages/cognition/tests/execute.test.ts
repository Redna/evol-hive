/**
 * Tests for ExecuteServiceImpl — the cognition layer orchestration of the
 * Execute phase of the PPER loop.
 *
 * Covers AC-19 through AC-35 (cognition-layer acceptance criteria).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  ExecuteResult,
  ExecuteDataProvider,
  AffordanceResult,
  AgentInternalState,
  PlanStep,
  Affordance,
} from '@evol-hive/shared';
import { ExecuteServiceImpl } from '../src/pper/execute-service.js';
import type { ExecuteService } from '../src/index.js';

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

const brewCoffee: Affordance = {
  id: 'brew_coffee',
  label: 'Brew coffee',
  engineEffect: 'brew_coffee',
  preconditions: ['has_water'],
  effects: { energy: 20 },
};

function makeAgentState(overrides: Partial<AgentInternalState> = {}): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    currentGoal: 'stay alive',
    currentPlan: null,
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
    ...overrides,
  };
}

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    description: 'Brew coffee',
    completed: false,
    ...overrides,
  };
}

/**
 * Fake ExecuteDataProvider that records all calls and returns configurable
 * results. This lets us verify the orchestration logic without coupling to
 * the engine package.
 */
class FakeExecuteDataProvider implements ExecuteDataProvider {
  agentState: AgentInternalState | null = makeAgentState();
  currentStep: PlanStep | null = makeStep({ targetAffordance: 'brew_coffee' });
  planComplete = false;
  // Callback to dynamically determine plan completion. If set, overrides static flags.
  isPlanCompleteFn: (() => boolean) | null = null;
  resolvedAffordance: { objectId: string; affordance: Affordance } | null = {
    objectId: 'coffee-1',
    affordance: brewCoffee,
  };
  preconditionResult: { satisfied: boolean; failed: string[] } = { satisfied: true, failed: [] };
  affordanceResult: AffordanceResult = { success: true, driveChanges: { energy: 20 } };

  // Call records
  getAgentStateCalls: string[] = [];
  getCurrentStepCalls: string[] = [];
  isPlanCompleteCalls: string[] = [];
  resolveAffordanceCalls: { roomId: string; affordanceId: string }[] = [];
  checkPreconditionsCalls: { affordanceId: string; objectId: string }[] = [];
  executeAffordanceCalls: { objectId: string; affordanceId: string; agentId: string }[] = [];
  advanceStepCalls: string[] = [];
  applyDriveChangesCalls: { agentId: string; changes: Partial<Record<string, number>> }[] = [];
  setSystemFeedbackCalls: { agentId: string; feedback: string }[] = [];
  setThinkingCalls: { agentId: string; isThinking: boolean }[] = [];

  getAgentState(agentId: string): AgentInternalState | null {
    this.getAgentStateCalls.push(agentId);
    return this.agentState;
  }
  getCurrentStep(agentId: string): PlanStep | null {
    this.getCurrentStepCalls.push(agentId);
    return this.currentStep;
  }
  isPlanComplete(agentId: string): boolean {
    this.isPlanCompleteCalls.push(agentId);
    if (this.isPlanCompleteFn) return this.isPlanCompleteFn();
    return this.planComplete;
  }
  resolveAffordance(
    roomId: string,
    affordanceId: string,
  ): { objectId: string; affordance: Affordance } | null {
    this.resolveAffordanceCalls.push({ roomId, affordanceId });
    return this.resolvedAffordance;
  }
  checkPreconditions(
    affordanceId: string,
    objectId: string,
  ): { satisfied: boolean; failed: string[] } {
    this.checkPreconditionsCalls.push({ affordanceId, objectId });
    return this.preconditionResult;
  }
  async executeAffordance(
    objectId: string,
    affordanceId: string,
    agentId: string,
  ): Promise<AffordanceResult> {
    this.executeAffordanceCalls.push({ objectId, affordanceId, agentId });
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
    if (this.agentState) {
      this.agentState = { ...this.agentState, isThinking };
    }
  }
}

// ─── ExecuteService interface (AC-19) ─────────────────────────────────────────

describe('ExecuteService interface (AC-19)', () => {
  it('is defined in cognition index with execute(agentId): Promise<ExecuteResult>', () => {
    const service: ExecuteService = {
      async execute(agentId: string): Promise<ExecuteResult> {
        return { success: true, planComplete: true };
      },
    };
    expect(typeof service.execute).toBe('function');
  });
});

// ─── ExecuteServiceImpl — basic structure (AC-20) ─────────────────────────────

describe('ExecuteServiceImpl (AC-20)', () => {
  it('is defined in pper/execute-service.ts and exported from pper/index.ts', () => {
    expect(ExecuteServiceImpl).toBeDefined();
    expect(typeof ExecuteServiceImpl).toBe('function');
  });
});

// ─── ExecuteServiceImpl.execute — orchestration ───────────────────────────────

describe('ExecuteServiceImpl.execute (AC-21 through AC-35)', () => {
  let provider: FakeExecuteDataProvider;

  beforeEach(() => {
    provider = new FakeExecuteDataProvider();
  });

  // AC-21: No active plan
  it('returns { success: false, error: "No active plan", planComplete: true } when currentPlan is null (AC-21)', async () => {
    provider.agentState = makeAgentState({ currentPlan: null });
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe('No active plan');
    expect(result.planComplete).toBe(true);
    // Must not have called resolveAffordance, checkPreconditions, or executeAffordance.
    expect(provider.resolveAffordanceCalls).toHaveLength(0);
    expect(provider.checkPreconditionsCalls).toHaveLength(0);
    expect(provider.executeAffordanceCalls).toHaveLength(0);
  });

  // AC-21b: Agent not found
  it('returns { success: false, error: "Agent not found", planComplete: true } when agent does not exist (AC-21)', async () => {
    provider.agentState = null;
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Agent not found');
    expect(result.planComplete).toBe(true);
  });

  // AC-22: Plan already complete
  it('returns { success: true, planComplete: true } when isPlanComplete is true (AC-22)', async () => {
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan1',
        description: 'done',
        steps: [],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.planComplete = true;
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.planComplete).toBe(true);
    expect(provider.resolveAffordanceCalls).toHaveLength(0);
    expect(provider.executeAffordanceCalls).toHaveLength(0);
  });

  // AC-21c: No current step
  it('returns { success: false, error: "No current step in plan", planComplete: true } when getCurrentStep is null (AC-21)', async () => {
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan1',
        description: 'test',
        steps: [makeStep()],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.currentStep = null;
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe('No current step in plan');
    expect(result.planComplete).toBe(true);
  });

  // AC-23: Step without targetAffordance (skipped)
  it('advances step and returns { success: true, stepSkipped: true } when targetAffordance is undefined (AC-23)', async () => {
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan1',
        description: 'test',
        steps: [makeStep({ targetAffordance: undefined })],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.currentStep = makeStep({ targetAffordance: undefined });
    provider.isPlanCompleteFn = () => provider.advanceStepCalls.length > 0;
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.stepSkipped).toBe(true);
    expect(result.planComplete).toBe(true);
    expect(provider.advanceStepCalls).toHaveLength(1);
    // No precondition check, execution, or drive changes.
    expect(provider.checkPreconditionsCalls).toHaveLength(0);
    expect(provider.executeAffordanceCalls).toHaveLength(0);
    expect(provider.applyDriveChangesCalls).toHaveLength(0);
  });

  // AC-24: Affordance not found in room
  it('sets system feedback, sets isThinking=false, returns failure when resolveAffordance returns null (AC-24, AC-30)', async () => {
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan1',
        description: 'test',
        steps: [makeStep({ targetAffordance: 'brew_coffee' })],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.currentStep = makeStep({ targetAffordance: 'brew_coffee' });
    provider.resolvedAffordance = null;
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.planComplete).toBe(false);
    expect(result.error).toContain('brew_coffee');
    expect(result.error).toContain(ROOM_ID);
    // System feedback must have been set.
    expect(provider.setSystemFeedbackCalls).toHaveLength(1);
    expect(provider.setSystemFeedbackCalls[0]!.feedback).toContain('brew_coffee');
    expect(provider.setSystemFeedbackCalls[0]!.feedback).toContain(ROOM_ID);
    // isThinking must be set to false.
    expect(provider.setThinkingCalls).toContainEqual({ agentId: AGENT_ID, isThinking: false });
    expect(provider.agentState?.isThinking).toBe(false);
  });

  // AC-25: Preconditions not met
  it('sets system feedback with failed preconditions, sets isThinking=false, returns failure (AC-25, AC-30)', async () => {
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan1',
        description: 'test',
        steps: [makeStep({ targetAffordance: 'brew_coffee' })],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.currentStep = makeStep({ targetAffordance: 'brew_coffee' });
    provider.preconditionResult = { satisfied: false, failed: ['has_water'] };
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Preconditions not met: has_water');
    expect(result.planComplete).toBe(false);
    expect(provider.setSystemFeedbackCalls).toHaveLength(1);
    expect(provider.setSystemFeedbackCalls[0]!.feedback).toContain('has_water');
    expect(provider.setThinkingCalls).toContainEqual({ agentId: AGENT_ID, isThinking: false });
    expect(provider.agentState?.isThinking).toBe(false);
    // Must not have executed the affordance.
    expect(provider.executeAffordanceCalls).toHaveLength(0);
  });

  // AC-26: Execution failure
  it('sets system feedback with failure reason, sets isThinking=false, returns failure (AC-26, AC-30)', async () => {
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan1',
        description: 'test',
        steps: [makeStep({ targetAffordance: 'brew_coffee' })],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.currentStep = makeStep({ targetAffordance: 'brew_coffee' });
    provider.affordanceResult = { success: false, failureReason: 'Machine broken' };
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Machine broken');
    expect(result.planComplete).toBe(false);
    expect(provider.setSystemFeedbackCalls).toHaveLength(1);
    expect(provider.setSystemFeedbackCalls[0]!.feedback).toBe('Machine broken');
    expect(provider.setThinkingCalls).toContainEqual({ agentId: AGENT_ID, isThinking: false });
    expect(provider.agentState?.isThinking).toBe(false);
    // Must not have advanced the step.
    expect(provider.advanceStepCalls).toHaveLength(0);
  });

  // AC-27: Success with drive changes
  it('applies drive changes, advances step, returns success with result (AC-27)', async () => {
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan1',
        description: 'test',
        steps: [makeStep({ targetAffordance: 'brew_coffee' })],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.currentStep = makeStep({ targetAffordance: 'brew_coffee' });
    provider.affordanceResult = { success: true, driveChanges: { energy: 20 } };
    provider.isPlanCompleteFn = () => provider.advanceStepCalls.length > 0;
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ success: true, driveChanges: { energy: 20 } });
    expect(result.planComplete).toBe(true);
    expect(provider.applyDriveChangesCalls).toHaveLength(1);
    expect(provider.applyDriveChangesCalls[0]!.changes).toEqual({ energy: 20 });
    expect(provider.advanceStepCalls).toHaveLength(1);
    // Should NOT set isThinking on success.
    expect(provider.setThinkingCalls).toHaveLength(0);
  });

  // AC-28: Success without drive changes
  it('does not call applyDriveChanges when result has no driveChanges (AC-28)', async () => {
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan1',
        description: 'test',
        steps: [makeStep({ targetAffordance: 'brew_coffee' })],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.currentStep = makeStep({ targetAffordance: 'brew_coffee' });
    provider.affordanceResult = { success: true };
    provider.isPlanCompleteFn = () => false; // plan not complete after advance
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ success: true });
    expect(result.planComplete).toBe(false);
    expect(provider.applyDriveChangesCalls).toHaveLength(0);
    expect(provider.advanceStepCalls).toHaveLength(1);
  });

  // AC-29: Exception handling
  it('catches exceptions, sets isThinking=false, returns failure without re-throwing (AC-29, AC-30)', async () => {
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan1',
        description: 'test',
        steps: [makeStep({ targetAffordance: 'brew_coffee' })],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.currentStep = makeStep({ targetAffordance: 'brew_coffee' });
    // Make resolveAffordance throw.
    provider.resolveAffordance = () => {
      throw new Error('Engine crashed');
    };
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Engine crashed');
    expect(result.planComplete).toBe(false);
    expect(provider.setThinkingCalls).toContainEqual({ agentId: AGENT_ID, isThinking: false });
    expect(provider.agentState?.isThinking).toBe(false);
  });

  // AC-31: No LLM calls
  it('does not call any LLM methods (AC-31)', async () => {
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan1',
        description: 'test',
        steps: [makeStep({ targetAffordance: 'brew_coffee' })],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.currentStep = makeStep({ targetAffordance: 'brew_coffee' });
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    await service.execute(AGENT_ID);
    // ExecuteServiceImpl only accepts dataProvider in its options — no LLMClient.
    // Verify that no LLM-related methods were called on the provider (there are none).
    // The ExecuteServiceOptions interface has no llmClient field.
    expect(provider.advanceStepCalls).toHaveLength(1);
  });

  // AC-35: Two-step plan — first succeeds, second skipped, plan complete
  it('two-step plan: first execute succeeds, second is skipped, planComplete=true (AC-35)', async () => {
    const plan = {
      id: 'plan1',
      description: 'Brew and drink',
      steps: [
        makeStep({ description: 'Brew coffee', targetAffordance: 'brew_coffee' }),
        makeStep({ description: 'Drink coffee', targetAffordance: undefined }),
      ],
      currentStepIndex: 0,
      createdAt: 100,
    };
    provider.agentState = makeAgentState({ currentPlan: plan });
    provider.affordanceResult = { success: true, driveChanges: { energy: 20 } };

    const service = new ExecuteServiceImpl({ dataProvider: provider });

    // First call: step 0 has targetAffordance → executes and advances.
    // Plan has 2 steps; after advancing past step 0, index=1, not complete.
    provider.currentStep = plan.steps[0]!;
    provider.isPlanCompleteFn = () => provider.advanceStepCalls.length >= 2;
    const result1 = await service.execute(AGENT_ID);
    expect(result1.success).toBe(true);
    expect(result1.planComplete).toBe(false);
    expect(provider.advanceStepCalls).toHaveLength(1);
    expect(provider.applyDriveChangesCalls).toHaveLength(1);

    // Second call: step 1 has no targetAffordance → skipped.
    // After advancing past step 1, index=2, plan is complete.
    provider.currentStep = plan.steps[1]!;
    const result2 = await service.execute(AGENT_ID);
    expect(result2.success).toBe(true);
    expect(result2.stepSkipped).toBe(true);
    expect(result2.planComplete).toBe(true);
    expect(provider.advanceStepCalls).toHaveLength(2);
  });

  // AC-34: No plan modification
  it('does not call clearPlan, createPlan, or modify plan description (AC-34)', async () => {
    const plan = {
      id: 'plan1',
      description: 'Brew coffee',
      steps: [makeStep({ targetAffordance: 'brew_coffee' })],
      currentStepIndex: 0,
      createdAt: 100,
    };
    provider.agentState = makeAgentState({ currentPlan: plan });
    provider.currentStep = plan.steps[0]!;
    provider.affordanceResult = { success: true, driveChanges: { energy: 20 } };
    provider.isPlanCompleteFn = () => provider.advanceStepCalls.length > 0;

    const service = new ExecuteServiceImpl({ dataProvider: provider });
    await service.execute(AGENT_ID);

    // The plan description should not have changed.
    expect(plan.description).toBe('Brew coffee');
    // ExecuteDataProvider does not expose clearPlan or createPlan, so they
    // cannot be called. Verify advanceStep was the only plan mutation.
    expect(provider.advanceStepCalls).toHaveLength(1);
  });
});
