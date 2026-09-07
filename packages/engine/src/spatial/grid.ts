/**
 * engine/spatial/grid — Room grid, deterministic anchors, BFS paths (spec 038, R1–R2)
 * ─────────────────────────────────────────────────────────────────────────────
 * The spatial model the architecture previously lacked: rooms are cell grids,
 * objects occupy deterministic anchor cells, agents walk cell-by-cell per
 * tick. Purely deterministic — paths are pure functions of grid + door state
 * (R7); no RNG anywhere.
 *
 * Division of labor (user-directed design): the LLM reasons over AREAS it
 * knows; this module owns how/when agents traverse cells.
 */

/** Grid dimensions per room (spec 038, R1 — configurable per scene later). */
export const GRID_WIDTH = 12;
export const GRID_HEIGHT = 8;

export interface Cell {
  x: number;
  y: number;
}

/**
 * Deterministic string hash (FNV-1a) — anchor assignment is a pure function
 * of the object ID so scenes load identically every run (R7).
 */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function key(c: Cell): string {
  return `${c.x},${c.y}`;
}

function* neighbours(c: Cell, w: number, h: number): Generator<Cell> {
  if (c.x > 0) yield { x: c.x - 1, y: c.y };
  if (c.x < w - 1) yield { x: c.x + 1, y: c.y };
  if (c.y > 0) yield { x: c.x, y: c.y - 1 };
  if (c.y < h - 1) yield { x: c.x, y: c.y + 1 };
}

function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Per-room grid state: object anchors + agent occupancy.
 * Anchors are assigned deterministically (hash of objectId + linear probing)
 * so scenes load identically every run (R7). Anchor cells block walking.
 */
export class RoomGrid {
  readonly width = GRID_WIDTH;
  readonly height = GRID_HEIGHT;
  private readonly anchors = new Map<string, Cell>();
  private readonly agents = new Map<string, Cell>();
  private readonly doorCell: Cell;

  constructor(
    objectIds: string[],
    doorCell: Cell = { x: GRID_WIDTH - 1, y: Math.floor(GRID_HEIGHT / 2) },
  ) {
    this.doorCell = doorCell;
    const taken = new Set<string>([key(doorCell)]);
    for (const id of [...objectIds].sort()) {
      let cell = this.hashCell(id);
      let probes = 0;
      while (taken.has(key(cell)) && probes < GRID_WIDTH * GRID_HEIGHT) {
        probes++;
        cell = { x: probes % GRID_WIDTH, y: Math.floor(probes / GRID_WIDTH) % GRID_HEIGHT };
      }
      this.anchors.set(id, cell);
      taken.add(key(cell));
    }
  }

  private hashCell(id: string): Cell {
    const h = hash32(id);
    return { x: h % GRID_WIDTH, y: Math.floor(h / GRID_WIDTH) % GRID_HEIGHT };
  }

  getAnchor(objectId: string): Cell | null {
    return this.anchors.get(objectId) ?? null;
  }

  getDoorCell(): Cell {
    return this.doorCell;
  }

  getAgentCell(agentId: string): Cell | null {
    return this.agents.get(agentId) ?? null;
  }

  getAgentCellAt(cell: Cell): string | null {
    for (const [id, c] of this.agents) {
      if (c.x === cell.x && c.y === cell.y) return id;
    }
    return null;
  }

  setAgentCell(agentId: string, cell: Cell): void {
    this.agents.set(agentId, cell);
  }

  removeAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  /** Anchor cells block walking; agents and the door cell do not. */
  isBlocked(cell: Cell): boolean {
    for (const anchor of this.anchors.values()) {
      if (anchor.x === cell.x && anchor.y === cell.y) return true;
    }
    return false;
  }

  /**
   * BFS shortest path between two cells (4-neighbour, anchor cells blocked).
   * Tie-break: lowest index — a pure function of grid state (R7).
   */
  path(from: Cell, to: Cell): Cell[] {
    if (from.x === to.x && from.y === to.y) return [to];
    const start = key(from);
    const goal = key(to);
    const prev = new Map<string, Cell | null>([[start, null]]);
    const queue: Cell[] = [from];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const n of neighbours(cur, this.width, this.height)) {
        const k = key(n);
        if (prev.has(k)) continue;
        if (this.isBlocked(n) && k !== goal) continue;
        prev.set(k, cur);
        if (k === goal) {
          const path: Cell[] = [];
          let at: Cell | null = n;
          while (at !== null) {
            path.unshift(at);
            at = prev.get(key(at)) ?? null;
          }
          return path;
        }
        queue.push(n);
      }
    }
    return [];
  }
}

/**
 * The whole-world spatial map: per-room grids + multi-room routing over the
 * scene's connection adjacency (R2). Room-level hops respect closed doors
 * via the injected `isConnectionOpen` predicate (spec 030 topology).
 */
export class WorldGrid {
  private readonly grids = new Map<string, RoomGrid>();
  private readonly roomList: { id: string; connections: string[] }[];

  constructor(
    rooms: { id: string; connections: string[] }[],
    objectAnchors: Map<string, string[]>,
    private readonly isConnectionOpen: (a: string, b: string) => boolean,
  ) {
    this.roomList = rooms;
    for (const room of rooms) {
      this.grids.set(room.id, new RoomGrid(objectAnchors.get(room.id) ?? []));
    }
  }

  grid(roomId: string): RoomGrid | null {
    return this.grids.get(roomId) ?? null;
  }

  /**
   * Multi-room route: BFS over the room connection graph (open doors only).
   * Returns ordered room IDs from `from` to `to` (inclusive), or [] when no
   * open route exists (R7: pure function of topology + door state).
   */
  route(from: string, to: string): string[] {
    if (from === to) return [from];
    const prev = new Map<string, string | null>([[from, null]]);
    const queue = [from];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const room = this.roomList.find((r) => r.id === cur);
      if (!room) continue;
      for (const next of room.connections) {
        if (prev.has(next)) continue;
        if (!this.isConnectionOpen(cur, next)) continue;
        prev.set(next, cur);
        if (next === to) {
          const path: string[] = [];
          let at: string | null = next;
          while (at !== null) {
            path.unshift(at);
            at = prev.get(at) ?? null;
          }
          return path;
        }
        queue.push(next);
      }
    }
    return [];
  }

  /** Cell path for an agent to approach an object's anchor (stops adjacent). */
  pathToObject(roomId: string, agentCell: Cell, objectId: string): Cell[] {
    const grid = this.grids.get(roomId);
    if (!grid) return [];
    const anchor = grid.getAnchor(objectId);
    if (!anchor) return [];
    const candidates = [...neighbours(anchor, grid.width, grid.height)]
      .filter((c) => !grid.isBlocked(c))
      .sort((a, b) => manhattan(a, agentCell) - manhattan(b, agentCell));
    for (const target of candidates) {
      const p = grid.path(agentCell, target);
      if (p.length > 0) return p;
    }
    return [];
  }

  /** Cell path to the room's door cell (for leaving the room). */
  pathToDoor(roomId: string, agentCell: Cell): Cell[] {
    const grid = this.grids.get(roomId);
    if (!grid) return [];
    return grid.path(agentCell, grid.getDoorCell());
  }

  /** Deterministic spawn cell near the door; re-seats the agent in the grid. */
  enterRoom(agentId: string, fromRoom: string | undefined, toRoom: string): Cell {
    if (fromRoom !== undefined) this.grids.get(fromRoom)?.removeAgent(agentId);
    const grid = this.grids.get(toRoom);
    if (!grid) return { x: 0, y: 0 };
    const door = grid.getDoorCell();
    let cell: Cell = door;
    for (const n of neighbours(door, grid.width, grid.height)) {
      if (!grid.isBlocked(n) && grid.getAgentCellAt(n) === null) {
        cell = n;
        break;
      }
    }
    grid.setAgentCell(agentId, cell);
    return cell;
  }
}
