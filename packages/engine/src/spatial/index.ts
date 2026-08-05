/**
 * spatial/ — Spatial management & debouncing
 * ──────────────────────────────────────────
 * Section 6.1: Perception is debounced — a new perception tick fires only when
 * the agent crosses a room boundary OR has been idle longer than the configured
 * debounce window. Deep object state never leaks through this layer.
 */

import type { GameTick, SmartObjectSummary } from '@evol-hive/shared';
import type { AgentManager } from '../agents/index.js';
import type { SmartObjectRegistry } from '../world/index.js';
import type { SpatialSystem } from '../index.js';

/** Constructor options for {@link SpatialSystemImpl}. */
export interface SpatialSystemOptions {
  agentManager: AgentManager;
  registry: SmartObjectRegistry;
  /** Seconds of idleness before triggering a perception tick (ENGINE_SPATIAL_DEBOUNCE_SECONDS). */
  spatialDebounceSeconds: number;
}

/**
 * Concrete SpatialSystem. Tracks each agent's last-seen room and the current
 * simulation time (updated via `update(tick)`) to evaluate debounce conditions.
 */
export class SpatialSystemImpl implements SpatialSystem {
  readonly name = 'spatial';

  private readonly agentManager: AgentManager;
  private readonly registry: SmartObjectRegistry;
  private readonly debounceSeconds: number;
  private currentSimTime = 0;
  /** Last room in which a perception tick fired for each agent. */
  private readonly lastLocationByAgent = new Map<string, string>();

  constructor(options: SpatialSystemOptions) {
    this.agentManager = options.agentManager;
    this.registry = options.registry;
    this.debounceSeconds = options.spatialDebounceSeconds;
  }

  /** Advance the simulation clock (called every tick by the game loop). */
  update(tick: GameTick): void {
    this.currentSimTime = tick.simulationTime;
  }

  /** Objects visible in a room — projected to { id, name, type } (no deep state). */
  getObjectsInRoom(roomId: string): SmartObjectSummary[] {
    return this.registry.getObjectsInRoom(roomId);
  }

  /**
   * Decide whether a perception tick should fire for an agent.
   * Returns true if the agent crossed a room boundary since the last tick, or
   * if the agent has been idle (no recorded perception) longer than the debounce
   * window. Returns false otherwise.
   */
  shouldTriggerPerception(agentId: string): boolean {
    const state = this.agentManager.getState(agentId);
    if (!state) return false;

    const location = state.location;
    const lastLocation = this.lastLocationByAgent.get(agentId);

    if (lastLocation === undefined) {
      // First observation: establish the baseline room, no boundary crossing yet.
      this.lastLocationByAgent.set(agentId, location);
    } else if (location !== lastLocation) {
      // Room threshold crossed.
      return true;
    }

    // Idle timer: time since the last recorded perception tick.
    const idleSeconds = this.currentSimTime - state.lastPerceptionTick;
    return idleSeconds > this.debounceSeconds;
  }

  /** Record that a perception tick fired, updating agent state and baseline room. */
  recordPerceptionTick(agentId: string, simulationTime: number): void {
    const state = this.agentManager.getState(agentId);
    if (!state) return;
    this.agentManager.updateState(agentId, { lastPerceptionTick: simulationTime });
    this.lastLocationByAgent.set(agentId, state.location);
  }
}

export {};
