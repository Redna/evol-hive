/**
 * Tests for SceneManagerImpl — in-memory room graph & agent movement.
 * Covers AC-9, AC-10.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Room, AgentProfile } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SpatialSystemImpl } from '../src/spatial/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';

const kitchen: Room = {
  id: 'kitchen',
  name: 'Kitchen',
  description: 'A small kitchen',
  connections: ['lounge'],
  objectIds: ['coffee-1'],
};

const lounge: Room = {
  id: 'lounge',
  name: 'Lounge',
  description: 'A cozy lounge',
  connections: ['kitchen'],
  objectIds: [],
};

function makeAgent(id = 'a1'): AgentProfile {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

function setup() {
  const agents = new AgentManagerImpl();
  agents.spawn(makeAgent('a1'));
  agents.updateState('a1', { location: 'kitchen' });
  const scene = new SceneManagerImpl(
    agents,
    new Map<string, Room>([
      ['kitchen', kitchen],
      ['lounge', lounge],
    ]),
  );
  return { agents, scene };
}

describe('SceneManagerImpl (AC-9)', () => {
  it('getRoom returns the registered Room or null', () => {
    const { scene } = setup();
    expect(scene.getRoom('kitchen')).toEqual(kitchen);
    expect(scene.getRoom('lounge')).toEqual(lounge);
    expect(scene.getRoom('nonexistent')).toBeNull();
  });

  it('getConnectedRooms returns all rooms whose IDs appear in room.connections', () => {
    const { scene } = setup();
    const connected = scene.getConnectedRooms('kitchen');
    expect(connected).toHaveLength(1);
    expect(connected[0]).toEqual(lounge);
  });

  it('getConnectedRooms returns empty for a room with no connections', () => {
    const agents = new AgentManagerImpl();
    const isolated: Room = {
      id: 'closet',
      name: 'Closet',
      description: '',
      connections: [],
      objectIds: [],
    };
    const scene = new SceneManagerImpl(agents, new Map([['closet', isolated]]));
    expect(scene.getConnectedRooms('closet')).toEqual([]);
  });

  it('moveAgent updates AgentInternalState.location', () => {
    const { agents, scene } = setup();
    scene.moveAgent('a1', 'lounge');
    expect(agents.getState('a1')?.location).toBe('lounge');
  });

  it('getAgentRoom returns the Room matching the agent current location', () => {
    const { scene } = setup();
    expect(scene.getAgentRoom('a1')).toEqual(kitchen);
    scene.moveAgent('a1', 'lounge');
    expect(scene.getAgentRoom('a1')).toEqual(lounge);
  });

  it('getAgentRoom returns null when the agent location has no matching room', () => {
    const { scene } = setup();
    expect(scene.getAgentRoom('unknown-agent')).toBeNull();
  });
});

describe('SceneManagerImpl — spatial debouncing (AC-10)', () => {
  it('moveAgent updates location, causing shouldTriggerPerception to return true on the next tick', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.updateState('a1', { location: 'kitchen', lastPerceptionTick: 0 });
    const registry = new SmartObjectRegistryImpl();
    const spatial = new SpatialSystemImpl({
      agentManager: agents,
      registry,
      spatialDebounceSeconds: 5,
    });
    const scene = new SceneManagerImpl(
      agents,
      new Map([
        ['kitchen', kitchen],
        ['lounge', lounge],
      ]),
    );

    spatial.update({ tickNumber: 0, simulationTime: 0, deltaSeconds: 0 });
    // Establish baseline.
    expect(spatial.shouldTriggerPerception('a1')).toBe(false);
    spatial.recordPerceptionTick('a1', 0);

    // Move agent to lounge.
    scene.moveAgent('a1', 'lounge');
    // Next tick — room boundary crossed.
    spatial.update({ tickNumber: 1, simulationTime: 0.0167, deltaSeconds: 0.0167 });
    expect(spatial.shouldTriggerPerception('a1')).toBe(true);
  });
});
