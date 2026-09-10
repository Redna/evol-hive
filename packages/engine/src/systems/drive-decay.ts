/**
 * systems/drive-decay — Drive decay engine system (spec 005, Req 4, 20)
 * ────────────────────────────────────────────────────────────────────────────
 * On each tick, applies `DriveSystem.applyDecay(state, deltaSeconds)` to every
 * active agent — including those with `isThinking === true` (drives decay while
 * the agent thinks, creating urgency for the next cycle).
 *
 * Per-agent decay scaling (spec 048, Req 1 — issue #168): with
 * `decayScaling: 'per-agent'` (the default) each agent decays at an effective
 * rate of `configuredDecayRate / N` per wall sim-second, where
 * `N = agentManager.getActiveAgents().length` **at that tick**. At concurrency
 * 3 the PPER scheduler spreads cycles across agents, stretching each agent's
 * effective cycle interval to 60–90s of sim time while ambient decay accrued
 * per wall sim-second — decay 6–9 points/interval against a best +5
 * restoration made the cc=3 economy structurally net-negative. Scaling by the
 * LIVE agent count (never `maxConcurrentCycles` — dormant/late-spawned agents
 * would skew the divisor) turns decay into a scene-level constant: constant
 * total decay per wall sim-minute across the population, with per-agent decay
 * a function of the agent's own cycle cadence.
 *
 * Implementation note: `DriveSystemImpl.applyDecay` is linear in
 * `deltaSeconds` (`current - deltaSeconds × decayRate`, spec 019) and its
 * signature/semantics are the spec-019 contract — NOT touched. Scaling the
 * time delta by `1 / N` therefore applies exactly `decayRate / N` per wall
 * sim-second. At `N = 1` the divisor is exactly `1` and IEEE-754 guarantees
 * `x / 1 === x`, so cc=1 decay is bit-identical to the pre-048 path (spec-019
 * test fixtures pass unmodified, AC-4/AC-7).
 *
 * `decayScaling: 'none'` keeps the legacy raw rate regardless of N — the
 * escape hatch for experiments (`ENGINE_DECAY_SCALING=none`).
 */

import type { DecayScaling, GameTick } from '@evol-hive/shared';
import type { AgentManager, DriveSystem } from '../index.js';

/** Options for {@link DriveDecaySystem} (spec 048, Req 1). */
export interface DriveDecaySystemOptions {
  /**
   * Decay scaling mode. Default `'per-agent'` (effective rate
   * `configuredDecayRate / N`, N = live agents at that tick). `'none'` applies
   * the raw configured rate regardless of N (legacy behavior, pre-spec-048).
   */
  decayScaling?: DecayScaling;
}

/** EngineSystem that decays agent drives every tick. */
export class DriveDecaySystem {
  readonly name = 'drive-decay';

  private readonly agentManager: AgentManager;
  private readonly driveSystem: DriveSystem;
  private readonly decayScaling: DecayScaling;

  constructor(
    agentManager: AgentManager,
    driveSystem: DriveSystem,
    options?: DriveDecaySystemOptions,
  ) {
    this.agentManager = agentManager;
    this.driveSystem = driveSystem;
    this.decayScaling = options?.decayScaling ?? 'per-agent';
  }

  update(tick: GameTick): void {
    const agents = this.agentManager.getActiveAgents();
    if (agents.length === 0) return;
    // Effective rate = configuredDecayRate / N (Req 1): applyDecay is linear
    // in deltaSeconds, so scaling the delta by 1/N scales the rate by 1/N.
    // 'none' → raw delta (legacy path); N = 1 → deltaSeconds / 1 ===
    // deltaSeconds exactly (IEEE-754), bit-identical to pre-048.
    const deltaSeconds =
      this.decayScaling === 'none' ? tick.deltaSeconds : tick.deltaSeconds / agents.length;
    for (const agent of agents) {
      this.driveSystem.applyDecay(agent, deltaSeconds);
    }
  }
}

export {};
