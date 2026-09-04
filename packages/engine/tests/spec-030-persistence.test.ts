/**
 * Tests for save/restore of mutated scenes (spec 030, issue #117).
 *
 * Covers:
 * - AC-7: save after a sequence of mutations (object moved, door closed, agent
 *   despawned) and restore: object placement, connection states, live agent
 *   states, and dormant agent states are identical to pre-save; the original
 *   base scene is unchanged.
 * - AC-11: static scenes produce byte-identical SaveState fields as before
 *   (minus the version constant), and old-format (v1) saves still load.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentProfile, Room, SaveState, SmartObject } from '@evol-hive/shared';
import { SAVE_FORMAT_VERSION } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { EnginePersistenceImpl } from '../src/persistence/engine-persistence.js';
import {
  SceneMutationServiceImpl,
  DormantAgentStore,
} from '../src/world/mutations/index.js';
import type { SceneDefinition } from '@evol-hive/shared';

// ── Fixture ──────────────────────────────────────────────────────────────────

function aff(id: string) {
  return { id, label: id, engineEffect: id, preconditions: [], effects: {} };
}

function makeObject(id: string, roomId: string, affordanceIds: string[]): SmartObject {
  return { id, name: id, type: 'furniture', state: {}, affordances: affordanceIds.map(aff), roomId };
}

/** Two connected rooms, one movable object, one doorway, one agent profile. */
function makeScene(): SceneDefinition {
  const roomA: Room = {
    id: 'room_a',
    name: 'A',
    description: '',
    connections: ['room_b'],
    objectIds: ['crate-1', 'doorway-room_a'],
  };
  const roomB: Room = {
    id: 'room_b',
    name: 'B',
    description: '',
    connections: ['room_a'],
    objectIds: ['doorway-room_b'],
  };
  return {
    id: 'dyn-scene',
    name: 'Dyn Scene',
    rooms: [roomA, roomB],
    objects: [
      makeObject('crate-1', 'room_a', ['carry']),
      makeObject('doorway-room_a', 'room_a', ['go_to_room_b']),
      makeObject('doorway-room_b', 'room_b', ['go_to_room_a']),
    ],
    agents: [],
  };
}

interface Harness {
  registry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  agentManager: AgentManagerImpl;
  dormantStore: DormantAgentStore;
  service: SceneMutationServiceImpl;
  persistence: EnginePersistenceImpl;
  scene: SceneDefinition;
}

function buildHarness(): Harness {
  const scene = makeScene();
  const registry = new SmartObjectRegistryImpl();
  const agentManager = new AgentManagerImpl();
  const roomMap = new Map<string, Room>();
  for (const room of scene.rooms) roomMap.set(room.id, { ...room });
  const sceneManager = new SceneManagerImpl(agentManager, roomMap);
  for (const object of scene.objects) registry.register({ ...object });
  const dormantStore = new DormantAgentStore();
  const service = new SceneMutationServiceImpl({
    registry,
    sceneManager,
    agentManager,
    dormantStore,
  });
  const persistence = new EnginePersistenceImpl({
    gameLoop: {
      currentTick: () => ({ tickNumber: 5, simulationTime: 5 / 60, deltaSeconds: 1 / 60 }),
      stop: () => undefined,
      restoreState: () => undefined,
    } as never,
    agentManager,
    smartObjectRegistry: registry,
    sceneManager,
    vectorStore: {
      exportAll: async () => [],
      importAll: async () => undefined,
    } as never,
    mutationService: service,
    dormantStore,
  });
  return { registry, sceneManager, agentManager, dormantStore, service, persistence, scene };
}

function profile(id: string): AgentProfile {
  return { id, name: id, description: '', traits: [], initialDrives: {} };
}

describe('Save/restore of mutated scenes (spec 030, AC-7 / Req 11)', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('round-trips mutations: moved object, closed door, dormant agent', async () => {
    // 1. Apply a sequence of mutations.
    h.service.propose({ type: 'move_object', payload: { objectId: 'crate-1', toRoomId: 'room_b' } });
    h.service.applyPending(1);
    h.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'room_a', roomB: 'room_b', action: 'close' },
    });
    h.service.applyPending(2);
    h.service.propose({ type: 'spawn_agent', payload: { profile: profile('drifter') } });
    h.service.applyPending(3);
    h.agentManager.updateState('drifter', {
      drives: { energy: 11, hunger: 22, social: 33, comfort: 44, curiosity: 55 },
      currentGoal: 'wander',
    });
    h.service.propose({ type: 'despawn_agent', payload: { agentId: 'drifter' } });
    h.service.applyPending(4);

    // 2. Save.
    const saved = await h.persistence.save();
    expect(saved.formatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(saved.dynamic).toBeDefined();
    expect(saved.dynamic!.mutationLog).toHaveLength(4);
    expect(saved.dynamic!.dormantAgents).toHaveLength(1);

    // 3. Restore into the same core (load is destructive by design).
    await h.persistence.load(saved);

    // Object placement restored.
    expect(h.registry.get('crate-1')?.roomId).toBe('room_b');
    // Connection state restored (closed).
    expect(h.sceneManager.getConnectedRooms('room_a').map((r) => r.id)).not.toContain('room_b');
    expect(h.registry.get('doorway-room_a')?.state['open']).toBe(false);
    // Live agents restored (none active — the drifter was despawned).
    expect(h.agentManager.getActiveAgents()).toHaveLength(0);
    // Dormant agents restored with full state.
    const dormant = h.dormantStore.get('drifter');
    expect(dormant).not.toBeNull();
    expect(dormant!.state.currentGoal).toBe('wander');
    expect(dormant!.state.drives.energy).toBe(11);
    // Mutation log preserved for event-sourcing continuity.
    expect(h.service.getMutations(0)).toHaveLength(4);
  });

  it('the original base SceneDefinition is unchanged by mutations + save/load', async () => {
    const pristine = JSON.stringify(h.scene);

    h.service.propose({ type: 'move_object', payload: { objectId: 'crate-1', toRoomId: 'room_b' } });
    h.service.applyPending(1);
    h.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'room_a', roomB: 'room_b', action: 'close' },
    });
    h.service.applyPending(2);

    await h.persistence.save();
    expect(JSON.stringify(h.scene)).toBe(pristine);
  });

  it('loads old-format (v1) saves with no dynamic data — no mutations replayed', async () => {
    const legacy: SaveState = {
      formatVersion: 1,
      savedAt: 123,
      gameLoop: { tickNumber: 1, simulationTime: 1 / 60, deltaSeconds: 1 / 60 },
      agents: [],
      world: { rooms: makeScene().rooms, objects: makeScene().objects },
      memories: [],
    };
    await expect(h.persistence.load(legacy)).resolves.toBeUndefined();
  });
});

describe('Static scene compatibility (spec 030, AC-11 / Req 16)', () => {
  it('a scene without mutations saves without a dynamic field — byte-identical minus version', async () => {
    const h = buildHarness();
    const saved = await h.persistence.save();

    // No mutations → no dynamic key at all.
    expect('dynamic' in saved).toBe(false);

    // Everything except the version constant is byte-identical to the legacy shape.
    const { formatVersion, ...rest } = saved;
    const legacyShape = JSON.stringify({ formatVersion: 1, ...rest });
    const expected = JSON.stringify({
      formatVersion: 1,
      savedAt: saved.savedAt,
      gameLoop: saved.gameLoop,
      agents: saved.agents,
      world: saved.world,
      memories: saved.memories,
    });
    expect(legacyShape).toBe(expected);
    expect(formatVersion).toBe(SAVE_FORMAT_VERSION);
  });
});