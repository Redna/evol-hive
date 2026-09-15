/**
 * Spec 060 — R1: one pure plan-shape classifier (`shared`, issue #214).
 *
 * `classifyPlanShape` is the single decision point over an already-decoded
 * `FormulatePlanResult`. It returns `null` for a valid shape, otherwise the
 * FIRST failing condition in the fixed order
 * `missing-description` → `missing-steps` → `empty-step-description`, so the
 * live reason code is stable and comparable across runs.
 */
import { describe, it, expect } from 'vitest';
import type { FormulatePlanResult } from '../src/index.js';
import { classifyPlanShape } from '../src/index.js';

describe('classifyPlanShape (spec 060, R1 / AC-1)', () => {
  it('returns null for a valid plan (non-empty description + described steps)', () => {
    const plan: FormulatePlanResult = {
      description: 'Restore energy',
      steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
    };
    expect(classifyPlanShape(plan)).toBeNull();
  });

  it('returns missing-description for an empty description string', () => {
    expect(
      classifyPlanShape({
        description: '',
        steps: [{ description: 'step' }],
      }),
    ).toBe('missing-description');
  });

  it('returns missing-description for a non-string description at runtime', () => {
    expect(
      classifyPlanShape({
        description: undefined as unknown as string,
        steps: [{ description: 'step' }],
      }),
    ).toBe('missing-description');
  });

  it('returns missing-steps for a non-array steps value', () => {
    expect(
      classifyPlanShape({
        description: 'd',
        steps: undefined as unknown as { description: string }[],
      }),
    ).toBe('missing-steps');
  });

  it('returns missing-steps for an empty steps array', () => {
    expect(classifyPlanShape({ description: 'd', steps: [] })).toBe('missing-steps');
  });

  it('returns empty-step-description when any step has an empty description', () => {
    expect(
      classifyPlanShape({
        description: 'd',
        steps: [{ description: 'ok' }, { description: '' }],
      }),
    ).toBe('empty-step-description');
  });

  it('returns empty-step-description for a non-object step at runtime', () => {
    expect(
      classifyPlanShape({
        description: 'd',
        steps: [null as unknown as { description: string }],
      }),
    ).toBe('empty-step-description');
  });

  it('is deterministic when several conditions fail: description wins over steps', () => {
    expect(classifyPlanShape({ description: '', steps: [] })).toBe('missing-description');
  });

  it('is deterministic when several conditions fail: missing steps wins over empty step', () => {
    expect(
      classifyPlanShape({
        description: 'd',
        steps: [],
      }),
    ).toBe('missing-steps');
  });

  it('is deterministic when description and step are both empty: description wins', () => {
    expect(
      classifyPlanShape({
        description: '',
        steps: [{ description: '' }],
      }),
    ).toBe('missing-description');
  });
});
