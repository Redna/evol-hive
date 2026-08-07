/**
 * Type-level tests for Plan phase types (PlanResult, PlanDataProvider).
 * These validate that the interfaces exist and have the correct shape.
 */
import { describe, it, expect } from 'vitest';
import type {
  PlanResult,
  PlanDataProvider,
  AgentPlan,
  AgentInternalState,
  FormulatePlanResult,
} from '../src/index.js';

describe('PlanResult type (AC-2)', () => {
  it('allows a success result with a plan', () => {
    const plan: AgentPlan = {
      id: 'plan_a1_1',
      description: 'Restore energy',
      steps: [{ description: 'Brew coffee', completed: false }],
      currentStepIndex: 0,
      createdAt: 100,
    };
    const result: PlanResult = { success: true, plan };
    expect(result.success).toBe(true);
    expect(result.plan).toEqual(plan);
    expect(result.error).toBeUndefined();
  });

  it('allows a failure result with an error', () => {
    const result: PlanResult = { success: false, error: 'LLM call failed' };
    expect(result.success).toBe(false);
    expect(result.error).toBe('LLM call failed');
    expect(result.plan).toBeUndefined();
  });
});

describe('PlanDataProvider interface (AC-21)', () => {
  it('can be implemented with the three required methods', () => {
    const provider: PlanDataProvider = {
      getAgentState(agentId: string): AgentInternalState | null {
        return null;
      },
      storePlan(agentId: string, result: FormulatePlanResult): AgentPlan {
        return {
          id: `plan_${agentId}_1`,
          description: result.description,
          steps: result.steps.map((s) => ({ description: s.description, completed: false })),
          currentStepIndex: 0,
          createdAt: 0,
        };
      },
      setThinking(agentId: string, isThinking: boolean): void {
        // no-op
      },
    };
    expect(provider.getAgentState('a1')).toBeNull();
    expect(provider.storePlan('a1', { description: 'd', steps: [] }).id).toBe('plan_a1_1');
    expect(() => provider.setThinking('a1', true)).not.toThrow();
  });
});
