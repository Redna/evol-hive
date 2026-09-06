/**
 * Spec 032 — Dynamic-World Demo: Drive Restoration Affordances & Long-Run
 * Equilibrium (issue #125)
 * ────────────────────────────────────────────────────────────────────────────
 * Deterministic acceptance tests for the scene-only fix: the dynamic-world
 * demo had no energy-restoring affordance, so drives decayed monotonically
 * toward zero in long runs while the LLM searched for nonexistent remedies
 * ("Restore energy by find...").
 *
 * Coverage (AC-5/AC-6's real-LLM observational half is recorded on the issue,
 * not here — everything in this file runs with zero LLM calls):
 *   AC-1  — `garden-bench-1` (garden) + `stool-1` (workshop), both furniture,
 *           listed in their room's objectIds; every room has ≥ 1 affordance
 *           declaring a positive energy delta.
 *   AC-2  — `sit_outside` on the bench and `relax` on the stool execute via
 *           the builtin furniture handlers (resolved by autoRegisterHandlers,
 *           exactly like the sim wires them) and return success with the
 *           documented positive energy/comfort driveChanges.
 *   AC-3  — a mock-cognition run through the real Execute phase (the sim's
 *           cognition stack — no LLM) raises the agent's energy and comfort
 *           by the handler deltas after driveChanges are applied.
 *   AC-4  — a mocked `talk_to` execution through the sim's cognition stack
 *           (CognitiveToolExecutorImpl + SocialManager, spec 018 path) raises
 *           the sender's social drive by +10 with a second agent co-present;
 *           the sim documentation states the solo-window social bound.
 *   Req 6 — the perception surface (System 0 affordance index) actually lists
 *           the rest affordances in both rooms, so the LLM never plans around
 *           phantom remedies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SmartObject } from '@evol-hive/shared';
import {
  createEngineCore,
  loadScene,
  autoRegisterHandlers,
  clearHandlerPlugins,
  registerHandlerPlugin,
  createBuiltinPlugins,
} from '@evol-hive/engine';
import type { EngineCore } from '@evol-hive/engine';
import { ExecuteServiceImpl } from '@evol-hive/cognition';
import { DYNAMIC_WORLD_SCENE, createDynamicWorldHandlers } from '../dynamic-world.ts';
import { assembleCognitionStack, buildMemorySubsystem } from '../assembly.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const GARDENER = 'gardener-1';

/** The sim's engine config (deterministic — no env coupling in tests). */
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

  // Handler registration: builtin plugins + scene handlers (spec 030 pattern).
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

/** Look up a scene object by ID. */
function sceneObject(id: string): SmartObject {
  const obj = DYNAMIC_WORLD_SCENE.objects.find((o) => o.id === id);
  if (!obj) throw new Error(`Object ${id} not found in DYNAMIC_WORLD_SCENE`);
  return obj;
}

// ── Clean env before/after each test (assembly.ts reads env vars) ────────────

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

// ── AC-1: rest furniture in every room (scene structure) ─────────────────────

describe('AC-1: garden-bench-1 and stool-1 rest furniture (scene structure)', () => {
  it('adds garden-bench-1 — type furniture, roomId garden, listed in garden.objectIds', () => {
    const bench = sceneObject('garden-bench-1');
    expect(bench.type).toBe('furniture');
    expect(bench.roomId).toBe('garden');

    const garden = DYNAMIC_WORLD_SCENE.rooms.find((r) => r.id === 'garden')!;
    expect(garden.objectIds).toContain('garden-bench-1');
  });

  it('adds stool-1 — type furniture, roomId workshop, listed in workshop.objectIds', () => {
    const stool = sceneObject('stool-1');
    expect(stool.type).toBe('furniture');
    expect(stool.roomId).toBe('workshop');

    const workshop = DYNAMIC_WORLD_SCENE.rooms.find((r) => r.id === 'workshop')!;
    expect(workshop.objectIds).toContain('stool-1');
  });

  it('every room has ≥ 1 object with an affordance declaring a positive energy delta', () => {
    for (const room of DYNAMIC_WORLD_SCENE.rooms) {
      const roomObjects = DYNAMIC_WORLD_SCENE.objects.filter((o) => o.roomId === room.id);
      const restorer = roomObjects.find((o) =>
        o.affordances.some((a) => (a.effects['energy'] ?? 0) > 0),
      );
      expect(
        restorer,
        `room '${room.id}' has no affordance restoring energy — long runs slide to zero`,
      ).toBeDefined();
    }
  });

  it('the bench declares sit_outside (energy +3, comfort +15, curiosity +5) and observe', () => {
    const bench = sceneObject('garden-bench-1');
    const sitOutside = bench.affordances.find((a) => a.id === 'sit_outside');
    expect(sitOutside).toBeDefined();
    expect(sitOutside!.engineEffect).toBe('sit_outside');
    expect(sitOutside!.effects['energy']).toBe(3);
    expect(sitOutside!.effects['comfort']).toBe(15);
    expect(sitOutside!.effects['curiosity']).toBe(5);
    expect(bench.affordances.some((a) => a.id === 'observe')).toBe(true);
  });

  it('the stool declares relax (energy +5, comfort +20) and observe', () => {
    const stool = sceneObject('stool-1');
    const relax = stool.affordances.find((a) => a.id === 'relax');
    expect(relax).toBeDefined();
    expect(relax!.engineEffect).toBe('relax');
    expect(relax!.effects['energy']).toBe(5);
    expect(relax!.effects['comfort']).toBe(20);
    expect(stool.affordances.some((a) => a.id === 'observe')).toBe(true);
  });

  it('every objectId in every room resolves to a registered object (scene consistency, Req 3)', () => {
    const objectIds = new Set(DYNAMIC_WORLD_SCENE.objects.map((o) => o.id));
    for (const room of DYNAMIC_WORLD_SCENE.rooms) {
      for (const id of room.objectIds) {
        expect(objectIds.has(id), `room '${room.id}' lists unknown object '${id}'`).toBe(true);
      }
    }
  });
});

// ── Req 6 (deterministic half of AC-6): perception surface lists the remedy ──

describe('Req 6: the affordance index exposes the rest affordances (no phantom remedies)', () => {
  it('garden perception lists sit_outside and relax from the bench; workshop lists relax from the stool', () => {
    const core = wireSimCore();

    const gardenAffordances = core.bridges.perception.getAffordancesInRoom('garden');
    expect(gardenAffordances.some((a) => a.id === 'sit_outside')).toBe(true);
    expect(gardenAffordances.some((a) => a.id === 'relax')).toBe(true);

    const workshopAffordances = core.bridges.perception.getAffordancesInRoom('workshop');
    expect(workshopAffordances.some((a) => a.id === 'relax')).toBe(true);
  });
});

// ── AC-2: builtin furniture handlers restore drives ──────────────────────────

describe('AC-2: builtin furniture handlers restore energy + comfort', () => {
  it('sit_outside on garden-bench-1 → success with driveChanges { energy: +3, comfort: +15, curiosity: +5 }', async () => {
    const core = wireSimCore();

    const result = await core.bridges.execute.executeAffordance(
      'garden-bench-1',
      'sit_outside',
      GARDENER,
    );

    expect(result.success).toBe(true);
    expect(result.driveChanges).toBeDefined();
    expect(result.driveChanges!['energy']).toBe(3);
    expect(result.driveChanges!['comfort']).toBe(15);
    expect(result.driveChanges!['curiosity']).toBe(5);
  });

  it('relax on stool-1 → success with driveChanges { energy: +5, comfort: +20 }', async () => {
    const core = wireSimCore();
    // The gardener starts in the garden — move to the workshop (co-location guard).
    core.sceneManager.moveAgent(GARDENER, 'workshop');

    const result = await core.bridges.execute.executeAffordance('stool-1', 'relax', GARDENER);

    expect(result.success).toBe(true);
    expect(result.driveChanges).toBeDefined();
    expect(result.driveChanges!['energy']).toBe(5);
    expect(result.driveChanges!['comfort']).toBe(20);
  });
});

// ── AC-3: Execute phase applies the drive deltas to the agent ────────────────

describe('AC-3: mock-cognition run — Execute phase raises energy and comfort', () => {
  it('executing sit_outside on the bench raises the gardener energy +3 / comfort +15 / curiosity +5', async () => {
    const core = wireSimCore();

    // Mid-run decayed state (the issue #125 failure mode: energy sliding
    // toward 0) — restoration must out-earn decay from a low base, and drives
    // clamp at 100 so the test starts the agent away from the ceiling.
    const state = core.agentManager.getState(GARDENER)!;
    core.agentManager.updateState(GARDENER, {
      drives: { ...state.drives, energy: 40, comfort: 35, curiosity: 50 },
    });
    const before = core.agentManager.getState(GARDENER)!.drives;
    expect(before.energy).toBe(40);

    core.bridges.plan.storePlan(GARDENER, {
      description: 'Sit on the garden bench to recover',
      steps: [{ description: 'Sit outside', targetAffordance: 'sit_outside' }],
    });

    const execute = new ExecuteServiceImpl({ dataProvider: core.bridges.execute });
    const result = await execute.execute(GARDENER);

    expect(result.success).toBe(true);

    const after = core.agentManager.getState(GARDENER)!.drives;
    expect(after.energy).toBe(43); // 40 + 3
    expect(after.comfort).toBe(50); // 35 + 15
    expect(after.curiosity).toBe(55); // 50 + 5
  });

  it('executing relax on the stool raises the gardener energy +5 / comfort +20', async () => {
    const core = wireSimCore();
    core.sceneManager.moveAgent(GARDENER, 'workshop');

    const state = core.agentManager.getState(GARDENER)!;
    core.agentManager.updateState(GARDENER, {
      drives: { ...state.drives, energy: 40, comfort: 35 },
    });

    core.bridges.plan.storePlan(GARDENER, {
      description: 'Rest on the workshop stool',
      steps: [{ description: 'Relax on the stool', targetAffordance: 'relax' }],
    });

    const execute = new ExecuteServiceImpl({ dataProvider: core.bridges.execute });
    const result = await execute.execute(GARDENER);

    expect(result.success).toBe(true);

    const after = core.agentManager.getState(GARDENER)!.drives;
    expect(after.energy).toBe(45); // 40 + 5
    expect(after.comfort).toBe(55); // 35 + 20
  });
});

// ── AC-4: social restoration via talk_to through the sim cognition stack ─────

describe('AC-4: talk_to raises the sender social +10 (spec 018 executor path)', () => {
  it('with the apprentice co-present, a mocked talk_to execution raises the gardener social by +10', async () => {
    // Sim's real-LLM wiring: memory subsystem → engine core → scene →
    // cognition stack. The executor is wired even though no LLM call is made —
    // the Execute/talk_to path is deterministic.
    process.env['USE_REAL_LLM'] = 'true';
    const memory = buildMemorySubsystem();
    const core = createEngineCore(makeConfig(), memory.memoryStore, memory.vectorStore);
    loadScene(core, DYNAMIC_WORLD_SCENE);
    clearHandlerPlugins();
    for (const plugin of createBuiltinPlugins()) {
      registerHandlerPlugin(plugin);
    }
    autoRegisterHandlers(core, DYNAMIC_WORLD_SCENE);
    for (const [effect, handler] of Object.entries(createDynamicWorldHandlers())) {
      core.affordanceRegistry.registerHandler(effect, handler);
    }

    // Co-present second agent (the Apprentice spawns at t+60s in the sim; here
    // it is pre-spawned with a garden start room so both agents share a room).
    core.agentManager.spawn({
      id: 'apprentice-1',
      name: 'Apprentice',
      description: 'An eager apprentice gardener learning the trade.',
      traits: ['curious', 'energetic'],
      initialDrives: { curiosity: 80, energy: 90 },
      startRoomId: 'garden',
    });

    const stack = assembleCognitionStack(core, undefined, { memory });
    expect(stack.cognitiveToolExecutor).toBeDefined();

    // Simulate the solo-window decay first: ≤ 6 points from 100 (0.1/s over
    // 60s) before the Apprentice spawns — social must be below the 100 clamp
    // for the +10 restoration to be observable.
    const state = core.agentManager.getState(GARDENER)!;
    core.agentManager.updateState(GARDENER, {
      drives: { ...state.drives, social: 55 },
    });

    const result = await stack.cognitiveToolExecutor!.executeTalkTo(
      GARDENER,
      'apprentice-1',
      'How are the planters coming along?',
    );

    expect(result.success).toBe(true);
    const after = core.agentManager.getState(GARDENER)!.drives.social;
    expect(after).toBe(65); // 55 + 10 (spec 018: talk_to → own social +10)
  });
});

// ── AC-4 (docs): the sim documents the drive economy + solo-window bound ─────

describe('AC-4/Req 4: sim documentation states the drive economy and solo-window bound', () => {
  const simSource = readFileSync(resolve(__dirname, '../dynamic-world-sim.ts'), 'utf-8');
  const sceneSource = readFileSync(resolve(__dirname, '../dynamic-world.ts'), 'utf-8');

  it('the sim header documents that social is restored only via agent-to-agent tools', () => {
    expect(simSource).toMatch(/talk_to/i);
    expect(simSource).toMatch(/social/i);
  });

  it('the sim header states the solo-window bound: ≤ 6 social decay before the Apprentice spawns at t+60s', () => {
    expect(simSource).toMatch(/6\s*points?\b.*social|social.*\b6\b/i);
    expect(simSource).toMatch(/t\+60s|60s/);
  });

  it('the sim header documents the energy restorations (bench/stool) alongside the decay', () => {
    expect(simSource).toMatch(/relax/i);
    expect(simSource).toMatch(/sit_outside/i);
    expect(simSource).toMatch(/0\.1\/s|decay/i);
  });

  it('the scene file documents the full drive economy (decays AND restorations per room)', () => {
    expect(sceneSource).toMatch(/sit_outside/i);
    expect(sceneSource).toMatch(/relax/i);
    expect(sceneSource).toMatch(/talk_to|social/i);
  });
});
