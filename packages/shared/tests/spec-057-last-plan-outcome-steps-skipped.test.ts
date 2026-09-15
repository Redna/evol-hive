/**
 * Spec 057 — Additive LastPlanOutcome.stepsSkipped (Req 2 — issue #204, AC-4)
 * ────────────────────────────────────────────────────────────────────────────
 * `LastPlanOutcome` gains one OPTIONAL field (`stepsSkipped`). Objects built
 * without it typecheck and behave exactly as before (legacy saves, spec-055
 * completion/failure stamps, spec-056 supersession stamps keep their exact
 * shape); the field is conditionally spread — no `undefined`-valued keys when
 * omitted (`exactOptionalPropertyTypes` safe). The type-level teeth of this
 * file are `pnpm typecheck`: a non-optional new field or a required-shape
 * break fails the build there.
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

const skipped: LastPlanOutcome = {
  planDescription: 'Morning greenhouse round',
  steps: ['go_to_greenhouse', 'water_plants', 'repot_seedlings'],
  success: true,
  stepsSkipped: 2,
  reflected: true,
};

describe('spec 057 Req 2 / AC-4: additive LastPlanOutcome.stepsSkipped', () => {
  it('a legacy stamp builds without stepsSkipped and reads as before', () => {
    expect(legacy.stepsSkipped).toBeUndefined();
    expect(legacy.success).toBe(true);
    expect(legacy.steps).toEqual(['go_to_greenhouse', 'water_plants']);
    expect(legacy.driveChanges).toEqual({ curiosity: 10 });
    expect(legacy.reflected).toBe(true);
  });

  it('a skipped stamp carries stepsSkipped alongside the base contract', () => {
    expect(skipped.stepsSkipped).toBe(2);
    expect(skipped.planDescription).toBe('Morning greenhouse round');
    expect(skipped.success).toBe(true);
    expect(skipped.reflected).toBe(true);
  });

  it('the field is conditionally spread — no undefined-valued key when omitted', () => {
    expect(Object.keys(legacy)).not.toContain('stepsSkipped');
    expect(Object.keys(skipped)).toContain('stepsSkipped');
  });
});

export {};
