/**
 * Multi-agent + multi-room combined integration tests (spec 008, AC-11, AC-12).
 *
 * Covers:
 *  - AC-11: Agents in different rooms perceive only their own room's objects
 *  - AC-12: Agent moving between rooms receives perception updates for the new room
 */
import { describe, it, expect } from 'vitest';
import type {
  Room,
  SmartObject,
  Affordance,
  AgentProfile,
} from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { PerceptionDataProviderImpl } from '../src/agents/perception/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { SystemFeedbackStore } from '../src/agents/feedback/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(id: string): AgentProfile {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

// ── Scene fixtures ───────────────────────────────────────────────────────────

const observe: Affordance = {
  id: 'observe',
  label: 'Observe',
  engineEffect: 'observe',
  preconditions: [],
  effects: {},
};

const brewCoffee: Affordance = {
  id: 'brew_coffee',
  label: 'Brew coffee',
  engineEffect: 'brew_coffee',
  preconditions: [],
  effects: { energy: 20 },
};

const sit: Affordance = {
  id: 'sit',
  label: 'Sit',
  engineEffect: 'sit',
  preconditions: [],
  effects: { comfort: 10 },
};

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
  objectIds: ['sofa-1'],
};

const coffeeMachine: SmartObject = {
  id: 'coffee-1',
  name: 'Coffee Machine',
  type: 'appliance',
  state: { water_level: 5, bean_count: 12 },
  affordances: [brewCoffee, observe],
  roomId: 'kitchen',
};

const sofa: SmartObject = {
  id: 'sofa-1',
  name: 'Sofa',
  type: 'furniture',
  state: { cushion_wear: 0 },
  affordances: [sit, observe],
  roomId: 'lounge',
};

/**
 * Shared setup: builds a multi-room scene with kitchen (CoffeeMachine) and
 * lounge (Sofa), plus a perception data provider backed by the real engine
 * subsystems.
 */
function setupMultiRoomScene() {
  const agents = new AgentManagerImpl();
  const smartRegistry = new SmartObjectRegistryImpl();
  const driveSystem = new DriveSystemImpl(agents);
  const feedbackStore = new SystemFeedbackStore();
  const perception = new PerceptionDataProviderImpl(
    agents,
    smartRegistry,
    driveSystem,
    feedbackStore,
  );
  const scene = new SceneManagerImpl(
    agents,
    new Map<string, Room>([
      ['kitchen', kitchen],
      ['lounge', lounge],
    ]),
  );

  smartRegistry.register(coffeeMachine);
  smartRegistry.register(sofa);

  return { agents, smartRegistry, driveSystem, feedbackStore, perception, scene };
}

// ── AC-11: Agents in different rooms perceive only their own room ─────────────

describe('Multi-agent + multi-room — AC-11: agents in different rooms perceive only their own room', () => {
  it('agent A in kitchen sees CoffeeMachine; agent B in lounge sees Sofa; no cross-room interference', () => {
    const ctx = setupMultiRoomScene();

    // Spawn agent A in kitchen, agent B in lounge.
    ctx.agents.spawn(makeAgent('a1'));
    ctx.agents.updateState('a1', { location: 'kitchen' });
    ctx.agents.spawn(makeAgent('a2'));
    ctx.agents.updateState('a2', { location: 'lounge' });

    // Agent A's perception: kitchen objects.
    const a1Location = ctx.perception.getAgentLocation('a1');
    const a1Objects = ctx.perception.getObjectsInRoom(a1Location);
    const a1Affordances = ctx.perception.getAffordancesInRoom(a1Location);

    expect(a1Location).toBe('kitchen');
    expect(a1Objects).toHaveLength(1);
    expect(a1Objects[0]?.id).toBe('coffee-1');
    expect(a1Affordances.map((a) => a.id)).toContain('brew_coffee');
    expect(a1Affordances.map((a) => a.id)).not.toContain('sit');

    // Agent B's perception: lounge objects.
    const a2Location = ctx.perception.getAgentLocation('a2');
    const a2Objects = ctx.perception.getObjectsInRoom(a2Location);
    const a2Affordances = ctx.perception.getAffordancesInRoom(a2Location);

    expect(a2Location).toBe('lounge');
    expect(a2Objects).toHaveLength(1);
    expect(a2Objects[0]?.id).toBe('sofa-1');
    expect(a2Affordances.map((a) => a.id)).toContain('sit');
    expect(a2Affordances.map((a) => a.id)).not.toContain('brew_coffee');

    // Neither agent's perception includes objects from the other's room.
    expect(a1Objects.find((o) => o.id === 'sofa-1')).toBeUndefined();
    expect(a2Objects.find((o) => o.id === 'coffee-1')).toBeUndefined();
  });
});

// ── AC-12: Agent moving between rooms receives new perception ────────────────

describe('Multi-agent + multi-room — AC-12: agent moving between rooms gets new perception', () => {
  it('after moving from kitchen to lounge, perception reflects lounge objects only', () => {
    const ctx = setupMultiRoomScene();

    // Spawn agent in kitchen.
    ctx.agents.spawn(makeAgent('a1'));
    ctx.agents.updateState('a1', { location: 'kitchen' });

    // First "PPER cycle" perception: kitchen objects.
    let location = ctx.perception.getAgentLocation('a1');
    let objects = ctx.perception.getObjectsInRoom(location);
    let affordances = ctx.perception.getAffordancesInRoom(location);

    expect(location).toBe('kitchen');
    expect(objects.map((o) => o.id)).toContain('coffee-1');
    expect(affordances.map((a) => a.id)).toContain('brew_coffee');
    expect(objects.find((o) => o.id === 'sofa-1')).toBeUndefined();

    // Agent moves to lounge (between ticks).
    ctx.scene.moveAgent('a1', 'lounge');

    // Second "PPER cycle" perception: lounge objects.
    location = ctx.perception.getAgentLocation('a1');
    objects = ctx.perception.getObjectsInRoom(location);
    affordances = ctx.perception.getAffordancesInRoom(location);

    expect(location).toBe('lounge');
    expect(objects.map((o) => o.id)).toContain('sofa-1');
    expect(affordances.map((a) => a.id)).toContain('sit');
    // CoffeeMachine from the previous room is no longer in perception.
    expect(objects.find((o) => o.id === 'coffee-1')).toBeUndefined();
    expect(affordances.map((a) => a.id)).not.toContain('brew_coffee');
  });
});