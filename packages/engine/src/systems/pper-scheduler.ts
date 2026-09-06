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

import type {
  PPERSchedulerConfig,
  PPEROrchestratorPort,
  System1GatePort,
  System1OutcomeRecorderPort,
  System1TriggerSourcePort,
} from '@evol-hive/shared';
import { NO_HARD_TRIGGERS, hasHardTrigger } from '@evol-hive/shared';
import type { GameTick } from '@evol-hive/shared';
import type { AgentManager } from '../index.js';

/** Optional System 1 ports (spec 035, Req 7/9). When omitted, the scheduler
 * behaves exactly as before (every idle agent cycles). */
export interface System1SchedulerPorts {
  /** The React/Ignore gate — consulted synchronously before startCycle. */
  gate: System1GatePort;
  /** Engine-state hard-trigger extraction (Req 5). */
  triggerSource?: System1TriggerSourcePort | undefined;
  /** Outcome labeling hooks (Req 9). */
  outcomeRecorder?: System1OutcomeRecorderPort | undefined;
}

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
  /** Optional System 1 ports (spec 035) — undefined = ungated behavior. */
  private readonly system1: System1SchedulerPorts | undefined;

  constructor(
    agentManager: AgentManager,
    orchestrator: PPEROrchestratorPort,
    config: PPERSchedulerConfig,
    /** Optional System 1 gating ports (spec 035, Req 7). */
    system1?: System1SchedulerPorts,
  ) {
    this.agentManager = agentManager;
    this.orchestrator = orchestrator;
    this.maxConcurrent = config.maxConcurrentCycles;
    this.system1 = system1;
  }

  /** The configured max concurrent cycle limit (spec 022, Req 1, AC-1). */
  get maxConcurrentCycles(): number {
    return this.maxConcurrent;
  }

  /** Called every tick by the game loop. Synchronous — never awaits. */
  update(_tick: GameTick): void {
    const agents = this.agentManager.getActiveAgents();
    if (agents.length === 0) return;

    // Round-robin: start scanning from the last position so that
    // with maxConcurrent=1, different agents get turns across ticks.
    // The cursor must be wrapped BEFORE the first access: agent despawns
    // (spec 030) shrink the active list between ticks, and a stale cursor
    // ≥ agents.length would read undefined and crash the frame (found by
    // the dynamic-world long-horizon run at the t+360s despawn).
    let scanned = 0;
    let idx = this.rrCursor % agents.length;
    while (scanned < agents.length) {
      if (this.activeCycles >= this.maxConcurrent) break;
      const agent = agents[idx]!;
      if (!agent.isThinking) {
        // System 1 gate (spec 035, Req 7): consult BEFORE startCycle, from
        // cached features only (synchronous, zero LLM calls). An idled agent
        // skips this tick entirely — no cycle, no associative injection
        // (Req 8), and no outcome sample (only completed cycles are labeled).
        const system1 = this.system1;
        if (system1 !== undefined) {
          system1.outcomeRecorder?.onTick?.(agent.agentId, _tick.tickNumber);
          const hardTriggers =
            system1.triggerSource?.getHardTriggers(agent.agentId) ?? NO_HARD_TRIGGERS;
          const decision = system1.gate.decide(agent.agentId, _tick.tickNumber, hardTriggers);
          // Belt-and-braces Req 5: hard triggers force a cycle regardless of
          // p(react) — even a buggy gate must never suppress an alarm.
          if (!decision.react && !hasHardTrigger(hardTriggers)) {
            idx = (idx + 1) % agents.length;
            scanned++;
            continue;
          }
          system1.outcomeRecorder?.onCycleStart(agent.agentId, {
            decision,
            hardTriggers,
            tickNumber: _tick.tickNumber,
            simTime: _tick.simulationTime,
          });
        }
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
        // Outcome labeling (spec 035, Req 9): the cycle settled — record the
        // REACT/IGNORE sample.
        this.system1?.outcomeRecorder?.onCycleSettled(agentId);
      });
  }
}

export {};
