/**
 * Issue #212 — Plan-Phase Contract Alignment: production-stack E2E
 * ================================================================
 * The issue-212 unit suites assert the plan-phase TEXT against synthetic
 * perceptions. This E2E suite closes the meso/macro gap: the REAL
 * `DYNAMIC_WORLD_SCENE` loaded into a REAL engine core (the spec-032/034
 * `wireSimCore` wiring), through the REAL `PerceptionServiceImpl` and the REAL
 * `PlanBuilderImpl` — deterministic, no LLM anywhere.
 *
 * It verifies the R5-probe contract end-to-end:
 *   E2E-1 — social: a co-located agent with an urgent social drive produces a
 *           plan payload whose social directives are PLAN-shaped and which
 *           contains none of the removed bypass phrases; `formulate_plan` is
 *           still offered (legality surface untouched).
 *   E2E-2 — drive: the hungry gardener's REAL hunger-chain hint (spec 048) is
 *           the plan-shaped wording through the production stack.
 *
 * Known residual (reported, not hidden): the `agents-present` block still
 * renders "You can call talk_to, observe_agent, help, or ignore directly to
 * interact with other agents." on the plan surface. It is documented in the
 * QA report for issue #212.
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
  PerceptionServiceImpl,
  PerceptionBuilderImpl,
  PlanBuilderImpl,
} from '@evol-hive/cognition';
import type { AffordanceClassifier } from '@evol-hive/cognition';
import type { Affordance, EngineConfig, PerceptionResult } from '@evol-hive/shared';
import { DYNAMIC_WORLD_SCENE, createDynamicWorldHandlers } from '../dynamic-world.ts';

const GARDENER = 'gardener-1';

/** The sim's engine config (deterministic — no env coupling in tests). */
function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

/** Wire a core exactly like dynamic-world-sim.ts does. */
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

/** Pass-through classifier — spec 212 does not touch pruning (deterministic). */
const stubClassifier: AffordanceClassifier = {
  prune: async (_driveLabel: string, affordances: Affordance[]) => affordances,
};

/** The REAL Perceive phase over the production provider. */
async function perceive(core: EngineCore, agentId: string): Promise<PerceptionResult> {
  const service = new PerceptionServiceImpl({
    provider: core.bridges.perception,
    classifier: stubClassifier,
  });
  return service.perceive(agentId);
}

/** Move the gardener into the greenhouse so it is co-located with iris + Tomas. */
function moveGardenerToGreenhouse(core: EngineCore): void {
  const state = core.agentManager.getState(GARDENER)!;
  core.agentManager.updateState(GARDENER, {
    location: 'greenhouse',
    drives: { ...state.drives, energy: 70, hunger: 70, social: 10, comfort: 70, curiosity: 65 },
    spatialMemory: { visitedRooms: ['greenhouse'], knownDoors: [], discoveredAt: {} },
  });
}

/** Put the gardener in a deterministic mid-run hunger state (spec 048 pattern). */
function makeHungryGardener(core: EngineCore, hunger: number): void {
  const state = core.agentManager.getState(GARDENER)!;
  core.agentManager.updateState(GARDENER, {
    drives: { ...state.drives, energy: 45, hunger, social: 55, comfort: 50, curiosity: 55 },
    spatialMemory: { visitedRooms: ['garden'], knownDoors: [], discoveredAt: {} },
  });
}

const BANNED_PLAN_BYPASS_PHRASES = [
  'do not use formulate_plan',
  'Do not formulate a plan first',
  'do not formulate a search plan',
  'Call talk_to or help NOW',
  'Call such an affordance NOW',
  'call the next chain step NOW',
];

beforeEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  vi.restoreAllMocks();
});

// ── E2E-1: social co-location through the real scene ─────────────────────────

describe('E2E-1: real scene + real perception + real PlanBuilder — social contract', () => {
  it('a co-located urgent-social agent gets PLAN-shaped directives and no bypass phrase', async () => {
    const core = wireSimCore();
    moveGardenerToGreenhouse(core);

    const perception = await perceive(core, GARDENER);
    expect(perception.passive.agentsPresent?.length ?? 0).toBeGreaterThan(0);
    expect(perception.primaryDriveLabel.toLowerCase()).toContain('social');

    const payload = new PlanBuilderImpl().build(perception);

    // Real production perception context is what the LLM sees.
    expect(payload.systemPrompt).toContain('first step of your plan');
    expect(payload.perceptionContext).toContain(
      'make it a plan step whose targetAffordance is talk_to, observe_agent, help, or ignore',
    );
    expect(payload.perceptionContext).toContain(
      'Make interacting with another agent in this room the FIRST step of your plan',
    );

    const all = `${payload.systemPrompt}\n${payload.perceptionContext}`;
    for (const banned of BANNED_PLAN_BYPASS_PHRASES) {
      expect(all).not.toContain(banned);
    }

    // Legality surface untouched: the plan tool is still offered.
    expect(payload.tools.some((t) => t.function.name === 'formulate_plan')).toBe(true);
  });
});

// ── E2E-2: the real drive/chain hint is plan-shaped ──────────────────────────

describe('E2E-2: real hunger chain through the production stack — plan-shaped hint', () => {
  it('the gardener’s chain hint instructs a plan step, never a direct call', async () => {
    const core = wireSimCore();
    makeHungryGardener(core, 23);

    const perception = await perceive(core, GARDENER);
    const planContext = new PlanBuilderImpl().build(perception).perceptionContext;

    expect(planContext).toContain(
      'planter-1 "plant_seeds" progresses the hunger chain (harvest → eat restores hunger) — make the next chain step your plan\'s next step; the restoration lands at the chain\'s end.',
    );
    for (const banned of BANNED_PLAN_BYPASS_PHRASES) {
      expect(planContext).not.toContain(banned);
    }
  });

  it('the perception (suggestion-form) chain line is unchanged and is not the plan surface', async () => {
    const core = wireSimCore();
    makeHungryGardener(core, 23);

    const perception = await perceive(core, GARDENER);
    const perceptionContext = new PerceptionBuilderImpl().build(perception).perceptionContext;
    // Suggestion form stays suggestion form — the plan builder is the surface
    // that must match the plan contract.
    expect(perceptionContext).toContain(
      'Your hunger is low (23). planter-1 "plant_seeds" progresses the hunger chain (harvest → eat restores hunger).',
    );
    expect(perceptionContext).not.toContain("make the next chain step your plan's next step");
  });
});
