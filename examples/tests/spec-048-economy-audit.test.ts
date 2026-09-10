/**
 * Spec 048 — Restoration-Magnitude Economy Audit (examples/dynamic-world) — AC-5
 * ==============================================================================
 * Deterministic acceptance test for Req 2 (issue #168): the drive-economy
 * ledger for the dynamic-world scene is encoded as a test, not hand-tuned. For
 * EVERY drive, the largest restoring delta available in the scene must exceed
 * the maximum per-interval decay at cc=3 (`decayRate / 3 × meanCycleInterval`).
 * Magnitudes move ONLY where the audit fails — the test names the failing
 * (affordance, drive) pair (spec 048 "audit-first rebalancing"; protects the
 * #139 oscillation, Req 4: restoration stays just above decay, never an order
 * of magnitude above, so drives keep oscillating instead of monotone-maxing).
 *
 * Derivation of the audit bound (deterministic — no LLM anywhere):
 *   - `configuredDecayRate` = 0.1/s — the spec-019 default, pinned by
 *     `defaultEngineConfig().driveDecayRate` (must never change; spec 019).
 *   - cc = 3 — the concurrency the spec targets (`ENGINE_MAX_CONCURRENT_LLM=3`,
 *     the Req 5 validation protocol); the divisor in Req 1's effective rate.
 *   - SCENE_DURATION_MS = 1_800_000 — the 30-minute live validation run (Req 5).
 *   - Expected cycles per agent = 20 — issue #168 evidence: the scheduler
 *     spreads cycles across 3 agents, stretching each agent's effective cycle
 *     interval to 60–90s of sim time (1800s / 90s worst case = 20 cycles).
 *   - meanCycleInterval = SCENE_DURATION_MS / expectedCyclesPerAgent = 90s.
 *   - Max per-interval decay at cc=3 = 0.1/3 × 90 ≈ 3 drive points.
 *
 * Social is audited against its DOCUMENTED restoration source — agent-to-agent
 * cognitive tools (`talk_to` +10 total: monologue +2, exchange +8, spec 018) —
 * not scene affordances: spec 032's design (and the sim header) reserves the
 * social drive for the spec-018/024/047 social system, so no affordance
 * declares a social `effects` delta BY DESIGN.
 *
 * Also pins (Req 3, scene half): `plant_seeds` and `harvest` declare
 * `progresses: { drive: 'hunger' }`; no scene affordance declares `progresses`
 * for `social`; and the sim header documents the cc=3 numbers (Req 2).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Affordance, SmartObject } from '@evol-hive/shared';
import { defaultEngineConfig } from '@evol-hive/shared';
import { DYNAMIC_WORLD_SCENE } from '../dynamic-world.ts';

// ── Audit bound (see module docblock for the derivation) ─────────────────────

/** The spec-019 default decay rate — the audit runs against the REAL config. */
const CONFIGURED_DECAY_RATE = defaultEngineConfig().driveDecayRate ?? 0.1;
expect(CONFIGURED_DECAY_RATE).toBe(0.1); // spec 019 pins it; AC-7 keeps it

const CC = 3; // ENGINE_MAX_CONCURRENT_LLM=3 (Req 5 validation protocol)
const SCENE_DURATION_MS = 1_800_000; // 30-min live run (Req 5)
const EXPECTED_CYCLES_PER_AGENT = 20; // 1800s / 90s worst-case interval (issue #168)
const MEAN_CYCLE_INTERVAL_S = SCENE_DURATION_MS / 1000 / EXPECTED_CYCLES_PER_AGENT; // 90
/** Maximum per-interval decay at cc=3 (Req 1 scaling): decayRate / CC × interval. */
const MAX_PER_INTERVAL_DECAY = (CONFIGURED_DECAY_RATE / CC) * MEAN_CYCLE_INTERVAL_S;

// ── Scene ledger: largest DECLARED restoring delta per drive ─────────────────

/** The five canonical drive keys (AgentDrives). */
const DRIVE_KEYS = ['energy', 'hunger', 'social', 'comfort', 'curiosity'] as const;

/** All affordances declared in the scene, flattened with their owning object. */
function sceneAffordances(): { object: SmartObject; affordance: Affordance }[] {
  return DYNAMIC_WORLD_SCENE.objects.flatMap((object) =>
    object.affordances.map((affordance) => ({ object, affordance })),
  );
}

describe('AC-5: drive-economy audit — restoration > per-interval decay at cc=3', () => {
  it('the audit bound is 0.1/3 × 90s ≈ 3 drive points', () => {
    expect(MEAN_CYCLE_INTERVAL_S).toBe(90);
    expect(MAX_PER_INTERVAL_DECAY).toBeCloseTo(3, 9);
  });

  it('every drive has a restoration source strictly above the per-interval decay (failing pairs named)', () => {
    const all = sceneAffordances();
    // Social's documented restoration is a cognitive tool, not an affordance
    // (spec 018: talk_to own social +10 = monologue +2 + exchange +8; the sim
    // header documents the solo-window bound). Encoded as the ledger row the
    // spec-032 economy documentation already establishes.
    const SOCIAL_TALK_TO_DELTA = 10;

    const failures: string[] = [];
    const ledger: { drive: string; source: string; delta: number }[] = [];

    for (const drive of DRIVE_KEYS) {
      if (drive === 'social') {
        ledger.push({
          drive,
          source: 'talk_to (cognitive tool, spec 018)',
          delta: SOCIAL_TALK_TO_DELTA,
        });
        continue;
      }
      let best: { source: string; delta: number } | null = null;
      for (const { object, affordance } of all) {
        // Only DECLARED `effects` bind the matcher (spec 032/034) — handler
        // driveChanges that are not declared do not count, and `progresses`
        // declarations are chain hints, NOT restorations (never audited here).
        const delta = affordance.effects?.[drive];
        if (delta !== undefined && delta > 0 && (best === null || delta > best.delta)) {
          best = { source: `${object.id} "${affordance.id}"`, delta };
        }
      }
      if (best === null) {
        failures.push(`(none, ${drive}): no restoring affordance declared in the scene`);
        continue;
      }
      ledger.push({ drive, source: best.source, delta: best.delta });
    }

    for (const row of ledger) {
      if (!(row.delta > MAX_PER_INTERVAL_DECAY)) {
        failures.push(`(${row.source}, ${row.drive}): ${row.delta} ≤ ${MAX_PER_INTERVAL_DECAY}`);
      }
    }

    expect(
      failures,
      `drive-economy audit FAILED — raise restoration magnitudes ONLY for these (affordance, drive) pairs: ${failures.join('; ')}`,
    ).toEqual([]);
  });

  it('the audited maxima are exactly the documented ledger (a silent scene edit is caught)', () => {
    const maxFor = (drive: string): number =>
      Math.max(
        0,
        ...sceneAffordances()
          .map(({ affordance }) => affordance.effects?.[drive] ?? 0)
          .filter((d) => d > 0),
      );
    // Sim-header economy table numbers (spec 032/034), cc=3-audited in spec 048.
    expect(maxFor('energy')).toBe(5); // bench/stool relax
    expect(maxFor('hunger')).toBe(25); // planter eat
    expect(maxFor('comfort')).toBe(20); // bench/stool relax
    expect(maxFor('curiosity')).toBe(12); // potting-table repot_seedlings
    expect(maxFor('social')).toBe(0); // restored ONLY by cognitive tools (by design)
  });

  it('restoration stays JUST above decay (Req 4: no order-of-magnitude overshoot → no monotone maxing)', () => {
    const maxFor = (drive: string): number =>
      Math.max(
        0,
        ...sceneAffordances()
          .map(({ affordance }) => affordance.effects?.[drive] ?? 0)
          .filter((d) => d > 0),
      );
    // The #139 oscillation requires restoration deltas above per-interval decay
    // but NOT an order of magnitude above it (over-tuning kills oscillation).
    for (const drive of ['energy', 'hunger', 'comfort', 'curiosity'] as const) {
      const delta = maxFor(drive);
      expect(delta).toBeGreaterThan(MAX_PER_INTERVAL_DECAY);
      expect(delta).toBeLessThan(MAX_PER_INTERVAL_DECAY * 10);
    }
  });
});

// ── Req 3 (scene half): hunger-chain declarations ────────────────────────────

describe('Req 3: plant_seeds/harvest declare progresses { drive: hunger } — scene data only', () => {
  const planter = DYNAMIC_WORLD_SCENE.objects.find((o) => o.id === 'planter-1')!;

  it('plant_seeds and harvest declare progresses for hunger (with notes)', () => {
    const plant = planter.affordances.find((a) => a.id === 'plant_seeds')!;
    const harvestAff = planter.affordances.find((a) => a.id === 'harvest')!;
    expect(plant.progresses).toEqual({
      drive: 'hunger',
      note: 'harvest → eat restores hunger',
    });
    expect(harvestAff.progresses).toEqual({
      drive: 'hunger',
      note: 'eat restores hunger once a vegetable is ripe',
    });
  });

  it('eat declares NO progresses (it IS the restoration) and plant_seeds declares no hunger effects (no faked restoration)', () => {
    const eat = planter.affordances.find((a) => a.id === 'eat')!;
    const plant = planter.affordances.find((a) => a.id === 'plant_seeds')!;
    expect(eat.progresses).toBeUndefined();
    expect(eat.effects?.hunger).toBe(25);
    // Spec 048 "What NOT to do": never fake chain progress with a small
    // positive hunger effect on plant_seeds.
    expect(plant.effects?.hunger).toBeUndefined();
  });

  it('no scene affordance declares progresses for social (spec 018/024/047 own it)', () => {
    const socialDeclarations = sceneAffordances().filter(
      ({ affordance }) => affordance.progresses?.drive === 'social',
    );
    expect(socialDeclarations).toEqual([]);
  });
});

// ── Req 2 (docs half): the sim header carries the cc=3 numbers ───────────────

describe('Req 2: the sim header documents the cc=3 rebalance and audit numbers', () => {
  const simSource = readFileSync(resolve(__dirname, '../dynamic-world-sim.ts'), 'utf-8');
  const sceneSource = readFileSync(resolve(__dirname, '../dynamic-world.ts'), 'utf-8');

  it('the sim header documents per-agent decay scaling with the cc=3 arithmetic', () => {
    expect(simSource).toMatch(/spec 048/);
    expect(simSource).toMatch(/decayRate\s*\/\s*N|decayRate \/ 3/);
    expect(simSource).toMatch(/ENGINE_DECAY_SCALING/);
    expect(simSource).toMatch(/0\.1\/3\s*×\s*90s?\s*≈\s*3|≈\s*3\s*points/);
  });

  it('the sim header documents the audit results per drive (energy/hunger/comfort/curiosity/social)', () => {
    expect(simSource).toMatch(/energy 5 > 3/);
    expect(simSource).toMatch(/hunger 25 > 3/);
    expect(simSource).toMatch(/comfort 20 > 3/);
    expect(simSource).toMatch(/curiosity 12 > 3/);
    expect(simSource).toMatch(/social 10/);
  });

  it('the sim header documents the hunger-chain surfacing (progresses on plant_seeds/harvest)', () => {
    expect(simSource).toMatch(/progresses/i);
    expect(simSource).toMatch(/2\/3-seeds stall|chain step/i);
  });

  it('the scene file documents the chain-surfacing rationale', () => {
    expect(sceneSource).toMatch(/spec 048/);
    expect(sceneSource).toMatch(/progresses/);
  });
});
