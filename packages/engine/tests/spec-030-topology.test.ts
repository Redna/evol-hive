/**
 * Tests for dynamic topology — connection state management (spec 030, #117).
 *
 * Covers:
 * - AC-4: after setConnectionOpen(A, B, false): getConnectedRooms(A) excludes B,
 *   navigation to B is rejected by plan validation (TopologyGuard), and
 *   cross-door affordances (go_to_*) are no longer offered. Re-opening
 *   restores all three.
 * - Req 9: closed connections preserve the doorway smart object with
 *   state.open = false; doorway open_door/close_door engine effects call
 *   SceneMutationService.setConnectionState.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Affordance, GuardrailConfig, Room, SmartObject } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { SceneMutationServiceImpl, DormantAgentStore } from '../src/world/mutations/index.js';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function aff(id: string): Affordance {
  return { id, label: id, engineEffect: id, preconditions: [], effects: {} };
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

function makeDoorway(id: string, roomId: string, targets: string[]): SmartObject {
  return {
    id,
    name: 'Doorway',
    type: 'doorway',
    state: { open: true },
    affordances: [...targets.map((t) => aff(`go_to_${t}`)), aff('observe')],
    roomId,
  };
}

/** office ↔ lab (with doorway objects), office ↔ lounge. */
function makeScene(): { registry: SmartObjectRegistryImpl; sceneManager: SceneManagerImpl; agentManager: AgentManagerImpl } {
  const office: Room = {
    id: 'office',
    name: 'Office',
    description: '',
    connections: ['lab', 'lounge'],
    objectIds: ['doorway-office', 'desk-1'],
  };
  const lab: Room = {
    id: 'lab',
    name: 'Lab',
    description: '',
    connections: ['office'],
    objectIds: ['doorway-lab'],
  };
  const lounge: Room = {
    id: 'lounge',
    name: 'Lounge',
    description: '',
    connections: ['office'],
    objectIds: ['sofa-1'],
  };
  const agentManager = new AgentManagerImpl();
  const roomMap = new Map<string, Room>(
    Object.entries({ office, lab, lounge }).map(([id, room]) => [id, { ...room }]),
  );
  const sceneManager = new SceneManagerImpl(agentManager, roomMap);
  const registry = new SmartObjectRegistryImpl();
  for (const object of [
    makeDoorway('doorway-office', 'office', ['lab', 'lounge']),
    makeDoorway('doorway-lab', 'lab', ['office']),
    makeObject('desk-1', 'office', ['work']),
    makeObject('sofa-1', 'lounge', ['relax']),
  ]) {
    registry.register({ ...object });
  }
  return { registry, sceneManager, agentManager };
}

function buildService() {
  const { registry, sceneManager, agentManager } = makeScene();
  const service = new SceneMutationServiceImpl({
    registry,
    sceneManager,
    agentManager,
    dormantStore: new DormantAgentStore(),
  });
  return { registry, sceneManager, agentManager, service };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Connection state management (spec 030, AC-4 / Req 9)', () => {
  let s: ReturnType<typeof buildService>;
  beforeEach(() => {
    s = buildService();
  });

  it('getConnectedRooms(office) excludes lab after close, and restores after reopen', () => {
    s.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'office', roomB: 'lab', action: 'close' },
    });
    s.service.applyPending(1);

    const connected = s.sceneManager.getConnectedRooms('office').map((r) => r.id);
    expect(connected).not.toContain('lab');
    expect(connected).toContain('lounge');

    // Re-opening restores adjacency.
    s.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'office', roomB: 'lab', action: 'open' },
    });
    s.service.applyPending(2);
    expect(s.sceneManager.getConnectedRooms('office').map((r) => r.id)).toContain('lab');
  });

  it('closing preserves the doorway smart object with state.open = false (Req 9)', () => {
    s.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'office', roomB: 'lab', action: 'close' },
    });
    s.service.applyPending(1);

    const doorway = s.registry.get('doorway-office');
    expect(doorway).not.toBeNull();
    expect(doorway!.state['open']).toBe(false);
    // go_to affordances remain defined on the object (not stripped).
    expect(doorway!.affordances.map((a) => a.id)).toContain('go_to_lab');

    // Re-open sets state.open back to true.
    s.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'office', roomB: 'lab', action: 'open' },
    });
    s.service.applyPending(2);
    expect(s.registry.get('doorway-office')!.state['open']).toBe(true);
  });

  it('setConnectionOpen / addConnection exist on the SceneManager (Req 9)', () => {
    s.sceneManager.setConnectionOpen('office', 'lab', false);
    expect(s.sceneManager.getConnectedRooms('office').map((r) => r.id)).not.toContain('lab');
    s.sceneManager.setConnectionOpen('office', 'lab', true);
    expect(s.sceneManager.getConnectedRooms('office').map((r) => r.id)).toContain('lab');

    s.sceneManager.addConnection('lounge', 'lab');
    expect(s.sceneManager.getConnectedRooms('lounge').map((r) => r.id)).toContain('lab');
    expect(s.sceneManager.getConnectedRooms('lab').map((r) => r.id)).toContain('lounge');
  });

  it('base scene rooms are not mutated by connection changes (SceneDefinition immutability)', () => {
    // Build the pristine scene object separately and capture a deep snapshot.
    const scene = makeScene();
    const officeRef = scene.sceneManager.getRoom('office')!;
    const pristineConnections = JSON.stringify(officeRef.connections);

    scene.sceneManager.setConnectionOpen('office', 'lab', false);
    // The runtime room is a clone — mutation must not leak into the authoring
    // artifact (constraint: never mutate SceneDefinition objects in place).
    expect(JSON.stringify(officeRef.connections)).toBe(pristineConnections);
  });

  it('insert adds a new connection between two rooms', () => {
    s.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'lounge', roomB: 'lab', action: 'insert' },
    });
    s.service.applyPending(1);
    expect(s.sceneManager.getConnectedRooms('lounge').map((r) => r.id)).toContain('lab');
  });

  it('remove deletes the connection (allowed when no room is left isolated)', () => {
    // Give lab a second connection first so removal isolates nobody.
    s.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'lab', roomB: 'lounge', action: 'insert' },
    });
    s.service.applyPending(1);
    s.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'office', roomB: 'lab', action: 'remove' },
    });
    s.service.applyPending(2);
    expect(s.sceneManager.getConnectedRooms('office').map((r) => r.id)).not.toContain('lab');
    expect(s.sceneManager.getConnectedRooms('lab').map((r) => r.id)).not.toContain('office');
  });
});

describe('Topology-aware traversal & perception (spec 030, AC-4 / Req 10)', () => {
  let s: ReturnType<typeof buildService>;
  beforeEach(() => {
    s = buildService();
  });

  it('cross-door go_to affordances are not offered in the closed direction', () => {
    s.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'office', roomB: 'lab', action: 'close' },
    });
    s.service.applyPending(1);

    // Room-level affordance queries drop go_to_lab (office→lab closed) but
    // keep go_to_lounge and non-movement affordances.
    const officeAffordances = s.registry.getAffordancesInRoom('office').map((a) => a.id);
    expect(officeAffordances).not.toContain('go_to_lab');
    expect(officeAffordances).toContain('go_to_lounge');
    expect(officeAffordances).toContain('work');

    // The lab side loses go_to_office too (both directions of the closed pair).
    const labAffordances = s.registry.getAffordancesInRoom('lab').map((a) => a.id);
    expect(labAffordances).not.toContain('go_to_office');

    // Available-affordance queries respect the same filter.
    const available = s.registry.getAvailableAffordancesInRoom('office').map((a) => a.id);
    expect(available).not.toContain('go_to_lab');
  });

  it('re-opening restores the cross-door affordances', () => {
    s.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'office', roomB: 'lab', action: 'close' },
    });
    s.service.applyPending(1);
    s.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'office', roomB: 'lab', action: 'open' },
    });
    s.service.applyPending(2);

    const officeAffordances = s.registry.getAffordancesInRoom('office').map((a) => a.id);
    expect(officeAffordances).toContain('go_to_lab');
  });

  it('TopologyGuard.isMovementBlocked reports blocked movement through the closed door', () => {
    s.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'office', roomB: 'lab', action: 'close' },
    });
    s.service.applyPending(1);

    expect(s.sceneManager.isMovementBlocked('agent-1', 'go_to_lab', 'office')).toBe(true);
    // Unblocked movement is not blocked.
    expect(s.sceneManager.isMovementBlocked('agent-1', 'go_to_lounge', 'office')).toBe(false);
    // Non-movement actions are never blocked.
    expect(s.sceneManager.isMovementBlocked('agent-1', 'work', 'office')).toBe(false);

    // After reopening, the same navigation is unblocked.
    s.service.propose({
      type: 'set_connection_state',
      payload: { roomA: 'office', roomB: 'lab', action: 'open' },
    });
    s.service.applyPending(2);
    expect(s.sceneManager.isMovementBlocked('agent-1', 'go_to_lab', 'office')).toBe(false);
  });

  it('doorway open_door/close_door engine effects call SceneMutationService (Req 9)', async () => {
    // The doorway handler's engineEffect delegates to the mutation service.
    // The handler derives the room pair from the doorway object's go_to_*
    // affordances (doorway-office connects office ↔ lab).
    const closeHandler = s.service.createDoorwayEffect('doorway-office', 'close_door');
    const result = await closeHandler('doorway-office', 'agent-1', {});
    expect(result.success).toBe(true);
    // Queued, not yet applied (tick-boundary discipline).
    expect(s.sceneManager.getConnectedRooms('office').map((r) => r.id)).toContain('lab');
    s.service.applyPending(1);
    expect(s.sceneManager.getConnectedRooms('office').map((r) => r.id)).not.toContain('lab');

    // Re-open via the open_door effect.
    const openHandler = s.service.createDoorwayEffect('doorway-office', 'open_door');
    const openResult = await openHandler('doorway-office', 'agent-1', {});
    expect(openResult.success).toBe(true);
    s.service.applyPending(2);
    expect(s.sceneManager.getConnectedRooms('office').map((r) => r.id)).toContain('lab');
  });
});