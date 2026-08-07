/**
 * Tests for PlanManagerImpl and PlanDataProviderImpl — the engine layer of
 * the Plan phase. Covers AC-15 through AC-22, AC-27.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentInternalState, AgentPlan, FormulatePlanResult } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { PlanManagerImpl, PlanDataProviderImpl } from '../src/agents/plans/index.js';

const AGENT_ID = 'a1';

function makeAgentState(overrides: Partial<AgentInternalState> = {}): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    currentGoal: 'stay alive',
    currentPlan: null,
    isThinking: false,
    location: 'kitchen',
    lastPerceptionTick: 0,
    ...overrides,
  };
}

function makeFormulatePlanResult(): FormulatePlanResult {
  return {
    description: 'Restore energy by brewing coffee',
    steps: [
      { description: 'Go to the coffee machine', targetAffordance: 'brew_coffee' },
      { description: 'Brew coffee and drink it' },
    ],
  };
}

// ─── PlanManagerImpl ──────────────────────────────────────────────────────────

describe('PlanManagerImpl (AC-15 through AC-20, AC-27)', () => {
  let agentManager: AgentManagerImpl;
  let planManager: PlanManagerImpl;

  beforeEach(() => {
    agentManager = new AgentManagerImpl();
    planManager = new PlanManagerImpl(agentManager, () => 100);
    agentManager.spawn({
      id: AGENT_ID,
      name: 'Test Agent',
      description: '',
      traits: [],
      initialDrives: { energy: 10 },
    });
  });

  describe('createPlan (AC-15, AC-16, AC-27)', () => {
    it('generates an AgentPlan with a unique id, currentStepIndex: 0, and createdAt = sim time', () => {
      const plan = planManager.createPlan(AGENT_ID, makeFormulatePlanResult());

      expect(plan.id).toMatch(/^plan_a1_/);
      expect(plan.currentStepIndex).toBe(0);
      expect(plan.createdAt).toBe(100);
      expect(plan.description).toBe('Restore energy by brewing coffee');
    });

    it('maps each step to a PlanStep with completed: false', () => {
      const plan = planManager.createPlan(AGENT_ID, makeFormulatePlanResult());

      expect(plan.steps).toHaveLength(2);
      expect(plan.steps[0]!.description).toBe('Go to the coffee machine');
      expect(plan.steps[0]!.targetAffordance).toBe('brew_coffee');
      expect(plan.steps[0]!.completed).toBe(false);
      expect(plan.steps[1]!.description).toBe('Brew coffee and drink it');
      expect(plan.steps[1]!.completed).toBe(false);
    });

    it('stores the AgentPlan in agent state via updateState (AC-16)', () => {
      planManager.createPlan(AGENT_ID, makeFormulatePlanResult());

      const state = agentManager.getState(AGENT_ID);
      expect(state?.currentPlan).not.toBeNull();
      expect(state?.currentPlan?.description).toBe('Restore energy by brewing coffee');
    });

    it('two successive createPlan calls produce different ids (AC-27)', () => {
      const plan1 = planManager.createPlan(AGENT_ID, makeFormulatePlanResult());
      const plan2 = planManager.createPlan(AGENT_ID, makeFormulatePlanResult());

      expect(plan1.id).not.toBe(plan2.id);
    });

    it('steps without targetAffordance map to PlanStep without targetAffordance', () => {
      const result: FormulatePlanResult = {
        description: 'Explore',
        steps: [{ description: 'Wander around' }],
      };
      const plan = planManager.createPlan(AGENT_ID, result);

      expect(plan.steps[0]!.description).toBe('Wander around');
      expect(plan.steps[0]!.targetAffordance).toBeUndefined();
    });
  });

  describe('advanceStep (AC-17)', () => {
    it('increments currentStepIndex and marks previous step completed', () => {
      planManager.createPlan(AGENT_ID, makeFormulatePlanResult());

      planManager.advanceStep(AGENT_ID);
      const state = agentManager.getState(AGENT_ID);
      expect(state?.currentPlan?.currentStepIndex).toBe(1);
      expect(state?.currentPlan?.steps[0]?.completed).toBe(true);
      expect(state?.currentPlan?.steps[1]?.completed).toBe(false);
    });

    it('is a no-op when the plan is already complete', () => {
      planManager.createPlan(AGENT_ID, makeFormulatePlanResult());
      // Advance past all steps.
      planManager.advanceStep(AGENT_ID);
      planManager.advanceStep(AGENT_ID);
      const stateBefore = agentManager.getState(AGENT_ID);
      expect(stateBefore?.currentPlan?.currentStepIndex).toBe(2);

      // Advancing again should not change anything.
      planManager.advanceStep(AGENT_ID);
      const stateAfter = agentManager.getState(AGENT_ID);
      expect(stateAfter?.currentPlan?.currentStepIndex).toBe(2);
      // All steps should be completed.
      expect(stateAfter?.currentPlan?.steps.every((s) => s.completed)).toBe(true);
    });

    it('is a no-op when no plan exists', () => {
      expect(() => planManager.advanceStep(AGENT_ID)).not.toThrow();
      expect(agentManager.getState(AGENT_ID)?.currentPlan).toBeNull();
    });
  });

  describe('getCurrentStep (AC-18)', () => {
    it('returns the PlanStep at the current step index', () => {
      planManager.createPlan(AGENT_ID, makeFormulatePlanResult());

      const step = planManager.getCurrentStep(AGENT_ID);
      expect(step).not.toBeNull();
      expect(step?.description).toBe('Go to the coffee machine');
    });

    it('returns null when no plan exists', () => {
      expect(planManager.getCurrentStep(AGENT_ID)).toBeNull();
    });

    it('returns null when index is out of bounds', () => {
      planManager.createPlan(AGENT_ID, makeFormulatePlanResult());
      // Advance past the end.
      planManager.advanceStep(AGENT_ID);
      planManager.advanceStep(AGENT_ID);
      expect(planManager.getCurrentStep(AGENT_ID)).toBeNull();
    });
  });

  describe('isComplete (AC-19)', () => {
    it('returns true when currentPlan is null', () => {
      expect(planManager.isComplete(AGENT_ID)).toBe(true);
    });

    it('returns false when the plan has remaining steps', () => {
      planManager.createPlan(AGENT_ID, makeFormulatePlanResult());
      expect(planManager.isComplete(AGENT_ID)).toBe(false);
    });

    it('returns true when currentStepIndex >= steps.length', () => {
      planManager.createPlan(AGENT_ID, makeFormulatePlanResult());
      planManager.advanceStep(AGENT_ID);
      planManager.advanceStep(AGENT_ID);
      expect(planManager.isComplete(AGENT_ID)).toBe(true);
    });
  });

  describe('clearPlan (AC-20)', () => {
    it('sets currentPlan to null in agent state', () => {
      planManager.createPlan(AGENT_ID, makeFormulatePlanResult());
      expect(agentManager.getState(AGENT_ID)?.currentPlan).not.toBeNull();

      planManager.clearPlan(AGENT_ID);
      expect(agentManager.getState(AGENT_ID)?.currentPlan).toBeNull();
    });

    it('is safe to call when no plan exists', () => {
      expect(() => planManager.clearPlan(AGENT_ID)).not.toThrow();
      expect(agentManager.getState(AGENT_ID)?.currentPlan).toBeNull();
    });
  });
});

// ─── PlanDataProviderImpl ─────────────────────────────────────────────────────

describe('PlanDataProviderImpl (AC-22)', () => {
  let agentManager: AgentManagerImpl;
  let planManager: PlanManagerImpl;
  let provider: PlanDataProviderImpl;

  beforeEach(() => {
    agentManager = new AgentManagerImpl();
    planManager = new PlanManagerImpl(agentManager, () => 200);
    provider = new PlanDataProviderImpl(agentManager, planManager);
    agentManager.spawn({
      id: AGENT_ID,
      name: 'Test Agent',
      description: '',
      traits: [],
      initialDrives: { energy: 10 },
    });
  });

  it('getAgentState delegates to AgentManager.getState', () => {
    const state = provider.getAgentState(AGENT_ID);
    expect(state).not.toBeNull();
    expect(state?.agentId).toBe(AGENT_ID);
  });

  it('getAgentState returns null for unknown agent', () => {
    expect(provider.getAgentState('nonexistent')).toBeNull();
  });

  it('storePlan delegates to PlanManager.createPlan and returns the AgentPlan', () => {
    const plan = provider.storePlan(AGENT_ID, makeFormulatePlanResult());
    expect(plan.id).toMatch(/^plan_a1_/);
    expect(plan.description).toBe('Restore energy by brewing coffee');
    // Verify it was stored in agent state.
    const state = agentManager.getState(AGENT_ID);
    expect(state?.currentPlan?.id).toBe(plan.id);
  });

  it('setThinking delegates to AgentManager.updateState', () => {
    provider.setThinking(AGENT_ID, true);
    expect(agentManager.getState(AGENT_ID)?.isThinking).toBe(true);

    provider.setThinking(AGENT_ID, false);
    expect(agentManager.getState(AGENT_ID)?.isThinking).toBe(false);
  });
});
