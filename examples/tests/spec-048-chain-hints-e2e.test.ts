/**
 * Spec 048 — Hunger-Chain Surfacing: REAL-SCENE Integration/E2E — AC-6
 * ====================================================================
 * The unit suite (`packages/cognition/tests/spec-048-drive-chain-hints.test.ts`)
 * pins the matcher/renderers against synthetic affordances COPIED from the
 * scene, and `spec-048-economy-audit.test.ts` pins the scene DECLARATIONS
 * statically. Neither exercises the production path end-to-end. This suite
 * closes that gap: the REAL `DYNAMIC_WORLD_SCENE` loaded into a REAL engine
 * core (spec-032/034 `wireSimCore` pattern), the REAL declarative-condition
 * gating (`eat` behind `vegetables >= 1`, `harvest` behind `seeds_planted >= 3`),
 * the REAL fog gate (spec 039), the REAL spec-034 matcher, and the REAL
 * Perception/Plan builders — deterministic, no LLM anywhere (spec 048
 * Constraints: AC-1/2/3 are the only live-run ACs).
 *
 * Coverage:
 *   AC-6-E2E-1 — fresh planter, hunger < 40: `eat`/`harvest` gated invisible →
 *                chain-ONLY hint surfaces through the production perceive()
 *                path (the 2/3-seeds stall fix, at the integration level).
 *   AC-6-E2E-2 — mid-chain (`seeds_planted >= 3`): `harvest` becomes visible
 *                and joins the chain refs in perception order.
 *   AC-6-E2E-3 — restorer visible (`vegetables >= 1`): the direct-restoration
 *                hint is ranked BEFORE the chain hint (AC-6: "ranked with,
 *                and after, any direct-restoration hints").
 *   AC-6-E2E-4 — hunger ≥ 40: no hunger hint of either kind through the real
 *                path (urgency threshold holds at the integration level).
 *   AC-6-E2E-5 — guardrail interplay: a planless agent under
 *                `affordanceMasking` sees NO chain hint (masking owns
 *                visibility, spec 016/020 — chain hints are suppressed
 *                exactly like direct hints); once a plan is stored they
 *                render again.
 *   Req 1 (sim half) — `dynamic-world-sim.ts` actually WIRES
 *                `decayScaling: defaultDecayScaling()` into its EngineConfig
 *                (the sim is not exported/importable in tests, so the wiring
 *                is pinned at source level, per the audit suite's
 *                source-assertion pattern).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import type { EngineCore } from '@evol-hive/engine';
import {
  PerceptionServiceImpl,
  PerceptionBuilderImpl,
  PlanBuilderImpl,
  GuardrailEngineImpl,
  matchDrivesToAffordances,
} from '@evol-hive/cognition';
import type { AffordanceClassifier } from '@evol-hive/cognition';
import type { Affordance, PerceptionResult } from '@evol-hive/shared';
import { DYNAMIC_WORLD_SCENE, createDynamicWorldHandlers } from '../dynamic-world.ts';

// ── Helpers (the spec-032/034 production wiring) ─────────────────────────────

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

/** Put the gardener in a deterministic mid-run state: hungry, garden explored. */
function makeHungryGardener(core: EngineCore, hunger: number): void {
  const state = core.agentManager.getState(GARDENER)!;
  core.agentManager.updateState(GARDENER, {
    drives: { ...state.drives, energy: 45, hunger, social: 55, comfort: 50, curiosity: 55 },
    // Spec 039 fog gate: the gardener has visited the garden (the sim marks
    // rooms visited on arrival) — without this the fog would hide everything.
    spatialMemory: { visitedRooms: ['garden'], knownDoors: [], discoveredAt: {} },
  });
}

/** Pass-through classifier — spec 048 does not touch pruning (deterministic). */
const stubClassifier: AffordanceClassifier = {
  prune: async (_driveLabel: string, affordances: Affordance[]) => affordances,
};

/** The REAL Perceive phase over the production provider, rendered by the REAL builders. */
async function perceiveThroughProductionStack(
  core: EngineCore,
  guardrail?: GuardrailEngineImpl,
): Promise<{ perception: PerceptionResult; perceptionContext: string; planContext: string }> {
  const service = new PerceptionServiceImpl({
    provider: core.bridges.perception,
    classifier: stubClassifier,
    ...(guardrail !== undefined ? { guardrail } : {}),
  });
  const perception = await service.perceive(GARDENER);
  const perceptionContext = new PerceptionBuilderImpl().build(perception).perceptionContext;
  const planContext = new PlanBuilderImpl().build(perception).perceptionContext;
  return { perception, perceptionContext, planContext };
}

/** The affordance set the matcher actually sees (fog + declarative gating). */
function visibleAffordanceIds(core: EngineCore): string[] {
  return core.bridges.perception.getVisibleAffordancesInRoom(GARDENER, 'garden').map((a) => a.id);
}

beforeEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  delete process.env['SCENE_DURATION_MS'];
  delete process.env['ENGINE_DECAY_SCALING'];
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  delete process.env['SCENE_DURATION_MS'];
  delete process.env['ENGINE_DECAY_SCALING'];
  vi.restoreAllMocks();
});

// ── AC-6-E2E-1: gated restorer → chain-ONLY hint through the production path ─

describe('AC-6-E2E-1: fresh planter — chain-only hint surfaces through the production stack', () => {
  it('the real registry gates eat AND harvest invisible; plant_seeds (with progresses) is visible', () => {
    const core = wireSimCore();
    makeHungryGardener(core, 23);
    const visible = visibleAffordanceIds(core);
    expect(visible).toContain('plant_seeds');
    expect(visible).not.toContain('harvest'); // seeds_planted < 3
    expect(visible).not.toContain('eat'); // vegetables < 1 — the gated restorer
  });

  it('the REAL matcher over the REAL visible set yields a chain-ONLY hunger match with the real scene note', async () => {
    const core = wireSimCore();
    makeHungryGardener(core, 23);
    const { perception } = await perceiveThroughProductionStack(core);
    const hunger = matchDrivesToAffordances(
      perception.passive.drives,
      perception.prunedAffordances,
    ).find((m) => m.drive === 'hunger');
    expect(hunger).toBeDefined();
    expect(hunger!.affordances).toEqual([]); // no visible direct restorer
    expect(hunger!.chainProgress!.map((a) => a.affordanceId)).toEqual(['plant_seeds']);
    // The note is the REAL scene declaration, not the unit test's copy.
    expect(hunger!.chainProgress![0]!.note).toBe('harvest → eat restores hunger');
    expect(hunger!.chainProgress![0]!.objectId).toBe('planter-1');
  });

  it('the production perception context renders the chain line and NO direct-restoration line', async () => {
    const core = wireSimCore();
    makeHungryGardener(core, 23);
    const { perceptionContext } = await perceiveThroughProductionStack(core);
    expect(perceptionContext).toContain(
      'Your hunger is low (23). planter-1 "plant_seeds" progresses the hunger chain (harvest → eat restores hunger).',
    );
    expect(perceptionContext).not.toContain('Here, you can restore it');
  });

  it('the production plan context renders the imperative chain line naming the next step', async () => {
    const core = wireSimCore();
    makeHungryGardener(core, 23);
    const { planContext } = await perceiveThroughProductionStack(core);
    expect(planContext).toContain(
      'Your hunger is low (23). planter-1 "plant_seeds" progresses the hunger chain (harvest → eat restores hunger) — call the next chain step NOW; the restoration lands at the chain\'s end.',
    );
    expect(planContext).not.toContain('restore it directly');
  });
});

// ── AC-6-E2E-2: mid-chain — harvest joins the chain refs in perception order ─

describe('AC-6-E2E-2: mid-chain (seeds_planted >= 3) — harvest surfaces as the second chain ref', () => {
  it('harvest becomes visible and the chain hint lists BOTH steps in perception order', async () => {
    const core = wireSimCore();
    makeHungryGardener(core, 23);
    core.smartObjectRegistry.updateState('planter-1', { seeds_planted: 3 });

    const visible = visibleAffordanceIds(core);
    expect(visible).toContain('harvest');
    expect(visible).not.toContain('eat'); // still gated

    const { perceptionContext } = await perceiveThroughProductionStack(core);
    expect(perceptionContext).toContain(
      'Your hunger is low (23). planter-1 "plant_seeds" progresses the hunger chain (harvest → eat restores hunger), planter-1 "harvest" progresses the hunger chain (eat restores hunger once a vegetable is ripe).',
    );
  });
});

// ── AC-6-E2E-3: restorer visible — direct hint ranked BEFORE the chain hint ──

describe('AC-6-E2E-3: vegetables >= 1 — direct eat hint ranked with, and after-ordered by, the chain line', () => {
  it('the direct-restoration line renders AND precedes the chain line', async () => {
    const core = wireSimCore();
    makeHungryGardener(core, 23);
    core.smartObjectRegistry.updateState('planter-1', { vegetables: 1, seeds_planted: 0 });

    const visible = visibleAffordanceIds(core);
    expect(visible).toContain('eat');

    const { perceptionContext } = await perceiveThroughProductionStack(core);
    const directIdx = perceptionContext.indexOf(
      'Your hunger is low (23). Here, you can restore it: planter-1 "eat" (restores hunger).',
    );
    const chainIdx = perceptionContext.indexOf('progresses the hunger chain');
    expect(directIdx).toBeGreaterThan(-1);
    expect(chainIdx).toBeGreaterThan(directIdx);
  });
});

// ── AC-6-E2E-4: hunger ≥ 40 — no hint through the real path ──────────────────

describe('AC-6-E2E-4: hunger at/above the urgency threshold — no hunger hint of either kind', () => {
  it('hunger 40 and 80 yield no hunger match and no chain line in the production context', async () => {
    for (const hunger of [40, 80]) {
      const core = wireSimCore();
      makeHungryGardener(core, hunger);
      const { perception, perceptionContext } = await perceiveThroughProductionStack(core);
      expect(
        matchDrivesToAffordances(perception.passive.drives, perception.prunedAffordances).find(
          (m) => m.drive === 'hunger',
        ),
      ).toBeUndefined();
      expect(perceptionContext).not.toContain('Your hunger is low');
      expect(perceptionContext).not.toContain('progresses the hunger chain');
    }
  });
});

// ── AC-6-E2E-5: guardrail masking owns visibility (spec 016/020 interplay) ───

describe('AC-6-E2E-5: chain hints respect affordance masking exactly like direct hints', () => {
  it('a planless agent under affordanceMasking sees NO chain hint; after storePlan it renders', async () => {
    const core = wireSimCore();
    makeHungryGardener(core, 23);
    const guardrail = new GuardrailEngineImpl({
      config: { affordanceMasking: true, contextualForcing: true, planValidation: true },
    });

    // Planless: masking blanks the physical affordance list → no hints at all.
    const masked = await perceiveThroughProductionStack(core, guardrail);
    expect(masked.perceptionContext).not.toContain('progresses the hunger chain');
    expect(masked.perceptionContext).not.toContain('Here, you can restore it');

    // With a stored plan the mask lifts and the chain hint renders again.
    core.bridges.plan.storePlan(GARDENER, {
      description: 'Plant seeds to progress the hunger chain',
      steps: [{ description: 'Plant seeds', targetAffordance: 'plant_seeds' }],
    });
    const planned = await perceiveThroughProductionStack(core, guardrail);
    expect(planned.perceptionContext).toContain(
      'planter-1 "plant_seeds" progresses the hunger chain (harvest → eat restores hunger)',
    );
  });
});

// ── Req 1 (sim half): the sim WIRES the scaling, not just documents it ───────

describe('Req 1: dynamic-world-sim passes decayScaling into its EngineConfig', () => {
  const simSource = readFileSync(resolve(__dirname, '../dynamic-world-sim.ts'), 'utf-8');

  it('makeConfig surfaces ENGINE_DECAY_SCALING via defaultDecayScaling() (regression pin)', () => {
    expect(simSource).toContain("import { defaultDecayScaling } from '@evol-hive/shared';");
    expect(simSource).toMatch(/decayScaling:\s*defaultDecayScaling\(\)/);
  });
});
