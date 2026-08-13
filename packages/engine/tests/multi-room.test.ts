/**
 * Multi-Room Integration Tests (spec 008)
 * ───────────────────────────────────────
 * Exercises agent navigation between rooms, object/affordance room scoping,
 * spatial debouncing on room change, SceneDefinition loading, and cross-cutting
 * multi-agent multi-room perception isolation. All tests use existing engine
 * systems — no new production code.
 *
 * Covers: AC-8, AC-9, AC-10, AC-11, AC-12, AC-13, AC-14, AC-15
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type {
  GameTick,
  AgentProfile,
  Room,
  SmartObject,
  Affordance,
  SceneDefinition,
  EngineConfig,
} from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SpatialSystemImpl } from '../src/spatial/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { GameLoopImpl } from '../src/loop/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { DriveDecaySystem } from '../src/systems/drive-decay.js';
import { PerceptionDataProviderImpl } from '../src/agents/perception/index.js';
import { createEngineCore, loadScene } from '../src/assembly.js';
import type { EngineSystem } from '../src/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAgent(id: string): AgentProfile {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

function makeAffordance(id: string, label = id): Affordance {
  return {
    id,
    label,
    engineEffect: id,
    preconditions: [],
    effects: {},
  };
}

function makeObject(id: string, roomId: string, affordances: Affordance[] = []): SmartObject {
  return {
    id,
    name: id.replace(/-/g, ' '),
    type: 'appliance',
    state: {},
    affordances,
    roomId,
  };
}

function makeConfig(fps = 60): EngineConfig {
  return {
    fps,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
  };
}

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
  objectIds: ['couch-1'],
};

const kitchenObject = makeObject('coffee-1', 'kitchen', [
  makeAffordance('brew_coffee'),
  makeAffordance('observe'),
]);

const loungeObject = makeObject('couch-1', 'lounge', [
  makeAffordance('sit_down'),
  makeAffordance('observe'),
]);

function setupTwoRooms() {
  const agents = new AgentManagerImpl();
  agents.spawn(makeAgent('a1'));
  agents.updateState('a1', { location: 'kitchen', lastPerceptionTick: 0 });

  const registry = new SmartObjectRegistryImpl();
  registry.register(kitchenObject);
  registry.register(loungeObject);

  const scene = new SceneManagerImpl(
    agents,
    new Map([
      ['kitchen', kitchen],
      ['lounge', lounge],
    ]),
  );

  const spatial = new SpatialSystemImpl({
    agentManager: agents,
    registry,
    spatialDebounceSeconds: 5,
  });

  const driveSystem = new DriveSystemImpl(agents);
  const perception = new PerceptionDataProviderImpl(agents, registry, driveSystem, {
    getSystemFeedback: () => undefined,
    setSystemFeedback: () => {},
    clearSystemFeedback: () => {},
  } as never);

  return { agents, registry, scene, spatial, perception };
}

// ─── AC-8: moveAgent → getAgentRoom reflects new room ─────────────────────────

describe('Multi-Room — agent navigation (AC-8)', () => {
  it("getAgentRoom returns the lounge Room after moveAgent(agentId, 'lounge')", () => {
    const { scene } = setupTwoRooms();

    // Initially in kitchen.
    expect(scene.getAgentRoom('a1')).toEqual(kitchen);

    // Move to lounge.
    scene.moveAgent('a1', 'lounge');
    expect(scene.getAgentRoom('a1')).toEqual(lounge);
  });

  it('getAgentRoom returns null for an unknown agent', () => {
    const { scene } = setupTwoRooms();
    expect(scene.getAgentRoom('unknown')).toBeNull();
  });
});

// ─── AC-9: After moving, getObjectsInRoom returns only new room objects ───────

describe('Multi-Room — object scoping after move (AC-9)', () => {
  it("getObjectsInRoom('lounge') returns only lounge objects after agent moves from kitchen", () => {
    const { scene, registry } = setupTwoRooms();

    // Before move: kitchen has coffee-1.
    const kitchenObjects = registry.getObjectsInRoom('kitchen');
    expect(kitchenObjects).toHaveLength(1);
    expect(kitchenObjects[0]!.id).toBe('coffee-1');

    // Move agent.
    scene.moveAgent('a1', 'lounge');

    // After move: lounge has couch-1, kitchen objects don't appear in lounge.
    const loungeObjects = registry.getObjectsInRoom('lounge');
    expect(loungeObjects).toHaveLength(1);
    expect(loungeObjects[0]!.id).toBe('couch-1');
    // Kitchen objects are NOT in lounge.
    const loungeIds = loungeObjects.map((o) => o.id);
    expect(loungeIds).not.toContain('coffee-1');
  });
});

// ─── AC-10: After moving, getAffordancesInRoom returns only new room affordances

describe('Multi-Room — affordance scoping after move (AC-10)', () => {
  it("getAffordancesInRoom('lounge') returns only lounge affordances after move", () => {
    const { scene, registry } = setupTwoRooms();

    // Before move: kitchen has brew_coffee and observe.
    const kitchenAffs = registry.getAffordancesInRoom('kitchen');
    expect(kitchenAffs.map((a) => a.id).sort()).toEqual(['brew_coffee', 'observe']);

    // Move agent.
    scene.moveAgent('a1', 'lounge');

    // After move: lounge has sit_down and observe — no kitchen affordances.
    const loungeAffs = registry.getAffordancesInRoom('lounge');
    const loungeAffIds = loungeAffs.map((a) => a.id).sort();
    expect(loungeAffIds).toEqual(['observe', 'sit_down']);
    // No kitchen-only affordances leak.
    expect(loungeAffIds).not.toContain('brew_coffee');
  });
});

// ─── AC-11: Moving triggers spatial debouncing ───────────────────────────────

describe('Multi-Room — spatial debouncing on room change (AC-11)', () => {
  it('shouldTriggerPerception returns true on the next tick after moveAgent', () => {
    const { scene, spatial } = setupTwoRooms();

    // Baseline: establish lastLocation.
    spatial.update({ tickNumber: 0, simulationTime: 0, deltaSeconds: 0 });
    expect(spatial.shouldTriggerPerception('a1')).toBe(false);
    spatial.recordPerceptionTick('a1', 0);

    // Move agent to lounge.
    scene.moveAgent('a1', 'lounge');

    // Next tick: room boundary crossed → perception should trigger.
    spatial.update({ tickNumber: 1, simulationTime: 0.0167, deltaSeconds: 0.0167 });
    expect(spatial.shouldTriggerPerception('a1')).toBe(true);
  });
});

// ─── AC-12: Loading SceneDefinition with 3 rooms, 5 objects, 2 agents ─────────

describe('Multi-Room — SceneDefinition loading (AC-12)', () => {
  it('loads 3 connected rooms, 5 objects, and 2 agents into correct initial state', () => {
    const config = makeConfig();
    const core = createEngineCore(config);

    // Build a scene with 3 connected rooms and 5 objects.
    const roomA: Room = {
      id: 'room-a',
      name: 'Room A',
      description: 'First room',
      connections: ['room-b'],
      objectIds: ['obj-1', 'obj-2'],
    };
    const roomB: Room = {
      id: 'room-b',
      name: 'Room B',
      connections: ['room-a', 'room-c'],
      description: 'Second room',
      objectIds: ['obj-3', 'obj-4'],
    };
    const roomC: Room = {
      id: 'room-c',
      name: 'Room C',
      description: 'Third room',
      connections: ['room-b'],
      objectIds: ['obj-5'],
    };

    const scene: SceneDefinition = {
      id: 'test-scene',
      name: 'Test Scene',
      rooms: [roomA, roomB, roomC],
      objects: [
        makeObject('obj-1', 'room-a', [makeAffordance('use_1')]),
        makeObject('obj-2', 'room-a', [makeAffordance('use_2')]),
        makeObject('obj-3', 'room-b', [makeAffordance('use_3')]),
        makeObject('obj-4', 'room-b', [makeAffordance('use_4')]),
        makeObject('obj-5', 'room-c', [makeAffordance('use_5')]),
      ],
      agents: [makeAgent('agent-1'), makeAgent('agent-2')],
    };

    loadScene(core, scene);

    // Verify rooms loaded — getConnectedRooms returns the expected graph.
    expect(core.sceneManager.getRoom('room-a')).toEqual(roomA);
    expect(core.sceneManager.getRoom('room-b')).toEqual(roomB);
    expect(core.sceneManager.getRoom('room-c')).toEqual(roomC);

    // room-a connects to room-b.
    const aConnections = core.sceneManager.getConnectedRooms('room-a');
    expect(aConnections).toHaveLength(1);
    expect(aConnections[0]!.id).toBe('room-b');

    // room-b connects to room-a and room-c.
    const bConnections = core.sceneManager.getConnectedRooms('room-b');
    expect(bConnections).toHaveLength(2);
    const bConnIds = bConnections.map((r) => r.id).sort();
    expect(bConnIds).toEqual(['room-a', 'room-c']);

    // room-c connects to room-b.
    const cConnections = core.sceneManager.getConnectedRooms('room-c');
    expect(cConnections).toHaveLength(1);
    expect(cConnections[0]!.id).toBe('room-b');

    // Verify objects scoped to rooms.
    expect(core.smartObjectRegistry.getObjectsInRoom('room-a')).toHaveLength(2);
    expect(core.smartObjectRegistry.getObjectsInRoom('room-b')).toHaveLength(2);
    expect(core.smartObjectRegistry.getObjectsInRoom('room-c')).toHaveLength(1);

    // Verify agents spawned — loadScene puts all agents in the first room.
    expect(core.agentManager.getState('agent-1')).not.toBeNull();
    expect(core.agentManager.getState('agent-2')).not.toBeNull();
    expect(core.agentManager.getState('agent-1')?.location).toBe('room-a');
    expect(core.agentManager.getState('agent-2')?.location).toBe('room-a');

    // Manually move agent-2 to room-c to simulate different starting rooms.
    core.agentManager.updateState('agent-2', { location: 'room-c' });
    expect(core.sceneManager.getAgentRoom('agent-2')?.id).toBe('room-c');
  });
});

// ─── AC-13: Agent in room A cannot access affordances from room B ────────────

describe('Multi-Room — affordance room isolation (AC-13)', () => {
  it("getAffordancesInRoom('room-a') excludes all affordances from objects in room-b", () => {
    const registry = new SmartObjectRegistryImpl();

    // Room A objects.
    registry.register(makeObject('obj-1', 'room-a', [makeAffordance('use_a1')]));
    registry.register(makeObject('obj-2', 'room-a', [makeAffordance('use_a2')]));

    // Room B objects.
    registry.register(makeObject('obj-3', 'room-b', [makeAffordance('use_b1')]));
    registry.register(makeObject('obj-4', 'room-b', [makeAffordance('use_b2')]));

    const roomAAffs = registry.getAffordancesInRoom('room-a');
    const roomAAffIds = roomAAffs.map((a) => a.id);
    expect(roomAAffIds).toContain('use_a1');
    expect(roomAAffIds).toContain('use_a2');
    // Room B affordances are NOT accessible from room A.
    expect(roomAAffIds).not.toContain('use_b1');
    expect(roomAAffIds).not.toContain('use_b2');

    // And vice-versa.
    const roomBAffs = registry.getAffordancesInRoom('room-b');
    const roomBAffIds = roomBAffs.map((a) => a.id);
    expect(roomBAffIds).toContain('use_b1');
    expect(roomBAffIds).toContain('use_b2');
    expect(roomBAffIds).not.toContain('use_a1');
    expect(roomBAffIds).not.toContain('use_a2');
  });
});

// ─── AC-14: Full game loop with 2 agents in 2 rooms → per-agent perception ────

describe('Multi-Room — full game loop perception isolation (AC-14)', () => {
  it('produces per-agent perception data scoped to each agent current room with no cross-room leakage', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));
    agents.updateState('a1', { location: 'kitchen', lastPerceptionTick: 0 });
    agents.updateState('a2', { location: 'lounge', lastPerceptionTick: 0 });

    const registry = new SmartObjectRegistryImpl();
    registry.register(kitchenObject);
    registry.register(loungeObject);

    const driveSystem = new DriveSystemImpl(agents);
    const perception = new PerceptionDataProviderImpl(agents, registry, driveSystem, {
      getSystemFeedback: () => undefined,
      setSystemFeedback: () => {},
      clearSystemFeedback: () => {},
    } as never);

    // Agent a1 is in kitchen → sees coffee-1, not couch-1.
    const a1Location = perception.getAgentLocation('a1');
    expect(a1Location).toBe('kitchen');
    const a1Objects = perception.getObjectsInRoom(a1Location);
    expect(a1Objects).toHaveLength(1);
    expect(a1Objects[0]!.id).toBe('coffee-1');

    const a1Affs = perception.getAffordancesInRoom(a1Location);
    expect(a1Affs.map((a) => a.id).sort()).toEqual(['brew_coffee', 'observe']);

    // Agent a2 is in lounge → sees couch-1, not coffee-1.
    const a2Location = perception.getAgentLocation('a2');
    expect(a2Location).toBe('lounge');
    const a2Objects = perception.getObjectsInRoom(a2Location);
    expect(a2Objects).toHaveLength(1);
    expect(a2Objects[0]!.id).toBe('couch-1');

    const a2Affs = perception.getAffordancesInRoom(a2Location);
    expect(a2Affs.map((a) => a.id).sort()).toEqual(['observe', 'sit_down']);

    // No cross-room leakage: a1's objects don't include couch-1.
    expect(a1Objects.map((o) => o.id)).not.toContain('couch-1');
    // a2's objects don't include coffee-1.
    expect(a2Objects.map((o) => o.id)).not.toContain('coffee-1');

    // Run a few game loop ticks to verify the loop doesn't cause leakage.
    const spatial = new SpatialSystemImpl({
      agentManager: agents,
      registry,
      spatialDebounceSeconds: 5,
    });
    const loop = new GameLoopImpl(makeConfig(60));
    loop.registerSystem(spatial);
    loop.injectElapsed(0.02); // 1 tick

    // After one tick, perception is still scoped correctly.
    expect(perception.getObjectsInRoom(perception.getAgentLocation('a1'))).toHaveLength(1);
    expect(perception.getObjectsInRoom(perception.getAgentLocation('a2'))).toHaveLength(1);
  });
});

// ─── AC-15: One agent moves, other stays → only mover's perception triggered ──

describe('Multi-Room — selective spatial debouncing (AC-15)', () => {
  it('only the moving agent perception is triggered; stationary agent is unaffected', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));
    agents.updateState('a1', { location: 'kitchen', lastPerceptionTick: 0 });
    agents.updateState('a2', { location: 'lounge', lastPerceptionTick: 0 });

    const registry = new SmartObjectRegistryImpl();
    registry.register(kitchenObject);
    registry.register(loungeObject);

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

    // Baseline: establish lastLocation for both agents.
    spatial.update({ tickNumber: 0, simulationTime: 0, deltaSeconds: 0 });
    expect(spatial.shouldTriggerPerception('a1')).toBe(false);
    spatial.recordPerceptionTick('a1', 0);
    expect(spatial.shouldTriggerPerception('a2')).toBe(false);
    spatial.recordPerceptionTick('a2', 0);

    // Only a1 moves to lounge.
    scene.moveAgent('a1', 'lounge');

    // Next tick.
    spatial.update({ tickNumber: 1, simulationTime: 0.0167, deltaSeconds: 0.0167 });

    // a1 (moved) → perception should trigger.
    expect(spatial.shouldTriggerPerception('a1')).toBe(true);

    // a2 (stayed in lounge) → perception should NOT trigger.
    // a2's location hasn't changed, and idle time (0.0167s) < debounce (5s).
    expect(spatial.shouldTriggerPerception('a2')).toBe(false);
  });
});
