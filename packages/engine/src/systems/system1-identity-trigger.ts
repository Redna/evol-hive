/**
 * systems/system1-identity-trigger — Mid-session identity consolidation
 * trigger (spec 035, Req 17)
 * ────────────────────────────────────────────────────────────────────────────
 * An optional `EngineSystem` that, each tick, hands every active agent to the
 * salience-weighted identity service through the shared
 * `System1IdentityTriggerPort` (implemented in cognition, wired at assembly).
 * The port checks the accumulated-salience threshold and fires a bounded
 * mid-session consolidation pass (within spec 033's pass budget and delta
 * bounds). `update_self_model` remains the conscious override — this system
 * adds a trigger, never a direct identity write.
 */

import type { GameTick, System1IdentityTriggerPort } from '@evol-hive/shared';
import type { AgentManager } from '../agents/index.js';

/** Constructor options for {@link System1IdentityTriggerSystem}. */
export interface System1IdentityTriggerOptions {
  agentManager: AgentManager;
  /** The cognition-side salience trigger (wired at assembly). */
  identityTrigger: System1IdentityTriggerPort;
}

export class System1IdentityTriggerSystem {
  readonly name = 'system1-identity-trigger';

  private readonly agentManager: AgentManager;
  private readonly identityTrigger: System1IdentityTriggerPort;

  constructor(options: System1IdentityTriggerOptions) {
    this.agentManager = options.agentManager;
    this.identityTrigger = options.identityTrigger;
  }

  /** Called every tick by the game loop. Synchronous — never awaits. */
  update(_tick: GameTick): void {
    for (const agent of this.agentManager.getActiveAgents()) {
      try {
        // Fire-and-forget inside the port implementation (bounded, audited).
        this.identityTrigger.tick(agent.agentId);
      } catch {
        // A trigger failure must never break the game loop.
      }
    }
  }
}
