/**
 * systems/pper-scheduler — PPER cycle scheduler (spec 005, Req 3, 18, 19, 21)
 * ────────────────────────────────────────────────────────────────────────────
 * An `EngineSystem` that, on each tick, iterates all active agents and
 * fires-and-forgets a `PPEROrchestratorPort.runCycle(agentId)` for every agent
 * with `isThinking === false`, up to `maxConcurrentCycles` concurrent cycles.
 *
 * The `update()` method is fully synchronous — it never awaits the cycle
 * promise. Uncaught rejections are caught and `isThinking` is reset to
 * `false` so the loop can retry on the next tick (§9.1).
 *
 * Round-robin fairness (fix): tracks the last agent index so that with
 * `maxConcurrentCycles=1`, each agent gets a turn instead of the first
 * agent monopolizing the slot.
 */

import type { PPERSchedulerConfig, PPEROrchestratorPort } from '@evol-hive/shared';
import type { GameTick } from '@evol-hive/shared';
import type { AgentManager } from '../index.js';

/** EngineSystem that schedules PPER cycles for agents each tick. */
export class PPERScheduler {
  readonly name = 'pper-scheduler';

  private readonly agentManager: AgentManager;
  private readonly orchestrator: PPEROrchestratorPort;
  private readonly maxConcurrent: number;
  /** Number of cycles currently in flight (incremented on start, decremented on settle). */
  private activeCycles = 0;
  /** Round-robin cursor — next tick starts scanning from this index. */
  private rrCursor = 0;

  constructor(
    agentManager: AgentManager,
    orchestrator: PPEROrchestratorPort,
    config: PPERSchedulerConfig,
  ) {
    this.agentManager = agentManager;
    this.orchestrator = orchestrator;
    this.maxConcurrent = config.maxConcurrentCycles;
  }

  /** The configured max concurrent cycle limit (spec 022, Req 1, AC-1). */
  get maxConcurrentCycles(): number {
    return this.maxConcurrent;
  }

  /** Called every tick by the game loop. Synchronous — never awaits. */
  update(_tick: GameTick): void {
    const agents = this.agentManager.getActiveAgents();
    if (agents.length === 0) return;

    // The agent list can shrink between ticks (runtime DespawnAgent,
    // spec 030) — a stale round-robin cursor must never read past the end
    // of the fresh snapshot, so clamp it before scanning.
    if (this.rrCursor >= agents.length) this.rrCursor = 0;

    // Round-robin: start scanning from the last position so that
    // with maxConcurrent=1, different agents get turns across ticks.
    let scanned = 0;
    let idx = this.rrCursor;
    while (scanned < agents.length) {
      if (this.activeCycles >= this.maxConcurrent) break;
      const agent = agents[idx]!;
      if (!agent.isThinking) {
        this.startCycle(agent.agentId);
      }
      idx = (idx + 1) % agents.length;
      scanned++;
    }
    // Advance cursor past the last agent we checked.
    this.rrCursor = idx;
  }

  /** Fire-and-forget a single PPER cycle. */
  private startCycle(agentId: string): void {
    this.activeCycles += 1;
    this.agentManager.updateState(agentId, { isThinking: true });

    this.orchestrator
      .runCycle(agentId)
      .catch((err: unknown) => {
        // Error resilience (Req 19): log and guarantee isThinking is false.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[PPERScheduler] PPER cycle for agent ${agentId} failed: ${message}`);
      })
      .finally(() => {
        this.activeCycles -= 1;
        // Guarantee isThinking is false regardless of what the orchestrator did.
        const state = this.agentManager.getState(agentId);
        if (state?.isThinking) {
          this.agentManager.updateState(agentId, { isThinking: false });
        }
      });
  }
}

export {};
