/**
 * Spec 055 — Phantom-affordance audit over every exported example scene
 * (Req 3 — issue #198, AC-3)
 * ────────────────────────────────────────────────────────────────────────────
 * A deterministic audit over the full handler-registry × scene-affordance
 * cross product, data-driven from the REAL scene definitions and the REAL
 * handler registries as wired in production:
 *
 * - dynamic-world: builtin plugins (per object type) + autoRegisterHandlers +
 *   `createDynamicWorldHandlers()` + carry + gate handlers (the
 *   dynamic-world-sim.ts registration);
 * - coffee-shop: `registerAffordanceHandlers` + `registerCoffeeShopHandlers`
 *   (the buildCoffeeShopEngine sceneSetup);
 * - morning-routine / office-day: `registerAffordanceHandlers` (their
 *   sceneSetup);
 * - minimal: `buildMinimalEngine()` (its two demo handlers are inline).
 *
 * The audit asserts (see phantom-audit.ts for the contract):
 * 1. no phantom handlers — every registered handler id is declared by ≥1
 *    scene object (the #198 `water_plants` class);
 * 2. no phantom affordances — every scene engineEffect resolves in its own
 *    wiring (registered handler or `go_to_<room>` builtin);
 * 3. stateless accounting — non-allowlisted handlers are resource-gated
 *    somewhere; new stateless handlers fail until allowlisted;
 * 4. no stale allowlist entries.
 *
 * Fixture tests inject synthetic scenes/wirings to prove the audit catches
 * an undeclared handler, an unresolvable affordance id, and a new stateless
 * handler that is not allowlisted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createEngineCore,
  loadScene,
  autoRegisterHandlers,
  clearHandlerPlugins,
  registerHandlerPlugin,
  createBuiltinPlugins,
} from '@evol-hive/engine';
import type { EngineCore } from '@evol-hive/engine';
import type { SceneDefinition } from '@evol-hive/shared';
import {
  DYNAMIC_WORLD_SCENE,
  createDynamicWorldHandlers,
  createCarryEffect,
  createGateHandlers,
} from '../dynamic-world.ts';
import { COFFEE_SHOP_SCENE } from '../coffee-shop.ts';
import { MORNING_ROUTINE_SCENE } from '../morning-routine.ts';
import { OFFICE_DAY_SCENE } from '../office-day.ts';
import { MINIMAL_SCENE, buildMinimalEngine } from '../minimal-scene.ts';
import { registerAffordanceHandlers, registerCoffeeShopHandlers } from '../scene-helpers.ts';
import {
  auditScenes,
  STATELESS_BY_DESIGN,
  type AuditViolation,
} from './phantom-audit.ts';

// ── Production wiring per exported scene ─────────────────────────────────────

/**
 * Wire a scene's production handler registration into a fresh core and return
 * the registered handler ids (read from the REAL registry — the same source
 * physics dispatches through).
 */
function productionHandlerIds(scene: SceneDefinition): string[] {
  if (scene.id === 'minimal') {
    // minimal-scene's handlers are inline closures inside buildMinimalEngine —
    // the production wiring IS that builder.
    const engine = buildMinimalEngine();
    return engine.affordanceRegistry.getRegisteredHandlerIds().sort();
  }

  const core: EngineCore = createEngineCore({
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: false,
  });
  loadScene(core, scene);

  if (scene.id === 'dynamic-world') {
    // The dynamic-world-sim.ts registration, verbatim.
    clearHandlerPlugins();
    for (const plugin of createBuiltinPlugins()) {
      registerHandlerPlugin(plugin);
    }
    autoRegisterHandlers(core, scene);
    for (const [effect, handler] of Object.entries(createDynamicWorldHandlers())) {
      core.affordanceRegistry.registerHandler(effect, handler);
    }
    core.affordanceRegistry.registerHandler('carry', createCarryEffect(core.mutationService));
    for (const [effect, handler] of Object.entries(createGateHandlers(core.mutationService))) {
      core.affordanceRegistry.registerHandler(effect, handler);
    }
  } else if (scene.id === 'coffee-shop') {
    // The buildCoffeeShopEngine sceneSetup, verbatim.
    registerAffordanceHandlers(core);
    registerCoffeeShopHandlers(core);
  } else if (scene.id === 'morning-routine' || scene.id === 'office-day') {
    // Their sceneSetup, verbatim.
    registerAffordanceHandlers(core);
  } else {
    throw new Error(`No production wiring known for scene '${scene.id}'`);
  }

  return core.affordanceRegistry.getRegisteredHandlerIds().sort();
}

/** Every exported example scene (the audit's population). */
function allScenes(): SceneDefinition[] {
  return [DYNAMIC_WORLD_SCENE, COFFEE_SHOP_SCENE, MORNING_ROUTINE_SCENE, OFFICE_DAY_SCENE, MINIMAL_SCENE];
}

beforeEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  delete process.env['SYSTEM1_GATE_ARTIFACT'];
  delete process.env['SYSTEM1_SESSION_LOG_DIR'];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  delete process.env['SYSTEM1_GATE_ARTIFACT'];
  delete process.env['SYSTEM1_SESSION_LOG_DIR'];
  vi.restoreAllMocks();
});

// ── The audit over the REAL examples ─────────────────────────────────────────

describe('spec 055 Req 3 / AC-3: the phantom-affordance audit passes over all exported scenes', () => {
  it('the audit population covers every exported example scene', () => {
    const ids = allScenes().map((s) => s.id);
    expect(ids).toEqual(['dynamic-world', 'coffee-shop', 'morning-routine', 'office-day', 'minimal']);
  });

  it('each scene wiring registers handlers from the REAL registry', () => {
    const wirings = new Map<string, string[]>();
    for (const scene of allScenes()) {
      const ids = productionHandlerIds(scene);
      expect(ids.length, `scene '${scene.id}' registered no handlers`).toBeGreaterThan(0);
      wirings.set(scene.id, ids);
    }
    // Spot-check the water economy joined the dynamic-world registry.
    const dynamic = wirings.get('dynamic-world')!;
    expect(dynamic).toContain('water_plants');
    expect(dynamic).toContain('fill_watering_can');
    expect(dynamic).toContain('close_gate');
    expect(dynamic).toContain('carry');
  });

  it('the full audit reports zero violations (phantom handlers, phantom affordances, stateless accounting, allowlist staleness)', () => {
    const wirings = new Map<string, string[]>();
    for (const scene of allScenes()) {
      wirings.set(scene.id, productionHandlerIds(scene));
    }
    const violations = auditScenes({ handlerIdsByScene: wirings, scenes: allScenes() });
    expect(violations).toEqual([]);
  });

  it('the STATELESS_BY_DESIGN allowlist documents every entry with a justification', () => {
    for (const [id, justification] of STATELESS_BY_DESIGN) {
      expect(justification.length, `allowlist entry '${id}' lacks a justification`).toBeGreaterThan(
        20,
      );
    }
  });
});

// ── Fixture tests: the audit catches the failure modes ──────────────────────

describe('spec 055 Req 3 / AC-3: the audit fails on injected phantoms (fixture tests)', () => {
  /** A minimal real-shaped scene for fixtures. */
  function fixtureScene(objects: SceneDefinition['objects']): SceneDefinition {
    return {
      id: 'fixture',
      name: 'Fixture',
      rooms: [{ id: 'room', name: 'Room', description: '', connections: [], objectIds: objects.map((o) => o.id) }],
      objects,
      agents: [],
    };
  }

  it('an UNDECLARED handler (registered, declared by no scene object) fails the audit', () => {
    const scene = fixtureScene([
      {
        id: 'obj-1',
        name: 'Object',
        type: 'furniture',
        state: {},
        roomId: 'room',
        affordances: [
          {
            id: 'observe',
            label: 'Observe',
            engineEffect: 'observe',
            preconditions: [],
            effects: {},
          },
        ],
      },
    ]);
    const violations = auditScenes({
      handlerIdsByScene: new Map([
        ['fixture', ['observe', 'water_plants']], // water_plants registered, undeclared
      ]),
      scenes: [scene],
    });
    const kinds = violations.map((v) => v.kind);
    expect(kinds).toContain('phantom-handler');
    const phantom = violations.find((v) => v.kind === 'phantom-handler')!;
    expect(phantom.detail).toContain('water_plants');
  });

  it('an UNRESOLVABLE affordance engineEffect fails the audit', () => {
    const scene = fixtureScene([
      {
        id: 'obj-1',
        name: 'Object',
        type: 'furniture',
        state: {},
        roomId: 'room',
        affordances: [
          {
            id: 'ghost_action',
            label: 'Ghost action',
            engineEffect: 'ghost_action', // no handler registers this
            preconditions: [],
            effects: {},
          },
        ],
      },
    ]);
    const violations = auditScenes({
      handlerIdsByScene: new Map([['fixture', ['observe']]]),
      scenes: [scene],
    });
    const kinds = violations.map((v) => v.kind);
    expect(kinds).toContain('phantom-affordance');
    const phantom = violations.find((v) => v.kind === 'phantom-affordance')!;
    expect(phantom.detail).toContain('ghost_action');
    expect(phantom.detail).toContain("scene 'fixture'");
  });

  it('a NEW stateless handler (declared, ungated, not allowlisted) fails the audit', () => {
    const scene = fixtureScene([
      {
        id: 'obj-1',
        name: 'Object',
        type: 'furniture',
        state: {},
        roomId: 'room',
        affordances: [
          {
            id: 'meditate',
            label: 'Meditate', // drive-only handler, no resource gate, not allowlisted
            engineEffect: 'meditate',
            preconditions: [],
            effects: { comfort: 10 },
          },
        ],
      },
    ]);
    const violations = auditScenes({
      handlerIdsByScene: new Map([['fixture', ['meditate', 'observe']]]),
      scenes: [scene],
    });
    const kinds = violations.map((v) => v.kind);
    expect(kinds).toContain('stateless-unaccounted');
    const unaccounted = violations.find((v) => v.kind === 'stateless-unaccounted')!;
    expect(unaccounted.detail).toContain('meditate');
  });

  it('a stale allowlist entry (allowlisted id declared by no scene) fails the audit', () => {
    const scene = fixtureScene([
      {
        id: 'obj-1',
        name: 'Object',
        type: 'furniture',
        state: {},
        roomId: 'room',
        affordances: [
          {
            id: 'observe',
            label: 'Observe',
            engineEffect: 'observe',
            preconditions: [],
            effects: {},
          },
        ],
      },
    ]);
    const violations = auditScenes({
      handlerIdsByScene: new Map([['fixture', ['observe']]]),
      scenes: [scene],
    });
    const kinds = violations.map((v) => v.kind);
    // 'pick_herbs' etc. are allowlisted but this fixture declares nothing —
    // staleness fires for every allowlist entry the fixture lacks.
    expect(kinds).toContain('stale-allowlist');
  });

  it('a resource-gated declaration accounts a non-allowlisted handler (the water_plants pattern)', () => {
    const scene = fixtureScene([
      {
        id: 'obj-1',
        name: 'Object',
        type: 'furniture',
        state: { water_level: 5 },
        roomId: 'room',
        affordances: [
          {
            id: 'water_plants',
            label: 'Water the plants',
            engineEffect: 'water_plants',
            preconditions: [],
            effects: { curiosity: 10 },
            conditions: [{ field: 'water_level', operator: '>', value: 0 }],
          },
          {
            id: 'observe',
            label: 'Observe',
            engineEffect: 'observe',
            preconditions: [],
            effects: {},
          },
        ],
      },
    ]);
    const violations = auditScenes({
      handlerIdsByScene: new Map([['fixture', ['water_plants', 'observe']]]),
      scenes: [scene],
    });
    // No stateless-unaccounted violation: the water_level condition gates it.
    // (Stale-allowlist violations are expected — the fixture lacks the other
    // allowlisted ids — so filter them out for this assertion.)
    const kinds = violations
      .filter((v) => v.kind !== 'stale-allowlist')
      .map((v) => v.kind);
    expect(kinds).toEqual([]);
  });
});

export type { AuditViolation };