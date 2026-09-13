/**
 * Spec 056 — Superseded verdict in the plan prompt (Req 3 — issue #201, AC-5)
 * ────────────────────────────────────────────────────────────────────────────
 * An engine-stamped superseded outcome renders as the dynamic-section line
 * `Your last plan was "step, step, …" — superseded after N of M steps.`
 * (spec 021 stable-prefix discipline — dynamic section only). driveChanges
 * append in the existing formatDriveDeltas form; reflected: true still adds
 * the reflection line. Outcomes without `superseded` render exactly as
 * today (spec 055: succeeded/failed); stepsCompleted/stepsTotal are only
 * read when superseded is true.
 */
import { describe, it, expect } from 'vitest';
import type { Affordance, LastPlanOutcome, PerceptionResult } from '@evol-hive/shared';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';

const drives = { energy: 45, hunger: 50, social: 50, comfort: 50, curiosity: 60 };

const prunedAffordances: Affordance[] = [
  {
    id: 'water_plants',
    label: 'Water the plants',
    engineEffect: 'water_plants',
    preconditions: [],
    effects: { curiosity: 10, comfort: 5 },
  },
];

function makePerception(overrides: Partial<PerceptionResult> = {}): PerceptionResult {
  return {
    passive: {
      roomId: 'garden',
      objectsPresent: [{ objectId: 'planter-1', name: 'Planter', type: 'furniture' }],
      drives,
    },
    prunedAffordances,
    primaryDriveLabel: 'low curiosity, need to restore curiosity',
    ...overrides,
  };
}

const SUPERSEDED_OUTCOME: LastPlanOutcome = {
  planDescription: 'Morning greenhouse round',
  steps: ['go_to_greenhouse', 'water_plants', 'repot_seedlings'],
  success: false,
  superseded: true,
  stepsCompleted: 1,
  stepsTotal: 3,
  reflected: false,
};

const builder = new PlanBuilderImpl();

/** Split the payload context into its stable (pre-`---`) and dynamic sections. */
function sections(context: string): { stable: string; dynamic: string } {
  const [stable, dynamic = ''] = context.split('\n---\n');
  return { stable: stable ?? '', dynamic };
}

describe('spec 056 Req 3 / AC-5: superseded verdict in the plan prompt', () => {
  it('renders the superseded verdict with N of M steps', () => {
    const payload = builder.build(makePerception({ lastPlanOutcome: SUPERSEDED_OUTCOME }));
    expect(payload.perceptionContext).toContain(
      'Your last plan was "go_to_greenhouse, water_plants, repot_seedlings" — superseded after 1 of 3 steps.',
    );
  });

  it('renders in the dynamic section only (stable prefix untouched)', () => {
    const payload = builder.build(makePerception({ lastPlanOutcome: SUPERSEDED_OUTCOME }));
    const { stable, dynamic } = sections(payload.perceptionContext);
    expect(dynamic).toContain('superseded after 1 of 3 steps');
    expect(stable).not.toContain('superseded');
  });

  it('appends drive deltas after the verdict in the existing formatDriveDeltas form', () => {
    const payload = builder.build(
      makePerception({
        lastPlanOutcome: { ...SUPERSEDED_OUTCOME, driveChanges: { curiosity: 10 } },
      }),
    );
    expect(payload.perceptionContext).toContain(
      'Your last plan was "go_to_greenhouse, water_plants, repot_seedlings" — superseded after 1 of 3 steps (curiosity +10).',
    );
  });

  it('the reflection line follows when reflected is true', () => {
    const payload = builder.build(
      makePerception({ lastPlanOutcome: { ...SUPERSEDED_OUTCOME, reflected: true } }),
    );
    const lines = payload.perceptionContext.split('\n');
    const verdictIndex = lines.findIndex((line) => line.includes('superseded after 1 of 3 steps'));
    expect(verdictIndex).toBeGreaterThanOrEqual(0);
    expect(lines[verdictIndex + 1]).toBe(
      'You already reflected on that plan — what you learned is in your memory.',
    );
  });

  it('outcomes without superseded render the spec-055 succeeded/failed verdicts byte-identically', () => {
    const succeeded = builder.build(
      makePerception({
        lastPlanOutcome: {
          planDescription: 'Water the greenhouse plants',
          steps: ['go_to_greenhouse', 'water_plants'],
          success: true,
          driveChanges: { curiosity: 10 },
          reflected: true,
        },
      }),
    );
    expect(succeeded.perceptionContext).toContain(
      'Your last plan was "go_to_greenhouse, water_plants" — it succeeded (curiosity +10).',
    );

    const failed = builder.build(
      makePerception({
        lastPlanOutcome: {
          planDescription: 'Water the greenhouse plants',
          steps: ['water_plants'],
          success: false,
          reflected: false,
        },
      }),
    );
    expect(failed.perceptionContext).toContain('Your last plan was "water_plants" — it failed.');
  });

  it('stepsCompleted/stepsTotal are ignored when superseded is absent', () => {
    const payload = builder.build(
      makePerception({
        lastPlanOutcome: {
          planDescription: 'Water the greenhouse plants',
          steps: ['water_plants'],
          success: false,
          stepsCompleted: 5,
          stepsTotal: 9,
          reflected: false,
        },
      }),
    );
    expect(payload.perceptionContext).toContain('Your last plan was "water_plants" — it failed.');
    expect(payload.perceptionContext).not.toContain('superseded after');
  });

  it('no lastPlanOutcome record → no last-plan lines (never fabricate history)', () => {
    const payload = builder.build(makePerception());
    expect(payload.perceptionContext).not.toContain('Your last plan was');
  });
});

export {};
