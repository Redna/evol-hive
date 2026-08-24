/**
 * loop/ — Fixed-timestep game loop with the accumulator pattern
 * ───────────────────────────────────────────────────────────────
 * Section 9 / spec 005: The game loop accumulates real elapsed time between
 * frames and consumes it in fixed-size `deltaSeconds` steps (1/fps seconds).
 * Each consumed step produces one `GameTick` passed to every registered
 * `EngineSystem` in registration order. The loop's `update()` path is fully
 * synchronous — all async work (LLM calls, memory stores) happens in
 * fired-and-forgotten promises from the `PPERScheduler`.
 */

import type { EngineConfig, GameTick } from '@evol-hive/shared';
import type { EngineSystem, GameLoop } from '../index.js';

/** Concrete GameLoop using the accumulator pattern. */
export class GameLoopImpl implements GameLoop {
  private readonly systems: EngineSystem[] = [];
  private readonly deltaSeconds: number;

  private running = false;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private lastRealTime = 0;
  private accumulator = 0;
  private tickNumber = 0;
  private simulationTime = 0;
  private currentGameTick: GameTick = { tickNumber: 0, simulationTime: 0, deltaSeconds: 0 };

  constructor(config: EngineConfig) {
    this.deltaSeconds = 1 / config.fps;
  }

  /** Begin the accumulator loop. No-op if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastRealTime = nowSeconds();
    this.scheduleNextFrame();
  }

  /** Halt the loop and release any timer handles. No-op if already stopped. */
  stop(): void {
    this.running = false;
    if (this.timerHandle !== null) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  /** Register a system to be updated each tick (in registration order). */
  registerSystem(system: EngineSystem): void {
    this.systems.push(system);
  }

  /** Return the names of registered systems in registration order (test helper). */
  systemNames(): string[] {
    return this.systems.map((s) => s.name);
  }

  /** The latest GameTick, even while stopped. */
  currentTick(): GameTick {
    return this.currentGameTick;
  }

  /**
   * Restore the deterministic loop state from a save (spec 017, Req 15).
   * Sets the internal `tickNumber` and `simulationTime` and updates
   * `currentGameTick`. The loop should not be running when this is called —
   * the caller (`EnginePersistenceImpl.load()`) stops the loop first. If the
   * loop is running, a warning is logged and the state is restored anyway
   * (defensive).
   */
  restoreState(tickNumber: number, simulationTime: number): void {
    if (this.running) {
      console.warn(
        '[GameLoopImpl] restoreState called while the loop is running — stop the loop before loading.',
      );
    }
    this.tickNumber = tickNumber;
    this.simulationTime = simulationTime;
    this.currentGameTick = {
      tickNumber: this.tickNumber,
      simulationTime: this.simulationTime,
      deltaSeconds: this.deltaSeconds,
    };
  }

  /** Schedule the next frame via setTimeout (deterministic & test-friendly). */
  private scheduleNextFrame(): void {
    if (!this.running) return;
    // ~16ms target frame; the accumulator absorbs the real elapsed delta.
    this.timerHandle = setTimeout(() => this.frame(), 16);
  }

  /** One frame: measure real elapsed time, consume fixed steps. */
  private frame(): void {
    if (!this.running) return;
    const real = nowSeconds();
    const elapsed = real - this.lastRealTime;
    this.lastRealTime = real;
    this.consume(elapsed);
    this.scheduleNextFrame();
  }

  /**
   * Consume `elapsed` seconds of real time in fixed `deltaSeconds` steps.
   * Exposed for testing so tests can drive exact elapsed time without real timers.
   */
  injectElapsed(elapsedSeconds: number): void {
    this.consume(elapsedSeconds);
  }

  private consume(elapsedSeconds: number): void {
    this.accumulator += elapsedSeconds;
    while (this.accumulator >= this.deltaSeconds) {
      this.accumulator -= this.deltaSeconds;
      this.tickNumber += 1;
      this.simulationTime += this.deltaSeconds;
      const tick: GameTick = {
        tickNumber: this.tickNumber,
        simulationTime: this.simulationTime,
        deltaSeconds: this.deltaSeconds,
      };
      this.currentGameTick = tick;
      for (const system of this.systems) {
        system.update(tick);
      }
    }
  }
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

export {};
