/**
 * examples/scene-helpers.ts — Shared affordance handler & precondition library (spec 013, Req 3-19)
 * ────────────────────────────────────────────────────────────────────────────
 * Exports `registerAffordanceHandlers(core)` which registers every engine-effect
 * handler and precondition checker used by the Morning Routine and Office Day
 * scenes. Both entry points call this function after `loadScene` so the
 * `SceneManager` is already populated (movement handlers capture
 * `core.sceneManager`).
 *
 * Handlers are deterministic closures (System 1) — no LLM calls, no randomness.
 */

import type { AffordanceResult } from '@evol-hive/shared';
import type { EngineCore } from '@evol-hive/engine';

/**
 * Register all affordance handlers and precondition checkers used by the richer
 * prototype scenes. Must be called after `loadScene(core, scene)` so that
 * `core.sceneManager` is the populated scene manager.
 */
export function registerAffordanceHandlers(core: EngineCore): void {
  const { affordanceRegistry, sceneManager } = core;

  // ── Precondition checkers (Req 19) ────────────────────────────────────────
  affordanceRegistry.registerPreconditionChecker('has_water', (state) => {
    return (state['water_level'] as number) > 0;
  });
  affordanceRegistry.registerPreconditionChecker('has_beans', (state) => {
    return (state['bean_count'] as number) > 0;
  });
  affordanceRegistry.registerPreconditionChecker('is_powered', (state) => {
    return state['powered_on'] === true;
  });
  affordanceRegistry.registerPreconditionChecker('has_books', (state) => {
    return (state['book_count'] as number) > 0;
  });
  affordanceRegistry.registerPreconditionChecker('has_paper', (state) => {
    return (state['paper_count'] as number) > 0;
  });

  // ── brew_coffee (Req 4) ───────────────────────────────────────────────────
  affordanceRegistry.registerHandler('brew_coffee', async (_objectId, _agentId, state) => {
    const water = (state['water_level'] as number) ?? 0;
    const beans = (state['bean_count'] as number) ?? 0;
    if (water <= 0 || beans <= 0) {
      return { success: false, failureReason: 'No water or beans left' };
    }
    const newState = { ...state, water_level: water - 1, bean_count: beans - 1 };
    const result: AffordanceResult = {
      success: true,
      newState,
      driveChanges: { energy: 20 },
    };
    return result;
  });

  // ── sleep (Req 5) ─────────────────────────────────────────────────────────
  affordanceRegistry.registerHandler('sleep', async (_objectId, _agentId, state) => {
    return { success: true, newState: state, driveChanges: { energy: 30, comfort: -5 } };
  });

  // ── take_shower (Req 6) ────────────────────────────────────────────────────
  affordanceRegistry.registerHandler('take_shower', async (_objectId, _agentId, state) => {
    const water = (state['water_level'] as number) ?? 0;
    const newState = { ...state, water_level: water - 1 };
    return { success: true, newState, driveChanges: { comfort: 25, energy: -5 } };
  });

  // ── watch_tv (Req 7) ──────────────────────────────────────────────────────
  affordanceRegistry.registerHandler('watch_tv', async (_objectId, _agentId, state) => {
    const newState = { ...state, powered_on: false };
    return {
      success: true,
      newState,
      driveChanges: { comfort: 15, energy: -5, curiosity: 5 },
    };
  });

  // ── read_book (Req 8) ──────────────────────────────────────────────────────
  affordanceRegistry.registerHandler('read_book', async (_objectId, _agentId, state) => {
    const books = (state['book_count'] as number) ?? 0;
    if (books <= 0) {
      return { success: false, failureReason: 'No books left' };
    }
    const newState = { ...state, book_count: books - 1 };
    return { success: true, newState, driveChanges: { curiosity: 20, energy: -10 } };
  });

  // ── go_outside (Req 9) ────────────────────────────────────────────────────
  affordanceRegistry.registerHandler('go_outside', async (_objectId, agentId, _state) => {
    // eslint-disable-next-line no-console
    console.log(`Agent ${agentId} went outside (scene transition not yet implemented)`);
    return { success: true };
  });

  // ── work (Req 10) ──────────────────────────────────────────────────────────
  affordanceRegistry.registerHandler('work', async (_objectId, _agentId, state) => {
    const tasks = (state['tasks_completed'] as number) ?? 0;
    const newState = { ...state, tasks_completed: tasks + 1 };
    return { success: true, newState, driveChanges: { energy: -15 } };
  });

  // ── brainstorm (Req 11) ────────────────────────────────────────────────────
  affordanceRegistry.registerHandler('brainstorm', async (_objectId, _agentId, state) => {
    const ideas = (state['ideas_generated'] as number) ?? 0;
    const newState = { ...state, ideas_generated: ideas + 1 };
    return {
      success: true,
      newState,
      driveChanges: { curiosity: 15, social: 5, energy: -10 },
    };
  });

  // ── small_talk (Req 12) ────────────────────────────────────────────────────
  affordanceRegistry.registerHandler('small_talk', async (_objectId, _agentId, state) => {
    return { success: true, newState: state, driveChanges: { social: 15, energy: -2 } };
  });

  // ── hold_meeting (Req 13) ──────────────────────────────────────────────────
  affordanceRegistry.registerHandler('hold_meeting', async (_objectId, _agentId, state) => {
    const meetings = (state['meetings_held'] as number) ?? 0;
    const newState = { ...state, meetings_held: meetings + 1 };
    return {
      success: true,
      newState,
      driveChanges: { social: 20, energy: -15, comfort: -5 },
    };
  });

  // ── use_bathroom (Req 14) ──────────────────────────────────────────────────
  affordanceRegistry.registerHandler('use_bathroom', async (_objectId, _agentId, state) => {
    return { success: true, newState: state, driveChanges: { comfort: 10 } };
  });

  // ── wash_hands (Req 15) ───────────────────────────────────────────────────
  affordanceRegistry.registerHandler('wash_hands', async (_objectId, _agentId, state) => {
    return { success: true, newState: state, driveChanges: { comfort: 5 } };
  });

  // ── print_document (Req 16) ────────────────────────────────────────────────
  affordanceRegistry.registerHandler('print_document', async (_objectId, _agentId, state) => {
    const paper = (state['paper_count'] as number) ?? 0;
    if (paper <= 0) {
      return { success: false, failureReason: 'Printer out of paper' };
    }
    const newState = { ...state, paper_count: paper - 1 };
    return { success: true, newState, driveChanges: { curiosity: 2 } };
  });

  // ── observe (Req 18) ───────────────────────────────────────────────────────
  affordanceRegistry.registerHandler('observe', async (_objectId, _agentId, state) => {
    return { success: true, newState: state };
  });

  // ── go_to_* movement handlers (Req 17) ─────────────────────────────────────
  // Register a handler for every go_to_<roomId> affordance used by any scene.
  // The handler teleports the agent to the target room via sceneManager.moveAgent.
  // 'garden' is included for the Coffee Shop scene (spec 019, Req 19).
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
  for (const dest of movementDestinations) {
    const affordanceId = `go_to_${dest}`;
    affordanceRegistry.registerHandler(affordanceId, async (_objectId, agentId) => {
      sceneManager.moveAgent(agentId, dest);
      return { success: true };
    });
  }
}

/**
 * Register affordance handlers and precondition checkers specific to the
 * Coffee Shop scene (spec 019, Req 16–18). Must be called after
 * `registerAffordanceHandlers(core)` and `loadScene(core, scene)` so the
 * SmartObjectRegistry and SceneManager are populated.
 *
 * Handlers are deterministic closures — no LLM calls, no randomness.
 */
export function registerCoffeeShopHandlers(core: EngineCore): void {
  const { affordanceRegistry } = core;

  // ── Precondition checkers (Req 18) ────────────────────────────────────────
  affordanceRegistry.registerPreconditionChecker('has_cups', (state) => {
    return (state['cup_count'] as number) > 0;
  });
  affordanceRegistry.registerPreconditionChecker('has_water_supply', (state) => {
    return (state['water_supply'] as number) > 0;
  });
  affordanceRegistry.registerPreconditionChecker('has_blooms', (state) => {
    return (state['bloom_count'] as number) > 0;
  });

  // ── add_water (Coffee Machine — compound action step 1, Req 16) ───────────
  // Water is replenished via the Sink's `refill_pitcher` cross-object effect.
  // This step confirms the water addition; no state change needed.
  affordanceRegistry.registerHandler('add_water', async (_objectId, _agentId, state) => {
    return { success: true, newState: state };
  });

  // ── pour_cup (Coffee Machine — compound action step 3, Req 16) ────────────
  // Pours brewed coffee into a cup; decrements cup_count.
  affordanceRegistry.registerHandler('pour_cup', async (_objectId, _agentId, state) => {
    const cups = (state['cup_count'] as number) ?? 0;
    if (cups <= 0) {
      return { success: false, failureReason: 'No cups left' };
    }
    const newState = { ...state, cup_count: cups - 1 };
    return { success: true, newState, driveChanges: { comfort: 5 } };
  });

  // ── refill_pitcher (Sink — cross-object state change, Req 17) ──────────────
  // Fills a pitcher from the sink and refills the Coffee Machine's water via
  // crossObjectStateChanges (spec 018, Req 8).
  affordanceRegistry.registerHandler('refill_pitcher', async (_objectId, _agentId, state) => {
    const supply = (state['water_supply'] as number) ?? 0;
    if (supply <= 0) {
      return { success: false, failureReason: 'Sink has no water supply' };
    }
    const newState = { ...state, water_supply: supply - 1 };
    return {
      success: true,
      newState,
      crossObjectStateChanges: [{ objectId: 'coffee-1', statePatch: { water_level: 5 } }],
    };
  });

  // ── relax (Sofa — Req 16) ─────────────────────────────────────────────────
  affordanceRegistry.registerHandler('relax', async (_objectId, _agentId, state) => {
    return { success: true, newState: state, driveChanges: { comfort: 20, energy: 5 } };
  });

  // ── sit_outside (Garden Bench — Req 16) ───────────────────────────────────
  affordanceRegistry.registerHandler('sit_outside', async (_objectId, _agentId, state) => {
    return {
      success: true,
      newState: state,
      driveChanges: { comfort: 15, curiosity: 5, energy: 3 },
    };
  });

  // ── observe_flowers (Flower Bed — Req 16) ─────────────────────────────────
  affordanceRegistry.registerHandler('observe_flowers', async (_objectId, _agentId, state) => {
    return {
      success: true,
      newState: state,
      driveChanges: { curiosity: 10, comfort: 5 },
    };
  });
}
