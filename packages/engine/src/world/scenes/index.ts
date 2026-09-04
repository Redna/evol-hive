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
  /**
   * Closed connection pairs (spec 030, Req 9). Closing removes the pair from
   * both rooms' `connections` adjacency (design note D2: connections stay the
   * adjacency source of truth), and the pair is remembered here so re-opening
   * can restore the adjacency without a parallel topology graph. Keys are
   * canonical `a|b` pairs (sorted).
   */
  private readonly closedConnections = new Set<string>();

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

  /** Return all rooms as an array (spec 017, Req 15 / AC-26). Read-only. */
  getAllRooms(): Room[] {
    return [...this.rooms.values()];
  }

  /**
   * Replace the internal room map contents with the provided rooms (spec 017,
   * Req 15 / AC-27). The existing `agentManager` binding is preserved.
   */
  restoreRooms(rooms: Map<string, Room>): void {
    this.rooms.clear();
    for (const [id, room] of rooms) {
      this.rooms.set(id, room);
    }
    this.closedConnections.clear();
  }

  // ── Dynamic topology (spec 030, Req 9) ───────────────────────────────────

  /** Canonical map key for an undirected room pair. */
  private pairKey(roomA: string, roomB: string): string {
    return [roomA, roomB].sort().join('|');
  }

  /**
   * Open or close the connection between two rooms (spec 030, Req 9). Closing
   * removes the pair from both rooms' `connections` (so `getConnectedRooms`
   * and all adjacency consumers immediately respect it) while the doorway
   * smart object is preserved by the caller (`SceneMutationService` mirrors
   * the state onto the doorway's `state.open`). Re-opening restores the
   * adjacency for a previously-closed pair.
   *
   * Throws a plain `Error` with an actionable message for unknown rooms or
   * never-connected pairs — the `SceneMutationService` validates first and
   * converts these into `SceneMutationError`s.
   */
  setConnectionOpen(roomA: string, roomB: string, open: boolean): void {
    const a = this.rooms.get(roomA);
    const b = this.rooms.get(roomB);
    if (!a) {
      throw new Error(
        `Cannot update connection: room '${roomA}' does not exist.`,
      );
    }
    if (!b) {
      throw new Error(
        `Cannot update connection: room '${roomB}' does not exist.`,
      );
    }
    const key = this.pairKey(roomA, roomB);
    if (open) {
      if (a.connections.includes(roomB)) return; // already open — no-op
      if (!this.closedConnections.has(key)) {
        throw new Error(
          `Cannot open connection between '${roomA}' and '${roomB}': the rooms were never connected. Use addConnection to create one.`,
        );
      }
      this.closedConnections.delete(key);
      a.connections.push(roomB);
      b.connections.push(roomA);
    } else {
      if (!a.connections.includes(roomB)) {
        if (this.closedConnections.has(key)) return; // already closed — no-op
        throw new Error(
          `Cannot close connection between '${roomA}' and '${roomB}': the rooms are not connected.`,
        );
      }
      this.closedConnections.add(key);
      a.connections = a.connections.filter((id) => id !== roomB);
      b.connections = b.connections.filter((id) => id !== roomA);
    }
  }

  /**
   * Add a connection between two rooms (spec 030, Req 9). Both adjacency
   * lists are updated. Throws for unknown rooms or already-connected pairs.
   */
  addConnection(roomA: string, roomB: string): void {
    const a = this.rooms.get(roomA);
    const b = this.rooms.get(roomB);
    if (!a) {
      throw new Error(`Cannot add connection: room '${roomA}' does not exist.`);
    }
    if (!b) {
      throw new Error(`Cannot add connection: room '${roomB}' does not exist.`);
    }
    if (a.connections.includes(roomB) || this.closedConnections.has(this.pairKey(roomA, roomB))) {
      throw new Error(
        `Cannot add connection between '${roomA}' and '${roomB}': the rooms are already connected.`,
      );
    }
    a.connections.push(roomB);
    b.connections.push(roomA);
  }

  /**
   * Remove the connection between two rooms entirely (spec 030, Req 9 — the
   * 'remove' action). Both adjacency lists are updated and the pair is
   * forgotten from the closed set (removal is final — it cannot be re-opened,
   * only re-inserted via `addConnection`). Throws for unknown or unconnected
   * pairs (open or closed).
   */
  removeConnection(roomA: string, roomB: string): void {
    const a = this.rooms.get(roomA);
    const b = this.rooms.get(roomB);
    if (!a) {
      throw new Error(`Cannot remove connection: room '${roomA}' does not exist.`);
    }
    if (!b) {
      throw new Error(`Cannot remove connection: room '${roomB}' does not exist.`);
    }
    const key = this.pairKey(roomA, roomB);
    if (!a.connections.includes(roomB) && !this.closedConnections.has(key)) {
      throw new Error(
        `Cannot remove connection between '${roomA}' and '${roomB}': the rooms are not connected.`,
      );
    }
    a.connections = a.connections.filter((id) => id !== roomB);
    b.connections = b.connections.filter((id) => id !== roomA);
    this.closedConnections.delete(key);
  }

  /** Whether the pair is connected but currently closed (spec 030, Req 9). */
  isPairClosed(roomA: string, roomB: string): boolean {
    return this.closedConnections.has(this.pairKey(roomA, roomB));
  }

  /** Whether a direct, open connection exists between two rooms. */
  hasConnection(roomA: string, roomB: string): boolean {
    return this.rooms.get(roomA)?.connections.includes(roomB) ?? false;
  }

  /**
   * TopologyGuard implementation (spec 030, Req 10): `go_to_<dest>` actions
   * are blocked when `<dest>` is a known room that is not reachable from
   * `fromRoom` through an open (direct) connection. Non-movement actions are
   * never blocked.
   */
  isMovementBlocked(_agentId: string, action: string, fromRoom: string): boolean {
    if (!action.startsWith('go_to_')) return false;
    const destination = action.slice('go_to_'.length);
    // Unknown destinations are not topology-guarded (e.g. `go_outside`).
    if (!this.rooms.has(destination)) return false;
    return !this.hasConnection(fromRoom, destination);
  }
}

export {};
