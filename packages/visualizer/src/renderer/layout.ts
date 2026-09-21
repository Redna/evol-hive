/**
 * renderer/layout.ts — the pure world-layout seam (spec 062, R1).
 * ─────────────────────────────────────────────────────────────────────────
 * `layoutWorld(state, viewport)` turns a `VisualizerState` snapshot into pure
 * geometry: room rectangles, door openings/corridors, projected object and
 * agent positions, and the viewport they must fit inside. It is **pure and
 * synchronous** — no canvas, no DOM, no clock, no I/O — so every topology,
 * door, sizing and safe-area rule is testable as plain data (spec 062,
 * Decision 2).
 *
 * Key behaviours (spec 062):
 *  - Column count is chosen to keep CONNECTED rooms edge-adjacent (topology
 *    score), breaking ties on room size. The old renderer used array insertion
 *    order, which put coffee-shop's `kitchen↔garden` and
 *    `living_room↔bathroom` on the diagonal — the "giant X".
 *  - Adjacent connections become wall openings; non-adjacent ones become
 *    corridor polylines routed through the empty gutters, so no door geometry
 *    can cross a room interior.
 *  - Rooms never exceed the cell the viewport allows, and stay inside
 *    `viewport.insets` (the measured HUD), so nothing hides behind the chrome.
 */

import type { VisualizerRoom, VisualizerState } from '@evol-hive/shared';

/** Grid dimensions per room — must match the engine's RoomGrid (spec 038). */
export const GRID_COLS = 12;
export const GRID_ROWS = 8;

/** Room aspect clamp: rooms may be modestly taller than wide, never extreme. */
const MAX_ASPECT = 1.4;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Space the HUD occupies, measured from the DOM by the client (spec 062, R7). */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Viewport {
  width: number;
  height: number;
  insets: Insets;
}

export const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

export interface RoomLayout {
  roomId: string;
  name: string;
  rect: Rect;
  col: number;
  row: number;
}

export interface EntityLayout {
  id: string;
  roomId: string;
  x: number;
  y: number;
  /** False when the fog viewer has never explored the entity's cell (R6). */
  visible: boolean;
}

export type DoorLayout =
  | { kind: 'opening'; fromRoom: string; toRoom: string; rect: Rect; axis: 'h' | 'v' }
  | { kind: 'corridor'; fromRoom: string; toRoom: string; points: Point[] };

export interface WorldLayout {
  viewport: Viewport;
  columns: number;
  rows: number;
  gutter: number;
  /** Smallest room side — the renderer's scale reference. */
  size: number;
  rooms: RoomLayout[];
  doors: DoorLayout[];
  objects: EntityLayout[];
  agents: EntityLayout[];
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** Top-left cell of a room's grid cell, in pixels. */
export function cellCenter(rect: Rect, cell: Point): Point {
  return {
    x: rect.x + ((cell.x + 0.5) * rect.w) / GRID_COLS,
    y: rect.y + ((cell.y + 0.5) * rect.h) / GRID_ROWS,
  };
}

/** Legacy slot for an agent with no grid position (pre-grid saves). */
export function legacySlot(rect: Rect, index: number): Point {
  return { x: rect.x + 40 + index * 60, y: rect.y + rect.h - 50 };
}

/**
 * Chip width for an object in a room. Shared by the layout (to space legacy
 * slots) and the skin (to draw the chip) so cell-less objects cannot overlap.
 */
export function objectChipWidth(rect: Rect): number {
  return Math.max(56, Math.min(rect.w * 0.3, 120));
}

/**
 * Legacy chip-grid slot for an object with no grid anchor (spec 038 legacy
 * path). The demo's adapter is constructed without a `navigation` grid, so
 * every object arrives cell-less; without this they would all stack at one
 * point and only the topmost chip would be visible.
 */
export function legacyObjectSlot(rect: Rect, index: number): Point {
  const headerH = Math.max(22, Math.min(rect.h * 0.1, 34));
  const chipW = objectChipWidth(rect);
  const chipH = Math.max(24, Math.min(chipW * 0.4, 42));
  const cols = Math.max(1, Math.min(3, Math.floor(rect.w / (chipW + 8))));
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: rect.x + 8 + chipW / 2 + col * (chipW + 8),
    y: rect.y + headerH + 10 + chipH / 2 + row * (chipH + 8),
  };
}

/**
 * Frame-rate-independent exponential approach (spec 062, R2). `halfLifeSeconds`
 * is the time to close half the remaining distance; equal elapsed time gives
 * equal results regardless of how `dtSeconds` is partitioned.
 */
export function smoothTowards(
  current: number,
  target: number,
  dtSeconds: number,
  halfLifeSeconds: number,
): number {
  if (halfLifeSeconds <= 0) return target;
  const k = 1 - Math.pow(0.5, dtSeconds / halfLifeSeconds);
  return current + (target - current) * k;
}

interface GridPos {
  col: number;
  row: number;
}

/**
 * Place rooms on a `cols × rows` grid by walking the connection graph
 * breadth-first from the highest-degree room, so connected rooms land in
 * adjacent cells where the grid allows (deterministic: neighbour order, then
 * first free cell in row-major order).
 */
export function placeRooms(
  rooms: readonly VisualizerRoom[],
  cols: number,
  rows: number,
): Map<string, GridPos> {
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const degree = (r: VisualizerRoom): number => r.connections.filter((c) => byId.has(c)).length;
  const start = [...rooms].sort((a, b) => degree(b) - degree(a))[0];
  const pos = new Map<string, GridPos>();
  if (start === undefined) return pos;

  pos.set(start.id, { col: 0, row: 0 });
  const used = new Set<string>(['0,0']);
  const queue: string[] = [start.id];
  const dirs: [number, number][] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  let guard = 0;
  const maxSteps = rooms.length * rooms.length * 4 + 16;

  while (queue.length > 0 && guard++ < maxSteps) {
    const id = queue.shift();
    if (id === undefined) break;
    const p = pos.get(id);
    const room = byId.get(id);
    if (p === undefined || room === undefined) continue;
    for (const nb of room.connections) {
      if (!byId.has(nb) || pos.has(nb)) continue;
      let placed = false;
      for (const [dc, dr] of dirs) {
        const col = p.col + dc;
        const row = p.row + dr;
        if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
        if (used.has(`${col},${row}`)) continue;
        pos.set(nb, { col, row });
        used.add(`${col},${row}`);
        queue.push(nb);
        placed = true;
        break;
      }
      if (!placed) queue.push(nb); // retry from another parent later
    }
  }

  // Any rooms the BFS could not reach (disconnected scenes) → first free cell.
  for (const room of rooms) {
    if (pos.has(room.id)) continue;
    for (let row = 0; row < rows; row++) {
      let done = false;
      for (let col = 0; col < cols; col++) {
        if (used.has(`${col},${row}`)) continue;
        pos.set(room.id, { col, row });
        used.add(`${col},${row}`);
        done = true;
        break;
      }
      if (done) break;
    }
  }
  return pos;
}

/** How many connections land on edge-adjacent cells (higher = clearer map). */
export function adjacencyScore(
  rooms: readonly VisualizerRoom[],
  pos: ReadonlyMap<string, GridPos>,
): number {
  const seen = new Set<string>();
  let adj = 0;
  for (const room of rooms) {
    const a = pos.get(room.id);
    if (a === undefined) continue;
    for (const cid of room.connections) {
      const b = pos.get(cid);
      if (b === undefined) continue;
      const key = [room.id, cid].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      if (Math.abs(a.col - b.col) + Math.abs(a.row - b.row) === 1) adj++;
    }
  }
  return adj;
}

interface GridMetrics {
  ox: number;
  oy: number;
  gx: number;
  gy: number;
  gutter: number;
}

/** Nearest point on a room's perimeter to an outside point (kept off corners). */
function edgePoint(rect: Rect, p: Point): Point {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  if (Math.abs(dx) * rect.h > Math.abs(dy) * rect.w) {
    return {
      x: dx > 0 ? rect.x + rect.w : rect.x,
      y: clamp(p.y, rect.y + rect.h * 0.22, rect.y + rect.h * 0.78),
    };
  }
  return {
    x: clamp(p.x, rect.x + rect.w * 0.22, rect.x + rect.w * 0.78),
    y: dy > 0 ? rect.y + rect.h : rect.y,
  };
}

/** The wall opening between two edge-adjacent rooms, or null when diagonal. */
function wallGap(a: RoomLayout, b: RoomLayout): { rect: Rect; axis: 'h' | 'v' } | null {
  const vert = Math.abs(a.col - b.col) === 1 && a.row === b.row;
  const horiz = Math.abs(a.row - b.row) === 1 && a.col === b.col;
  if (vert) {
    const left = a.col < b.col ? a : b;
    const right = a.col < b.col ? b : a;
    const x = left.rect.x + left.rect.w;
    const w = right.rect.x - x;
    const yTop = Math.max(a.rect.y, b.rect.y);
    const yBot = Math.min(a.rect.y + a.rect.h, b.rect.y + b.rect.h);
    const len = Math.min((yBot - yTop) * 0.34, 54);
    const cy = (yTop + yBot) / 2;
    return { rect: { x, y: cy - len / 2, w, h: len }, axis: 'v' };
  }
  if (horiz) {
    const top = a.row < b.row ? a : b;
    const bot = a.row < b.row ? b : a;
    const y = top.rect.y + top.rect.h;
    const h = bot.rect.y - y;
    const xL = Math.max(a.rect.x, b.rect.x);
    const xR = Math.min(a.rect.x + a.rect.w, b.rect.x + b.rect.w);
    const len = Math.min((xR - xL) * 0.34, 54);
    const cx = (xL + xR) / 2;
    return { rect: { x: cx - len / 2, y, w: len, h }, axis: 'h' };
  }
  return null;
}

/** Centre of the gutter cross between two diagonally-placed rooms. */
function crossingPoint(a: RoomLayout, b: RoomLayout, m: GridMetrics): Point {
  const col = Math.min(a.col, b.col);
  const row = Math.min(a.row, b.row);
  return {
    x: m.ox + (col + 1) * m.gx - m.gutter / 2,
    y: m.oy + (row + 1) * m.gy - m.gutter / 2,
  };
}

function corridorPoints(a: RoomLayout, b: RoomLayout, m: GridMetrics): Point[] {
  const mid = crossingPoint(a, b, m);
  const from = edgePoint(a.rect, mid);
  const to = edgePoint(b.rect, mid);
  return [from, mid, to];
}

/** Resolve every connection into door geometry (openings + corridors). */
export function resolveDoors(
  rooms: readonly VisualizerRoom[],
  roomById: ReadonlyMap<string, RoomLayout>,
  metrics: GridMetrics,
): DoorLayout[] {
  const seen = new Set<string>();
  const doors: DoorLayout[] = [];
  for (const room of rooms) {
    const a = roomById.get(room.id);
    if (a === undefined) continue;
    for (const cid of room.connections) {
      const b = roomById.get(cid);
      if (b === undefined) continue;
      const key = [room.id, cid].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const gap = wallGap(a, b);
      if (gap !== null) {
        doors.push({
          kind: 'opening',
          fromRoom: room.id,
          toRoom: cid,
          rect: gap.rect,
          axis: gap.axis,
        });
      } else {
        doors.push({
          kind: 'corridor',
          fromRoom: room.id,
          toRoom: cid,
          points: corridorPoints(a, b, metrics),
        });
      }
    }
  }
  return doors;
}

/** Rect per unexplored cell of a room (spec 039 R8), for the fog pass. */
export function unexploredRects(rect: Rect, explored: ReadonlySet<string>): Rect[] {
  const out: Rect[] = [];
  const cw = rect.w / GRID_COLS;
  const ch = rect.h / GRID_ROWS;
  for (let y = 0; y < GRID_ROWS; y++) {
    for (let x = 0; x < GRID_COLS; x++) {
      if (explored.has(`${x},${y}`)) continue;
      out.push({ x: rect.x + x * cw, y: rect.y + y * ch, w: cw, h: ch });
    }
  }
  return out;
}

/** Compute the full world layout for a snapshot and viewport. */
export function layoutWorld(state: VisualizerState, viewport: Viewport): WorldLayout {
  const n = Math.max(state.rooms.length, 1);
  const insets = viewport.insets;
  const availW = Math.max(viewport.width - insets.left - insets.right, 0);
  const availH = Math.max(viewport.height - insets.top - insets.bottom, 0);
  const gutter = clamp(Math.min(availW, availH) * 0.03, 6, 20);

  let best: {
    cols: number;
    rows: number;
    cw: number;
    ch: number;
    size: number;
    adj: number;
    pos: Map<string, GridPos>;
  } | null = null;

  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (availW - gutter * (cols - 1)) / cols;
    const ch = (availH - gutter * (rows - 1)) / rows;
    const size = Math.min(cw, ch);
    if (size <= 8) continue;
    const pos = placeRooms(state.rooms, cols, rows);
    const adj = adjacencyScore(state.rooms, pos);
    if (best === null || adj > best.adj || (adj === best.adj && size > best.size + 0.5)) {
      best = { cols, rows, cw, ch, size, adj, pos };
    }
  }
  if (best === null) {
    best = {
      cols: 1,
      rows: n,
      cw: availW,
      ch: availH,
      size: Math.max(availW, 40),
      adj: 0,
      pos: placeRooms(state.rooms, 1, n),
    };
  }

  // Rooms may be modestly non-square, but never exceed the allowed cell.
  const roomH = Math.min(best.ch, best.cw * MAX_ASPECT);
  const roomW = Math.min(best.cw, roomH * MAX_ASPECT);
  const gx = roomW + gutter;
  const gy = roomH + gutter;
  const totalW = roomW * best.cols + gutter * (best.cols - 1);
  const totalH = roomH * best.rows + gutter * (best.rows - 1);
  const ox = insets.left + (availW - totalW) / 2;
  const oy = insets.top + (availH - totalH) / 2;

  const rooms: RoomLayout[] = state.rooms.map((r) => {
    const p = best.pos.get(r.id) ?? { col: 0, row: 0 };
    return {
      roomId: r.id,
      name: r.name,
      col: p.col,
      row: p.row,
      rect: { x: ox + p.col * gx, y: oy + p.row * gy, w: roomW, h: roomH },
    };
  });
  const roomById = new Map(rooms.map((r) => [r.roomId, r]));
  const doors = resolveDoors(state.rooms, roomById, { ox, oy, gx, gy, gutter });

  const viewer = state.agents.find((a) => a.fog !== undefined) ?? null;
  const fogActive = viewer?.fog !== undefined;

  const objects: EntityLayout[] = [];
  for (const room of state.rooms) {
    const rl = roomById.get(room.id);
    if (rl === undefined) continue;
    const explored = fogActive ? viewer?.fog?.exploredCells[room.id] : undefined;
    room.objects.forEach((obj, index) => {
      if (obj.type === 'doorway') return; // doors are geometry, not chips (R3)
      const cell = obj.cell;
      const at = cell !== undefined ? cellCenter(rl.rect, cell) : legacyObjectSlot(rl.rect, index);
      // Cell-less objects are legacy and always render (spec 039 R8).
      const visible =
        !fogActive || cell === undefined || explored?.includes(`${cell.x},${cell.y}`) === true;
      objects.push({ id: obj.id, roomId: room.id, x: at.x, y: at.y, visible });
    });
  }

  const agents: EntityLayout[] = [];
  state.agents.forEach((a, index) => {
    const rl = roomById.get(a.location);
    if (rl === undefined) return;
    const at =
      a.position !== undefined ? cellCenter(rl.rect, a.position) : legacySlot(rl.rect, index);
    const explored = fogActive ? viewer?.fog?.exploredCells[a.location] : undefined;
    const visible =
      !fogActive ||
      a === viewer ||
      a.position === undefined ||
      explored?.includes(`${a.position.x},${a.position.y}`) === true;
    agents.push({ id: a.agentId, roomId: a.location, x: at.x, y: at.y, visible });
  });

  return {
    viewport,
    columns: best.cols,
    rows: best.rows,
    gutter,
    size: Math.min(roomW, roomH),
    rooms,
    doors,
    objects,
    agents,
  };
}
