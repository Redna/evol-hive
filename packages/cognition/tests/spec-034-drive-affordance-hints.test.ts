/**
 * Tests for spec 034 — Drive→Affordance Matching Hints (issue #130).
 * ────────────────────────────────────────────────────────────────────────────
 * Deterministic acceptance tests for the cognition half of spec 034. The
 * drive→affordance matcher binds urgent drives (value < 40, social excluded)
 * to the affordances in the current perception whose declared `effects`
 * positively restore them — no hardcoded drive→tool table (AC-4), no hint
 * when no matching affordance exists (Req 4, no phantom remedies), and hints
 * only in the dynamic prompt section (KV-cache safety, spec 021).
 *
 * Coverage:
 *   AC-1 — PerceptionBuilder emits the suggestion-form hint line; PlanBuilder
 *          emits the imperative variant; both name the affordance IDs, their
 *          object (when attributed), and the drive restored.
 *   AC-2 — no hint when (a) the drive is ≥ 40, (b) no affordance in perception
 *          has a positive effects entry for that drive, or (c) the urgent
 *          drive is `social`; hints appear only below the `---` separator and
 *          the stable section is byte-identical with/without hints.
 *   AC-4 — the matcher is driven purely by `Affordance.effects`: a fake
 *          affordance with `effects: { hunger: 30 }` surfaces for a
 *          low-hunger agent with zero cognition-side mapping.
 */
import { describe, it, expect } from 'vitest';
import type { Affordance, PassivePerception, PerceptionResult } from '@evol-hive/shared';
import {
  matchDrivesToAffordances,
  DRIVE_URGENCY_THRESHOLD,
  MAX_DRIVE_HINT_AFFORDANCES,
  HINTABLE_DRIVES,
  type DriveAffordanceMatch,
} from '../src/pper/drive-affordance-matcher.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A bench affordance annotated with its owning object (dynamic-world pattern). */
function sitOutside(): Affordance {
  return {
    id: 'sit_outside',
    label: 'Sit outside',
    engineEffect: 'sit_outside',
    preconditions: [],
    effects: { comfort: 15, curiosity: 5, energy: 3 },
    objectId: 'garden-bench-1',
    objectName: 'Garden Bench',
  } as Affordance;
}

function relax(): Affordance {
  return {
    id: 'relax',
    label: 'Relax on the bench',
    engineEffect: 'relax',
    preconditions: [],
    effects: { comfort: 20, energy: 5 },
    objectId: 'garden-bench-1',
    objectName: 'Garden Bench',
  } as Affordance;
}

/** Unattributed affordance (no owning-object annotation). */
function plainWork(): Affordance {
  return {
    id: 'work',
    label: 'Work',
    engineEffect: 'work',
    preconditions: [],
    effects: { curiosity: 6, energy: -4, comfort: -3 },
  };
}

function makePerceptionResult(
  overrides: Partial<PerceptionResult> = {},
  passiveOverrides: Partial<PassivePerception> = {},
  affordances: Affordance[] = [sitOutside(), relax()],
): PerceptionResult {
  const passive: PassivePerception = {
    roomId: 'garden',
    objectsPresent: [{ objectId: 'garden-bench-1', name: 'Garden Bench', type: 'furniture' }],
    drives: { energy: 23, hunger: 80, social: 80, comfort: 50, curiosity: 50 },
    ...passiveOverrides,
  };
  return {
    passive,
    prunedAffordances: affordances,
    primaryDriveLabel: 'low energy, need to restore energy',
    ...overrides,
  };
}

/** Split a perceptionContext at the `---` separator into [stable, dynamic]. */
function splitSections(context: string): { stable: string; dynamic: string } {
  const lines = context.split('\n');
  const sep = lines.indexOf('---');
  expect(sep, 'perceptionContext must contain a --- separator line').toBeGreaterThan(-1);
  return { stable: lines.slice(0, sep).join('\n'), dynamic: lines.slice(sep + 1).join('\n') };
}

const PERCEPTION_HINT =
  'Your energy is low (23). Here, you can restore it: garden-bench-1 "sit_outside" (restores energy), garden-bench-1 "relax" (restores energy).';
const PLAN_HINT =
  'Your energy is low (23). The affordances in your tool list restore it directly (e.g., sit_outside at the Garden Bench). Call such an affordance NOW — do not formulate a search plan.';

// ── Matcher: data-driven core (AC-4, Req 3) ─────────────────────────────────

describe('matcher — matchDrivesToAffordances (data-driven, AC-4)', () => {
  it('AC-4: a fake affordance with effects { hunger: 30 } surfaces for a low-hunger agent — no hardcoded mapping', () => {
    const fake: Affordance = {
      id: 'fake_herbs',
      label: 'Eat mystery herbs',
      engineEffect: 'fake_herbs',
      preconditions: [],
      effects: { hunger: 30 },
    };
    const matches = matchDrivesToAffordances(
      { energy: 90, hunger: 20, social: 80, comfort: 80, curiosity: 80 },
      [fake],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.drive).toBe('hunger');
    expect(matches[0]!.driveValue).toBe(20);
    expect(matches[0]!.affordances.map((a) => a.affordanceId)).toEqual(['fake_herbs']);
  });

  it('surfaces multiple restoring affordances in perception order', () => {
    const matches = matchDrivesToAffordances(
      { energy: 23, hunger: 80, social: 80, comfort: 50, curiosity: 50 },
      [sitOutside(), relax()],
    );
    const energy = matches.find((m) => m.drive === 'energy');
    expect(energy).toBeDefined();
    expect(energy!.affordances.map((a) => a.affordanceId)).toEqual(['sit_outside', 'relax']);
  });

  it('ignores non-positive effects entries (zero or negative deltas never restore)', () => {
    const draining: Affordance = {
      id: 'work',
      label: 'Work',
      engineEffect: 'work',
      preconditions: [],
      effects: { energy: -4 },
    };
    const zero: Affordance = {
      id: 'observe',
      label: 'Observe',
      engineEffect: 'observe',
      preconditions: [],
      effects: { energy: 0 },
    };
    const matches = matchDrivesToAffordances(
      { energy: 10, hunger: 80, social: 80, comfort: 80, curiosity: 80 },
      [draining, zero],
    );
    expect(matches).toEqual([]);
  });

  it('suppresses drives with no matching affordance in perception (Req 4 — no phantom remedies)', () => {
    const matches = matchDrivesToAffordances(
      { energy: 10, hunger: 5, social: 80, comfort: 80, curiosity: 80 },
      [sitOutside()], // restores energy only — hunger is urgent with no remedy
    );
    expect(matches.map((m) => m.drive)).toEqual(['energy']);
  });

  it('excludes the social drive (spec 018/024 own it) even when an affordance restores it', () => {
    const socialAffordance: Affordance = {
      id: 'community_dinner',
      label: 'Community dinner',
      engineEffect: 'community_dinner',
      preconditions: [],
      effects: { social: 10 },
    };
    const matches = matchDrivesToAffordances(
      { energy: 90, hunger: 90, social: 5, comfort: 90, curiosity: 90 },
      [socialAffordance],
    );
    expect(matches).toEqual([]);
  });

  it('uses a strict < threshold — drive exactly at the threshold is not urgent', () => {
    expect(DRIVE_URGENCY_THRESHOLD).toBe(40);
    const atThreshold = matchDrivesToAffordances(
      { energy: 40, hunger: 80, social: 80, comfort: 80, curiosity: 80 },
      [sitOutside()],
    );
    expect(atThreshold).toEqual([]);
    const justBelow = matchDrivesToAffordances(
      { energy: 39.9, hunger: 80, social: 80, comfort: 80, curiosity: 80 },
      [sitOutside()],
    );
    expect(justBelow).toHaveLength(1);
  });

  it('caps affordance mentions per drive', () => {
    expect(MAX_DRIVE_HINT_AFFORDANCES).toBe(3);
    const benches: Affordance[] = [1, 2, 3, 4, 5].map((i) => ({
      id: `sit_outside_${i}`,
      label: `Sit outside ${i}`,
      engineEffect: 'sit_outside',
      preconditions: [],
      effects: { energy: 3 },
    }));
    const matches = matchDrivesToAffordances(
      { energy: 10, hunger: 80, social: 80, comfort: 80, curiosity: 80 },
      benches,
    );
    expect(matches[0]!.affordances).toHaveLength(3);
    expect(matches[0]!.affordances.map((a) => a.affordanceId)).toEqual([
      'sit_outside_1',
      'sit_outside_2',
      'sit_outside_3',
    ]);
  });

  it('iterates drives in a deterministic AgentDrives-key order with social excluded', () => {
    expect(HINTABLE_DRIVES).toEqual(['energy', 'hunger', 'comfort', 'curiosity']);
  });

  it('carries optional owning-object attribution through to the matches', () => {
    const matches = matchDrivesToAffordances(
      { energy: 23, hunger: 80, social: 80, comfort: 50, curiosity: 50 },
      [sitOutside(), relax()],
    );
    const energy = matches.find((m) => m.drive === 'energy')!;
    expect(energy.affordances[0]!.objectId).toBe('garden-bench-1');
    expect(energy.affordances[0]!.objectName).toBe('Garden Bench');
  });

  it('is a pure function — same inputs, same output, no mutation of inputs', () => {
    const drives = { energy: 23, hunger: 80, social: 80, comfort: 50, curiosity: 50 };
    const affordances = [sitOutside(), relax()];
    const frozen = JSON.parse(JSON.stringify({ drives, affordances })) as {
      drives: Record<string, number>;
      affordances: Affordance[];
    };
    const a: DriveAffordanceMatch[] = matchDrivesToAffordances(drives, affordances);
    const b: DriveAffordanceMatch[] = matchDrivesToAffordances(drives, affordances);
    expect(a).toEqual(b);
    expect({ drives, affordances }).toEqual(frozen);
  });

  it('returns [] for empty affordance input or empty drives', () => {
    expect(matchDrivesToAffordances({ energy: 10 }, [])).toEqual([]);
    expect(matchDrivesToAffordances({}, [sitOutside()])).toEqual([]);
  });
});

// ── PerceptionBuilder hint (AC-1, Req 1) ─────────────────────────────────────

describe('PerceptionBuilder — drive→affordance hint (spec 034 Req 1)', () => {
  const builder = new PerceptionBuilderImpl();

  it('AC-1: energy < 40 with sit_outside/relax in perception → suggestion hint naming IDs, object, and drive', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).toContain(PERCEPTION_HINT);
  });

  it('the hint line is in the dynamic section (below the --- separator)', () => {
    const payload = builder.build(makePerceptionResult());
    const { dynamic } = splitSections(payload.perceptionContext);
    expect(dynamic).toContain(PERCEPTION_HINT);
  });

  it('unattributed affordances render without the object prefix', () => {
    const payload = builder.build(
      makePerceptionResult({}, {}, [
        plainWork(),
        { ...sitOutside(), objectId: undefined, objectName: undefined } as Affordance,
      ]),
    );
    expect(payload.perceptionContext).toContain(
      'Your energy is low (23). Here, you can restore it: "sit_outside" (restores energy).',
    );
  });

  it('one line per urgent drive (energy and comfort both urgent → two lines)', () => {
    const payload = builder.build(
      makePerceptionResult(
        {},
        { drives: { energy: 23, hunger: 80, social: 80, comfort: 12, curiosity: 50 } },
      ),
    );
    expect(payload.perceptionContext).toContain(
      'Your energy is low (23). Here, you can restore it: garden-bench-1 "sit_outside" (restores energy), garden-bench-1 "relax" (restores energy).',
    );
    expect(payload.perceptionContext).toContain(
      'Your comfort is low (12). Here, you can restore it: garden-bench-1 "sit_outside" (restores comfort), garden-bench-1 "relax" (restores comfort).',
    );
  });

  it('caps mentions at 3 affordances per drive in the rendered line', () => {
    const benches: Affordance[] = [1, 2, 3, 4].map((i) => ({
      id: `sit_outside_${i}`,
      label: `Sit outside ${i}`,
      engineEffect: 'sit_outside',
      preconditions: [],
      effects: { energy: 3 },
    }));
    const payload = builder.build(makePerceptionResult({}, {}, benches));
    expect(payload.perceptionContext).toContain(
      'Your energy is low (23). Here, you can restore it: "sit_outside_1" (restores energy), "sit_outside_2" (restores energy), "sit_outside_3" (restores energy).',
    );
  });

  it('uses the masked affordances as the data source when a guardrail masked them', () => {
    // masked list drops the bench — no hint may fire even though prunedAffordances has it.
    const payload = builder.build(makePerceptionResult({ maskedAffordances: [plainWork()] }));
    expect(payload.perceptionContext).not.toContain('Here, you can restore it');
  });
});

// ── PerceptionBuilder suppression (AC-2, Req 4) ──────────────────────────────

describe('PerceptionBuilder — hint suppression (spec 034 Req 4 / AC-2)', () => {
  const builder = new PerceptionBuilderImpl();

  it('AC-2a: drive ≥ 40 → no hint', () => {
    const payload = builder.build(
      makePerceptionResult(
        {},
        { drives: { energy: 40, hunger: 80, social: 80, comfort: 80, curiosity: 80 } },
      ),
    );
    expect(payload.perceptionContext).not.toContain('Here, you can restore it');
  });

  it('AC-2b: no affordance in perception restores the drive → no hint', () => {
    const payload = builder.build(makePerceptionResult({}, {}, [plainWork()]));
    expect(payload.perceptionContext).not.toContain('Here, you can restore it');
  });

  it('AC-2c: urgent social drive → no drive→affordance hint (spec 018/024 own social)', () => {
    const socialAffordance: Affordance = {
      id: 'community_dinner',
      label: 'Community dinner',
      engineEffect: 'community_dinner',
      preconditions: [],
      effects: { social: 10 },
    };
    const payload = builder.build(
      makePerceptionResult(
        { primaryDriveLabel: 'low social, need social interaction' },
        { drives: { energy: 80, hunger: 80, social: 10, comfort: 80, curiosity: 80 } },
        [socialAffordance],
      ),
    );
    expect(payload.perceptionContext).not.toContain('Your social is low');
    expect(payload.perceptionContext).not.toContain('Here, you can restore it');
    // The spec-018/024 social hints still work — untouched.
  });
});

// ── PlanBuilder imperative hint (AC-1, Req 2) ────────────────────────────────

describe('PlanBuilder — imperative drive→affordance hint (spec 034 Req 2)', () => {
  const builder = new PlanBuilderImpl();

  it('AC-1: energy < 40 with sit_outside/relax in perception → imperative hint naming ID and object', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).toContain(PLAN_HINT);
  });

  it('the hint line is in the dynamic section (below the --- separator)', () => {
    const payload = builder.build(makePerceptionResult());
    const { dynamic } = splitSections(payload.perceptionContext);
    expect(dynamic).toContain(PLAN_HINT);
  });

  it('unattributed affordances render the affordance ID only', () => {
    const payload = builder.build(
      makePerceptionResult({}, {}, [
        { ...sitOutside(), objectId: undefined, objectName: undefined } as Affordance,
      ]),
    );
    expect(payload.perceptionContext).toContain(
      'Your energy is low (23). The affordances in your tool list restore it directly (e.g., sit_outside). Call such an affordance NOW — do not formulate a search plan.',
    );
  });

  it('supplements (does not replace) the social directive logic when social is primary and energy is urgent', () => {
    const payload = builder.build(
      makePerceptionResult(
        { primaryDriveLabel: 'low social, need social interaction' },
        {
          drives: { energy: 23, hunger: 80, social: 10, comfort: 80, curiosity: 80 },
          agentsPresent: [
            { agentId: 'agent-carol', name: 'Carol', currentActivity: 'idle', isThinking: false },
          ],
        },
      ),
    );
    // The energy hint fires…
    expect(payload.perceptionContext).toContain(PLAN_HINT);
    // …and the spec-018/024 social directive + strengthened hint are untouched.
    expect(payload.perceptionContext).toContain(
      'IMPORTANT: Other agents are present. Call talk_to, observe_agent, help, or ignore directly to interact with them. Do not use formulate_plan for social actions.',
    );
    expect(payload.perceptionContext).toContain(
      'Your social drive is your most urgent need. Call talk_to or help NOW to interact with another agent in this room. Do not formulate a plan first.',
    );
  });
});

// ── PlanBuilder suppression (AC-2) ───────────────────────────────────────────

describe('PlanBuilder — hint suppression (spec 034 Req 4 / AC-2)', () => {
  const builder = new PlanBuilderImpl();

  it('AC-2a: drive ≥ 40 → no imperative hint', () => {
    const payload = builder.build(
      makePerceptionResult(
        {},
        { drives: { energy: 40, hunger: 80, social: 80, comfort: 80, curiosity: 80 } },
      ),
    );
    expect(payload.perceptionContext).not.toContain('Call such an affordance NOW');
  });

  it('AC-2b: no matching affordance → no imperative hint', () => {
    const payload = builder.build(makePerceptionResult({}, {}, [plainWork()]));
    expect(payload.perceptionContext).not.toContain('Call such an affordance NOW');
  });

  it('AC-2c: urgent social drive → no drive→affordance hint', () => {
    const socialAffordance: Affordance = {
      id: 'community_dinner',
      label: 'Community dinner',
      engineEffect: 'community_dinner',
      preconditions: [],
      effects: { social: 10 },
    };
    const payload = builder.build(
      makePerceptionResult(
        { primaryDriveLabel: 'low social, need social interaction' },
        { drives: { energy: 80, hunger: 80, social: 10, comfort: 80, curiosity: 80 } },
        [socialAffordance],
      ),
    );
    expect(payload.perceptionContext).not.toContain('Your social is low');
    expect(payload.perceptionContext).not.toContain('Call such an affordance NOW');
  });
});

// ── KV-cache stability (AC-2, spec 021) ──────────────────────────────────────

describe('KV-cache stability — hints never touch the stable section (spec 034 AC-2)', () => {
  const perceptionBuilder = new PerceptionBuilderImpl();
  const planBuilder = new PlanBuilderImpl();

  it('PerceptionBuilder: stable section byte-identical with and without hints (same room state)', () => {
    const withHint = perceptionBuilder.build(makePerceptionResult());
    const withoutHint = perceptionBuilder.build(
      makePerceptionResult(
        {},
        { drives: { energy: 90, hunger: 80, social: 80, comfort: 80, curiosity: 80 } },
      ),
    );
    expect(splitSections(withHint.perceptionContext).stable).toBe(
      splitSections(withoutHint.perceptionContext).stable,
    );
    // Sanity: the hint WAS emitted in the dynamic section of the first build.
    expect(splitSections(withHint.perceptionContext).dynamic).toContain('Here, you can restore it');
  });

  it('PlanBuilder: stable section byte-identical with and without hints (same room state)', () => {
    const withHint = planBuilder.build(makePerceptionResult());
    const withoutHint = planBuilder.build(
      makePerceptionResult(
        {},
        { drives: { energy: 90, hunger: 80, social: 80, comfort: 80, curiosity: 80 } },
      ),
    );
    expect(splitSections(withHint.perceptionContext).stable).toBe(
      splitSections(withoutHint.perceptionContext).stable,
    );
    expect(withHint.systemPrompt).toBe(withoutHint.systemPrompt);
  });

  it('tool ordering is unchanged when hints fire (no reorder, spec 019/024 order preserved)', () => {
    const withHint = planBuilder.build(makePerceptionResult());
    const withoutHint = planBuilder.build(
      makePerceptionResult(
        {},
        { drives: { energy: 90, hunger: 80, social: 80, comfort: 80, curiosity: 80 } },
      ),
    );
    expect(withHint.tools.map((t) => t.function.name)).toEqual(
      withoutHint.tools.map((t) => t.function.name),
    );
    const perceptionWithHint = perceptionBuilder.build(makePerceptionResult());
    const perceptionWithoutHint = perceptionBuilder.build(
      makePerceptionResult(
        {},
        { drives: { energy: 90, hunger: 80, social: 80, comfort: 80, curiosity: 80 } },
      ),
    );
    expect(perceptionWithHint.tools.map((t) => t.function.name)).toEqual(
      perceptionWithoutHint.tools.map((t) => t.function.name),
    );
  });
});
