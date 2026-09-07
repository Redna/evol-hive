/**
 * engine/spatial/navigation — Tick-integrated walking + spatial memory (spec 038, R1/R2/R4/R5)
 * ─────────────────────────────────────────────────────────────────────────────
 * The NavigationSystem is a game-loop system: each tick it advances every
 * navigating agent one cell along its path. Crossing a room's door cell
 * moves the agent to the next room in the route (SceneManager.moveAgent —
 * the same logical location-change moment as before, spec 031 contracts
 * preserved). First arrival in a room updates the agent's spatial memory and
 * rewards curiosity (R5) — exploration finally has a real remedy.
 *
 * Determinism: paths come from WorldGrid (pure functions of grid + door
 * state); movement is one cell per tick. No RNG.
 */

import type { GameTick } from '@evol-hive/shared';
import type { AgentManager } from '../agents/index.js';
import type { Cell } from './grid.js';
import { WorldGrid } from './grid.js';

/** Reward applied once, on first personal arrival in a room (R5). */
const CURIOSITY_EXPLORE_REWARD = 15;

interface WalkState {
  /** Remaining cell path (already includes the door cell of each hop). */
  cells: Cell[];
  /** Rooms still to traverse after the current one (inclusive of destination). */
  roomQueue: string[];
}

export interface NavigationSystemOptions {
  agentManager: AgentManager;
  sceneManager: SceneManagerImplAlias;
  grid: WorldGrid;
  /** Applied when an agent discovers a room for the first time (R5). */
  onDiscoverRoom?: (agentId: string, roomId: string) => void;
}

/** Structural subset of SceneManagerImpl the navigator needs (no cycle). */
export interface SceneManagerImplAlias {
  moveAgent(agentId: string, toRoomId: string): void;
  /** Live adjacency — already reflects open/closed door state (spec 030). */
  getConnectedRooms(roomId: string): { id: string }[];
}

export class NavigationSystemImpl {
  readonly name = 'navigation';
  private readonly walks = new Map<string, WalkState>();

  constructor(private readonly options: NavigationSystemOptions) {}

  /**
   * Request a walk from the agent's current room to `toRoomId`. The agent's
   * `location` changes only when it crosses the door cell into the next room
   * (preserving spec 031/032 semantics for everything that reads location).
   * Returns false when no open route exists.
   */
  requestWalk(agentId: string, toRoomId: string): boolean {
    const state = this.options.agentManager.getState(agentId);
    if (!state) return false;
    if (state.location === toRoomId) return true; // already there
    const route = this.options.grid.route(state.location, toRoomId);
    if (route.length === 0) return false;

    // Start walking toward the current room's door cell.
    const grid = this.options.grid.grid(state.location);
    const agentCell =
      state.position ?? this.options.grid.enterRoom(agentId, undefined, state.location);
    const cells = grid ? grid.path(agentCell ?? { x: 0, y: 0 }, grid.getDoorCell()) : [];
    // Room queue: rooms after the current one, including the destination.
    const roomQueue = route.slice(1);
    this.walks.set(agentId, { cells, roomQueue });
    return true;
  }

  /** Is the agent currently walking? */
  isWalking(agentId: string): boolean {
    return this.walks.has(agentId);
  }

  /** Game-loop system tick: advance every navigating agent one cell. */
  update(tick: GameTick): void {
    void tick;
    for (const [agentId, walk] of this.walks) {
      this.advance(agentId, walk);
    }
  }

  private advance(agentId: string, walk: WalkState): void {
    const state = this.options.agentManager.getState(agentId);
    if (!state) {
      this.walks.delete(agentId);
      return;
    }
    const grid = this.options.grid.grid(state.location);

    // Step to the next cell in the current room's path.
    const next = walk.cells.shift();
    if (next !== undefined) {
      grid?.setAgentCell(agentId, next);
      this.options.agentManager.updateState(agentId, { position: next });
    }

    // Standing on the door cell with more rooms to traverse → cross.
    if (walk.cells.length === 0 && walk.roomQueue.length > 0) {
      const doorGrid = this.options.grid.grid(state.location);
      const atDoor =
        (state.position !== undefined &&
          doorGrid !== null &&
          doorGrid.getDoorCell().x === state.position.x &&
          doorGrid.getDoorCell().y === state.position.y) ||
        next === undefined;
      if (atDoor) {
        const toRoom = walk.roomQueue[0];
        if (toRoom === undefined) {
          this.walks.delete(agentId);
          return;
        }
        // Cross: location changes here (teleport semantics preserved), then
        // walk from the new room's door toward the next hop or finish.
        this.options.sceneManager.moveAgent(agentId, toRoom);
        this.discover(agentId, toRoom);
        const newQueue = walk.roomQueue.slice(1);
        const newGrid = this.options.grid.grid(toRoom);
        const door = newGrid?.getDoorCell() ?? { x: 0, y: 0 };
        this.options.grid.enterRoom(agentId, state.location, toRoom);
        this.options.agentManager.updateState(agentId, { position: door });
        if (newQueue.length === 0) {
          this.walks.delete(agentId);
          return;
        }
        walk.roomQueue = newQueue;
        const nextRoom = newQueue[0] ?? toRoom;
        if (nextRoom !== toRoom) {
          walk.cells = newGrid ? newGrid.path(door, newGrid.getDoorCell()) : [];
        } else {
          this.walks.delete(agentId);
        }
        return;
      }
    }

    // Path exhausted without a pending room hop → arrival.
    if (walk.cells.length === 0 && walk.roomQueue.length <= 1) {
      if (walk.roomQueue.length === 1) {
        const dest = walk.roomQueue[0];
        if (dest !== undefined && dest !== state.location) {
          this.options.sceneManager.moveAgent(agentId, dest);
          this.discover(agentId, dest);
        }
      }
      this.walks.delete(agentId);
    }
  }

  /** Spatial memory + curiosity reward on first personal arrival (R4/R5). */
  private discover(agentId: string, roomId: string): void {
    const state = this.options.agentManager.getState(agentId);
    if (!state) return;
    const memory = state.spatialMemory ?? { visitedRooms: [], knownDoors: [], discoveredAt: {} };
    if (memory.visitedRooms.includes(roomId)) {
      // Known room — refresh door knowledge only.
      this.recordDoors(agentId, memory, roomId);
      return;
    }
    memory.visitedRooms = [...memory.visitedRooms, roomId];
    memory.discoveredAt[roomId] = Date.now();
    this.recordDoors(agentId, memory, roomId);
    this.options.agentManager.updateState(agentId, { spatialMemory: memory });

    // Curiosity remedy (R5): exploration satisfies curiosity, clamped.
    const drives = { ...state.drives };
    const cur = drives['curiosity'];
    if (typeof cur === 'number') {
      drives['curiosity'] = Math.max(0, Math.min(100, cur + CURIOSITY_EXPLORE_REWARD));
      this.options.agentManager.updateState(agentId, { drives });
    }
    this.options.onDiscoverRoom?.(agentId, roomId);
  }

  /** Doors of a room enter memory as seen (R4): "garden|workshop" pairs. */
  private recordDoors(
    agentId: string,
    memory: { visitedRooms: string[]; knownDoors: string[]; discoveredAt: Record<string, number> },
    roomId: string,
  ): void {
    void agentId;
    for (const conn of this.options.sceneManager.getConnectedRooms(roomId)) {
      const pair = [roomId, conn.id].sort().join('|');
      if (!memory.knownDoors.includes(pair)) {
        memory.knownDoors = [...memory.knownDoors, pair];
      }
    }
    this.options.agentManager.updateState(agentId, { spatialMemory: memory });
  }
}
