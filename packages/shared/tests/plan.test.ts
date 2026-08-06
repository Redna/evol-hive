import { describe, it, expect } from 'vitest';
import type {
  PlanResult,
  PlanDataProvider,
  AgentPlan,
  AgentInternalState,
  FormulatePlanResult,
  Affordance,
} from '../src/index.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const planStep: AgentPlan['steps'][number] = {
  description: 'Go to the kitchen',
  completed: false,
};

const samplePlan: AgentPlan = {
  id: 'plan_a1_1700000000',
  description: 'Get coffee to restore energy',
  steps: [planStep, { description: 'Brew coffee', completed: false }],
  currentStepIndex: 0,
  createdAt: 100,
};

const sampleAgentState: AgentInternalState = {
  agentId: 'a1',
  drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
  currentGoal: 'restore energy',
  currentPlan: null,
  isThinking: false,
  location: 'kitchen',
  lastPerceptionTick: 0,
};

const formulateResult: FormulatePlanResult = {
  description: 'Get coffee to restore energy',
  steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
};

// ─── PlanResult (AC-2) ───────────────────────────────────────────────────────

describe('PlanResult (AC-2)', () => {
  it('is defined with success: boolean, plan?: AgentPlan, error?: string', () => {
    const successResult: PlanResult = {
      success: true,
      plan: samplePlan,
    };
    expect(successResult.success).toBe(true);
    expect(successResult.plan).toEqual(samplePlan);
    expect(successResult.error).toBeUndefined();

    const failureResult: PlanResult = {
      success: false,
      error: 'LLM call failed',
    };
    expect(failureResult.success).toBe(false);
    expect(failureResult.plan).toBeUndefined();
    expect(failureResult.error).toBe('LLM call failed');
  });
});

// ─── PlanDataProvider (AC-21) ────────────────────────────────────────────────

describe('PlanDataProvider (AC-21)', () => {
  it('defines getAgentState, storePlan, and setThinking', () => {
    const provider: PlanDataProvider = {
      getAgentState: (agentId: string) => ({ ...sampleAgentState, agentId }),
      storePlan: (_agentId: string, _result: FormulatePlanResult): AgentPlan => samplePlan,
      setThinking: (_agentId: string, _isThinking: boolean) => {},
    };

    const state = provider.getAgentState('a1');
    expect(state).not.toBeNull();
    expect(state?.agentId).toBe('a1');

    const plan = provider.storePlan('a1', formulateResult);
    expect(plan).toEqual(samplePlan);

    expect(() => provider.setThinking('a1', true)).not.toThrow();
  });

  it('getAgentState returns null when agent does not exist', () => {
    const provider: PlanDataProvider = {
      getAgentState: () => null,
      storePlan: () => samplePlan,
      setThinking: () => {},
    };
    expect(provider.getAgentState('nonexistent')).toBeNull();
  });

  it('storePlan returns an AgentPlan', () => {
    const provider: PlanDataProvider = {
      getAgentState: () => sampleAgentState,
      storePlan: (_agentId, result) => ({
        id: `plan_${_agentId}_123`,
        description: result.description,
        steps: result.steps.map((s) => ({
          description: s.description,
          completed: false,
          ...(s.targetAffordance !== undefined ? { targetAffordance: s.targetAffordance } : {}),
        })),
        currentStepIndex: 0,
        createdAt: 50,
      }),
      setThinking: () => {},
    };

    const plan = provider.storePlan('a1', formulateResult);
    expect(plan.id).toBe('plan_a1_123');
    expect(plan.description).toBe(formulateResult.description);
    expect(plan.currentStepIndex).toBe(0);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.completed).toBe(false);
  });
});
