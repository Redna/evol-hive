import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  AgentInternalState,
  AgentProfile,
  AgentPlan,
  FormulatePlanResult,
} from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { PlanManagerImpl, PlanDataProviderImpl } from '../src/agents/plans/index.js';

const AGENT_ID = 'a1';

const profile: AgentProfile = {
  id: AGENT_ID,
  name: 'Test Agent',
  description: 'A test agent',
  traits: [],
  initialDrives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
};

const formulateResult: FormulatePlanResult = {
  description: 'Brew coffee to restore energy',
  steps: [
    { description: 'Go to coffee machine', targetAffordance: 'brew_coffee' },
    { description: 'Drink coffee' },
  ],
};

function makeAgentManager() {
  return new AgentManagerImpl();
}

function spawnAgent(agentManager: AgentManagerImpl, overrides: Partial<AgentInternalState> = {}) {
  agentManager.spawn(profile);
  if (Object.keys(overrides).length > 0) {
    agentManager.updateState(AGENT_ID, overrides);
  }
  return agentManager.getState(AGENT_ID)!;
}

// ─── PlanManagerImpl.createPlan (AC-15, AC-16) ───────────────────────────────

describe('PlanManagerImpl.createPlan (AC-15, AC-16, AC-27)', () => {
  let agentManager: AgentManagerImpl;
  let planManager: PlanManagerImpl;

  beforeEach(() => {
    agentManager = makeAgentManager();
    planManager = new PlanManagerImpl(agentManager);
    spawnAgent(agentManager);
  });

  it('generates an AgentPlan with a unique id, currentStepIndex 0, createdAt set to sim time (AC-15)', () => {
    const plan = planManager.createPlan(AGENT_ID, formulateResult);
    expect(plan.id).toMatch(new RegExp(`^plan_${AGENT_ID}_`));
    expect(plan.currentStepIndex).toBe(0);
    expect(plan.createdAt).toBeGreaterThan(0);
    expect(plan.description).toBe(formulateResult.description);
  });

  it('maps each step to a PlanStep with completed: false (AC-15)', () => {
    const plan = planManager.createPlan(AGENT_ID, formulateResult);
    expect(plan.steps).toHaveLength(formulateResult.steps.length);
    for (let i = 0; i < plan.steps.length; i++) {
      expect(plan.steps[i]!.description).toBe(formulateResult.steps[i]!.description);
      expect(plan.steps[i]!.completed).toBe(false);
      if (formulateResult.steps[i]!.targetAffordance !== undefined) {
        expect(plan.steps[i]!.targetAffordance).toBe(formulateResult.steps[i]!.targetAffordance);
      }
    }
  });

  it('stores the AgentPlan in agent state via AgentManager.updateState (AC-16)', () => {
    planManager.createPlan(AGENT_ID, formulateResult);
    const state = agentManager.getState(AGENT_ID);
    expect(state?.currentPlan).not.toBeNull();
    expect(state?.currentPlan?.description).toBe(formulateResult.description);
  });

  it('two successive createPlan calls produce different ids (AC-27)', async () => {
    const plan1 = planManager.createPlan(AGENT_ID, formulateResult);
    // Small delay to ensure different Date.now() if called in same millisecond
    await new Promise((r) => setTimeout(r, 5));
    planManager.clearPlan(AGENT_ID);
    const plan2 = planManager.createPlan(AGENT_ID, formulateResult);
    expect(plan1.id).not.toBe(plan2.id);
  });
});

// ─── PlanManagerImpl.advanceStep (AC-17) ─────────────────────────────────────

describe('PlanManagerImpl.advanceStep (AC-17)', () => {
  let agentManager: AgentManagerImpl;
  let planManager: PlanManagerImpl;

  beforeEach(() => {
    agentManager = makeAgentManager();
    planManager = new PlanManagerImpl(agentManager);
    spawnAgent(agentManager);
    planManager.createPlan(AGENT_ID, formulateResult);
  });

  it('increments currentStepIndex by 1 and marks previous step completed: true (AC-17)', () => {
    planManager.advanceStep(AGENT_ID);
    const state = agentManager.getState(AGENT_ID)!;
    expect(state.currentPlan!.currentStepIndex).toBe(1);
    expect(state.currentPlan!.steps[0]!.completed).toBe(true);
    expect(state.currentPlan!.steps[1]!.completed).toBe(false);
  });

  it('is a no-op when the plan is already complete (AC-17)', () => {
    // Advance past the last step
    planManager.advanceStep(AGENT_ID); // index 0 → 1
    planManager.advanceStep(AGENT_ID); // index 1 → 2 (complete)
    const stateBefore = agentManager.getState(AGENT_ID)!;
    expect(stateBefore.currentPlan!.currentStepIndex).toBe(2);
    planManager.advanceStep(AGENT_ID); // no-op
    const stateAfter = agentManager.getState(AGENT_ID)!;
    expect(stateAfter.currentPlan!.currentStepIndex).toBe(2);
  });
});

// ─── PlanManagerImpl.getCurrentStep (AC-18) ──────────────────────────────────

describe('PlanManagerImpl.getCurrentStep (AC-18)', () => {
  let agentManager: AgentManagerImpl;
  let planManager: PlanManagerImpl;

  beforeEach(() => {
    agentManager = makeAgentManager();
    planManager = new PlanManagerImpl(agentManager);
    spawnAgent(agentManager);
  });

  it('returns the PlanStep at the current step index (AC-18)', () => {
    planManager.createPlan(AGENT_ID, formulateResult);
    const step = planManager.getCurrentStep(AGENT_ID);
    expect(step).not.toBeNull();
    expect(step!.description).toBe(formulateResult.steps[0]!.description);
  });

  it('returns null if no plan exists (AC-18)', () => {
    const step = planManager.getCurrentStep(AGENT_ID);
    expect(step).toBeNull();
  });

  it('returns null if the index is out of bounds (AC-18)', () => {
    planManager.createPlan(AGENT_ID, formulateResult);
    // Advance to completion
    planManager.advanceStep(AGENT_ID);
    planManager.advanceStep(AGENT_ID);
    const step = planManager.getCurrentStep(AGENT_ID);
    expect(step).toBeNull();
  });
});

// ─── PlanManagerImpl.isComplete (AC-19) ──────────────────────────────────────

describe('PlanManagerImpl.isComplete (AC-19)', () => {
  let agentManager: AgentManagerImpl;
  let planManager: PlanManagerImpl;

  beforeEach(() => {
    agentManager = makeAgentManager();
    planManager = new PlanManagerImpl(agentManager);
    spawnAgent(agentManager);
  });

  it('returns true when currentPlan is null (AC-19)', () => {
    expect(planManager.isComplete(AGENT_ID)).toBe(true);
  });

  it('returns false when plan is not complete (AC-19)', () => {
    planManager.createPlan(AGENT_ID, formulateResult);
    expect(planManager.isComplete(AGENT_ID)).toBe(false);
  });

  it('returns true when currentStepIndex >= steps.length (AC-19)', () => {
    planManager.createPlan(AGENT_ID, formulateResult);
    planManager.advanceStep(AGENT_ID);
    planManager.advanceStep(AGENT_ID);
    expect(planManager.isComplete(AGENT_ID)).toBe(true);
  });
});

// ─── PlanManagerImpl.clearPlan (AC-20) ───────────────────────────────────────

describe('PlanManagerImpl.clearPlan (AC-20)', () => {
  let agentManager: AgentManagerImpl;
  let planManager: PlanManagerImpl;

  beforeEach(() => {
    agentManager = makeAgentManager();
    planManager = new PlanManagerImpl(agentManager);
    spawnAgent(agentManager);
  });

  it('sets currentPlan to null in agent state (AC-20)', () => {
    planManager.createPlan(AGENT_ID, formulateResult);
    expect(agentManager.getState(AGENT_ID)?.currentPlan).not.toBeNull();
    planManager.clearPlan(AGENT_ID);
    expect(agentManager.getState(AGENT_ID)?.currentPlan).toBeNull();
  });
});

// ─── PlanDataProviderImpl (AC-22) ─────────────────────────────────────────────

describe('PlanDataProviderImpl (AC-22)', () => {
  let agentManager: AgentManagerImpl;
  let planManager: PlanManagerImpl;
  let dataProvider: PlanDataProviderImpl;

  beforeEach(() => {
    agentManager = makeAgentManager();
    planManager = new PlanManagerImpl(agentManager);
    dataProvider = new PlanDataProviderImpl(agentManager, planManager);
    spawnAgent(agentManager);
  });

  it('getAgentState delegates to AgentManager.getState (AC-22)', () => {
    const state = dataProvider.getAgentState(AGENT_ID);
    expect(state).not.toBeNull();
    expect(state?.agentId).toBe(AGENT_ID);
  });

  it('getAgentState returns null when agent does not exist (AC-22)', () => {
    expect(dataProvider.getAgentState('nonexistent')).toBeNull();
  });

  it('storePlan delegates to PlanManager.createPlan (AC-22)', () => {
    const plan = dataProvider.storePlan(AGENT_ID, formulateResult);
    expect(plan).toBeDefined();
    expect(plan.description).toBe(formulateResult.description);
    expect(plan.currentStepIndex).toBe(0);
    // Verify it was stored in agent state
    const state = agentManager.getState(AGENT_ID);
    expect(state?.currentPlan).toEqual(plan);
  });

  it('setThinking delegates to AgentManager.updateState (AC-22)', () => {
    dataProvider.setThinking(AGENT_ID, true);
    let state = agentManager.getState(AGENT_ID);
    expect(state?.isThinking).toBe(true);

    dataProvider.setThinking(AGENT_ID, false);
    state = agentManager.getState(AGENT_ID);
    expect(state?.isThinking).toBe(false);
  });
});
