/**
 * dynamic-world.ts — Dynamic Scenes / Living Worlds demo (spec 030, issue #117)
 * ──────────────────────────────────────────────────────────────────────────────
 * A small scene plus helper factories for runtime scene mutation:
 *  - `portableObject` — an object with a `carry` affordance; the effect
 *    enqueues a `move_object` proposal through the SceneMutationService
 *    (agent-initiated mutation, spec 028 Execute pattern — the change lands
 *    at the next tick boundary).
 *  - `createGateHandlers` — `open_door`/`close_door` engine effects that call
 *    the mutation service (spec 030, Req 9).
 *  - `mutateScene` — propose mutations directly (engine/system use).
 *
 * The scene itself is a plain spec-022 `SceneDefinition` — dynamic changes
 * are runtime deltas only; the authoring format is unchanged (Req 16).
 */

import type { SceneDefinition, SmartObject } from '@evol-hive/shared';
import type { SceneMutationServiceImpl } from '@evol-hive/engine';
import type { AffordanceHandler } from '@evol-hive/engine';

// ── Scene ────────────────────────────────────────────────────────────────────

function aff(id: string, label = id) {
  return { id, label, engineEffect: id, preconditions: [], effects: {} };
}

function makeObject(
  id: string,
  name: string,
  type: string,
  roomId: string,
  affordances: ReturnType<typeof aff>[],
): SmartObject {
  return { id, name, type, state: {}, affordances, roomId };
}

const garden: SceneDefinition['rooms'][number] = {
  id: 'garden',
  name: 'Community Garden',
  description: 'A small garden with planters and a gate.',
  connections: ['workshop'],
  objectIds: ['planter-1', 'gate-1', 'toolbox-1', 'doorway-garden'],
};

const workshop: SceneDefinition['rooms'][number] = {
  id: 'workshop',
  name: 'Workshop',
  description: 'A workshop with a workbench and tool rack.',
  connections: ['garden'],
  objectIds: ['workbench-1', 'doorway-workshop'],
};

/** The demo scene: a garden and a workshop connected by a gated doorway. */
export const DYNAMIC_WORLD_SCENE: SceneDefinition = {
  id: 'dynamic-world',
  name: 'Dynamic World Demo',
  rooms: [garden, workshop],
  objects: [
    makeObject('planter-1', 'Planter', 'furniture', 'garden', [aff('plant_seeds', 'Plant seeds')]),
    makeObject('gate-1', 'Gate', 'doorway', 'garden', [aff('open_gate', 'Open gate')]),
    makeObject('workbench-1', 'Workbench', 'furniture', 'workshop', [
      aff('work', 'Work'),
      aff('build_planter', 'Build a planter'),
    ]),
    makeObject('doorway-garden', 'Doorway', 'doorway', 'garden', [
      aff('go_to_workshop', 'Go to workshop'),
      aff('observe', 'Observe'),
    ]),
    makeObject('doorway-workshop', 'Doorway', 'doorway', 'workshop', [
      aff('go_to_garden', 'Go to garden'),
      aff('observe', 'Observe'),
    ]),
  ],
  agents: [
    {
      id: 'gardener-1',
      name: 'Gardener',
      description: 'A methodical gardener who keeps the planters healthy.',
      traits: ['patient'],
      initialDrives: { curiosity: 70 },
      startRoomId: 'garden',
    },
  ],
};

// ── Runtime mutation helpers ────────────────────────────────────────────────

/** A portable object the `carry` affordance can move between rooms. */
export function portableObject(id: string, name: string, roomId: string): SmartObject {
  return makeObject(id, name, 'furniture', roomId, [
    {
      id: 'carry',
      label: `Carry the ${name.toLowerCase()}`,
      engineEffect: 'carry',
      preconditions: [],
      effects: { energy: -5 },
    },
    aff('observe', 'Observe'),
  ]);
}

/**
 * `carry` engine effect for portable objects (spec 030, AC-1): enqueues a
 * `move_object` proposal through the mutation service. The destination room
 * is read from the object's `target_room` state key (set by the planner or
 * the caller); the change lands at the next tick boundary.
 */
export function createCarryEffect(service: SceneMutationServiceImpl): AffordanceHandler {
  return async (objectId, _agentId, objectState) => {
    const targetRoom = objectState['target_room'];
    if (typeof targetRoom !== 'string' || targetRoom.length === 0) {
      return { success: false, failureReason: `No target_room set on object '${objectId}'.` };
    }
    const result = service.propose({
      type: 'move_object',
      payload: { objectId, toRoomId: targetRoom },
      source: 'agent',
    });
    if (!result.accepted) {
      return { success: false, failureReason: result.error ?? 'Move rejected.' };
    }
    return { success: true, newState: { ...objectState, target_room: undefined } };
  };
}

/** Gate open/close handlers wired to the mutation service (spec 030, Req 9). */
export function createGateHandlers(
  service: SceneMutationServiceImpl,
): Record<string, AffordanceHandler> {
  return {
    open_gate: async (objectId) => {
      const handler = service.createDoorwayEffect(objectId, 'open_door');
      return handler(objectId, '', {});
    },
    close_gate: async (objectId) => {
      const handler = service.createDoorwayEffect(objectId, 'close_door');
      return handler(objectId, '', {});
    },
  };
}

/** Enqueue a mutation proposal; returns whether validation accepted it. */
export function mutateScene(
  service: SceneMutationServiceImpl,
  mutation: Parameters<SceneMutationServiceImpl['propose']>[0],
): boolean {
  return service.propose(mutation).accepted;
}
