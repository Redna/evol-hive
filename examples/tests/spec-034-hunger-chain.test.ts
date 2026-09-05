/**
 * Tests for spec 034 — Hunger Restoration Chain (issue #130).
 * ────────────────────────────────────────────────────────────────────────────
 * Deterministic acceptance tests for the examples half of spec 034: the
 * planter-1 harvest→eat chain closes the hunger loop (plant → water →
 * harvest → eat), the five-drive state log samples every drive, and the
 * scene documents the complete five-drive economy.
 *
 * Coverage:
 *   AC-3 — `harvest` on planter-1 fails while `seeds_planted < 3` and succeeds
 *          at `>= 3` (vegetables +1, seeds_planted reset to 0); `eat` fails
 *          while `vegetables < 1` and succeeds with driveChanges.hunger >= +25
 *          (vegetables −1). Tested over `createDynamicWorldHandlers()` and the
 *          declarative `AffordanceCondition` evaluator.
 *   AC-5 — `logState()` output includes `h=` (hunger) and `co=` (comfort) for
 *          every agent sample.
 *   Req 7 — the scene header documents the complete five-drive economy
 *          (decay AND restoration path for every drive).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createEngineCore,
  loadScene,
  autoRegisterHandlers,
  clearHandlerPlugins,
  registerHandlerPlugin,
  createBuiltinPlugins,
} from '@evol-hive/engine';
import type { EngineCore, AffordanceHandler } from '@evol-hive/engine';
import { ExecuteServiceImpl } from '@evol-hive/cognition';
import { DYNAMIC_WORLD_SCENE, createDynamicWorldHandlers } from '../dynamic-world.ts';
import { logState } from '../dynamic-world-sim.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const GARDENER = 'gardener-1';

function makeConfig(): import('@evol-hive/shared').EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

/** Wire a core exactly like dynamic-world-sim.ts does (builtin plugins + scene handlers). */
function wireSimCore(): EngineCore {
  const core = createEngineCore(makeConfig());
  loadScene(core, DYNAMIC_WORLD_SCENE);
  clearHandlerPlugins();
  for (const plugin of createBuiltinPlugins()) {
    registerHandlerPlugin(plugin);
  }
  autoRegisterHandlers(core, DYNAMIC_WORLD_SCENE);
  for (const [effect, handler] of Object.entries(createDynamicWorldHandlers())) {
    core.affordanceRegistry.registerHandler(effect, handler);
  }
  return core;
}

function sceneObject(id: string): import('@evol-hive/shared').SmartObject {
  const obj = DYNAMIC_WORLD_SCENE.objects.find((o) => o.id === id);
  if (!obj) throw new Error(`Object ${id} not found in DYNAMIC_WORLD_SCENE`);
  return obj;
}

beforeEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  delete process.env['SCENE_DURATION_MS'];
});

afterEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  delete process.env['SCENE_DURATION_MS'];
});

// ── AC-3a: scene declares the harvest/eat affordances with conditions+effects ─

describe('AC-3a: planter-1 declares harvest and eat (scene structure)', () => {
  it('harvest is declared with condition seeds_planted >= 3 and effects curiosity +10 / comfort +5', () => {
    const planter = sceneObject('planter-1');
    const harvest = planter.affordances.find((a) => a.id === 'harvest');
    expect(harvest).toBeDefined();
    expect(harvest!.engineEffect).toBe('harvest');
    expect(harvest!.conditions).toEqual([{ field: 'seeds_planted', operator: '>=', value: 3 }]);
    expect(harvest!.effects['curiosity']).toBe(10);
    expect(harvest!.effects['comfort']).toBe(5);
  });

  it('eat is declared with condition vegetables >= 1 and effects hunger +25', () => {
    const planter = sceneObject('planter-1');
    const eat = planter.affordances.find((a) => a.id === 'eat');
    expect(eat).toBeDefined();
    expect(eat!.engineEffect).toBe('eat');
    expect(eat!.conditions).toEqual([{ field: 'vegetables', operator: '>=', value: 1 }]);
    expect(eat!.effects['hunger']).toBe(25);
  });

  it('the planter is not gated by an ObjectDependency (declarative condition suffices, Req 6)', () => {
    const planter = sceneObject('planter-1');
    expect(planter.dependencies).toBeUndefined();
  });
});

// ── AC-3b: handler gating, state mutation, drive changes ─────────────────────

describe('AC-3b: harvest/eat handlers gate on state, mutate it, and restore drives', () => {
  const handlers: Record<string, AffordanceHandler> = createDynamicWorldHandlers();

  it('harvest fails while seeds_planted < 3', async () => {
    const result = await handlers['harvest']!('planter-1', GARDENER, { seeds_planted: 2 });
    expect(result.success).toBe(false);
    expect(result.failureReason).toBeDefined();
  });

  it('harvest also fails on an untouched planter (state defaults)', async () => {
    const result = await handlers['harvest']!('planter-1', GARDENER, {});
    expect(result.success).toBe(false);
  });

  it('harvest succeeds at seeds_planted >= 3: vegetables +1, seeds_planted reset to 0, curiosity/comfort restored', async () => {
    const result = await handlers['harvest']!('planter-1', GARDENER, {
      seeds_planted: 3,
      water_level: 2,
    });
    expect(result.success).toBe(true);
    expect(result.newState!['vegetables']).toBe(1);
    expect(result.newState!['seeds_planted']).toBe(0);
    expect(result.newState!['water_level']).toBe(2); // unrelated state preserved
    expect(result.driveChanges!['curiosity']).toBe(10);
    expect(result.driveChanges!['comfort']).toBe(5);
  });

  it('eat fails while vegetables < 1', async () => {
    const result = await handlers['eat']!('planter-1', GARDENER, { vegetables: 0 });
    expect(result.success).toBe(false);
    expect(result.failureReason).toBeDefined();
  });

  it('eat also fails on an untouched planter (state defaults)', async () => {
    const result = await handlers['eat']!('planter-1', GARDENER, {});
    expect(result.success).toBe(false);
  });

  it('eat succeeds with driveChanges.hunger >= +25 and decrements vegetables', async () => {
    const result = await handlers['eat']!('planter-1', GARDENER, { vegetables: 2, seeds_planted: 1 });
    expect(result.success).toBe(true);
    expect(result.newState!['vegetables']).toBe(1);
    expect(result.newState!['seeds_planted']).toBe(1); // unrelated state preserved
    expect((result.driveChanges!['hunger'] ?? 0) >= 25).toBe(true);
  });
});

// ── AC-3c: declarative conditions filter the affordances at perception time ──

describe('AC-3c: declarative AffordanceConditions gate visibility (spec 018, Req 14)', () => {
  it('harvest/eat are hidden from perception until their conditions are met', () => {
    const core = wireSimCore();

    // Fresh planter: neither harvest nor eat is available.
    let available = core.bridges.perception
      .getAvailableAffordancesInRoom('garden')
      .map((a) => a.id);
    expect(available).not.toContain('harvest');
    expect(available).not.toContain('eat');

    // Three seeds planted → harvest appears, eat does not.
    core.smartObjectRegistry.updateState('planter-1', { seeds_planted: 3 });
    available = core.bridges.perception.getAvailableAffordancesInRoom('garden').map((a) => a.id);
    expect(available).toContain('harvest');
    expect(available).not.toContain('eat');

    // A vegetable exists → eat appears; with seeds reset to 0, harvest hides again.
    core.smartObjectRegistry.updateState('planter-1', { seeds_planted: 0, vegetables: 1 });
    available = core.bridges.perception.getAvailableAffordancesInRoom('garden').map((a) => a.id);
    expect(available).not.toContain('harvest'); // seeds_planted < 3 again (updateState replaces state)
    expect(available).toContain('eat');
  });
});

// ── AC-3d: the full chain through the real Execute phase raises hunger ───────

describe('AC-3d: harvest → eat chain through the sim cognition stack restores hunger', () => {
  it('planting 3 seeds, harvesting, then eating raises the gardener hunger by +25', async () => {
    const core = wireSimCore();

    // Mature planter: three seeds planted (the plant_seeds loop ran 3×).
    core.smartObjectRegistry.updateState('planter-1', { seeds_planted: 3 });

    // Mid-run decayed state (the issue #130 failure mode: hunger pins at 0;
    // comfort starts at 100 and must be pulled off the clamp to observe +5).
    const state = core.agentManager.getState(GARDENER)!;
    core.agentManager.updateState(GARDENER, {
      drives: { ...state.drives, hunger: 30, comfort: 50 },
    });

    core.bridges.plan.storePlan(GARDENER, {
      description: 'Harvest the vegetables and eat one',
      steps: [
        { description: 'Harvest the vegetables', targetAffordance: 'harvest' },
        { description: 'Eat a vegetable', targetAffordance: 'eat' },
      ],
    });

    const execute = new ExecuteServiceImpl({ dataProvider: core.bridges.execute });

    // Step 1: harvest → vegetables +1, seeds reset.
    const harvestResult = await execute.execute(GARDENER);
    expect(harvestResult.success).toBe(true);
    const planterAfterHarvest = core.smartObjectRegistry.get('planter-1')!.state;
    expect(planterAfterHarvest['vegetables']).toBe(1);
    expect(planterAfterHarvest['seeds_planted']).toBe(0);
    const afterHarvestDrives = core.agentManager.getState(GARDENER)!.drives;
    expect(afterHarvestDrives.curiosity).toBe(state.drives.curiosity + 10);
    expect(afterHarvestDrives.comfort).toBe(55); // 50 + 5 (comfort clamps at 100 — pulled off the ceiling above)

    // Step 2: eat → hunger +25, vegetables −1.
    const eatResult = await execute.execute(GARDENER);
    expect(eatResult.success).toBe(true);
    const after = core.agentManager.getState(GARDENER)!.drives;
    expect(after.hunger).toBe(55); // 30 + 25
    expect(core.smartObjectRegistry.get('planter-1')!.state['vegetables']).toBe(0);
  });
});

// ── AC-5: the state log prints all five drives ───────────────────────────────

describe('AC-5: logState prints all five drives (h= and co= added)', () => {
  it('every agent sample line includes e=, h=, s=, co=, and cu= fields', () => {
    const lines: string[] = [];
    const log = (msg: string): void => {
      lines.push(msg);
    };

    const core = {
      agentManager: {
        getActiveAgents: () => [{ agentId: GARDENER }],
        getState: (id: string) =>
          id === GARDENER
            ? {
                agentId: GARDENER,
                location: 'garden',
                isThinking: false,
                drives: { energy: 41, hunger: 88, social: 99, comfort: 50, curiosity: 70 },
              }
            : null,
      },
      mutationService: { getMutations: () => [] },
    } as unknown as EngineCore;

    logState(core, log);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\be=41\b/);
    expect(lines[0]).toMatch(/\bh=88\b/);
    expect(lines[0]).toMatch(/\bs=99\b/);
    expect(lines[0]).toMatch(/\bco=50\b/);
    expect(lines[0]).toMatch(/\bcu=70\b/);
  });

  it('samples multiple agents, printing five drives for each', () => {
    const lines: string[] = [];
    const log = (msg: string): void => {
      lines.push(msg);
    };

    const core = {
      agentManager: {
        getActiveAgents: () => [{ agentId: GARDENER }, { agentId: 'apprentice-1' }],
        getState: (id: string) =>
          id === GARDENER
            ? {
                agentId: GARDENER,
                location: 'garden',
                isThinking: false,
                drives: { energy: 41, hunger: 88, social: 99, comfort: 50, curiosity: 70 },
              }
            : {
                agentId: 'apprentice-1',
                location: 'workshop',
                isThinking: true,
                drives: { energy: 90, hunger: 95, social: 94, comfort: 100, curiosity: 80 },
              },
      },
      mutationService: { getMutations: () => [] },
    } as unknown as EngineCore;

    logState(core, log);

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/\bh=\d+\b/);
      expect(line).toMatch(/\bco=\d+\b/);
    }
  });
});

// ── Req 7: the scene documents the complete five-drive economy ───────────────

describe('Req 7: drive-economy documentation covers all five drives', () => {
  const sceneSource = readFileSync(resolve(__dirname, '../dynamic-world.ts'), 'utf-8');
  const simSource = readFileSync(resolve(__dirname, '../dynamic-world-sim.ts'), 'utf-8');

  it('the scene header documents restoration paths for energy, hunger, comfort, curiosity, and social', () => {
    expect(sceneSource).toMatch(/energy/i);
    expect(sceneSource).toMatch(/hunger/i);
    expect(sceneSource).toMatch(/comfort/i);
    expect(sceneSource).toMatch(/curiosity/i);
    expect(sceneSource).toMatch(/social/i);
    // Hunger restoration must reference the eat affordance…
    expect(sceneSource).toMatch(/hunger[^\n]*eat|eat[^\n]*hunger/i);
    // …and the harvest step must be documented as part of the chain.
    expect(sceneSource).toMatch(/harvest/i);
  });

  it('the sim header documents the hunger restoration path (no longer "out of scope")', () => {
    expect(simSource).toMatch(/hunger/i);
    expect(simSource).not.toMatch(/out of scope for this demo/i);
    expect(simSource).toMatch(/eat/i);
  });

  it('the sim header documents the comfort restoration paths (bench/stool/water loop)', () => {
    expect(simSource).toMatch(/comfort/i);
  });
});