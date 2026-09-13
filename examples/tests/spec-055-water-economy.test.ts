/**
 * Spec 055 — Water economy: declared, initialized, depleting, saturating
 * (Req 1 + Req 2 — issue #198, AC-1 + AC-2) and the engine-stamped plan
 * outcome through the REAL stack (Req 4 engine half)
 * ────────────────────────────────────────────────────────────────────────────
 * The world must be able to say no: `water_plants` becomes a DECLARED
 * affordance on `planter-1` gated by the declarative condition
 * `water_level > 0` (spec 018 perception-time gating) with initialized state
 * `{ water_level: 5, seeds_planted: 0, vegetables: 0 }` — when the supply is
 * exhausted the affordance LEAVES the enum. The handler keeps its −1
 * depletion and its execution-time defense ("The watering can is empty.").
 *
 * The refill path closes the loop: `water-butt-1` ("Rain Barrel") declares
 * `fill_watering_can`, whose handler refills the planter via
 * `AffordanceResult.crossObjectStateChanges` (spec 018, Req 9) — deplete →
 * disappear → refill → re-appear is exercisable end-to-end, deterministically.
 *
 * Also pins the engine stamping seam through the REAL providers: a cycle
 * whose plan completes leaves `AgentInternalState.lastPlanOutcome` stamped
 * (success, steps, drive deltas, reflected) and the perception provider
 * surfaces it (`getLastPlanOutcome`) for the plan context (Req 4).
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
import {
  ExecuteServiceImpl,
  PerceptionServiceImpl,
  PlanServiceImpl,
  ReflectServiceImpl,
  PlanBuilderImpl,
  ReflectBuilderImpl,
} from '@evol-hive/cognition';
import type { AffordanceClassifier, LLMClient } from '@evol-hive/cognition';
import type {
  ExecuteResult,
  FormulatePlanResult,
  LLMActionResponse,
  PerceptionResult,
  ReflectLLMResponse,
  ReflectionResult,
  SmartObject,
} from '@evol-hive/shared';
import { DYNAMIC_WORLD_SCENE, createDynamicWorldHandlers } from '../dynamic-world.ts';

// ── Wiring (the sim's production registration, incl. carry + gate) ──────────

function makeConfig(): import('@evol-hive/shared').EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: false,
    guardrails: { affordanceMasking: false, contextualForcing: false, planValidation: false },
  };
}

function wireCore(): EngineCore {
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
  // The sim also registers carry + gate handlers (spec 030) — part of the
  // production registration the water economy joins.
  core.affordanceRegistry.registerHandler('carry', async () => ({ success: true }));
  core.affordanceRegistry.registerHandler('open_gate', async () => ({ success: true }));
  core.affordanceRegistry.registerHandler('close_gate', async () => ({ success: true }));
  return core;
}

const GARDENER = 'gardener-1';

function sceneObject(id: string): SmartObject {
  const obj = DYNAMIC_WORLD_SCENE.objects.find((o) => o.id === id);
  if (!obj) throw new Error(`Object ${id} not found in DYNAMIC_WORLD_SCENE`);
  return obj;
}

function availableInGarden(core: EngineCore): string[] {
  return core.bridges.perception.getAvailableAffordancesInRoom('garden').map((a) => a.id);
}

beforeEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  vi.restoreAllMocks();
});

// ── AC-1: declared, initialized, depleting, saturating ──────────────────────

describe('spec 055 Req 1 / AC-1: planter-1 declares water_plants with initialized state', () => {
  it('planter-1 declares water_plants gated by water_level > 0 (spec 018 conditions)', () => {
    const planter = sceneObject('planter-1');
    const water = planter.affordances.find((a) => a.id === 'water_plants');
    expect(water).toBeDefined();
    expect(water!.conditions).toEqual([{ field: 'water_level', operator: '>', value: 0 }]);
  });

  it('planter-1 initial state is fully initialized: { water_level: 5, seeds_planted: 0, vegetables: 0 }', () => {
    expect(sceneObject('planter-1').state).toEqual({
      water_level: 5,
      seeds_planted: 0,
      vegetables: 0,
    });
  });

  it('the declared effects mirror the handler driveChanges (curiosity +10, comfort +5)', () => {
    const water = sceneObject('planter-1').affordances.find((a) => a.id === 'water_plants')!;
    expect(water.effects).toEqual({ curiosity: 10, comfort: 5 });
  });

  it('with water_level at 0 the affordance is ABSENT from the available set; at 3 it is present', () => {
    const core = wireCore();
    core.smartObjectRegistry.updateState('planter-1', {
      water_level: 0,
      seeds_planted: 0,
      vegetables: 0,
    });
    expect(availableInGarden(core)).not.toContain('water_plants');

    core.smartObjectRegistry.updateState('planter-1', {
      water_level: 3,
      seeds_planted: 0,
      vegetables: 0,
    });
    expect(availableInGarden(core)).toContain('water_plants');
  });

  it('an uninitialized planter (no water_level field) also hides the affordance (condition fails on missing field)', () => {
    const core = wireCore();
    core.smartObjectRegistry.updateState('planter-1', { seeds_planted: 0, vegetables: 0 });
    expect(availableInGarden(core)).not.toContain('water_plants');
  });

  it('a handler execution decrements water_level by EXACTLY 1 through the real Execute phase', async () => {
    const core = wireCore();
    core.smartObjectRegistry.updateState('planter-1', {
      water_level: 3,
      seeds_planted: 0,
      vegetables: 0,
    });
    core.bridges.plan.storePlan(GARDENER, {
      description: 'Water the plants',
      steps: [{ description: 'Water the plants', targetAffordance: 'water_plants' }],
    });
    const execute = new ExecuteServiceImpl({ dataProvider: core.bridges.execute });
    const result = await execute.execute(GARDENER);
    expect(result.success).toBe(true);
    expect(core.smartObjectRegistry.get('planter-1')!.state['water_level']).toBe(2);
  });

  it('the execution-time defense stays: an empty reservoir fails the handler ("The watering can is empty.")', async () => {
    const core = wireCore();
    const handler = core.affordanceRegistry.getHandler('water_plants')!;
    const result = await handler('planter-1', GARDENER, { water_level: 0 });
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('The watering can is empty.');
  });

  it('drive effects are unchanged: curiosity +10, comfort +5 on success', async () => {
    const core = wireCore();
    const handler = core.affordanceRegistry.getHandler('water_plants')!;
    const result = await handler('planter-1', GARDENER, { water_level: 2 });
    expect(result.success).toBe(true);
    expect(result.driveChanges).toEqual({ curiosity: 10, comfort: 5 });
  });
});

// ── AC-2: the refill path closes the loop ───────────────────────────────────

describe('spec 055 Req 2 / AC-2: water-butt-1 refill closes the loop', () => {
  it('water-butt-1 ("Rain Barrel", furniture) exists in the garden declaring fill_watering_can', () => {
    const barrel = sceneObject('water-butt-1');
    expect(barrel.name).toBe('Rain Barrel');
    expect(barrel.type).toBe('furniture');
    expect(barrel.roomId).toBe('garden');
    expect(barrel.affordances.map((a) => a.id)).toContain('fill_watering_can');
    expect(DYNAMIC_WORLD_SCENE.rooms.find((r) => r.id === 'garden')!.objectIds).toContain(
      'water-butt-1',
    );
  });

  it('the barrel is an unbounded source: fill_watering_can declares no availability condition', () => {
    const barrel = sceneObject('water-butt-1');
    const fill = barrel.affordances.find((a) => a.id === 'fill_watering_can')!;
    expect(fill.conditions).toBeUndefined();
  });

  it('executing fill_watering_can sets planter-1.water_level to 5 via crossObjectStateChanges', async () => {
    const core = wireCore();
    core.smartObjectRegistry.updateState('planter-1', {
      water_level: 0,
      seeds_planted: 0,
      vegetables: 0,
    });
    // Through the REAL physics execution path — the patch lands via
    // SmartObjectRegistry.applyStatePatch (spec 018, Req 9 mechanics).
    const result = await core.physics.executeAffordance(
      'water-butt-1',
      'fill_watering_can',
      GARDENER,
    );
    expect(result.success).toBe(true);
    expect(core.smartObjectRegistry.get('planter-1')!.state['water_level']).toBe(5);
  });

  it('the exhausted state is recoverable: deplete → affordance exits → refill → re-enters', async () => {
    const core = wireCore();
    // Full reservoir → water_plants available.
    expect(availableInGarden(core)).toContain('water_plants');

    // Deplete to 0 through the real Execute phase (5 handler runs).
    const execute = new ExecuteServiceImpl({ dataProvider: core.bridges.execute });
    core.bridges.plan.storePlan(GARDENER, {
      description: 'Water the plants repeatedly',
      steps: [{ description: 'Water the plants', targetAffordance: 'water_plants' }],
    });
    core.smartObjectRegistry.updateState('planter-1', {
      water_level: 1,
      seeds_planted: 0,
      vegetables: 0,
    });
    const first = await execute.execute(GARDENER);
    expect(first.success).toBe(true);
    expect(core.smartObjectRegistry.get('planter-1')!.state['water_level']).toBe(0);
    // The world says no: the affordance left the enum.
    expect(availableInGarden(core)).not.toContain('water_plants');

    // Refill from the barrel through the real physics path.
    await core.physics.executeAffordance('water-butt-1', 'fill_watering_can', GARDENER);
    expect(core.smartObjectRegistry.get('planter-1')!.state['water_level']).toBe(5);
    // The loop is closed: water_plants re-enters the available set.
    expect(availableInGarden(core)).toContain('water_plants');
  });
});

// ── Req 4 engine half: the stamped outcome through the REAL providers ───────

/** Scripted LLM serving one plan and a memory-writing reflect response. */
class WaterCycleLLM implements LLMClient {
  constructor(private readonly planResult: FormulatePlanResult) {}
  async completeStructured(): Promise<LLMActionResponse> {
    return { reasoning: 'scripted', action: 'wait' };
  }
  async completeReflection(): Promise<ReflectionResult> {
    return { agentId: GARDENER, newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(): Promise<FormulatePlanResult> {
    return this.planResult;
  }
  async completeReflect(): Promise<ReflectLLMResponse> {
    return {
      memoryContent: 'Watered the planter; the reservoir dropped by one.',
      memoryImportance: 5,
      memoryType: 'action',
    };
  }
}

/** Pass-through classifier stub (deterministic, no embeddings). */
const classifier = {
  prune: async (_q: string, affordances: import('@evol-hive/shared').Affordance[]) => affordances,
} as unknown as AffordanceClassifier;

describe('spec 055 Req 4: the engine stamps lastPlanOutcome through the real stack', () => {
  async function runFullCycle(
    core: EngineCore,
    planResult: FormulatePlanResult,
  ): Promise<PerceptionResult> {
    const llm = new WaterCycleLLM(planResult);

    const perception = await new PerceptionServiceImpl({
      provider: core.bridges.perception,
      classifier,
    }).perceive(GARDENER);
    await new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: core.bridges.plan,
    }).plan(GARDENER, perception);
    const execute: ExecuteResult = await new ExecuteServiceImpl({
      dataProvider: core.bridges.execute,
    }).execute(GARDENER);
    await new ReflectServiceImpl({
      reflectBuilder: new ReflectBuilderImpl(),
      llmClient: llm,
      dataProvider: core.bridges.reflect,
    }).reflect(GARDENER, execute);
    return perception;
  }

  it('a completing plan leaves success + steps + drive deltas + reflected=true on the agent state', async () => {
    const core = wireCore();
    await runFullCycle(core, {
      description: 'Water the plants',
      steps: [{ description: 'Water the plants', targetAffordance: 'water_plants' }],
    });

    const outcome = core.agentManager.getState(GARDENER)!.lastPlanOutcome;
    expect(outcome).toBeDefined();
    expect(outcome!.planDescription).toBe('Water the plants');
    expect(outcome!.steps).toEqual(['water_plants']);
    expect(outcome!.success).toBe(true);
    expect(outcome!.driveChanges).toEqual({ curiosity: 10, comfort: 5 });
    expect(outcome!.reflected).toBe(true);
  });

  it('the perception provider surfaces the stamped outcome to the plan context', async () => {
    const core = wireCore();
    await runFullCycle(core, {
      description: 'Water the plants',
      steps: [{ description: 'Water the plants', targetAffordance: 'water_plants' }],
    });

    expect(core.bridges.perception.getLastPlanOutcome!(GARDENER)).toBeDefined();

    // The next cycle's plan context carries the last-plan line (Req 4 seam).
    const perception = await new PerceptionServiceImpl({
      provider: core.bridges.perception,
      classifier,
    }).perceive(GARDENER);
    expect(perception.lastPlanOutcome).toBeDefined();
    const payload = new PlanBuilderImpl().build(perception);
    expect(payload.perceptionContext).toContain('Your last plan was "water_plants" — it succeeded');
    expect(payload.perceptionContext).toContain('(curiosity +10, comfort +5)');
  });

  it('the depleted reservoir + self-visibility drive the NEXT plan context to the refill chain', async () => {
    const core = wireCore();
    // Cycle 1: a successful watering — the stamp records success + deltas and
    // the reservoir drops 5 → 4 (Req 1 depletion + Req 4 stamping).
    const perception1 = await runFullCycle(core, {
      description: 'Water the plants',
      steps: [{ description: 'Water the plants', targetAffordance: 'water_plants' }],
    });
    const outcome = core.agentManager.getState(GARDENER)!.lastPlanOutcome;
    expect(outcome!.success).toBe(true);
    expect(outcome!.reflected).toBe(true);
    expect(core.smartObjectRegistry.get('planter-1')!.state['water_level']).toBe(4);

    // Drain the reservoir completely — the world now says NO: the affordance
    // left the available set (Req 1 saturation, perception-time gating).
    core.smartObjectRegistry.updateState('planter-1', {
      water_level: 0,
      seeds_planted: 0,
      vegetables: 0,
    });
    expect(availableInGarden(core)).not.toContain('water_plants');

    // The NEXT cycle's perception still carries the last plan + outcome
    // (Req 4 self-visibility): the agent sees what it just did while the
    // enum refuses the exhausted action — the plan context steers toward the
    // refill chain (fill_watering_can stays available; it is an unbounded
    // source, Req 2).
    const perception2 = await new PerceptionServiceImpl({
      provider: core.bridges.perception,
      classifier,
    }).perceive(GARDENER);
    expect(perception2.lastPlanOutcome).toEqual(outcome);
    expect(perception1.lastPlanOutcome).toBeUndefined(); // cycle 1 predates the stamp
    const payload = new PlanBuilderImpl().build(perception2);
    expect(payload.perceptionContext).toContain('Your last plan was "water_plants" — it succeeded');
    // The enum the LLM plans over excludes the saturated affordance…
    const enumIds = payload.availableAffordances.map((a) => a.id);
    expect(enumIds).not.toContain('water_plants');
    // …but keeps the refill path available (the loop is closable).
    expect(enumIds).toContain('fill_watering_can');
  });
});
