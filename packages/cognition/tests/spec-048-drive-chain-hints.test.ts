/**
 * Spec 048 — Hunger-Chain Surfacing via Declared `progresses` (Cognition) — AC-6
 * ==============================================================================
 * Deterministic acceptance tests for Req 3 (issue #168): the spec-034 matcher
 * additionally collects, for each urgent drive, affordances whose declared
 * `progresses.drive` matches — the next chain steps toward eventual
 * restoration. Scene data only (`Affordance.progresses`) — NO hardcoded
 * drive→chain table (spec 034 Req 3 preserved). Chain hints render as a
 * secondary line AFTER the direct-restoration hints, never suppress them, and
 * never apply to `social` (spec 018/024/047 own it).
 *
 * Coverage:
 *   AC-6a — hunger < 40 with `eat` visible: direct hints (eat) ranked first,
 *           chain hints (plant_seeds, harvest) ranked after them.
 *   AC-6b — hunger < 40 with `eat` GATED invisible (vegetables < 1): the
 *           chain-only match still surfaces (the 2/3-seeds stall fix).
 *   AC-6c — no chain hint when hunger ≥ 40 (40 itself is not urgent).
 *   AC-6d — no chain hint for `social` even if a `progresses` declares it.
 *   AC-6e — `progresses` naming a NON-urgent drive produces no hint.
 *   AC-6f — `progresses` absent on other affordances → no chain refs; legacy
 *           (pre-048) fixtures produce byte-identical matches/hints.
 *   AC-6g — perception renderer: suggestion-form chain line AFTER the direct
 *           line, dynamic section only (KV-cache safety, spec 021).
 *   AC-6h — plan renderer: imperative-form chain line AFTER the direct line.
 *   AC-6i — cap: chain refs cap at MAX_DRIVE_HINT_AFFORDANCES (perception order).
 */
import { describe, it, expect } from 'vitest';
import type { Affordance, PassivePerception, PerceptionResult } from '@evol-hive/shared';
import {
  matchDrivesToAffordances,
  formatPerceptionDriveHint,
  formatPlanDriveHint,
  formatPerceptionChainHint,
  formatPlanChainHint,
  DRIVE_URGENCY_THRESHOLD,
  MAX_DRIVE_HINT_AFFORDANCES,
} from '../src/pper/drive-affordance-matcher.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The planter's chain affordances as declared in examples/dynamic-world.ts. */
function plantSeeds(): Affordance {
  return {
    id: 'plant_seeds',
    label: 'Plant seeds (after 3 plantings, vegetables ripen for harvest)',
    engineEffect: 'plant_seeds',
    preconditions: [],
    effects: {},
    objectId: 'planter-1',
    objectName: 'Planter',
    progresses: { drive: 'hunger', note: 'harvest → eat restores hunger' },
  } as Affordance;
}

function harvest(): Affordance {
  return {
    id: 'harvest',
    label: 'Harvest vegetables (requires 3 seeds planted)',
    engineEffect: 'harvest',
    preconditions: [],
    effects: { curiosity: 10, comfort: 5 },
    objectId: 'planter-1',
    objectName: 'Planter',
    progresses: { drive: 'hunger', note: 'eat restores hunger once a vegetable is ripe' },
  } as Affordance;
}

/** The actual restoration — gated invisible when vegetables < 1 (spec 032). */
function eat(): Affordance {
  return {
    id: 'eat',
    label: 'Eat a vegetable',
    engineEffect: 'eat',
    preconditions: [],
    effects: { hunger: 25 },
    objectId: 'planter-1',
    objectName: 'Planter',
  } as Affordance;
}

/** A `progresses` declaration targeting `social` — must NEVER hint (spec 018/024/047). */
function socialChain(): Affordance {
  return {
    id: 'wave',
    label: 'Wave',
    engineEffect: 'wave',
    preconditions: [],
    effects: {},
    progresses: { drive: 'social', note: 'talk_to restores social' },
  } as Affordance;
}

/** Chain progress for a NON-urgent drive + no note (renders without parens). */
function pickHerbs(): Affordance {
  return {
    id: 'pick_herbs',
    label: 'Pick fresh herbs',
    engineEffect: 'pick_herbs',
    preconditions: [],
    effects: { curiosity: 8 },
    objectId: 'seed-shelf-1',
    objectName: 'Seed Shelf',
    progresses: { drive: 'hunger' },
  } as Affordance;
}

function makePerceptionResult(
  passiveOverrides: Partial<PassivePerception> = {},
  affordances: Affordance[] = [eat(), plantSeeds(), harvest()],
): PerceptionResult {
  const passive: PassivePerception = {
    roomId: 'garden',
    objectsPresent: [{ objectId: 'planter-1', name: 'Planter', type: 'furniture' }],
    drives: { energy: 50, hunger: 23, social: 80, comfort: 50, curiosity: 50 },
    ...passiveOverrides,
  };
  return {
    passive,
    prunedAffordances: affordances,
    primaryDriveLabel: 'low hunger, need to restore hunger',
  };
}

function splitSections(context: string): { stable: string; dynamic: string } {
  const lines = context.split('\n');
  const sep = lines.indexOf('---');
  expect(sep, 'perceptionContext must contain a --- separator line').toBeGreaterThan(-1);
  return { stable: lines.slice(0, sep).join('\n'), dynamic: lines.slice(sep + 1).join('\n') };
}

// ── Matcher: chain collection (AC-6a/6b/6c/6d/6e/6f) ─────────────────────────

describe('matcher — chain-progress collection (spec 048, Req 3)', () => {
  it('AC-6a: hunger < 40 → plant_seeds + harvest surface as chain refs AFTER the direct eat ref', () => {
    const matches = matchDrivesToAffordances(
      { energy: 50, hunger: 23, social: 80, comfort: 50, curiosity: 50 },
      [eat(), plantSeeds(), harvest()],
    );
    const hunger = matches.find((m) => m.drive === 'hunger');
    expect(hunger).toBeDefined();
    // Direct restoration ranked first…
    expect(hunger!.affordances.map((a) => a.affordanceId)).toEqual(['eat']);
    // …chain progress collected in perception order, after it.
    expect(hunger!.chainProgress!.map((a) => a.affordanceId)).toEqual(['plant_seeds', 'harvest']);
    // Notes ride on the chain refs only.
    expect(hunger!.chainProgress![0]!.note).toBe('harvest → eat restores hunger');
    expect(hunger!.chainProgress![1]!.note).toBe('eat restores hunger once a vegetable is ripe');
    // Direct refs never carry a note.
    expect(hunger!.affordances[0]!.note).toBeUndefined();
    // Attribution preserved on chain refs (dynamic-world stamping).
    expect(hunger!.chainProgress![0]!.objectId).toBe('planter-1');
  });

  it('AC-6b: eat gated invisible → chain-ONLY match still surfaces (the 2/3-seeds stall fix)', () => {
    const matches = matchDrivesToAffordances(
      { energy: 50, hunger: 23, social: 80, comfort: 50, curiosity: 50 },
      [plantSeeds(), harvest()],
    );
    const hunger = matches.find((m) => m.drive === 'hunger');
    expect(hunger).toBeDefined();
    expect(hunger!.affordances).toEqual([]); // no direct restoration visible
    expect(hunger!.chainProgress!.map((a) => a.affordanceId)).toEqual(['plant_seeds', 'harvest']);
  });

  it('AC-6c: no chain hint when hunger ≥ 40 (the urgency threshold is exclusive)', () => {
    for (const hunger of [DRIVE_URGENCY_THRESHOLD, 80]) {
      const matches = matchDrivesToAffordances(
        { energy: 50, hunger, social: 80, comfort: 50, curiosity: 50 },
        [eat(), plantSeeds(), harvest()],
      );
      expect(matches.find((m) => m.drive === 'hunger')).toBeUndefined();
    }
  });

  it('AC-6d: no chain hint for social even when a progresses declares it', () => {
    const matches = matchDrivesToAffordances(
      { energy: 50, hunger: 80, social: 10, comfort: 50, curiosity: 50 },
      [socialChain()],
    );
    // social is not hintable (spec 018/024/047 own it) — no match at all.
    expect(matches.find((m) => m.drive === 'social')).toBeUndefined();
    expect(matches).toEqual([]);
  });

  it('AC-6e: progresses naming a NON-urgent drive produces no hint', () => {
    // pick_herbs progresses hunger; hunger is NOT urgent here → no hunger
    // match, and curiosity (urgent) gets only its direct ref (effects), no
    // chain entry from pick_herbs' hunger declaration.
    const matches = matchDrivesToAffordances(
      { energy: 50, hunger: 80, social: 80, comfort: 50, curiosity: 23 },
      [pickHerbs()],
    );
    const curiosity = matches.find((m) => m.drive === 'curiosity');
    expect(curiosity).toBeDefined();
    expect(curiosity!.chainProgress).toBeUndefined();
    expect(matches.find((m) => m.drive === 'hunger')).toBeUndefined();
  });

  it('AC-6f: affordances without progresses yield NO chain refs — legacy fixtures unchanged', () => {
    const legacy: Affordance[] = [
      {
        id: 'relax',
        label: 'Relax on the bench',
        engineEffect: 'relax',
        preconditions: [],
        effects: { comfort: 20, energy: 5 },
        objectId: 'garden-bench-1',
        objectName: 'Garden Bench',
      },
    ];
    const matches = matchDrivesToAffordances(
      { energy: 23, hunger: 80, social: 80, comfort: 50, curiosity: 50 },
      legacy,
    );
    const energy = matches.find((m) => m.drive === 'energy');
    expect(energy).toBeDefined();
    expect(energy!.chainProgress).toBeUndefined(); // absent, not empty — pre-048 shape
    expect(energy!.affordances.map((a) => a.affordanceId)).toEqual(['relax']);
  });

  it('AC-6i: chain refs cap at MAX_DRIVE_HINT_AFFORDANCES in perception order', () => {
    const many: Affordance[] = [1, 2, 3, 4].map((i) => ({
      id: `chain_step_${i}`,
      label: `step ${i}`,
      engineEffect: `step_${i}`,
      preconditions: [],
      effects: {},
      progresses: { drive: 'hunger' },
    })) as Affordance[];
    const hunger = matchDrivesToAffordances(
      { energy: 50, hunger: 23, social: 80, comfort: 50, curiosity: 50 },
      many,
    ).find((m) => m.drive === 'hunger');
    expect(hunger!.chainProgress).toHaveLength(MAX_DRIVE_HINT_AFFORDANCES);
    expect(hunger!.chainProgress!.map((a) => a.affordanceId)).toEqual([
      'chain_step_1',
      'chain_step_2',
      'chain_step_3',
    ]);
  });
});

// ── Renderers: secondary line AFTER direct hints (AC-6g/6h) ─────────────────

describe('renderers — chain hints are secondary (spec 048, Req 3)', () => {
  it('AC-6g: perception renders the direct line, then the chain line (suggestion form)', () => {
    const match = matchDrivesToAffordances(
      { energy: 50, hunger: 23, social: 80, comfort: 50, curiosity: 50 },
      [eat(), plantSeeds(), harvest()],
    ).find((m) => m.drive === 'hunger')!;

    const direct = formatPerceptionDriveHint(match);
    const chain = formatPerceptionChainHint(match);
    expect(direct).toBe(
      'Your hunger is low (23). Here, you can restore it: planter-1 "eat" (restores hunger).',
    );
    expect(chain).toBe(
      'Your hunger is low (23). planter-1 "plant_seeds" progresses the hunger chain (harvest → eat restores hunger), planter-1 "harvest" progresses the hunger chain (eat restores hunger once a vegetable is ripe).',
    );
  });

  it('AC-6g: PerceptionBuilder emits the chain line AFTER the direct line, dynamic section only', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    const { stable, dynamic } = splitSections(payload.perceptionContext);
    const directIdx = dynamic.indexOf(
      'Your hunger is low (23). Here, you can restore it: planter-1 "eat" (restores hunger).',
    );
    const chainIdx = dynamic.indexOf(
      'Your hunger is low (23). planter-1 "plant_seeds" progresses the hunger chain (harvest → eat restores hunger), planter-1 "harvest" progresses the hunger chain (eat restores hunger once a vegetable is ripe).',
    );
    expect(directIdx).toBeGreaterThan(-1);
    expect(chainIdx).toBeGreaterThan(directIdx);
    // KV-cache safety: hints live below the --- separator only.
    expect(stable).not.toContain('progresses the hunger chain');
    expect(stable).not.toContain('Here, you can restore it');
  });

  it('AC-6b (renderer): chain-ONLY match renders NO direct line but DOES render the chain line', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult({}, [plantSeeds(), harvest()]));
    const { dynamic } = splitSections(payload.perceptionContext);
    expect(dynamic).not.toContain('Here, you can restore it');
    expect(dynamic).toContain(
      'Your hunger is low (23). planter-1 "plant_seeds" progresses the hunger chain (harvest → eat restores hunger), planter-1 "harvest" progresses the hunger chain (eat restores hunger once a vegetable is ripe).',
    );
  });

  it('AC-6h: PlanBuilder renders the imperative chain line AFTER the direct imperative', () => {
    const builder = new PlanBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    const dynamicLines = payload.perceptionContext.split('\n');
    const directIdx = dynamicLines.findIndex((l) =>
      l.includes(
        'The affordances in your tool list restore it directly (e.g., eat at the Planter).',
      ),
    );
    const chainIdx = dynamicLines.findIndex(
      (l) =>
        l.includes('planter-1 "plant_seeds" progresses the hunger chain') &&
        l.includes('call the next chain step NOW'),
    );
    expect(directIdx).toBeGreaterThan(-1);
    expect(chainIdx).toBeGreaterThan(directIdx);
  });

  it('the imperative chain line names the FIRST chain ref (the next step) and the plan form only', () => {
    const match = matchDrivesToAffordances(
      { energy: 50, hunger: 23, social: 80, comfort: 50, curiosity: 50 },
      [eat(), plantSeeds(), harvest()],
    ).find((m) => m.drive === 'hunger')!;
    expect(formatPlanChainHint(match)).toBe(
      'Your hunger is low (23). planter-1 "plant_seeds" progresses the hunger chain (harvest → eat restores hunger) — call the next chain step NOW; the restoration lands at the chain\'s end.',
    );
  });

  it('unattributed chain affordances render in the spec example form; no note → no parens', () => {
    const unattributed: Affordance = {
      id: 'plant_seeds',
      label: 'Plant seeds',
      engineEffect: 'plant_seeds',
      preconditions: [],
      effects: {},
      progresses: { drive: 'hunger', note: 'harvest → eat restores hunger' },
    } as Affordance;
    const noNote: Affordance = {
      id: 'pick_herbs',
      label: 'Pick fresh herbs',
      engineEffect: 'pick_herbs',
      preconditions: [],
      effects: {},
      progresses: { drive: 'hunger' },
    } as Affordance;
    const match = matchDrivesToAffordances(
      { energy: 50, hunger: 23, social: 80, comfort: 50, curiosity: 50 },
      [unattributed, noNote],
    ).find((m) => m.drive === 'hunger')!;
    // The spec's example line, verbatim for the unattributed + noted ref.
    expect(formatPerceptionChainHint(match)).toBe(
      'Your hunger is low (23). "plant_seeds" progresses the hunger chain (harvest → eat restores hunger), "pick_herbs" progresses the hunger chain.',
    );
  });

  it('no chain line when no progresses declared (legacy hint output byte-identical)', () => {
    const legacy: Affordance[] = [
      {
        id: 'relax',
        label: 'Relax on the bench',
        engineEffect: 'relax',
        preconditions: [],
        effects: { comfort: 20, energy: 5 },
        objectId: 'garden-bench-1',
        objectName: 'Garden Bench',
      },
    ];
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(
      makePerceptionResult(
        { drives: { energy: 23, hunger: 80, social: 80, comfort: 50, curiosity: 50 } },
        legacy,
      ),
    );
    const { dynamic } = splitSections(payload.perceptionContext);
    expect(dynamic).toContain(
      'Your energy is low (23). Here, you can restore it: garden-bench-1 "relax" (restores energy).',
    );
    expect(dynamic).not.toContain('progresses the');
  });
});
