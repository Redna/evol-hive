/**
 * systems/drive-decay — Drive decay engine system (spec 005, Req 4, 20)
 * ────────────────────────────────────────────────────────────────────────────
 * On each tick, applies `DriveSystem.applyDecay(state, deltaSeconds)` to every
 * active agent — including those with `isThinking === true` (drives decay while
 * the agent thinks, creating urgency for the next cycle).
 */

import type { GameTick } from '@evol-hive/shared';
import type { AgentManager, DriveSystem } from '../index.js';

/** EngineSystem that decays agent drives every tick. */
export class DriveDecaySystem {
  readonly name = 'drive-decay';

  private readonly agentManager: AgentManager;
  private readonly driveSystem: DriveSystem;

  constructor(agentManager: AgentManager, driveSystem: DriveSystem) {
    this.agentManager = agentManager;
    this.driveSystem = driveSystem;
  }

  update(tick: GameTick): void {
    const agents = this.agentManager.getActiveAgents();
    for (const agent of agents) {
      this.driveSystem.applyDecay(agent, tick.deltaSeconds);
    }
  }
}

export {};
