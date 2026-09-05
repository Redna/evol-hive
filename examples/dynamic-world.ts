/**
 * dynamic-world.ts — Dynamic Scenes / Living Worlds demo (spec 030, issue #117;
 * drive restoration per spec 032, issue #125)
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
 *
 * Drive economy (spec 032 — closed loops; decay 0.1/s per drive, spec 019):
 *  - garden:  plant_seeds/water_plants (+curiosity, +comfort), garden-bench-1
 *    `sit_outside` (+comfort 15, +curiosity 5, +energy 3) and `relax`
 *    (+comfort 20, +energy 5) — builtin furniture handlers
 *  - workshop: work (+curiosity, −energy, −comfort), stool-1 `relax`
 *    (+comfort 20, +energy 5) — every room restores energy
 *  - social:  restored only through agent-to-agent cognitive tools —
 *    `talk_to` (own social +10) and `help` (target primary drive + own
 *    social), available whenever another agent is co-present (the Apprentice
 *    from t+60s; see dynamic-world-sim.ts)
 * Declared `effects` mirror the builtin handler `driveChanges` so the LLM's
 * affordance tool descriptions surface the real remedies (spec 032, Req 6).
 */

import type { SceneDefinition, SmartObject } from '@evol-hive/shared';
import type { SceneMutationServiceImpl } from '@evol-hive/engine';
import type { AffordanceHandler } from '@evol-hive/engine';

// ── Scene ────────────────────────────────────────────────────────────────────

/**
 * Affordance factory (coffee-shop pattern): `preconditions` and `effects`
 * are optional — declared `effects` mirror the builtin handler
 * `driveChanges` so the LLM tool descriptions surface the real drive
 * impacts (spec 032, Req 6).
 */
function aff(
  id: string,
  label = id,
  preconditions: string[] = [],
  effects: Partial<Record<string, number>> = {},
) {
  return { id, label, engineEffect: id, preconditions, effects };
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
  objectIds: ['planter-1', 'gate-1', 'toolbox-1', 'garden-bench-1', 'doorway-garden'],
};

const workshop: SceneDefinition['rooms'][number] = {
  id: 'workshop',
  name: 'Workshop',
  description: 'A workshop with a workbench and tool rack.',
  connections: ['garden'],
  objectIds: ['workbench-1', 'stool-1', 'doorway-workshop'],
};

/** The demo scene: a garden and a workshop connected by a gated doorway. */
export const DYNAMIC_WORLD_SCENE: SceneDefinition = {
  id: 'dynamic-world',
  name: 'Dynamic World Demo',
  rooms: [garden, workshop],
  objects: [
    makeObject('planter-1', 'Planter', 'furniture', 'garden', [aff('plant_seeds', 'Plant seeds')]),
    // Referenced by garden.objectIds — was missing (the runtime move_object
    // proposal was rejected with "no object with ID 'toolbox-1'").
    makeObject('toolbox-1', 'Toolbox', 'tool', 'garden', [
      aff('take_tool', 'Take a tool'),
      aff('observe', 'Observe'),
    ]),
    makeObject('gate-1', 'Gate', 'doorway', 'garden', [aff('open_gate', 'Open gate')]),
    // Garden bench (spec 032, Req 1): builtin furniture `sit_outside` and
    // `relax` restore energy + comfort — the garden's rest affordance.
    makeObject('garden-bench-1', 'Garden Bench', 'furniture', 'garden', [
      aff('sit_outside', 'Sit outside', [], { comfort: 15, curiosity: 5, energy: 3 }),
      aff('relax', 'Relax on the bench', [], { comfort: 20, energy: 5 }),
      aff('observe', 'Observe'),
    ]),
    makeObject('workbench-1', 'Workbench', 'furniture', 'workshop', [
      aff('work', 'Work'),
      aff('build_planter', 'Build a planter'),
    ]),
    // Workshop stool (spec 032, Req 2): builtin furniture `relax` restores
    // energy + comfort so the room with energy-negative `work` also has an
    // energy-restoring affordance (every room must restore energy).
    makeObject('stool-1', 'Stool', 'furniture', 'workshop', [
      aff('relax', 'Relax on the stool', [], { comfort: 20, energy: 5 }),
      aff('observe', 'Observe'),
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

// ── Scene-specific affordance handlers ──────────────────────────────────────

/**
 * Handlers for the dynamic-world demo (spec 030): without these, every
 * garden/workshop action fails on execution or restores no drives, leaving
 * the LLM no reason to navigate — a stalemate. These give both rooms a
 * working drive-restoration loop so plans can actually succeed:
 *
 *   garden:  plant_seeds (+curiosity, +comfort), water_plants (+curiosity,
 *            +comfort, consumes water) — plus garden-bench-1 `sit_outside`
 *            and `relax` (energy + comfort) from the builtin furniture plugin
 *   workshop: work (+curiosity, −energy, −comfort), take_tool (enables
 *            build_planter), build_planter (+curiosity, +comfort) — plus
 *            stool-1 `relax` (energy + comfort) from the furniture plugin
 *   both:    go_to_* via the builtin doorway plugin (movement)
 *
 * Drive-economy closed loops (spec 032, Req 4–5): every room restores energy
 * (bench/stool), curiosity/comfort are restored by the gardening/work loops,
 * and social is restored only by agent-to-agent cognitive tools (`talk_to` →
 * own social +10; `help` → target primary drive + own social). Rest affordance
 * handlers are NOT duplicated here — they are builtin `HandlerPlugin`s
 * (registered via `autoRegisterHandlers`) and re-registering them would
 * shadow/conflict with plugin registration semantics.
 */
export function createDynamicWorldHandlers(): Record<string, AffordanceHandler> {
  return {
    plant_seeds: async (_objectId, _agentId, state) => {
      const planted = (state['seeds_planted'] as number) ?? 0;
      if (planted >= 3) {
        return { success: false, failureReason: 'The planter is full.' };
      }
      return {
        success: true,
        newState: { ...state, seeds_planted: planted + 1 },
        driveChanges: { curiosity: 12, comfort: 4 },
      };
    },
    water_plants: async (_objectId, _agentId, state) => {
      const water = (state['water_level'] as number) ?? 0;
      if (water <= 0) {
        return { success: false, failureReason: 'The watering can is empty.' };
      }
      return {
        success: true,
        newState: { ...state, water_level: water - 1 },
        driveChanges: { curiosity: 10, comfort: 5 },
      };
    },
    work: async (_objectId, _agentId, state) => {
      const items = (state['items_built'] as number) ?? 0;
      return {
        success: true,
        newState: { ...state, items_built: items + 1 },
        driveChanges: { curiosity: 6, energy: -4, comfort: -3 },
      };
    },
    take_tool: async (objectId, agentId, state) => {
      return {
        success: true,
        newState: { ...state, taken_by: agentId, taken_from: objectId },
        driveChanges: { curiosity: 8 },
      };
    },
    build_planter: async (_objectId, _agentId, state) => {
      if (state['taken_by'] === undefined) {
        return {
          success: false,
          failureReason: 'Take a tool from the toolbox first.',
        };
      }
      return {
        success: true,
        newState: { ...state, planters_built: ((state['planters_built'] as number) ?? 0) + 1 },
        driveChanges: { curiosity: 20, comfort: 8 },
      };
    },
  };
}

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
