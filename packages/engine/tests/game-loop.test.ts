/**
 * Tests for GameLoopImpl — the fixed-timestep accumulator game loop.
 * Covers AC-1, AC-2, AC-3, AC-8, AC-24.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GameTick, EngineConfig } from '@evol-hive/shared';
import { GameLoopImpl } from '../src/loop/index.js';
import type { EngineSystem } from '../src/index.js';

function makeConfig(fps = 60): EngineConfig {
  return {
    fps,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
  };
}

/** A recording system that captures every GameTick it receives. */
class RecordingSystem implements EngineSystem {
  readonly name: string;
  readonly ticks: GameTick[] = [];

  constructor(name: string) {
    this.name = name;
  }

  update(tick: GameTick): void {
    this.ticks.push({ ...tick });
  }
}

describe('GameLoopImpl — accumulator pattern (AC-1)', () => {
  it('consumes exactly 2 ticks when ~33.3ms (2 × 16.67ms) elapses at 60 FPS', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    const sys = new RecordingSystem('rec');
    loop.registerSystem(sys);

    // 60 FPS => deltaSeconds = 1/60 ≈ 0.016667s per tick.
    // 2 ticks = 2 × 16.67ms ≈ 33.33ms. Inject slightly over 33.33ms to consume
    // exactly 2 ticks, carrying a small remainder.
    loop.injectElapsed(2 / 60 + 0.0001);

    expect(sys.ticks).toHaveLength(2);
    expect(sys.ticks[0]!.tickNumber).toBe(1);
    expect(sys.ticks[1]!.tickNumber).toBe(2);
    // deltaSeconds equals 1/fps for each consumed tick.
    expect(sys.ticks[0]!.deltaSeconds).toBeCloseTo(1 / 60, 5);
    expect(sys.ticks[1]!.deltaSeconds).toBeCloseTo(1 / 60, 5);
  });

  it('consumes only 1 tick when 33ms (just under 2 steps) elapses', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    const sys = new RecordingSystem('rec');
    loop.registerSystem(sys);
    // 33ms < 33.33ms (2 steps) => 1 tick, remainder carried.
    loop.injectElapsed(0.033);
    expect(sys.ticks).toHaveLength(1);
  });

  it('carries the remainder over to the next frame', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    const sys = new RecordingSystem('rec');
    loop.registerSystem(sys);

    // First frame: 20ms => 1 tick (16.67ms), remainder 3.33ms.
    loop.injectElapsed(0.02);
    expect(sys.ticks).toHaveLength(1);

    // Second frame: another 20ms => remainder 3.33 + 20 = 23.33ms => 1 tick (16.67), remainder 6.66.
    loop.injectElapsed(0.02);
    expect(sys.ticks).toHaveLength(2);
  });

  it('consumes zero ticks when elapsed is less than one step', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    const sys = new RecordingSystem('rec');
    loop.registerSystem(sys);
    loop.injectElapsed(0.005);
    expect(sys.ticks).toHaveLength(0);
  });
});

describe('GameLoopImpl — start/stop (AC-2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('start() begins the loop and stop() halts it', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    const sys = new RecordingSystem('rec');
    loop.registerSystem(sys);

    loop.start();
    // Advance fake time by ~50ms in 16ms intervals (requestAnimationFrame).
    vi.advanceTimersByTime(50);
    loop.stop();

    expect(sys.ticks.length).toBeGreaterThan(0);
  });

  it('calling start() when already running does not create a second loop', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    loop.start();
    loop.start(); // no-op
    // Should still only have one timer handle.
    loop.stop();
    // After stop, advancing timers should NOT produce more ticks.
    const sys = new RecordingSystem('rec');
    loop.registerSystem(sys);
    vi.advanceTimersByTime(100);
    expect(sys.ticks).toHaveLength(0);
  });

  it('stopping an already-stopped loop is a no-op', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    expect(() => loop.stop()).not.toThrow();
    expect(() => loop.stop()).not.toThrow();
  });

  it('currentTick() returns the last GameTick after stopping', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    loop.registerSystem(new RecordingSystem('rec'));
    loop.start();
    vi.advanceTimersByTime(40);
    loop.stop();
    const tick = loop.currentTick();
    expect(tick.tickNumber).toBeGreaterThan(0);
    expect(tick.simulationTime).toBeGreaterThan(0);
  });

  it('currentTick() returns a zero tick before the loop ever runs', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    const tick = loop.currentTick();
    expect(tick.tickNumber).toBe(0);
    expect(tick.simulationTime).toBe(0);
  });
});

describe('GameLoopImpl — GameTick propagation (AC-3)', () => {
  it('every system receives the same GameTick on a given tick (same tickNumber, simulationTime, deltaSeconds)', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    const a = new RecordingSystem('a');
    const b = new RecordingSystem('b');
    const c = new RecordingSystem('c');
    loop.registerSystem(a);
    loop.registerSystem(b);
    loop.registerSystem(c);

    loop.injectElapsed(2 / 60 + 0.0001); // 2 ticks

    expect(a.ticks).toHaveLength(2);
    expect(b.ticks).toHaveLength(2);
    expect(c.ticks).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(a.ticks[i]).toEqual(b.ticks[i]);
      expect(b.ticks[i]).toEqual(c.ticks[i]);
    }
  });

  it('calls systems in registration order', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    const order: string[] = [];
    const mk = (name: string): EngineSystem => ({
      name,
      update: () => order.push(name),
    });
    loop.registerSystem(mk('first'));
    loop.registerSystem(mk('second'));
    loop.registerSystem(mk('third'));
    loop.injectElapsed(0.02); // 1 tick
    expect(order).toEqual(['first', 'second', 'third']);
  });
});

describe('GameLoopImpl — synchronous update (AC-24)', () => {
  it('update path completes synchronously without awaiting promises', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    let syncOk = false;
    loop.registerSystem({
      name: 'sync-check',
      update: () => {
        syncOk = true;
      },
    });
    loop.injectElapsed(0.02);
    // After injectElapsed returns, the system update must have run synchronously.
    expect(syncOk).toBe(true);
  });
});
