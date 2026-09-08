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
 * Spec 039 phase 2 (R2): `navigateToArea` resolves an LLM `targetArea`
 * intent (a known room or object anchor — never cell coordinates) into a
 * multi-tick walk; the caller (Execute) executes the affordance only when
 * arrival is observed. Every cell the agent walks is recorded into
 * `spatialMemory.exploredCells` (cell-level fog for the visualizer, R8).
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

/**
 * A pending `targetArea` walk (spec 039, R2): the LLM's area intent being
 * walked out by the engine. `kind: 'room'` walks to the room itself;
 * `kind: 'object'` walks to the object's anchor cell (stops adjacent).
 */
interface PendingArea {
  area: string;
  kind: 'room' | 'object';
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
  /** Pending targetArea walks (spec 039, R2) — one per agent. */
  private readonly pendingAreas = new Map<string, PendingArea>();

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

  /** Is a targetArea walk pending for the agent (spec 039, R2)? */
  hasPendingArea(agentId: string): boolean {
    return this.pendingAreas.has(agentId);
  }

  /**
   * Resolve an LLM `targetArea` intent into navigation (spec 039, R2).
   *
   * The agent reasons over AREAS it knows — a room (visited or seen through
   * a door) or an object anchor recorded in spatial memory — never cell
   * coordinates. Unknown areas fail with `'unknown-area'` (fog holds: the
   * engine never reveals or routes to what the agent has not observed);
   * known areas route through the WorldGrid doorway graph (spec 030
   * topology — open doors only) and walk over multiple ticks.
   *
   * Callers poll: `'walking'` while the multi-tick walk is in progress,
   * `'arrived'` once the agent stands at the target (adjacent to the anchor
   * for object targets), `'no-route'` when no open route exists.
   */
  navigateToArea(
    agentId: string,
    targetArea: string,
  ): import('@evol-hive/shared').NavigationStepStatus {
    const state = this.options.agentManager.getState(agentId);
    if (!state) return 'unknown-area';

    // (1) A pending walk: poll for arrival instead of re-routing.
    const pending = this.pendingAreas.get(agentId);
    if (pending !== undefined) {
      if (this.walks.has(agentId)) return 'walking';
      if (pending.kind === 'room') {
        if (state.location === pending.area) {
          this.pendingAreas.delete(agentId);
          return 'arrived';
        }
        // The walk ended somewhere else (world moved the agent) — re-route.
      } else {
        const objectRoom = this.objectRoom(agentId, pending.area);
        if (objectRoom !== undefined && state.location === objectRoom) {
          if (this.isAdjacentToAnchor(agentId, pending.area)) {
            this.pendingAreas.delete(agentId);
            return 'arrived';
          }
          // Room reached — walk the remaining cells to the anchor.
          if (this.walkToObject(agentId, pending.area)) return 'walking';
          return 'no-route'; // anchor unreachable (fully blocked)
        }
        // Walk ended in a different room — re-route to the object's room.
      }
      this.pendingAreas.delete(agentId);
    }

    // (2) Already standing at the target.
    if (state.location === targetArea) return 'arrived';

    // (3) Object anchor target (spec 039, R1 — observed anchors only).
    const objectRoom = this.objectRoom(agentId, targetArea);
    if (objectRoom !== undefined) {
      if (objectRoom === state.location) {
        if (this.walkToObject(agentId, targetArea)) {
          this.pendingAreas.set(agentId, { area: targetArea, kind: 'object' });
          return 'walking';
        }
        return 'no-route'; // anchor unreachable (fully blocked)
      }
      const route = this.options.grid.route(state.location, objectRoom);
      if (route.length === 0) return 'no-route';
      if (!this.requestWalkTo(agentId, objectRoom)) return 'no-route';
      this.pendingAreas.set(agentId, { area: targetArea, kind: 'object' });
      return 'walking';
    }

    // (4) Room target (spec 039, R1 — visited or door-adjacent rooms only).
    if (!this.isKnownRoom(agentId, targetArea)) return 'unknown-area';
    const route = this.options.grid.route(state.location, targetArea);
    if (route.length === 0) return 'no-route';
    if (!this.requestWalkTo(agentId, targetArea)) return 'no-route';
    this.pendingAreas.set(agentId, { area: targetArea, kind: 'room' });
    return 'walking';
  }

  /** The room an object anchor was last seen in (spatial memory), if known. */
  private objectRoom(agentId: string, objectId: string): string | undefined {
    const state = this.options.agentManager.getState(agentId);
    return state?.spatialMemory?.observedObjects?.[objectId];
  }

  /** Rooms the agent knows: visited, door-adjacent (seen), or anchor-hosting. */
  private isKnownRoom(agentId: string, roomId: string): boolean {
    const state = this.options.agentManager.getState(agentId);
    const memory = state?.spatialMemory;
    if (!memory) return false;
    if (memory.visitedRooms.includes(roomId)) return true;
    for (const pair of memory.knownDoors) {
      const [a, b] = pair.split('|');
      if (a === roomId || b === roomId) return true;
    }
    return false;
  }

  /** Is the agent standing adjacent to (or on) the object's anchor cell? */
  private isAdjacentToAnchor(agentId: string, objectId: string): boolean {
    const state = this.options.agentManager.getState(agentId);
    if (!state?.position) return false;
    const anchor = this.options.grid.grid(state.location)?.getAnchor(objectId);
    if (!anchor) return false;
    return Math.abs(state.position.x - anchor.x) + Math.abs(state.position.y - anchor.y) <= 1;
  }

  /**
   * Start a cell walk to the object's anchor (stops adjacent — anchor cells
   * block walking). Returns false when no path exists.
   */
  private walkToObject(agentId: string, objectId: string): boolean {
    const state = this.options.agentManager.getState(agentId);
    if (!state?.position) return false;
    const path = this.options.grid.pathToObject(state.location, state.position, objectId);
    if (path.length === 0) return false;
    this.walks.set(agentId, { cells: path, roomQueue: [] });
    return true;
  }

  /** requestWalk with a boolean contract (false = no open route). */
  private requestWalkTo(agentId: string, toRoomId: string): boolean {
    const state = this.options.agentManager.getState(agentId);
    if (!state) return false;
    if (state.location === toRoomId) return true;
    return this.requestWalk(agentId, toRoomId);
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
      this.pendingAreas.delete(agentId);
      return;
    }
    const grid = this.options.grid.grid(state.location);

    // Step to the next cell in the current room's path.
    const next = walk.cells.shift();
    if (next !== undefined) {
      grid?.setAgentCell(agentId, next);
      this.options.agentManager.updateState(agentId, { position: next });
      // Cell-level fog (spec 039, R3/R8): every walked cell enters the
      // agent's explored set for the visualizer's shading.
      this.markExploredCell(agentId, state.location, next);
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
        // Cell-level fog: the door cell of the newly entered room is explored.
        this.markExploredCell(agentId, toRoom, door);
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
    memory: {
      visitedRooms: string[];
      knownDoors: string[];
      discoveredAt: Record<string, number>;
      observedObjects?: Record<string, string>;
      exploredCells?: Record<string, string[]>;
    },
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

  /**
   * Record a cell into the agent's explored set (spec 039, R3/R8 — cell-level
   * fog). Deterministic: set-insertion, no RNG.
   */
  private markExploredCell(agentId: string, roomId: string, cell: Cell): void {
    const state = this.options.agentManager.getState(agentId);
    if (!state?.spatialMemory) return; // legacy agent — no fog tracking
    const memory = state.spatialMemory;
    const key = `${cell.x},${cell.y}`;
    const cells = memory.exploredCells ?? {};
    const known = cells[roomId] ?? [];
    if (known.includes(key)) return;
    this.options.agentManager.updateState(agentId, {
      spatialMemory: {
        ...memory,
        exploredCells: { ...cells, [roomId]: [...known, key] },
      },
    });
  }

  /**
   * Seed the agent's spatial memory for its spawn room (spec 039, AC-8): the
   * start room counts as personally visited, its doors are seen, its object
   * anchors are observed, and the spawn cell (+ free neighbours) is explored.
   * Deterministic — scenes load identically every run.
   */
  seedSpawnKnowledge(agentId: string, roomId: string, objectIds: string[]): void {
    const state = this.options.agentManager.getState(agentId);
    if (!state) return;
    const memory = state.spatialMemory ?? { visitedRooms: [], knownDoors: [], discoveredAt: {} };
    if (!memory.visitedRooms.includes(roomId)) {
      memory.visitedRooms = [...memory.visitedRooms, roomId];
      memory.discoveredAt[roomId] = Date.now();
    }
    this.recordDoors(agentId, memory, roomId);
    const observed = { ...(memory.observedObjects ?? {}) };
    for (const objectId of objectIds) {
      observed[objectId] = roomId;
    }
    // Explored cells: the spawn cell + its free neighbours (deterministic).
    const cells = { ...(memory.exploredCells ?? {}) };
    const position = state.position;
    const explored = new Set<string>(cells[roomId] ?? []);
    if (position) {
      explored.add(`${position.x},${position.y}`);
      const grid = this.options.grid.grid(roomId);
      if (grid) {
        for (const n of [
          { x: position.x - 1, y: position.y },
          { x: position.x + 1, y: position.y },
          { x: position.x, y: position.y - 1 },
          { x: position.x, y: position.y + 1 },
        ]) {
          if (n.x >= 0 && n.x < grid.width && n.y >= 0 && n.y < grid.height && !grid.isBlocked(n)) {
            explored.add(`${n.x},${n.y}`);
          }
        }
      }
    }
    cells[roomId] = [...explored];
    this.options.agentManager.updateState(agentId, {
      spatialMemory: { ...memory, observedObjects: observed, exploredCells: cells },
    });
  }
}
