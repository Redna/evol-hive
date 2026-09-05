/**
 * dynamic-world.ts — Dynamic Scenes / Living Worlds demo (spec 030, issue #117;
 * drive restoration per spec 032, issue #125; hunger chain + drive→affordance
 * hints per spec 034, issue #130)
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
 * Drive economy (spec 032 + spec 034 — closed loops; decay 0.1/s per drive,
 * spec 019). Decay AND restoration path for every drive (spec 034, Req 7):
 *
 *   - energy:    restored by garden-bench-1 `sit_outside` (+3) / `relax` (+5)
 *                in the garden and stool-1 `relax` (+5) in the workshop —
 *                every room restores energy, offsetting the workbench's
 *                energy-negative `work` (−4)
 *   - hunger:    restored by planter-1 `eat` (+25) — the harvest→eat chain
 *                (plant → water → harvest → eat) closes the loop; hunger
 *                previously had NO restoration path (spec 034, Req 6)
 *   - comfort:   bench/stool `relax` (+20), bench `sit_outside` (+15),
 *                water_plants (+5), harvest (+5), build_planter (+8)
 *   - curiosity: plant_seeds (+12), water_plants (+10), take_tool (+8),
 *                work (+6), build_planter (+20), harvest (+10),
 *                bench `sit_outside` (+5)
 *   - social:    restored ONLY through agent-to-agent cognitive tools —
 *                `talk_to` (own social +10) and `help` (target's primary
 *                drive + own social), available whenever another agent is
 *                co-present (the Apprentice from t+60s; see
 *                dynamic-world-sim.ts)
 * Declared `effects` mirror the builtin handler `driveChanges` so the LLM's
 * affordance tool descriptions surface the real remedies (spec 032, Req 6)
 * and the cognition drive→affordance matcher can bind urgent drives to them
 * (spec 034, Req 1–4). `makeObject` stamps each affordance with its owning
 * object (`objectId`/`objectName`) so the spec-034 hints name the object
 * that offers each affordance.
 */

import type { SceneDefinition, SmartObject } from '@evol-hive/shared';
import type { SceneMutationServiceImpl } from '@evol-hive/engine';
import type { AffordanceHandler } from '@evol-hive/engine';
import type { AttributedAffordance } from '@evol-hive/cognition';

// ── Scene ────────────────────────────────────────────────────────────────────

/**
 * Declarative, self-describing availability condition (spec 018, Req 1):
 * evaluated against the owning object's `state` at perception time.
 */
type AffordanceCondition = NonNullable<
  SmartObject['affordances'][number]['conditions']
>[number];

/**
 * Affordance factory (coffee-shop pattern): `preconditions`, `effects`, and
 * `conditions` are optional — declared `effects` mirror the builtin handler
 * `driveChanges` so the LLM tool descriptions surface the real drive impacts
 * (spec 032, Req 6) and the drive→affordance matcher can bind urgent drives
 * to them (spec 034, Req 1–4); declarative `conditions` gate availability at
 * perception time without a registered PreconditionChecker (spec 018, Req 7).
 */
function aff(
  id: string,
  label = id,
  preconditions: string[] = [],
  effects: Partial<Record<string, number>> = {},
  conditions?: AffordanceCondition[],
) {
  return {
    id,
    label,
    engineEffect: id,
    preconditions,
    effects,
    ...(conditions !== undefined ? { conditions } : {}),
  };
}

function makeObject(
  id: string,
  name: string,
  type: string,
  roomId: string,
  affordances: ReturnType<typeof aff>[],
): SmartObject {
  // Spec 034: stamp owning-object attribution on every affordance so the
  // cognition drive→affordance hints can name the object that offers each
  // affordance ("sit_outside at the Garden Bench"). Harmless extra fields —
  // affordance tool definitions render id/label/effects only.
  const attributed = affordances.map(
    (a): AttributedAffordance => ({ ...a, objectId: id, objectName: name }),
  );
  return { id, name, type, state: {}, affordances: attributed, roomId };
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
    // Planter (spec 018 object ecosystem + spec 034 hunger chain, Req 5–6):
    //   plant_seeds → water_plants → harvest (seeds_planted >= 3) → eat
    //   (vegetables >= 1, hunger +25). `harvest` and `eat` are gated by
    //   declarative `AffordanceCondition`s — no ObjectDependency needed when
    //   the gate lives on the same object.
    makeObject('planter-1', 'Planter', 'furniture', 'garden', [
      aff('plant_seeds', 'Plant seeds'),
      aff('harvest', 'Harvest vegetables', [], { curiosity: 10, comfort: 5 }, [
        { field: 'seeds_planted', operator: '>=', value: 3 },
      ]),
      aff('eat', 'Eat a vegetable', [], { hunger: 25 }, [
        { field: 'vegetables', operator: '>=', value: 1 },
      ]),
    ]),
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
 *            +comfort, consumes water), harvest (vegetables +1 at
 *            seeds_planted >= 3, resets the counter — spec 034, Req 5),
 *            eat (hunger +25, consumes one vegetable — spec 034, Req 6;
 *            closes the hunger loop: plant → water → harvest → eat) —
 *            plus garden-bench-1 `sit_outside` and `relax` (energy +
 *            comfort) from the builtin furniture plugin
 *   workshop: work (+curiosity, −energy, −comfort), take_tool (enables
 *            build_planter), build_planter (+curiosity, +comfort) — plus
 *            stool-1 `relax` (energy + comfort) from the furniture plugin
 *   both:    go_to_* via the builtin doorway plugin (movement)
 *
 * Drive-economy closed loops (spec 032, Req 4–5; spec 034, Req 7): every
 * room restores energy (bench/stool), hunger is restored by the planter's
 * `eat`, curiosity/comfort are restored by the gardening/work loops, and
 * social is restored only by agent-to-agent cognitive tools (`talk_to` →
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
    // Spec 034, Req 5: harvest closes the growth half of the hunger chain.
    // Gated declaratively at perception time (conditions: seeds_planted >= 3)
    // and defensively here at execution time: yields one vegetable and resets
    // the planted-seed counter so the plant → water loop can run again.
    harvest: async (_objectId, _agentId, state) => {
      const planted = (state['seeds_planted'] as number) ?? 0;
      if (planted < 3) {
        return { success: false, failureReason: 'The vegetables are not ready to harvest yet.' };
      }
      return {
        success: true,
        newState: {
          ...state,
          vegetables: ((state['vegetables'] as number) ?? 0) + 1,
          seeds_planted: 0,
        },
        driveChanges: { curiosity: 10, comfort: 5 },
      };
    },
    // Spec 034, Req 6: eat closes the hunger loop (plant → water → harvest →
    // eat). Gated declaratively (conditions: vegetables >= 1) and defensively
    // here: consumes one vegetable and restores hunger +25 via driveChanges.
    eat: async (_objectId, _agentId, state) => {
      const vegetables = (state['vegetables'] as number) ?? 0;
      if (vegetables < 1) {
        return { success: false, failureReason: 'There are no ripe vegetables to eat.' };
      }
      return {
        success: true,
        newState: { ...state, vegetables: vegetables - 1 },
        driveChanges: { hunger: 25 },
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
