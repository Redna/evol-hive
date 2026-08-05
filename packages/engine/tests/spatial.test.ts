import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentProfile, GameTick } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SpatialSystemImpl } from '../src/spatial/index.js';

const DEBOUNCE_SECONDS = 5;

function makeTick(simulationTime: number): GameTick {
  return { tickNumber: 0, simulationTime, deltaSeconds: 0 };
}

function setupAgent(location: string) {
  const agents = new AgentManagerImpl();
  const profile: AgentProfile = {
    id: 'a1',
    name: 'Test Agent',
    description: 'test',
    traits: [],
    initialDrives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
  const state = agents.spawn(profile);
  agents.updateState('a1', { location, lastPerceptionTick: 0 });
  return { agents, state };
}

function makeSpatial(agents: AgentManagerImpl) {
  const registry = new SmartObjectRegistryImpl();
  return new SpatialSystemImpl({
    agentManager: agents,
    registry,
    spatialDebounceSeconds: DEBOUNCE_SECONDS,
  });
}

describe('SpatialSystem.shouldTriggerPerception — room threshold (AC-5, AC-6)', () => {
  let agents: AgentManagerImpl;
  let spatial: SpatialSystemImpl;

  beforeEach(() => {
    ({ agents } = setupAgent('kitchen'));
    spatial = makeSpatial(agents);
    spatial.update(makeTick(0));
  });

  it('returns true when location changes from kitchen to lounge (AC-5)', () => {
    // First tick establishes the baseline location at kitchen.
    expect(spatial.shouldTriggerPerception('a1')).toBe(false);
    spatial.recordPerceptionTick('a1', 0);

    // Agent moves to lounge.
    agents.updateState('a1', { location: 'lounge' });
    expect(spatial.shouldTriggerPerception('a1')).toBe(true);
  });

  it('returns false when location does not change between ticks (AC-6)', () => {
    expect(spatial.shouldTriggerPerception('a1')).toBe(false);
    spatial.recordPerceptionTick('a1', 0);

    spatial.update(makeTick(2));
    // No movement, idle timer (2s) < debounce (5s).
    expect(spatial.shouldTriggerPerception('a1')).toBe(false);
  });
});

describe('SpatialSystem.shouldTriggerPerception — idle timer (AC-7, AC-8)', () => {
  let agents: AgentManagerImpl;
  let spatial: SpatialSystemImpl;

  beforeEach(() => {
    ({ agents } = setupAgent('kitchen'));
    spatial = makeSpatial(agents);
    spatial.update(makeTick(0));
    // Establish baseline: a perception tick fires at t=0 in the kitchen.
    expect(spatial.shouldTriggerPerception('a1')).toBe(false);
    spatial.recordPerceptionTick('a1', 0);
  });

  it('returns true when idle for debounceSeconds + 1 (AC-7)', () => {
    spatial.update(makeTick(DEBOUNCE_SECONDS + 1));
    expect(spatial.shouldTriggerPerception('a1')).toBe(true);
  });

  it('returns false when idle for less than debounceSeconds (AC-8)', () => {
    spatial.update(makeTick(DEBOUNCE_SECONDS - 1));
    expect(spatial.shouldTriggerPerception('a1')).toBe(false);
  });
});

describe('SpatialSystem.shouldTriggerPerception — debounce skip (AC-10)', () => {
  it('returns false when neither condition is met', () => {
    const { agents } = setupAgent('kitchen');
    const spatial = makeSpatial(agents);
    spatial.update(makeTick(0));
    expect(spatial.shouldTriggerPerception('a1')).toBe(false);
    spatial.recordPerceptionTick('a1', 0);

    spatial.update(makeTick(1));
    // No room change, idle 1s < 5s.
    expect(spatial.shouldTriggerPerception('a1')).toBe(false);
  });
});

describe('SpatialSystem.recordPerceptionTick (AC-9)', () => {
  it('updates AgentInternalState.lastPerceptionTick to the passed simulationTime', () => {
    const { agents } = setupAgent('kitchen');
    const spatial = makeSpatial(agents);
    spatial.update(makeTick(42));
    spatial.recordPerceptionTick('a1', 42);
    const state = agents.getState('a1');
    expect(state?.lastPerceptionTick).toBe(42);
  });
});

describe('SpatialSystem.getObjectsInRoom (AC-1 projected shape)', () => {
  it('returns the projected { id, name, type } shape, no deep state', () => {
    const { agents } = setupAgent('kitchen');
    const registry = new SmartObjectRegistryImpl();
    registry.register({
      id: 'coffee-1',
      name: 'Coffee Machine',
      type: 'appliance',
      state: { water_level: 'low' },
      affordances: [],
      roomId: 'kitchen',
    });
    const spatial = new SpatialSystemImpl({
      agentManager: agents,
      registry,
      spatialDebounceSeconds: DEBOUNCE_SECONDS,
    });
    const objects = spatial.getObjectsInRoom('kitchen');
    expect(objects).toHaveLength(1);
    expect(objects[0]).toEqual({ id: 'coffee-1', name: 'Coffee Machine', type: 'appliance' });
    expect(objects[0]).not.toHaveProperty('state');
    expect(objects[0]).not.toHaveProperty('affordances');
  });
});
