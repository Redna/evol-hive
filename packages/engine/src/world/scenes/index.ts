/**
 * scenes/ — SceneManagerImpl — in-memory room graph & agent movement (spec 005, Req 6)
 * ────────────────────────────────────────────────────────────────────────────
 * Backed by an in-memory `Map<string, Room>`. Supports room lookup, connected-room
 * traversal, agent teleport (direct move — no pathfinding for the prototype), and
 * querying the room an agent currently occupies. Moving an agent updates
 * `AgentInternalState.location`, which the `SpatialSystemImpl` detects on the
 * next tick (room boundary crossing).
 */

import type { Room } from '@evol-hive/shared';
import type { AgentManager } from '../../index.js';
import type { SceneManager } from '../index.js';

/** Concrete SceneManager backed by an in-memory room map. */
export class SceneManagerImpl implements SceneManager {
  private readonly rooms: Map<string, Room>;
  private readonly agentManager: AgentManager;

  constructor(agentManager: AgentManager, rooms: Map<string, Room>) {
    this.agentManager = agentManager;
    this.rooms = rooms;
  }

  getRoom(roomId: string): Room | null {
    return this.rooms.get(roomId) ?? null;
  }

  getConnectedRooms(roomId: string): Room[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const connected: Room[] = [];
    for (const id of room.connections) {
      const r = this.rooms.get(id);
      if (r) connected.push(r);
    }
    return connected;
  }

  moveAgent(agentId: string, toRoomId: string): void {
    this.agentManager.updateState(agentId, { location: toRoomId });
  }

  getAgentRoom(agentId: string): Room | null {
    const state = this.agentManager.getState(agentId);
    if (!state) return null;
    return this.rooms.get(state.location) ?? null;
  }

  // ── Spec 017 (persistence) — export/import ────────────────────────────────

  /** Return all rooms as an array (spec 017, Req 15). Read-only. */
  getAllRooms(): Room[] {
    return [...this.rooms.values()];
  }

  /** Replace the internal room map (spec 017, Req 15). Preserves `agentManager` binding. */
  restoreRooms(rooms: Map<string, Room>): void {
    this.rooms.clear();
    for (const [id, room] of rooms) {
      this.rooms.set(id, room);
    }
  }
}

export {};
