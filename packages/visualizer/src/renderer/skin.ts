/**
 * renderer/skin.ts — the sprite/skin seam (spec 062, R4).
 * ─────────────────────────────────────────────────────────────────────────
 * All entity DRAWING lives behind the `Skin` interface. The default
 * `CanvasSkin` draws with canvas primitives only (no assets, no external
 * dependency); a future sprite skin can replace it without touching layout,
 * because `layoutWorld` is skin-independent (spec 062, AC-5).
 */

import type { VisualizerAgent, VisualizerObject, VisualizerState } from '@evol-hive/shared';
import { GRID_COLS as COLS, GRID_ROWS as ROWS, objectChipWidth } from './layout.js';
import type { DoorLayout, EntityLayout, Point, Rect, RoomLayout, Viewport } from './layout.js';
import { FOG_CELL_FILL, THEME, PHASE_COLORS, DRIVES, AGENT_COLORS, shade } from './theme.js';
import { formatStateLine, initials, truncate } from './format.js';

type Ctx = CanvasRenderingContext2D;

/** Drawing interface for the world. Implementations must not compute layout. */
export interface Skin {
  drawBackground(ctx: Ctx, viewport: Viewport): void;
  drawRoom(
    ctx: Ctx,
    room: RoomLayout,
    opts: { fogRects: Rect[]; showFog: boolean; scale: number },
  ): void;
  drawCorridor(ctx: Ctx, door: DoorLayout, scale: number): void;
  drawDoorOpening(ctx: Ctx, door: DoorLayout, scale: number): void;
  drawObject(
    ctx: Ctx,
    obj: VisualizerObject,
    at: EntityLayout,
    roomRect: Rect,
    scale: number,
  ): void;
  drawAgent(
    ctx: Ctx,
    agent: VisualizerAgent,
    at: EntityLayout,
    opts: { index: number; scale: number; selected: boolean },
  ): void;
  drawRelationship(ctx: Ctx, from: Point, to: Point, trust: number): void;
  drawStatus(ctx: Ctx, state: VisualizerState, viewport: Viewport): void;
}

/**
 * Filled rounded rectangle built from two crossed rects plus four corner
 * discs. Uses only `fillRect` + `arc` + `fill` so it works with the narrow
 * canvas mock the test suite uses (no `arcTo`/`roundRect` dependency).
 */
function roundRectFill(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  style: string,
): void {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.fillStyle = style;
  if (rad <= 0.5) {
    ctx.fillRect(x, y, w, h);
    return;
  }
  ctx.fillRect(x + rad, y, w - 2 * rad, h);
  ctx.fillRect(x, y + rad, w, h - 2 * rad);
  const corners: [number, number][] = [
    [x + rad, y + rad],
    [x + w - rad, y + rad],
    [x + rad, y + h - rad],
    [x + w - rad, y + h - rad],
  ];
  for (const [cx, cy] of corners) {
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A small abstract type glyph drawn with rects/discs (no emoji, no fonts). */
function drawGlyph(ctx: Ctx, type: string, x: number, y: number, s: number, color: string): void {
  ctx.fillStyle = color;
  if (type === 'appliance') {
    ctx.fillRect(x - s * 0.3, y - s * 0.3, s * 0.5, s * 0.6);
    ctx.beginPath();
    ctx.arc(x + s * 0.3, y, s * 0.17, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === 'fixture') {
    ctx.beginPath();
    ctx.arc(x, y, s * 0.34, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === 'nature') {
    ctx.beginPath();
    ctx.arc(x, y, s * 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = THEME.roomFloor;
    ctx.beginPath();
    ctx.arc(x - s * 0.12, y + s * 0.08, s * 0.14, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === 'conversation') {
    ctx.fillRect(x - s * 0.36, y - s * 0.3, s * 0.72, s * 0.5);
    ctx.fillRect(x - s * 0.1, y + s * 0.18, s * 0.2, s * 0.16);
  } else {
    ctx.fillRect(x - s * 0.34, y - s * 0.2, s * 0.68, s * 0.4);
  }
}

/** The default canvas skin: improved palette/hierarchy, no assets. */
export class CanvasSkin implements Skin {
  drawBackground(ctx: Ctx, viewport: Viewport): void {
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    ctx.fillStyle = THEME.bgHi;
    ctx.fillRect(0, 0, viewport.width, Math.max(0, viewport.insets.top));
  }

  drawRoom(
    ctx: Ctx,
    room: RoomLayout,
    opts: { fogRects: Rect[]; showFog: boolean; scale: number },
  ): void {
    const { x, y, w, h } = room.rect;
    const headerH = Math.max(22, Math.min(h * 0.1, 34));
    // Floor + header band.
    ctx.fillStyle = THEME.roomFloor;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = THEME.roomHeader;
    ctx.fillRect(x, y, w, headerH);
    // Inner cell grid, drawn as 1px fills (keeps `lineTo` free for relationships).
    ctx.fillStyle = THEME.grid;
    for (let i = 1; i < COLS; i++) ctx.fillRect(x + (i * w) / COLS, y, 1, h);
    for (let i = 1; i < ROWS; i++) ctx.fillRect(x, y + (i * h) / ROWS, w, 1);
    // Room name.
    const fs = Math.max(10, Math.min(opts.scale * 13, 17));
    ctx.fillStyle = THEME.text;
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(room.name, 20), x + 10, y + headerH / 2);
    // Fog over unexplored cells (exact fill so spec-039 tests can count it).
    if (opts.showFog) {
      ctx.fillStyle = FOG_CELL_FILL;
      for (const cell of opts.fogRects) ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
    }
    // Border last, so it frames floor/grid/fog.
    ctx.strokeStyle = THEME.roomBorder;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
  }

  drawCorridor(ctx: Ctx, door: DoorLayout, scale: number): void {
    if (door.kind !== 'corridor') return;
    const pts = door.points;
    if (pts.length < 2) return;
    ctx.strokeStyle = THEME.doorBridge;
    ctx.lineWidth = Math.max(8, scale * 10);
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.stroke();
    ctx.strokeStyle = THEME.door;
    ctx.lineWidth = Math.max(2, scale * 3);
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.stroke();
  }

  drawDoorOpening(ctx: Ctx, door: DoorLayout, scale: number): void {
    if (door.kind !== 'opening') return;
    const { x, y, w, h } = door.rect;
    ctx.fillStyle = THEME.doorBridge;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = THEME.door;
    ctx.lineWidth = 2;
    const tick = Math.max(1, scale * 1.5);
    ctx.beginPath();
    if (door.axis === 'v') {
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y);
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + w, y + h);
    } else {
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + h);
      ctx.moveTo(x + w, y);
      ctx.lineTo(x + w, y + h);
    }
    ctx.lineWidth = tick;
    ctx.stroke();
  }

  drawObject(
    ctx: Ctx,
    obj: VisualizerObject,
    at: EntityLayout,
    roomRect: Rect,
    scale: number,
  ): void {
    const chipW = objectChipWidth(roomRect);
    const chipH = Math.max(24, Math.min(chipW * 0.4, 42));
    const headerH = Math.max(22, Math.min(roomRect.h * 0.1, 34));
    const x = Math.max(
      roomRect.x + 6,
      Math.min(at.x - chipW / 2, roomRect.x + roomRect.w - chipW - 6),
    );
    const y = Math.max(
      roomRect.y + headerH + 4,
      Math.min(at.y - chipH / 2, roomRect.y + roomRect.h - chipH - 6),
    );
    const tint = obj.conversation?.sentimentTint ?? THEME.chip;
    ctx.fillStyle = THEME.chipShadow;
    ctx.fillRect(x + 1, y + 2, chipW, chipH);
    roundRectFill(ctx, x, y, chipW, chipH, 9, tint);
    const glyphSize = chipH * 0.6;
    drawGlyph(ctx, obj.type, x + glyphSize * 0.8, y + chipH / 2, glyphSize, THEME.text);
    const fs = Math.max(9, Math.min(scale * 10.5, 12.5));
    const textX = x + glyphSize * 1.25;
    const availPx = Math.max(20, chipW - glyphSize * 1.35 - 6);
    const maxChars = Math.max(4, Math.floor(availPx / (fs * 0.56)));
    ctx.fillStyle = THEME.text;
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(truncate(obj.name, maxChars), textX, y + chipH * 0.16);
    // The state VALUE must survive truncation (issue #105) — formatStateLine
    // clamps by shrinking the KEY, never by dropping the value.
    const line =
      obj.conversation !== undefined
        ? truncate(`topic ${obj.conversation.topic}`, maxChars)
        : firstStateLine(obj.state, availPx);
    if (line !== '') {
      ctx.fillStyle = THEME.muted;
      ctx.font = `${Math.max(8, fs - 1)}px system-ui, sans-serif`;
      ctx.fillText(line, textX, y + chipH * 0.56);
    }
  }

  drawAgent(
    ctx: Ctx,
    agent: VisualizerAgent,
    at: EntityLayout,
    opts: { index: number; scale: number; selected: boolean },
  ): void {
    const r = Math.max(12, Math.min(opts.scale * 17, 22));
    const color = AGENT_COLORS[opts.index % AGENT_COLORS.length] ?? THEME.select;
    if (agent.isThinking) {
      ctx.fillStyle = THEME.thinkHalo;
      ctx.beginPath();
      ctx.arc(at.x, at.y, r + 8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (opts.selected) {
      ctx.strokeStyle = THEME.select;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(at.x, at.y, r + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    // PPER phase ring: faint track + phase arc.
    const phase = PHASE_COLORS[agent.pperPhase] ?? THEME.muted;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r + 3.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = phase;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r + 3.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 1.1);
    ctx.stroke();
    // Avatar.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = shade(color, 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.stroke();
    // Initials.
    ctx.fillStyle = '#08111f';
    ctx.font = `800 ${Math.max(10, Math.min(r * 0.8, 15))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(agent.name), at.x, at.y + 0.5);
    // Name pill.
    const nfs = Math.max(9, Math.min(opts.scale * 10.5, 12.5));
    ctx.font = `600 ${nfs}px system-ui, sans-serif`;
    const pillW = Math.max(nfs * 2.4, agent.name.length * nfs * 0.62 + 14);
    const pillH = nfs + 8;
    const pillY = at.y + r + 7;
    roundRectFill(ctx, at.x - pillW / 2, pillY, pillW, pillH, pillH / 2, THEME.panel);
    ctx.fillStyle = THEME.text;
    ctx.textBaseline = 'middle';
    ctx.fillText(agent.name, at.x, pillY + pillH / 2);
    // Drive bars.
    const bw = r * 2.1;
    const bh = 3;
    const gap = 1.5;
    const by = pillY + pillH + 5;
    DRIVES.forEach((drive, i) => {
      const yy = by + i * (bh + gap);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(at.x - bw / 2, yy, bw, bh);
      const v = Math.max(0, Math.min(100, agent.drives[drive.key])) / 100;
      ctx.fillStyle = drive.color;
      ctx.fillRect(at.x - bw / 2, yy, Math.max(2, bw * v), bh);
    });
  }

  drawRelationship(ctx: Ctx, from: Point, to: Point, trust: number): void {
    const opacity = 0.06 + (Math.max(0, Math.min(100, trust)) / 100) * 0.22;
    ctx.strokeStyle = `rgba(148,197,255,${opacity})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  drawStatus(ctx: Ctx, state: VisualizerState, viewport: Viewport): void {
    const status = state.isRunning ? '▶ running' : '⏸ paused';
    const line = `tick ${state.tickNumber} · ${state.simulationTime.toFixed(1)}s · ${status} · ${state.timeScale}×`;
    ctx.fillStyle = THEME.muted;
    ctx.font = '12px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(line, viewport.width - 12, 10);
  }
}

/** First state entry rendered on a chip, clamped to `maxWidthPx`, or ''. */
function firstStateLine(state: Record<string, unknown>, maxWidthPx: number): string {
  const entry = Object.entries(state)[0];
  if (entry === undefined) return '';
  return formatStateLine(entry[0], entry[1], Math.max(30, maxWidthPx));
}
