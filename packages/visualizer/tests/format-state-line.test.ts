/**
 * Spec 029 — Visualizer Object State Text: Round Decimals & Truncate Overflow
 * Unit tests for the state-line formatting helpers (AC-1..AC-5, AC-8).
 *
 * The renderer composes `${key}: ${value}` for the first state entry of each
 * object chip and clips it to the 56px usable chip width using the context's
 * `measureText` — no fixed character counts (Req 4). These tests exercise the
 * pure helpers with injected linear width models; the renderer-level tests in
 * `canvas-renderer.test.ts` drive the same path through a MockContext.
 */
import { describe, it, expect } from 'vitest';
import { formatStateLine, formatStateValue } from '../src/renderer/canvas-renderer.js';

/** AC-6 mock: linear width model, 5px per character. */
const measure5 = (text: string): number => text.length * 5;

/** A measure under which every string fits — isolates rounding from clipping. */
const measureFit = (): number => 0;

describe('formatStateValue — numeric rounding (spec 029, Req 1)', () => {
  it('rounds a long float to at most 2 decimal places (AC-1)', () => {
    expect(formatStateValue(95.666666674)).toBe('95.67');
  });

  it('renders integers with no decimal tail and no trailing zeros (AC-2)', () => {
    expect(formatStateValue(5)).toBe('5');
  });

  it('preserves one decimal place without padding to two (AC-3)', () => {
    expect(formatStateValue(95.5)).toBe('95.5');
  });

  it('rounds 0.125 to 0.13 (standard rounding, not truncation)', () => {
    expect(formatStateValue(0.125)).toBe('0.13');
  });

  it('trims trailing zeros (95.50 renders as 95.5, 95.0 as 95)', () => {
    expect(formatStateValue(95.5)).toBe('95.5');
    expect(formatStateValue(95.0)).toBe('95');
  });
});

describe('formatStateValue — non-numeric pass-through (spec 029, Req 2)', () => {
  it('renders string values verbatim (AC-4)', () => {
    expect(formatStateValue('blooming')).toBe('blooming');
  });

  it('renders boolean values verbatim (AC-4)', () => {
    expect(formatStateValue(true)).toBe('true');
    expect(formatStateValue(false)).toBe('false');
  });
});

describe('formatStateLine — composition and display-only rounding (AC-5)', () => {
  it('composes "key: value" with the rounded number (AC-1)', () => {
    expect(formatStateLine('water_supply', 95.666666674, measureFit)).toBe('water_supply: 95.67');
  });

  it('never mutates the source value — display-only rounding (AC-5)', () => {
    const state: Record<string, unknown> = { water_supply: 95.666666674 };
    formatStateLine('water_supply', state.water_supply, measureFit);
    expect(state.water_supply).toBe(95.666666674);
  });
});

describe('formatStateLine — measureText-based clipping (spec 029, Req 3/4)', () => {
  it('renders a line that fits within 56px verbatim, with no ellipsis (AC-7)', () => {
    expect(formatStateLine('a', 1, measure5)).toBe('a: 1');
    expect(formatStateLine('made', true, measure5)).toBe('made: true');
  });

  it('clips a line that exceeds 56px with a single trailing ellipsis (AC-6)', () => {
    const line = formatStateLine('water_supply', 95.666666674, measure5);
    expect(line.endsWith('…')).toBe(true);
    expect(line.match(/…/g)).toHaveLength(1);
    expect(measure5(line)).toBeLessThanOrEqual(56);
  });

  it('drops trailing characters until the line (plus ellipsis) fits (AC-6)', () => {
    const line = formatStateLine('water_supply', 95.666666674, measure5);
    // "water_supply: 95.67" is 19 chars → 95px; shrunk until ≤ 56px.
    expect(line.length).toBeLessThan('water_supply: 95.67'.length);
    expect(measure5(line)).toBeLessThanOrEqual(56);
  });

  it('changes the truncation point with the measure model — no fixed char count (AC-8)', () => {
    const wide = formatStateLine('water_supply', 95.666666674, measure5);
    const wider = formatStateLine('water_supply', 95.666666674, (t) => t.length * 10);
    expect(wider.endsWith('…')).toBe(true);
    expect(wider.length).toBeLessThan(wide.length);
    expect(wider.length * 10).toBeLessThanOrEqual(56);
  });

  it('defaults to the 56px usable chip width', () => {
    // 20 chars * 5px = 100px > 56px → clipped; 10 chars * 5px = 50px ≤ 56px → kept.
    const long = formatStateLine('water_supply', 95.666666674, measure5);
    expect(long.endsWith('…')).toBe(true);
  });
});
