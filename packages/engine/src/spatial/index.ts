// spatial/ — Spatial management & debouncing
// ────────────────────────────────────────────
// Section 6.1: Perception is debounced to avoid spamming the LLM every frame.
// A new perception tick fires only when:
//   - The agent crosses a room boundary, OR
//   - The agent has been idle longer than spatialDebounceSeconds.

import type { AgentInternalState, GameTick, SmartObjectProjection } from '@evol-hive/shared';
import type { SpatialSystem } from '../index.js';

/**
 * Interface for accessing agent internal state.
 * This is a subset of `AgentManager` — the spatial system only needs
 * to read and update agent state for debouncing purposes.
 */
export interface AgentStateAccessor {
  getState(agentId: string): AgentInternalState | null;
  updateState(agentId: string, updates: Partial<AgentInternalState>): void;
}

/**
 * Interface for retrieving projected objects in a room.
 * This is a subset of `SmartObjectRegistry` — the spatial system delegates
 * object retrieval to the registry.
 */
export interface ObjectRetriever {
  getObjectsInRoom(roomId: string): SmartObjectProjection[];
}

/** Configuration for the spatial debounce system. */
export interface SpatialSystemConfig {
  spatialDebounceSeconds: number;
}

/**
 * Implementation of `SpatialSystem` with room-threshold and idle-timer debouncing.
 *
 * - `shouldTriggerPerception` returns true when the agent's room has changed
 *   since the last perception tick, OR when the idle time exceeds the debounce.
 * - `recordPerceptionTick` updates `AgentInternalState.lastPerceptionTick`
 *   and records the current room as the last known room.
 */
export class SpatialSystemImpl implements SpatialSystem {
  readonly name = 'spatial';

  private currentSimTime = 0;
  /** Tracks the agent's last known room at the time of the last perception tick. */
  private lastKnownRoom = new Map<string, string>();

  constructor(
    private agentState: AgentStateAccessor,
    private objectRetriever: ObjectRetriever,
    private config: SpatialSystemConfig,
  ) {}

  /**
   * Called every tick by the game loop — stores the current simulation time
   * for debounce calculations.
   */
  update(tick: GameTick): void {
    this.currentSimTime = tick.simulationTime;
  }

  /**
   * Get projected objects in a room (passive perception).
   * Delegates to the object retriever.
   */
  getObjectsInRoom(roomId: string): SmartObjectProjection[] {
    return this.objectRetriever.getObjectsInRoom(roomId);
  }

  /**
   * Check if a perception tick should fire (spatial debouncing).
   *
   * Returns true when:
   * - (AC-5) The agent's room has changed since the last perception tick.
   * - (AC-7) The agent has been idle longer than `spatialDebounceSeconds`.
   *
   * Returns false when:
   * - (AC-6, AC-8, AC-10) Neither condition is met.
   */
  shouldTriggerPerception(agentId: string): boolean {
    const state = this.agentState.getState(agentId);
    if (!state) {
      return false;
    }

    // ── Room threshold check ──
    const currentRoom = state.location;
    const lastRoom = this.lastKnownRoom.get(agentId) ?? currentRoom;
    if (currentRoom !== lastRoom) {
      return true;
    }

    // ── Idle timer check ──
    const idleTime = this.currentSimTime - state.lastPerceptionTick;
    if (idleTime > this.config.spatialDebounceSeconds) {
      return true;
    }

    return false;
  }

  /**
   * Record that a perception tick fired for an agent.
   * (AC-9) Updates `AgentInternalState.lastPerceptionTick` to the passed
   * simulation time, and records the current room as the last known room.
   */
  recordPerceptionTick(agentId: string, simulationTime: number): void {
    const state = this.agentState.getState(agentId);
    if (!state) {
      return;
    }

    this.agentState.updateState(agentId, { lastPerceptionTick: simulationTime });
    this.lastKnownRoom.set(agentId, state.location);
  }
}
