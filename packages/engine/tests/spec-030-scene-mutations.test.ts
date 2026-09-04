/**
 * Tests for the SceneMutationService (spec 030, issue #117) — engine layer.
 *
 * Covers:
 * - AC-1: MoveObject updates roomId, getObjectsInRoom reflects both rooms,
 *   and the per-room affordance cache is invalidated so affordance lists move.
 * - AC-5: validation rejections with actionable SceneMutationError messages.
 * - AC-8: replaying getMutations(0) over the base scene reproduces the live
 *   scene exactly (event-sourcing determinism).
 * - Req 1: operations are queued and applied at tick boundaries only.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentProfile, SmartObject } from '@evol-hive/shared';
import { affordancesToToolDefinitions } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { AffordanceResolutionCache } from '../src/world/affordances/cache.js';
import {
  SceneMutationServiceImpl,
  DormantAgentStore,
} from '../src/world/mutations/index.js';
import { SceneMutationSystem } from '../src/world/mutations/index.js';
import { SceneMutationError } from '@evol-hive/shared';
import type { SceneDefinition, Room, SceneMutationEvent } from '@evol-hive/shared';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function aff(id: string) {
  return {
    id,
    label: id,
    engineEffect: id,
    preconditions: [],
    effects: {},
  };
}

function makeObject(id: string, roomId: string, affordanceIds: string[]): SmartObject {
  return {
    id,
    name: id,
    type: 'furniture',
    state: {},
    affordances: affordanceIds.map(aff),
    roomId,
  };
}

/** Two rooms, one object in each, connected pair + a doorway object in room_a. */
function makeScene(): SceneDefinition {
  const roomA: Room = {
    id: 'room_a',
    name: 'Room A',
    description: '',
    connections: ['room_b'],
    objectIds: ['desk-1', 'doorway-room_a'],
  };
  const roomB: Room = {
    id: 'room_b',
    name: 'Room B',
    description: '',
    connections: ['room_a'],
    objectIds: ['lamp-1', 'doorway-room_b'],
  };
  const doorwayA = makeObject('doorway-room_a', 'room_a', ['go_to_room_b', 'observe']);
  const doorwayB = makeObject('doorway-room_b', 'room_b', ['go_to_room_a', 'observe']);
  return {
    id: 'test-scene',
    name: 'Test Scene',
    rooms: [roomA, roomB],
    objects: [
      makeObject('desk-1', 'room_a', ['work']),
      makeObject('lamp-1', 'room_b', ['glow']),
      doorwayA,
      doorwayB,
    ],
    agents: [],
  };
}

/** Wire a mutation service over freshly-built subsystems from a scene. */
interface Harness {
  registry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  agentManager: AgentManagerImpl;
  dormantStore: DormantAgentStore;
  cache: AffordanceResolutionCache;
  service: SceneMutationServiceImpl;
}

function buildHarness(scene: SceneDefinition): Harness {
  const registry = new SmartObjectRegistryImpl();
  const agentManager = new AgentManagerImpl();
  const roomMap = new Map<string, Room>();
  for (const room of scene.rooms) {
    roomMap.set(room.id, {
      ...room,
      connections: [...room.connections],
      objectIds: [...room.objectIds],
    });
  }
  const sceneManager = new SceneManagerImpl(agentManager, roomMap);
  for (const object of scene.objects) {
    registry.register({
      ...object,
      state: { ...object.state },
      affordances: object.affordances.map((a) => ({ ...a })),
    });
  }
  const dormantStore = new DormantAgentStore();
  const cache = new AffordanceResolutionCache((roomId) =>
    affordancesToToolDefinitions(registry.getAffordancesInRoom(roomId)),
  );
  const service = new SceneMutationServiceImpl({
    registry,
    sceneManager,
    agentManager,
    dormantStore,
    affordanceCache: cache,
  });
  return { registry, sceneManager, agentManager, dormantStore, cache, service };
}

function profile(id: string, startRoomId?: string): AgentProfile {
  return {
    id,
    name: id,
    description: `test agent ${id}`,
    traits: [],
    initialDrives: { energy: 80 },
    ...(startRoomId !== undefined ? { startRoomId } : {}),
  };
}

/** Project live state for equality comparison (AC-8). */
function liveState(h: Harness) {
  return {
    rooms: h.sceneManager.getAllRooms().map((r) => ({
      id: r.id,
      connections: [...r.connections].sort(),
      objectIds: [...r.objectIds].sort(),
    })),
    objects: h.registry.getAll().map((o) => ({ id: o.id, roomId: o.roomId, state: o.state })),
    agents: h.agentManager.getActiveAgents().map((s) => ({
      agentId: s.agentId,
      location: s.location,
      drives: { ...s.drives },
    })),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SceneMutationService — queue & tick-boundary application (spec 030, Req 1)', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness(makeScene());
  });

  it('queues proposals and applies them only at applyPending()', () => {
    const result = h.service.propose({
      type: 'add_object',
      payload: { object: makeObject('crate-1', 'room_a', []) },
      source: 'engine',
    });
    expect(result.accepted).toBe(true);

    // Not applied yet — queued until the next tick boundary.
    expect(h.registry.get('crate-1')).toBeNull();

    h.service.applyPending(10);
    expect(h.registry.get('crate-1')?.roomId).toBe('room_a');
    expect(h.sceneManager.getRoom('room_a')?.objectIds).toContain('crate-1');
  });

  it('applies queued mutations in queue order with monotonically increasing seq', () => {
    h.service.propose({
      type: 'add_object',
      payload: { object: makeObject('crate-1', 'room_a', []) },
    });
    h.service.applyPending(5);
    // The move validates against the post-add state (propose-time validation,
    // Req 3) — it is enqueued after the add has been applied.
    h.service.propose({
      type: 'move_object',
      payload: { objectId: 'crate-1', toRoomId: 'room_b' },
    });
    h.service.applyPending(6);

    const log = h.service.getMutations();
    expect(log).toHaveLength(2);
    expect(log[0]!.seq).toBe(1);
    expect(log[1]!.seq).toBe(2);
    expect(log[0]!.type).toBe('add_object');
    expect(log[1]!.type).toBe('move_object');
    expect(log[0]!.tick).toBe(5);
    expect(log[1]!.tick).toBe(6);
    expect(log[0]!.source).toBe('engine');
  });

  it('getMutations(sinceSeq) returns only events after the given seq', () => {
    h.service.propose({
      type: 'add_object',
      payload: { object: makeObject('crate-1', 'room_a', []) },
    });
    h.service.applyPending(1);
    h.service.propose({ type: 'remove_object', payload: { objectId: 'crate-1' } });
    h.service.applyPending(2);

    expect(h.service.getMutations()).toHaveLength(2);
    expect(h.service.getMutations(1).map((e) => e.type)).toEqual(['remove_object']);
    expect(h.service.getMutations(0)).toHaveLength(2);
  });

  it('SceneMutationSystem applies pending mutations on each engine tick', () => {
    h.service.propose({
      type: 'add_object',
      payload: { object: makeObject('crate-1', 'room_a', []) },
    });
    const system = new SceneMutationSystem(h.service);
    system.update({ tickNumber: 7, simulationTime: 7 / 60, deltaSeconds: 1 / 60 });
    expect(h.registry.get('crate-1')).not.toBeNull();
    expect(h.service.getMutations()[0]!.tick).toBe(7);
  });

  it('add_object keeps room objectIds consistent (no orphans, no duplicates)', () => {
    h.service.propose({
      type: 'add_object',
      payload: { object: makeObject('crate-1', 'room_a', []) },
    });
    h.service.applyPending(1);
    const ids = h.sceneManager.getRoom('room_a')!.objectIds;
    expect(ids.filter((id) => id === 'crate-1')).toHaveLength(1);
  });
});

describe('MoveObject & affordance cache invalidation (spec 030, AC-1 / Req 4 / Req 5)', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness(makeScene());
  });

  it('moves the object between rooms and updates both room objectIds', () => {
    const result = h.service.propose({
      type: 'move_object',
      payload: { objectId: 'desk-1', toRoomId: 'room_b' },
      source: 'agent',
    });
    expect(result.accepted).toBe(true);
    h.service.applyPending(1);

    expect(h.registry.get('desk-1')?.roomId).toBe('room_b');
    expect(h.sceneManager.getRoom('room_a')!.objectIds).not.toContain('desk-1');
    expect(h.sceneManager.getRoom('room_b')!.objectIds).toContain('desk-1');

    const roomA = h.registry.getObjectsInRoom('room_a').map((o) => o.id);
    const roomB = h.registry.getObjectsInRoom('room_b').map((o) => o.id);
    expect(roomA).toContain('doorway-room_a');
    expect(roomA).not.toContain('desk-1');
    expect(roomB).toContain('desk-1');
  });

  it('invalidates the per-room affordance cache so affordance lists move with the object', () => {
    // Prime the cache for both rooms. The lamp's unique affordance 'glow'
    // starts in room_b only.
    const beforeA = h.cache.getAffordanceTools('room_a').map((t) => t.function.name);
    const beforeB = h.cache.getAffordanceTools('room_b').map((t) => t.function.name);
    expect(beforeA).toContain('work');
    expect(beforeA).not.toContain('glow');
    expect(beforeB).toContain('glow');

    const result = h.service.propose({
      type: 'move_object',
      payload: { objectId: 'lamp-1', toRoomId: 'room_a' },
    });
    expect(result.accepted).toBe(true);
    h.service.applyPending(1);

    // The cache reflects the new object distribution on the next read.
    const afterA = h.cache.getAffordanceTools('room_a').map((t) => t.function.name);
    const afterB = h.cache.getAffordanceTools('room_b').map((t) => t.function.name);
    expect(afterA).toContain('glow'); // lamp's affordance now in room_a
    expect(afterB).not.toContain('glow');
  });

  it('registry.setRoom and registry.remove exist and keep references consistent', () => {
    h.registry.setRoom('desk-1', 'room_b');
    expect(h.registry.get('desk-1')?.roomId).toBe('room_b');

    h.registry.remove('lamp-1');
    expect(h.registry.get('lamp-1')).toBeNull();
  });
});

describe('Mutation validation (spec 030, AC-5 / Req 3)', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness(makeScene());
  });

  it('rejects duplicate object ID with the offending ID named', () => {
    const result = h.service.propose({
      type: 'add_object',
      payload: { object: makeObject('desk-1', 'room_a', []) },
    });
    expect(result.accepted).toBe(false);
    expect(result.error).toContain('desk-1');
    expect(result.error).toContain('already exists');
  });

  it('rejects adding an object to a non-existent room', () => {
    const result = h.service.propose({
      type: 'add_object',
      payload: { object: makeObject('crate-1', 'null_room', []) },
    });
    expect(result.accepted).toBe(false);
    expect(result.error).toContain('null_room');
  });

  it('rejects removing an unknown object', () => {
    const result = h.service.propose({
      type: 'remove_object',
      payload: { objectId: 'ghost-1' },
    });
    expect(result.accepted).toBe(false);
    expect(result.error).toContain('ghost-1');
  });

  it('rejects moving an unknown object / to an unknown room (offending IDs named)', () => {
    const badObject = h.service.propose({
      type: 'move_object',
      payload: { objectId: 'ghost-1', toRoomId: 'room_b' },
    });
    expect(badObject.accepted).toBe(false);
    expect(badObject.error).toContain('ghost-1');

    const badRoom = h.service.propose({
      type: 'move_object',
      payload: { objectId: 'desk-1', toRoomId: 'null_room' },
    });
    expect(badRoom.accepted).toBe(false);
    expect(badRoom.error).toContain('null_room');
  });

  it('rejects spawn with out-of-range drive values (energy: 150)', () => {
    const bad = profile('bad-agent');
    bad.initialDrives = { energy: 150 };
    const result = h.service.propose({ type: 'spawn_agent', payload: { profile: bad } });
    expect(result.accepted).toBe(false);
    expect(result.error).toContain('bad-agent');
    expect(result.error).toContain('energy');
    expect(result.error).toContain('0–100');
  });

  it('rejects spawn with a non-existent start room', () => {
    const result = h.service.propose({
      type: 'spawn_agent',
      payload: { profile: profile('wanderer', 'null_room') },
    });
    expect(result.accepted).toBe(false);
    expect(result.error).toContain('null_room');
  });

  it('rejects duplicate agent spawn', () => {
    h.agentManager.spawn(profile('dupe-agent'));
    const result = h.service.propose({
      type: 'spawn_agent',
      payload: { profile: profile('dupe-agent') },
    });
    expect(result.accepted).toBe(false);
    expect(result.error).toContain('dupe-agent');
  });

  it('rejects despawn of an unknown agent', () => {
    const result = h.service.propose({ type: 'despawn_agent', payload: { agentId: 'ghost' } });
    expect(result.accepted).toBe(false);
    expect(result.error).toContain('ghost');
  });

  it('rejects removing a room’s last connection (zero-connection rule)', () => {
    // room_b's only connection is room_a. Removing it isolates room_b.
    const result = h.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'room_a', roomB: 'room_b', action: 'remove' },
    });
    expect(result.accepted).toBe(false);
    expect(result.error).toContain('room_b');
    expect(result.error).toContain('zero connections');
  });

  it('rejects connection operations on unknown or non-connected rooms', () => {
    const unknownRoom = h.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'room_a', roomB: 'null_room', action: 'close' },
    });
    expect(unknownRoom.accepted).toBe(false);
    expect(unknownRoom.error).toContain('null_room');

    const notConnected = h.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'room_a', roomB: 'room_b', action: 'open' },
    });
    // room_a–room_b is open, so "open" on an already-open pair is accepted as a no-op…
    expect(notConnected.accepted).toBe(true);

    const insertDuplicate = h.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'room_a', roomB: 'room_b', action: 'insert' },
    });
    expect(insertDuplicate.accepted).toBe(false);
    expect(insertDuplicate.error).toContain('room_a');
    expect(insertDuplicate.error).toContain('room_b');
  });

  it('validation errors thrown from validate() are SceneMutationError instances', () => {
    expect(() =>
      h.service.validate({
        type: 'add_object',
        payload: { object: makeObject('desk-1', 'room_a', []) },
      }),
    ).toThrow(SceneMutationError);
  });
});

describe('Event-sourcing determinism (spec 030, AC-8 / Req 2)', () => {
  it('replaying getMutations(0) over the base scene reproduces the exact live scene', () => {
    // Original run: a sequence of structural mutations.
    const scene = makeScene();
    const h1 = buildHarness(scene);
    h1.service.propose({
      type: 'add_object',
      payload: { object: makeObject('crate-1', 'room_a', ['carry']) },
    });
    h1.service.applyPending(1);
    h1.service.propose({ type: 'move_object', payload: { objectId: 'crate-1', toRoomId: 'room_b' } });
    h1.service.applyPending(2);
    h1.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'room_a', roomB: 'room_b', action: 'close' },
    });
    h1.service.applyPending(3);
    h1.service.propose({ type: 'spawn_agent', payload: { profile: profile('mover', 'room_a') } });
    h1.service.applyPending(4);
    h1.agentManager.updateState('mover', { currentGoal: 'carry the crate' });
    h1.service.propose({ type: 'despawn_agent', payload: { agentId: 'mover' } });
    h1.service.applyPending(5);

    const log: SceneMutationEvent[] = h1.service.getMutations(0);
    expect(log.length).toBe(5);

    // Replay over a fresh base scene.
    const h2 = buildHarness(makeScene());
    for (const event of log) {
      const result = h2.service.propose({ type: event.type, payload: event.payload });
      if (!result.accepted) {
        throw new Error(`replay rejected event ${event.seq}: ${result.error}`);
      }
      h2.service.applyPending(event.tick);
    }

    expect(liveState(h2)).toEqual(liveState(h1));
  });
});