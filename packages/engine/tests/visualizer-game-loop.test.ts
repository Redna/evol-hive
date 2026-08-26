/**
 * Spec 023 — Visual Output Canvas Renderer
 * GameLoopImpl timeScale + isRunning (AC-2, AC-3).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { EngineConfig } from '@evol-hive/shared';
import { GameLoopImpl } from '../src/loop/index.js';
import type { EngineSystem } from '../src/index.js';
import type { GameTick } from '@evol-hive/shared';

function makeConfig(fps = 60): EngineConfig {
  return {
    fps,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
  };
}

class RecordingSystem implements EngineSystem {
  readonly name = 'rec';
  readonly ticks: GameTick[] = [];
  update(tick: GameTick): void {
    this.ticks.push({ ...tick });
  }
}

describe('GameLoopImpl — isRunning (AC-3)', () => {
  it('returns false before start', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    expect(loop.isRunning()).toBe(false);
  });

  it('returns true after start() and false after stop()', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    loop.start();
    expect(loop.isRunning()).toBe(true);
    loop.stop();
    expect(loop.isRunning()).toBe(false);
  });
});

describe('GameLoopImpl — timeScale (AC-2)', () => {
  it('getTimeScale defaults to 1', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    expect(loop.getTimeScale()).toBe(1);
  });

  it('setTimeScale(2) doubles the simulation time advance', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    const sys = new RecordingSystem();
    loop.registerSystem(sys);

    loop.setTimeScale(2);
    expect(loop.getTimeScale()).toBe(2);

    // Inject 1 second of real elapsed time. With timeScale 2, the accumulator
    // receives 2.0 seconds → 120 ticks at 60 FPS → simulationTime ≈ 2.0s.
    loop.injectElapsed(1.0);

    const tick = loop.currentTick();
    expect(tick.simulationTime).toBeCloseTo(2.0, 1);
    expect(tick.tickNumber).toBe(120);
  });

  it('setTimeScale(5) produces 5x simulation time', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    loop.registerSystem(new RecordingSystem());
    loop.setTimeScale(5);
    loop.injectElapsed(1.0);
    expect(loop.currentTick().simulationTime).toBeCloseTo(5.0, 1);
  });

  it('setTimeScale(1) is 1:1 (backward compatible)', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    loop.registerSystem(new RecordingSystem());
    loop.injectElapsed(1.0);
    expect(loop.currentTick().simulationTime).toBeCloseTo(1.0, 1);
  });

  it('default timeScale does not change existing accumulator behavior', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    const sys = new RecordingSystem();
    loop.registerSystem(sys);
    // 2 ticks at 60 FPS = 33.33ms.
    loop.injectElapsed(2 / 60 + 0.0001);
    expect(sys.ticks).toHaveLength(2);
  });

  it('setTimeScale rejects non-positive or non-finite values', () => {
    const loop = new GameLoopImpl(makeConfig(60));
    expect(() => loop.setTimeScale(0)).toThrow();
    expect(() => loop.setTimeScale(-1)).toThrow();
    expect(() => loop.setTimeScale(NaN)).toThrow();
    expect(() => loop.setTimeScale(Infinity)).toThrow();
    // value should remain unchanged after a rejected set
    expect(loop.getTimeScale()).toBe(1);
  });
});
