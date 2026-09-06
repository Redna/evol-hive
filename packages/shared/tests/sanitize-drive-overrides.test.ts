/**
 * Issue #134 — LLM-supplied drive deltas must never poison numeric drive
 * state. One malformed reflect/tool response (NaN, Infinity, string values)
 * previously propagated through every later drive computation and
 * permanently zeroed the agent.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeDriveOverrides } from '../src/index.js';

describe('sanitizeDriveOverrides (issue #134)', () => {
  it('drops non-numeric and non-finite entries', () => {
    const out = sanitizeDriveOverrides({
      energy: 10,
      hunger: Number.NaN,
      social: Number.POSITIVE_INFINITY,
      comfort: Number.NEGATIVE_INFINITY,
      curiosity: '15' as unknown as number,
      boredom: undefined as unknown as number,
      null: null as unknown as number,
    });
    expect(out).toEqual({ energy: 10 });
  });

  it('clamps magnitudes to the default ±50', () => {
    const out = sanitizeDriveOverrides({ energy: 999, hunger: -999, social: 20 });
    expect(out).toEqual({ energy: 50, hunger: -50, social: 20 });
  });

  it('honors a custom magnitude cap', () => {
    const out = sanitizeDriveOverrides({ energy: 10 }, 5);
    expect(out).toEqual({ energy: 5 });
  });

  it('returns an empty object for null/non-object input', () => {
    expect(sanitizeDriveOverrides(null as unknown as Record<string, number>)).toEqual({});
    expect(sanitizeDriveOverrides(undefined as unknown as Record<string, number>)).toEqual({});
    expect(sanitizeDriveOverrides('nonsense' as unknown as Record<string, number>)).toEqual({});
  });
});
