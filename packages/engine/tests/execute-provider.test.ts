/**
 * Tests for the system feedback store and ExecuteDataProviderImpl bridge.
 *
 * Covers AC-14, AC-15, AC-16, AC-17, AC-18, AC-33.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Affordance, SmartObject } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { PlanManagerImpl } from '../src/agents/plans/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { AffordanceRegistryImpl } from '../src/world/affordances/index.js';
import { PhysicsSystemImpl } from '../src/physics/index.js';
import { SystemFeedbackStore } from '../src/agents/feedback/index.js';
import { ExecuteDataProviderImpl } from '../src/agents/execute/index.js';

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

const brewCoffee: Affordance = {
  id: 'brew_coffee',
  label: 'Brew coffee',
  engineEffect: 'brew_coffee',
  preconditions: [],
  effects: { energy: 20 },
};

const coffeeMachine: SmartObject = {
  id: 'coffee-1',
  name: 'Coffee Machine',
  type: 'appliance',
  state: { water_level: 5 },
  affordances: [brewCoffee],
  roomId: ROOM_ID,
};

function setup() {
  const agentManager = new AgentManagerImpl();
  const planManager = new PlanManagerImpl(agentManager, () => 100);
  const driveSystem = new DriveSystemImpl(agentManager);
  const smartRegistry = new SmartObjectRegistryImpl();
  const affordanceRegistry = new AffordanceRegistryImpl(smartRegistry);
  const physics = new PhysicsSystemImpl(smartRegistry, affordanceRegistry);
  const feedbackStore = new SystemFeedbackStore();
  const provider = new ExecuteDataProviderImpl({
    agentManager,
    planManager,
    driveSystem,
    smartRegistry,
    affordanceRegistry,
    physics,
    feedbackStore,
  });

  agentManager.spawn({
    id: AGENT_ID,
    name: 'Test Agent',
    description: '',
    traits: [],
    initialDrives: { energy: 10 },
  });
  agentManager.updateState(AGENT_ID, { location: ROOM_ID });

  return {
    agentManager,
    planManager,
    driveSystem,
    smartRegistry,
    affordanceRegistry,
    physics,
    feedbackStore,
    provider,
  };
}

// ─── SystemFeedbackStore (AC-14, AC-15) ──────────────────────────────────────

describe('SystemFeedbackStore (AC-14, AC-15)', () => {
  let store: SystemFeedbackStore;

  beforeEach(() => {
    store = new SystemFeedbackStore();
  });

  it('setSystemFeedback stores feedback and getSystemFeedback retrieves it (AC-14)', () => {
    store.setSystemFeedback(AGENT_ID, 'Machine broken');
    expect(store.getSystemFeedback(AGENT_ID)).toBe('Machine broken');
  });

  it('calling setSystemFeedback again overwrites the previous feedback (AC-14)', () => {
    store.setSystemFeedback(AGENT_ID, 'First failure');
    store.setSystemFeedback(AGENT_ID, 'Second failure');
    expect(store.getSystemFeedback(AGENT_ID)).toBe('Second failure');
  });

  it('getSystemFeedback returns undefined for an agent with no feedback', () => {
    expect(store.getSystemFeedback(AGENT_ID)).toBeUndefined();
  });

  it('clearSystemFeedback removes stored feedback (AC-15)', () => {
    store.setSystemFeedback(AGENT_ID, 'Machine broken');
    store.clearSystemFeedback(AGENT_ID);
    expect(store.getSystemFeedback(AGENT_ID)).toBeUndefined();
  });

  it('clearSystemFeedback is safe to call when no feedback exists (AC-15)', () => {
    expect(() => store.clearSystemFeedback(AGENT_ID)).not.toThrow();
    expect(store.getSystemFeedback(AGENT_ID)).toBeUndefined();
  });
});

// ─── ExecuteDataProviderImpl (AC-16, AC-17, AC-18, AC-33) ─────────────────────

describe('ExecuteDataProviderImpl (AC-16, AC-17, AC-18, AC-33)', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('getAgentState delegates to AgentManager.getState', () => {
    const state = ctx.provider.getAgentState(AGENT_ID);
    expect(state).not.toBeNull();
    expect(state?.agentId).toBe(AGENT_ID);
  });

  it('getAgentState returns null for unknown agent', () => {
    expect(ctx.provider.getAgentState('nonexistent')).toBeNull();
  });

  it('getCurrentStep delegates to PlanManager.getCurrentStep', () => {
    ctx.planManager.createPlan(AGENT_ID, {
      description: 'Test plan',
      steps: [{ description: 'Step 1', targetAffordance: 'brew_coffee' }],
    });
    const step = ctx.provider.getCurrentStep(AGENT_ID);
    expect(step).not.toBeNull();
    expect(step?.description).toBe('Step 1');
  });

  it('getCurrentStep returns null when no plan exists', () => {
    expect(ctx.provider.getCurrentStep(AGENT_ID)).toBeNull();
  });

  it('isPlanComplete delegates to PlanManager.isComplete', () => {
    expect(ctx.provider.isPlanComplete(AGENT_ID)).toBe(true); // no plan = complete
    ctx.planManager.createPlan(AGENT_ID, {
      description: 'Test plan',
      steps: [{ description: 'Step 1', targetAffordance: 'brew_coffee' }],
    });
    expect(ctx.provider.isPlanComplete(AGENT_ID)).toBe(false);
  });

  it('resolveAffordance returns { objectId, affordance } for the first matching object (AC-16)', () => {
    ctx.smartRegistry.register(coffeeMachine);
    const result = ctx.provider.resolveAffordance(ROOM_ID, 'brew_coffee');
    expect(result).not.toBeNull();
    expect(result?.objectId).toBe('coffee-1');
    expect(result?.affordance.id).toBe('brew_coffee');
  });

  it('resolveAffordance returns null when no object in the room has the affordance (AC-16)', () => {
    ctx.smartRegistry.register(coffeeMachine);
    expect(ctx.provider.resolveAffordance(ROOM_ID, 'nonexistent')).toBeNull();
  });

  it('resolveAffordance returns null when the room is empty (AC-16)', () => {
    expect(ctx.provider.resolveAffordance('empty_room', 'brew_coffee')).toBeNull();
  });

  it('checkPreconditions delegates to AffordanceRegistry.checkPreconditions', () => {
    ctx.smartRegistry.register({
      ...coffeeMachine,
      state: { water_level: 0 },
      affordances: [{ ...brewCoffee, preconditions: ['has_water'] }],
    });
    ctx.affordanceRegistry.registerPreconditionChecker('has_water', (state) => {
      return (state['water_level'] as number) > 0;
    });
    const result = ctx.provider.checkPreconditions('brew_coffee', 'coffee-1');
    expect(result.satisfied).toBe(false);
    expect(result.failed).toEqual(['has_water']);
  });

  it('executeAffordance delegates to PhysicsSystem.executeAffordance', async () => {
    ctx.smartRegistry.register({ ...coffeeMachine, state: { water_level: 5 } });
    ctx.affordanceRegistry.registerHandler('brew_coffee', async () => ({
      success: true,
      driveChanges: { energy: 20 },
    }));
    const result = await ctx.provider.executeAffordance('coffee-1', 'brew_coffee', AGENT_ID);
    expect(result.success).toBe(true);
  });

  it('advanceStep delegates to PlanManager.advanceStep (AC-18)', () => {
    ctx.planManager.createPlan(AGENT_ID, {
      description: 'Test plan',
      steps: [
        { description: 'Step 1', targetAffordance: 'brew_coffee' },
        { description: 'Step 2' },
      ],
    });
    ctx.provider.advanceStep(AGENT_ID);
    const state = ctx.agentManager.getState(AGENT_ID);
    expect(state?.currentPlan?.currentStepIndex).toBe(1);
    expect(state?.currentPlan?.steps[0]?.completed).toBe(true);
  });

  it('applyDriveChanges delegates to DriveSystem.applyChanges which clamps to 0-100 (AC-17)', () => {
    ctx.provider.applyDriveChanges(AGENT_ID, { energy: 200 });
    const state = ctx.agentManager.getState(AGENT_ID);
    expect(state?.drives.energy).toBe(100); // clamped
  });

  it('applyDriveChanges with negative delta clamps to 0 (AC-17)', () => {
    ctx.provider.applyDriveChanges(AGENT_ID, { energy: -200 });
    const state = ctx.agentManager.getState(AGENT_ID);
    expect(state?.drives.energy).toBe(0); // clamped
  });

  it('setSystemFeedback stores feedback in the shared store (AC-33)', () => {
    ctx.provider.setSystemFeedback(AGENT_ID, 'Action failed: machine broken');
    expect(ctx.feedbackStore.getSystemFeedback(AGENT_ID)).toBe('Action failed: machine broken');
  });

  it('setThinking delegates to AgentManager.updateState', () => {
    ctx.provider.setThinking(AGENT_ID, true);
    expect(ctx.agentManager.getState(AGENT_ID)?.isThinking).toBe(true);
    ctx.provider.setThinking(AGENT_ID, false);
    expect(ctx.agentManager.getState(AGENT_ID)?.isThinking).toBe(false);
  });
});
