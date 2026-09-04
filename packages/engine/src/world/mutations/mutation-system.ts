/**
 * world/mutations/mutation-system — Tick-boundary mutation application (spec 030, Req 1)
 * ───────────────────────────────────────────────────────────────────────────────────────
 * An `EngineSystem` that drains the `SceneMutationService` queue at each tick
 * boundary. Registered FIRST (before spatial/decay/scheduler) so a tick's
 * mutations land before any other system observes the world — mutations are
 * never applied mid-phase (deterministic core constraint).
 */

import type { GameTick } from '@evol-hive/shared';
import type { EngineSystem } from '../../index.js';
import type { SceneMutationServiceImpl } from './scene-mutation-service.js';

/** EngineSystem that applies queued scene mutations at each tick boundary. */
export class SceneMutationSystem implements EngineSystem {
  readonly name = 'scene-mutations';

  constructor(private readonly service: SceneMutationServiceImpl) {}

  /** Called every tick by the game loop — synchronous. */
  update(tick: GameTick): void {
    this.service.applyPending(tick.tickNumber);
  }
}