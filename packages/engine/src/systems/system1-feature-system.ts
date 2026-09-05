/**
 * systems/system1-feature-system — Per-tick feature plumbing (spec 035, Req 1/7)
 * ────────────────────────────────────────────────────────────────────────────
 * An optional `EngineSystem` that gathers the deterministic engine-state
 * snapshot for every active agent each tick and drives the (cognition-side)
 * feature refresher through the shared `System1FeatureRefresherPort`:
 *   - `refreshScalars` synchronously (drives, deltas, flags — engine state);
 *   - `refreshEmbedding` fire-and-forget every N ticks (the ONLY async input
 *     to the extractor — the snapshot embedding, shared with the classifier
 *     and memory store).
 *
 * The scheduler's gate consult then reads cached features synchronously
 * (Req 7: no await in the hot path, zero LLM calls added by gating).
 */

import type {
  GameTick,
  System1EngineSnapshot,
  System1FeatureRefresherPort,
  System1TriggerSourcePort,
} from '@evol-hive/shared';
import { defaultSystem1GateConfig } from '@evol-hive/shared';
import type { AgentManager } from '../agents/index.js';
import type { System1AgentTracker } from './system1-agent-tracker.js';

/** Constructor options for {@link System1FeatureSystem}. */
export interface System1FeatureSystemOptions {
  agentManager: AgentManager;
  /** Hard-trigger source (flags are part of the snapshot — engine state). */
  triggerSource: System1TriggerSourcePort;
  /** The cognition-side refresher (wired at assembly). */
  refresher: System1FeatureRefresherPort;
  tracker: System1AgentTracker;
  /** Embedding refresh interval in ticks (default 30). */
  embeddingRefreshIntervalTicks?: number;
}

export class System1FeatureSystem {
  readonly name = 'system1-features';

  private readonly agentManager: AgentManager;
  private readonly triggerSource: System1TriggerSourcePort;
  private readonly refresher: System1FeatureRefresherPort;
  private readonly tracker: System1AgentTracker;
  private readonly interval: number;

  constructor(options: System1FeatureSystemOptions) {
    this.agentManager = options.agentManager;
    this.triggerSource = options.triggerSource;
    this.refresher = options.refresher;
    this.tracker = options.tracker;
    this.interval =
      options.embeddingRefreshIntervalTicks ??
      defaultSystem1GateConfig().embeddingRefreshIntervalTicks;
  }

  /** Called every tick by the game loop. Synchronous — never awaits. */
  update(tick: GameTick): void {
    for (const agent of this.agentManager.getActiveAgents()) {
      const agentId = agent.agentId;
      this.tracker.noteTick(agentId, tick.tickNumber);

      const triggers = this.triggerSource.getHardTriggers(agentId);
      const conversation = this.triggerSource.getConversationContext?.(agentId) ?? {
        open: false,
        turns: 0,
      };
      const snapshot: System1EngineSnapshot = {
        agentId,
        tickNumber: tick.tickNumber,
        simTime: tick.simulationTime,
        drives: agent.drives,
        drivesAtLastCycle: this.tracker.getDrivesAtLastCycle(agentId),
        ticksSinceLastCycle: this.tracker.getTicksSinceLastCycle(agentId),
        messagePending: triggers.messagePending,
        conversationOpen: conversation.open,
        conversationTurns: conversation.turns,
        nearbyObjectStateChange: triggers.nearbyObjectMutation,
        worldMutation: triggers.nearbyObjectMutation,
        snapshotText: buildSnapshotText(agent),
      };

      // Scalar part: synchronous (engine state only).
      this.refresher.refreshScalars(agentId, snapshot);

      // Embedding part: fire-and-forget on the interval (the only async input).
      if (tick.tickNumber % this.interval === 0) {
        this.refresher.refreshEmbedding(agentId, snapshot).catch(() => {
          // Never break the loop on an embedding failure (fail-open upstream).
        });
      }
    }
  }

}

/** Deterministic snapshot text from engine state (embedded on the async path). */
function buildSnapshotText(agent: {
  location: string;
  currentGoal: string;
}): string {
  return `room:${agent.location}|goal:${agent.currentGoal}`;
}