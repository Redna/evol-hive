/**
 * systems/memory-maintenance — background memory decay & reflection (spec 014, Req 16)
 * ─────────────────────────────────────────────────────────────────────────────
 * An `EngineSystem` that, on each tick, runs background memory maintenance:
 *   - Every `decayIntervalTicks` ticks: fire-and-forgets
 *     `memoryDecayService.applyDecay` for each active agent.
 *   - Each tick: checks `reflectionLoop.shouldReflect` and fire-and-forgets
 *     `reflectionLoop.runReflection` when it returns `true`.
 *
 * The `update()` method is fully synchronous — it never awaits async operations
 * (matching the `PPERScheduler` pattern, spec 005). Errors are logged via
 * `.catch()` and never thrown. This ensures the game loop runs at full FPS
 * regardless of LLM latency.
 *
 * Imports from `@evol-hive/shared` and `@evol-hive/memory` only (per ADR-0001 /
 * spec 014, Req 20).
 */

import type { GameTick, MemoryDecayConfig } from '@evol-hive/shared';
import type { MemoryDecayService, ReflectionLoop } from '@evol-hive/memory';
import type { AgentManager } from '../index.js';

/** Constructor options for {@link MemoryMaintenanceSystem}. */
export interface MemoryMaintenanceOptions {
  agentManager: AgentManager;
  memoryDecayService: MemoryDecayService;
  /** Optional — reflection is skipped when not provided (spec 014, Req 18). */
  reflectionLoop?: ReflectionLoop;
  decayConfig: MemoryDecayConfig;
}

export class MemoryMaintenanceSystem {
  readonly name = 'memory-maintenance';

  private readonly agentManager: AgentManager;
  private readonly memoryDecayService: MemoryDecayService;
  private readonly reflectionLoop: ReflectionLoop | undefined;
  private readonly decayConfig: MemoryDecayConfig;
  private tickCounter = 0;

  constructor(options: MemoryMaintenanceOptions) {
    this.agentManager = options.agentManager;
    this.memoryDecayService = options.memoryDecayService;
    this.reflectionLoop = options.reflectionLoop;
    this.decayConfig = options.decayConfig;
  }

  /** Called every tick by the game loop. Synchronous — never awaits. */
  update(tick: GameTick): void {
    this.tickCounter += 1;
    const timeForDecay = this.tickCounter % this.decayConfig.decayIntervalTicks === 0;
    const agents = this.agentManager.getActiveAgents();

    for (const agent of agents) {
      // Decay pass (fire-and-forget, only on interval ticks).
      if (timeForDecay) {
        this.memoryDecayService
          .applyDecay(agent.agentId, tick.simulationTime)
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              `[MemoryMaintenanceSystem] applyDecay for ${agent.agentId} failed: ${message}`,
            );
          });
      }

      // Reflection check (fire-and-forget) — skipped when no reflection loop.
      const reflectionLoop = this.reflectionLoop;
      if (!reflectionLoop) continue;
      const isIdle = !agent.isThinking;
      reflectionLoop
        .shouldReflect(agent.agentId, tick.simulationTime, isIdle)
        .then((should) => {
          if (should) {
            return reflectionLoop.runReflection(agent.agentId);
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[MemoryMaintenanceSystem] reflection for ${agent.agentId} failed: ${message}`,
          );
        });
    }
  }
}

export {};
