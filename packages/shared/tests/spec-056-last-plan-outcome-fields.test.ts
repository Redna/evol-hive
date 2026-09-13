/**
 * Spec 056 — Additive LastPlanOutcome fields (Req 2 — issue #201, AC-4)
 * ────────────────────────────────────────────────────────────────────────────
 * `LastPlanOutcome` gains three OPTIONAL fields (`superseded`,
 * `stepsCompleted`, `stepsTotal`). Objects built without the new fields
 * typecheck and behave as before (legacy stamps and legacy saves keep
 * rendering byte-identically); the new fields are conditionally spread —
 * no `undefined`-valued keys when omitted (exactOptionalPropertyTypes safe).
 * The type-level teeth of this file are `pnpm typecheck`: a non-optional
 * new field or a required-shape break fails the build there.
 */
import { describe, it, expect } from 'vitest';
import type { LastPlanOutcome } from '../src/types/agent.js';

const legacy: LastPlanOutcome = {
  planDescription: 'Water the greenhouse plants',
  steps: ['go_to_greenhouse', 'water_plants'],
  success: true,
  driveChanges: { curiosity: 10 },
  reflected: true,
};

const superseded: LastPlanOutcome = {
  planDescription: 'Morning greenhouse round',
  steps: ['go_to_greenhouse', 'water_plants', 'repot_seedlings'],
  success: false,
  superseded: true,
  stepsCompleted: 1,
  stepsTotal: 3,
  reflected: false,
};

describe('spec 056 Req 2 / AC-4: additive LastPlanOutcome fields', () => {
  it('a legacy stamp builds without the new fields and reads as before', () => {
    expect(legacy.superseded).toBeUndefined();
    expect(legacy.stepsCompleted).toBeUndefined();
    expect(legacy.stepsTotal).toBeUndefined();
    expect(legacy.success).toBe(true);
    expect(legacy.steps).toEqual(['go_to_greenhouse', 'water_plants']);
    expect(legacy.driveChanges).toEqual({ curiosity: 10 });
    expect(legacy.reflected).toBe(true);
  });

  it('a superseded stamp carries the three new fields alongside the base contract', () => {
    expect(superseded.superseded).toBe(true);
    expect(superseded.stepsCompleted).toBe(1);
    expect(superseded.stepsTotal).toBe(3);
    expect(superseded.planDescription).toBe('Morning greenhouse round');
    expect(superseded.success).toBe(false);
    expect(superseded.reflected).toBe(false);
  });

  it('fields are conditionally spread — no undefined-valued keys when omitted', () => {
    expect(Object.keys(legacy)).not.toContain('superseded');
    expect(Object.keys(legacy)).not.toContain('stepsCompleted');
    expect(Object.keys(legacy)).not.toContain('stepsTotal');

    expect(Object.keys(superseded)).toContain('superseded');
    expect(Object.keys(superseded)).toContain('stepsCompleted');
    expect(Object.keys(superseded)).toContain('stepsTotal');
  });
});

export {};
