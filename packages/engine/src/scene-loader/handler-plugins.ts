/**
 * scene-loader/handler-plugins.ts — Affordance handler plugin system (spec 022, Req 10–11)
 * ────────────────────────────────────────────────────────────────────────────
 * Provides a `HandlerPlugin` interface and a global registry for mapping
 * object `type` values to affordance handler functions and precondition
 * checkers. The loader's `autoRegisterHandlers(core, scene)` iterates over
 * scene objects, finds matching plugins by type, and registers handlers.
 *
 * Built-in plugins (from `examples/scene-helpers.ts`) are provided via
 * `createBuiltinPlugins()`. Custom plugins can be registered before loading
 * a scene via `registerHandlerPlugin(plugin)`.
 */

import type { SceneDefinition } from '@evol-hive/shared';
import type { EngineCore } from '../assembly.js';
import type { AffordanceHandler } from '../world/index.js';
import type { PreconditionChecker } from '../world/affordances/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A plugin that provides affordance handlers for a specific object type. */
export interface HandlerPlugin {
  /** The object type this plugin handles (e.g., "appliance", "furniture", "doorway"). */
  objectType: string;
  /** Handlers keyed by affordance engineEffect ID. */
  handlers: Record<string, AffordanceHandler>;
  /** Optional precondition checkers keyed by precondition name. */
  preconditionCheckers?: Record<string, PreconditionChecker>;
}

// ─── Global plugin registry ─────────────────────────────────────────────────

const _plugins: HandlerPlugin[] = [];

/**
 * Register a handler plugin (spec 022, Req 11). Plugins are matched by
 * `objectType` during auto-registration.
 */
export function registerHandlerPlugin(plugin: HandlerPlugin): void {
  // Remove any existing plugin with the same objectType (replace semantics).
  const idx = _plugins.findIndex((p) => p.objectType === plugin.objectType);
  if (idx >= 0) {
    _plugins[idx] = plugin;
  } else {
    _plugins.push(plugin);
  }
}

/** Clear all registered handler plugins (useful for testing). */
export function clearHandlerPlugins(): void {
  _plugins.length = 0;
}

/** Get all registered handler plugins. */
export function getRegisteredPlugins(): readonly HandlerPlugin[] {
  return [..._plugins];
}

// ─── Auto-registration ──────────────────────────────────────────────────────

/**
 * Auto-register affordance handlers for all objects in the scene (spec 022,
 * Req 10). For each object, finds the plugin matching its `type` and registers
 * all handlers and precondition checkers from that plugin.
 *
 * If no plugin matches an object's type, a warning is logged and the scene
 * continues — affordance execution will return `{ success: false,
 * failureReason: 'No handler registered' }` at runtime.
 *
 * Must be called after `loadScene(core, scene)` so that
 * `core.sceneManager` is populated (movement handlers capture it).
 */
export function autoRegisterHandlers(core: EngineCore, scene: SceneDefinition): void {
  // Wire the scene manager so doorway movement handlers can call moveAgent.
  _setSceneManagerForPlugins(core.sceneManager);

  const pluginsByType = new Map<string, HandlerPlugin>();
  for (const plugin of _plugins) {
    pluginsByType.set(plugin.objectType, plugin);
  }

  const registeredEffects = new Set<string>();
  const registeredPreconditions = new Set<string>();

  for (const obj of scene.objects) {
    const plugin = pluginsByType.get(obj.type);
    if (!plugin) {
      console.warn(
        `[autoRegisterHandlers] No plugin registered for object type "${obj.type}" (object "${obj.id}"). Affordance execution will return failure.`,
      );
      continue;
    }

    // Register precondition checkers (deduplicated by name).
    if (plugin.preconditionCheckers) {
      for (const [name, checker] of Object.entries(plugin.preconditionCheckers)) {
        if (!registeredPreconditions.has(name)) {
          core.affordanceRegistry.registerPreconditionChecker(name, checker);
          registeredPreconditions.add(name);
        }
      }
    }

    // Register handlers (deduplicated by engineEffect).
    for (const [effectId, handler] of Object.entries(plugin.handlers)) {
      if (!registeredEffects.has(effectId)) {
        core.affordanceRegistry.registerHandler(effectId, handler);
        registeredEffects.add(effectId);
      }
    }
  }
}

// ─── Built-in plugins ────────────────────────────────────────────────────────

/**
 * Create the built-in handler plugins derived from `examples/scene-helpers.ts`
 * (spec 022, Req 11). These cover the object types used by the example scenes:
 * `appliance`, `fixture`, `furniture`, `doorway`, and `nature`.
 *
 * Movement handlers (`go_to_*`) are registered on the `doorway` plugin and
 * use a closure that captures `core.sceneManager`.
 */
export function createBuiltinPlugins(): HandlerPlugin[] {
  return [
    createDoorwayPlugin(),
    createFurniturePlugin(),
    createAppliancePlugin(),
    createFixturePlugin(),
    createNaturePlugin(),
  ];
}

// ─── Doorway plugin ──────────────────────────────────────────────────────────

/** Placeholder for the scene manager — set during auto-registration. */
let _sceneManager: { moveAgent: (agentId: string, toRoomId: string) => void } | null = null;

/** Internal: set the scene manager reference for movement handlers. */
export function _setSceneManagerForPlugins(
  sm: { moveAgent: (agentId: string, toRoomId: string) => void } | null,
): void {
  _sceneManager = sm;
}

function createDoorwayPlugin(): HandlerPlugin {
  const movementDestinations = [
    'bedroom',
    'bathroom',
    'living_room',
    'kitchen',
    'office',
    'break_room',
    'meeting_room',
    'garden',
  ];

  const handlers: Record<string, AffordanceHandler> = {};

  // Generic go_to handler factory — works for any destination.
  for (const dest of movementDestinations) {
    const effectId = `go_to_${dest}`;
    handlers[effectId] = async (_objectId, agentId) => {
      _sceneManager?.moveAgent(agentId, dest);
      return { success: true };
    };
  }

  // Also register a generic observe handler for doorways.
  handlers['observe'] = async (_objectId, _agentId, state) => ({
    success: true,
    newState: state,
  });

  return {
    objectType: 'doorway',
    handlers,
  };
}

// ─── Furniture plugin ────────────────────────────────────────────────────────

function createFurniturePlugin(): HandlerPlugin {
  return {
    objectType: 'furniture',
    handlers: {
      relax: async (_objId, _agentId, state) => ({
        success: true,
        newState: state,
        driveChanges: { comfort: 20, energy: 5 },
      }),
      read_book: async (_objId, _agentId, state) => {
        const books = (state['book_count'] as number) ?? 0;
        if (books <= 0) return { success: false, failureReason: 'No books left' };
        return {
          success: true,
          newState: { ...state, book_count: books - 1 },
          driveChanges: { curiosity: 20, energy: -10 },
        };
      },
      sit_outside: async (_objId, _agentId, state) => ({
        success: true,
        newState: state,
        driveChanges: { comfort: 15, curiosity: 5, energy: 3 },
      }),
      observe: async (_objId, _agentId, state) => ({
        success: true,
        newState: state,
      }),
    },
    preconditionCheckers: {
      has_books: (state) => (state['book_count'] as number) > 0,
    },
  };
}

// ─── Appliance plugin ────────────────────────────────────────────────────────

function createAppliancePlugin(): HandlerPlugin {
  return {
    objectType: 'appliance',
    handlers: {
      brew_coffee: async (_objId, _agentId, state) => {
        const water = (state['water_level'] as number) ?? 0;
        const beans = (state['bean_count'] as number) ?? 0;
        if (water <= 0 || beans <= 0) {
          return { success: false, failureReason: 'No water or beans left' };
        }
        return {
          success: true,
          newState: { ...state, water_level: water - 1, bean_count: beans - 1 },
          driveChanges: { energy: 20 },
        };
      },
      add_water: async (_objId, _agentId, state) => ({
        success: true,
        newState: state,
      }),
      pour_cup: async (_objId, _agentId, state) => {
        const cups = (state['cup_count'] as number) ?? 0;
        if (cups <= 0) return { success: false, failureReason: 'No cups left' };
        return {
          success: true,
          newState: { ...state, cup_count: cups - 1 },
          driveChanges: { comfort: 5 },
        };
      },
      watch_tv: async (_objId, _agentId, state) => ({
        success: true,
        newState: { ...state, powered_on: false },
        driveChanges: { comfort: 15, energy: -5, curiosity: 5 },
      }),
      work: async (_objId, _agentId, state) => {
        const tasks = (state['tasks_completed'] as number) ?? 0;
        return {
          success: true,
          newState: { ...state, tasks_completed: tasks + 1 },
          driveChanges: { energy: -15 },
        };
      },
      get_food: async (_objId, _agentId, state) => {
        return {
          success: true,
          newState: state,
          driveChanges: { hunger: -20 },
        };
      },
      print_document: async (_objId, _agentId, state) => {
        const paper = (state['paper_count'] as number) ?? 0;
        if (paper <= 0) return { success: false, failureReason: 'Printer out of paper' };
        return {
          success: true,
          newState: { ...state, paper_count: paper - 1 },
          driveChanges: { curiosity: 2 },
        };
      },
      observe: async (_objId, _agentId, state) => ({
        success: true,
        newState: state,
      }),
    },
    preconditionCheckers: {
      has_water: (state) => (state['water_level'] as number) > 0,
      has_beans: (state) => (state['bean_count'] as number) > 0,
      is_powered: (state) => state['powered_on'] === true,
      has_cups: (state) => (state['cup_count'] as number) > 0,
      has_paper: (state) => (state['paper_count'] as number) > 0,
    },
  };
}

// ─── Fixture plugin ──────────────────────────────────────────────────────────

function createFixturePlugin(): HandlerPlugin {
  return {
    objectType: 'fixture',
    handlers: {
      sleep: async (_objId, _agentId, state) => ({
        success: true,
        newState: state,
        driveChanges: { energy: 30, comfort: -5 },
      }),
      take_shower: async (_objId, _agentId, state) => {
        const water = (state['water_level'] as number) ?? 0;
        return {
          success: true,
          newState: { ...state, water_level: water - 1 },
          driveChanges: { comfort: 25, energy: -5 },
        };
      },
      use_bathroom: async (_objId, _agentId, state) => ({
        success: true,
        newState: state,
        driveChanges: { comfort: 10 },
      }),
      wash_hands: async (_objId, _agentId, state) => ({
        success: true,
        newState: state,
        driveChanges: { comfort: 5 },
      }),
      refill_pitcher: async (_objId, _agentId, state) => {
        const supply = (state['water_supply'] as number) ?? 0;
        if (supply <= 0) {
          return { success: false, failureReason: 'Sink has no water supply' };
        }
        return {
          success: true,
          newState: { ...state, water_supply: supply - 1 },
          crossObjectStateChanges: [{ objectId: 'coffee-1', statePatch: { water_level: 5 } }],
        };
      },
      observe: async (_objId, _agentId, state) => ({
        success: true,
        newState: state,
      }),
    },
    preconditionCheckers: {
      has_water_supply: (state) => (state['water_supply'] as number) > 0,
    },
  };
}

// ─── Nature plugin ──────────────────────────────────────────────────────────

function createNaturePlugin(): HandlerPlugin {
  return {
    objectType: 'nature',
    handlers: {
      observe_flowers: async (_objId, _agentId, state) => ({
        success: true,
        newState: state,
        driveChanges: { curiosity: 10, comfort: 5 },
      }),
      go_outside: async (_objId, agentId) => {
        console.log(`Agent ${agentId} went outside (scene transition not yet implemented)`);
        return { success: true };
      },
      observe: async (_objId, _agentId, state) => ({
        success: true,
        newState: state,
      }),
    },
    preconditionCheckers: {
      has_blooms: (state) => (state['bloom_count'] as number) > 0,
    },
  };
}
