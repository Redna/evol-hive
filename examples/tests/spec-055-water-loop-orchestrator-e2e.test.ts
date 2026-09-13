/**
 * Spec 055 — Closed watering loop through the REAL PPER orchestrator
 * (Req 1 + Req 2 + Req 4 + Req 7 integration — issue #198)
 * ────────────────────────────────────────────────────────────────────────────
 * The deterministic E2E proxy for the AC-8 live-run loop: a multi-cycle run
 * of the production `PPEROrchestratorImpl` over the REAL dynamic-world engine
 * (real perception gating, real plan service, real execute/physics, real
 * reflect stamping) with a SCRIPTED LLM standing in for the model.
 *
 * Nothing else in the suite runs the closed loop at the orchestrator level:
 * the water-economy test drives the phases individually, and the
 * orchestrator/diagnostic tests use fake providers. This test integrates the
 * four seams the spec connects:
 *
 *   cycle 1  plan [water_plants]      → deplete 5→4, outcome stamped
 *   cycle 2  same plan re-formulated  → ONE [plan-repeat] line (count=2),
 *                                      deplete 4→3
 *   (reservoir drained to 0 — equivalent to 3 more identical cycles; the
 *    −1-per-execution rule is pinned in spec-055-water-economy.test.ts)
 *   cycle 3  the agent SEES its last plan ("Your last plan was …") and the
 *            enum WITHOUT water_plants but WITH fill_watering_can → plans the
 *            refill → crossObjectStateChanges restores 5
 *   cycle 4  water_plants re-enters the enum → planned again → executes,
 *            fingerprint changed → NO new [plan-repeat] line (reset)
 *
 * Also pins Req 6's presence in the REAL planner payload: the formulate_plan
 * tool schema the orchestrator hands the LLM carries steps.maxItems
 * (= PLAN_MAX_STEPS, default 6).
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
import { PPEROrchestratorImpl } from '@evol-hive/cognition';
import type { AffordanceClassifier, LLMClient, LLMContextPayload } from '@evol-hive/cognition';
import type {
  FormulatePlanResult,
  LLMActionResponse,
  ReflectLLMResponse,
  ReflectionResult,
  SmartObject,
} from '@evol-hive/shared';
import { DYNAMIC_WORLD_SCENE, createDynamicWorldHandlers } from '../dynamic-world.ts';

// ── Wiring (identical production registration to spec-055-water-economy) ────

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
  core.affordanceRegistry.registerHandler('carry', async () => ({ success: true }));
  core.affordanceRegistry.registerHandler('open_gate', async () => ({ success: true }));
  core.affordanceRegistry.registerHandler('close_gate', async () => ({ success: true }));
  return core;
}

const GARDENER = 'gardener-1';

function planterState(core: EngineCore): Record<string, unknown> {
  return core.smartObjectRegistry.get('planter-1')!.state;
}

function setWaterLevel(core: EngineCore, level: number): void {
  core.smartObjectRegistry.updateState('planter-1', {
    water_level: level,
    seeds_planted: 0,
    vegetables: 0,
  });
}

// ── Scripted LLM: serves plans in order, records every plan payload ─────────

class LoopLLM implements LLMClient {
  /** Every formulate_plan payload the orchestrator built, in call order. */
  readonly planPayloads: LLMContextPayload[] = [];
  private readonly queue: FormulatePlanResult[];

  constructor(...plans: FormulatePlanResult[]) {
    this.queue = [...plans];
  }

  async completeStructured(): Promise<LLMActionResponse> {
    return { reasoning: 'scripted', action: 'wait' };
  }
  async completeReflection(): Promise<ReflectionResult> {
    return { agentId: GARDENER, newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(payload: LLMContextPayload): Promise<FormulatePlanResult> {
    this.planPayloads.push(payload);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('LoopLLM script exhausted');
    return next;
  }
  async completeReflect(): Promise<ReflectLLMResponse> {
    return {
      memoryContent: 'Tended the garden; the reservoir and my plans are in memory now.',
      memoryImportance: 5,
      memoryType: 'action',
    };
  }
}

/** Pass-through classifier stub (deterministic, no embeddings). */
const classifier = {
  prune: async (_q: string, affordances: import('@evol-hive/shared').Affordance[]) => affordances,
} as unknown as AffordanceClassifier;

const WATER_PLAN: FormulatePlanResult = {
  description: 'Water the planter',
  steps: [{ description: 'Water the planter', targetAffordance: 'water_plants' }],
};
const REFILL_PLAN: FormulatePlanResult = {
  description: 'Refill the watering reservoir from the rain barrel',
  steps: [{ description: 'Fill the watering can', targetAffordance: 'fill_watering_can' }],
};

/** formulates the formulate_plan ToolDefinition from an orchestrator payload. */
function planTool(payload: LLMContextPayload): import('@evol-hive/shared').ToolDefinition {
  const tool = payload.tools.find((t) => t.function.name === 'formulate_plan');
  if (!tool) throw new Error('formulate_plan tool missing from the plan payload');
  return tool;
}

function planRepeatLines(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map((args) => args.map(String).join(' '))
    .filter((l) => l.includes('[plan-repeat]'));
}

beforeEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  delete process.env['PLAN_MAX_STEPS'];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  delete process.env['PLAN_MAX_STEPS'];
  vi.restoreAllMocks();
});

describe('spec 055 E2E: the closed watering loop through the REAL orchestrator', () => {
  it('deplete → [plan-repeat] → disappear → refill → re-enter, with self-visibility at the plan seam', async () => {
    const core = wireCore();
    expect(planterState(core)['water_level']).toBe(5);

    const llm = new LoopLLM(WATER_PLAN, WATER_PLAN, REFILL_PLAN, WATER_PLAN);
    const orchestrator = new PPEROrchestratorImpl({
      perceptionProvider: core.bridges.perception,
      planProvider: core.bridges.plan,
      executeProvider: core.bridges.execute,
      reflectProvider: core.bridges.reflect,
      classifier,
      llmClient: llm,
    });

    // ── Cycle 1: water → deplete 5→4, outcome stamped (Req 1 + Req 4) ──────
    await orchestrator.runCycle(GARDENER);
    expect(planterState(core)['water_level']).toBe(4);
    const outcome1 = core.agentManager.getState(GARDENER)!.lastPlanOutcome;
    expect(outcome1).toMatchObject({
      planDescription: 'Water the planter',
      steps: ['water_plants'],
      success: true,
      reflected: true,
    });

    // ── Cycle 2: identical re-formulation → ONE [plan-repeat] line ─────────
    await orchestrator.runCycle(GARDENER);
    expect(planterState(core)['water_level']).toBe(3);
    const repeatLines = planRepeatLines();
    expect(repeatLines).toHaveLength(1);
    expect(repeatLines[0]).toContain('agent=gardener-1');
    expect(repeatLines[0]).toContain('count=2');

    // ── The world says no: drain the reservoir (setup acceleration — three
    //    more identical watering cycles, each proven −1 in
    //    spec-055-water-economy.test.ts) → water_plants leaves the enum. ────
    setWaterLevel(core, 0);

    // ── Cycle 3: the agent SEES its last plan; the enum refuses watering but
    //    offers the refill; the scripted model re-plans accordingly ─────────
    await orchestrator.runCycle(GARDENER);
    const payload3 = llm.planPayloads[2]!;
    // Req 4 self-visibility in the REAL plan context (dynamic section):
    expect(payload3.perceptionContext).toContain(
      'Your last plan was "water_plants" — it succeeded',
    );
    expect(payload3.perceptionContext).toContain('You already reflected on that plan');
    // Req 1 saturation: water_plants is gone from the value space…
    const enum3 = payload3.availableAffordances.map((a) => a.id);
    expect(enum3).not.toContain('water_plants');
    // …but the refill path (Req 2) is still offered.
    expect(enum3).toContain('fill_watering_can');
    // Req 6 rides the REAL payload: the emitted schema caps steps.
    const params = planTool(payload3).function.parameters as {
      properties: { steps: { maxItems?: number } };
    };
    expect(params.properties.steps.maxItems).toBe(6);
    // The refill executed through real physics: the reservoir is restored.
    expect(planterState(core)['water_level']).toBe(5);

    // ── Cycle 4: water_plants re-enters the enum and is planned again ──────
    await orchestrator.runCycle(GARDENER);
    const payload4 = llm.planPayloads[3]!;
    const enum4 = payload4.availableAffordances.map((a) => a.id);
    expect(enum4).toContain('water_plants');
    // The loop re-closed: another successful watering depletes again.
    expect(planterState(core)['water_level']).toBe(4);
    const outcome4 = core.agentManager.getState(GARDENER)!.lastPlanOutcome;
    expect(outcome4).toMatchObject({ steps: ['water_plants'], success: true, reflected: true });
    // The fingerprint changed at cycle 3 — no NEW [plan-repeat] line fired.
    expect(planRepeatLines()).toHaveLength(1);
    // Every cycle planned exactly once — no hidden binding retries.
    expect(llm.planPayloads).toHaveLength(4);
  });

  it('the final logState sample: planter reservoir, agent outcome, and diagnostic count', async () => {
    const core = wireCore();
    const llm = new LoopLLM(WATER_PLAN, REFILL_PLAN);
    const orchestrator = new PPEROrchestratorImpl({
      perceptionProvider: core.bridges.perception,
      planProvider: core.bridges.plan,
      executeProvider: core.bridges.execute,
      reflectProvider: core.bridges.reflect,
      classifier,
      llmClient: llm,
    });

    await orchestrator.runCycle(GARDENER); // 5→4
    setWaterLevel(core, 0);
    await orchestrator.runCycle(GARDENER); // refill → 5

    // The AC-8 evidence shape, deterministically: reservoir recovered, the
    // last outcome is the refill, and the different plans never repeated.
    expect(planterState(core)['water_level']).toBe(5);
    expect(core.agentManager.getState(GARDENER)!.lastPlanOutcome).toMatchObject({
      planDescription: 'Refill the watering reservoir from the rain barrel',
      steps: ['fill_watering_can'],
      success: true,
    });
    expect(planRepeatLines()).toHaveLength(0);
    // The scene's declared state survived the loop: the barrel stays an
    // unbounded source (no self-draining condition), the planter holds 5.
    const barrel = DYNAMIC_WORLD_SCENE.objects.find((o) => o.id === 'water-butt-1') as SmartObject;
    expect(
      barrel.affordances.find((a) => a.id === 'fill_watering_can')!.conditions,
    ).toBeUndefined();
  });
});
