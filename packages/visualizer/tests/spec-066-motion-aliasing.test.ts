/**
 * Spec 066 leg 3 — motion is paced against the snapshot interval (AC-6, AC-7).
 *
 * The engine steps one cell per game-loop tick at ~60 ticks/s
 * (`spatial/navigation.ts:243`, `loop/index.ts:111`) while the client receives
 * snapshots every `snapshotRateMs = 100` — about 6 cells of movement arrive in
 * each snapshot (≈30 at 5×). The old glide used a FIXED `GLIDE_HALF_LIFE_S` and
 * therefore never traversed a delivered delta over the interval it bridged: at
 * 1× it reached the new cell in a few hundred milliseconds and at 5× it lagged
 * arbitrarily far behind, cutting corners and reading as a teleport.
 *
 * `motionTowards` is the pure, clock-free seam (spec 062, R2 discipline): from,
 * to, elapsed and the interval in; position out. No timers, no DOM, no clock.
 *
 * The worked example is the spec's own: a 1× snapshot bridges ~6 cells and a 5×
 * snapshot ~30, over the same 0.1 s interval. At a 20 px cell that is 120 px and
 * 600 px — both traversed over 0.1 s, so the observed speed scales with the
 * simulation's `timeScale` without retuning any constant.
 */

import { describe, it, expect } from 'vitest';
import { motionTowards } from '../src/renderer/layout.js';
import type { Point } from '../src/renderer/layout.js';

/** Snapshot interval: `snapshotRateMs = 100` on the server. */
const INTERVAL_S = 0.1;
/** One grid cell on screen, used to turn the spec's cell counts into pixels. */
const CELL_PX = 20;

function expectPoint(actual: Point, x: number, y: number): void {
  expect(actual.x).toBeCloseTo(x, 6);
  expect(actual.y).toBeCloseTo(y, 6);
}

describe('spec 066 leg 3 — interval-paced motion (AC-6)', () => {
  it('is proportional to elapsed time within the interval', () => {
    const from = { x: 100, y: 200 };
    const to = { x: 700, y: 800 }; // a 600 px delta on each axis

    expectPoint(motionTowards(from, to, 0, INTERVAL_S), 100, 200);
    expectPoint(motionTowards(from, to, 0.025, INTERVAL_S), 250, 350);
    expectPoint(motionTowards(from, to, 0.05, INTERVAL_S), 400, 500);
    expectPoint(motionTowards(from, to, 0.075, INTERVAL_S), 550, 650);
  });

  it('arrives exactly at the target as the interval completes', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 600, y: 600 };
    expect(motionTowards(from, to, INTERVAL_S, INTERVAL_S)).toEqual(to);
  });

  it('clamps beyond the interval — no overshoot, no jump past the target', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 600, y: 600 };

    expect(motionTowards(from, to, INTERVAL_S * 1.5, INTERVAL_S)).toEqual(to);
    expect(motionTowards(from, to, INTERVAL_S * 100, INTERVAL_S)).toEqual(to);
    // Clock skew (negative elapsed) holds at the start, never before it.
    expect(motionTowards(from, to, -0.01, INTERVAL_S)).toEqual(from);
    // A non-positive interval cannot be divided by: the delta is instantaneous.
    expect(motionTowards(from, to, 0.05, 0)).toEqual(to);
  });

  it('holds at the target while the next snapshot is pending (no frame jumps)', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 120, y: 0 };
    let previous = motionTowards(from, to, 0, INTERVAL_S);
    for (const elapsed of [0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.2]) {
      const current = motionTowards(from, to, elapsed, INTERVAL_S);
      // Monotonic and never past the target on either axis.
      expect(current.x).toBeGreaterThanOrEqual(previous.x);
      expect(current.x).toBeLessThanOrEqual(to.x);
      previous = current;
    }
    expect(previous).toEqual(to);
  });
});

describe('spec 066 leg 3 — motion follows the speed it bridges (AC-7)', () => {
  // The engine moves ~60 cells/s (one per ~16 ms tick). A 0.1 s snapshot
  // therefore bridges ~6 cells at 1× and ~30 at 5×. Neither call retunes a
  // constant: only the delta grows, and the displacement grows with it.
  const X1_DELTA_PX = 6 * CELL_PX; // 120 px
  const X5_DELTA_PX = 30 * CELL_PX; // 600 px

  it('a 5× delta over the same interval moves proportionally faster', () => {
    const half = INTERVAL_S / 2;
    const at1x = motionTowards({ x: 0, y: 0 }, { x: X1_DELTA_PX, y: 0 }, half, INTERVAL_S);
    const at5x = motionTowards({ x: 0, y: 0 }, { x: X5_DELTA_PX, y: 0 }, half, INTERVAL_S);

    expectPoint(at1x, 60, 0);
    expectPoint(at5x, 300, 0);
    expect(at5x.x / at1x.x).toBeCloseTo(5, 6);
    expect(at5x.x / at1x.x).toBeCloseTo(X5_DELTA_PX / X1_DELTA_PX, 6);
  });

  it('reports the simulated speed: 6 cells per 0.1 s is 60 cells/s at 1×', () => {
    const from = { x: 0, y: 0 };
    const to = { x: X1_DELTA_PX, y: 0 };
    const start = motionTowards(from, to, 0, INTERVAL_S);
    const done = motionTowards(from, to, INTERVAL_S, INTERVAL_S);
    const cellsPerSecond = (done.x - start.x) / CELL_PX / INTERVAL_S;
    expect(cellsPerSecond).toBeCloseTo(60, 6);
  });
});
