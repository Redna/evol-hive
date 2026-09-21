/**
 * renderer/canvas-renderer.ts — Canvas 2D renderer for the simulation.
 * ─────────────────────────────────────────────────────────────────────────
 * Orchestration only (spec 062): it reads the pure `layoutWorld` geometry,
 * applies fog visibility, and dispatches every draw call to a `Skin`. All
 * layout math lives in `layout.ts`, all colours in `theme.ts`, all drawing in
 * `skin.ts` — so this file holds no geometry and no colour literals.
 *
 * Backward-compatible surface: `CanvasRenderer`, `FOG_CELL_FILL` and
 * `formatStateLine` are still exported from here (existing imports/tests).
 */

import type { VisualizerState } from '@evol-hive/shared';
import { layoutWorld, unexploredRects, ZERO_INSETS } from './layout.js';
import type { Insets, Point } from './layout.js';
import { transformLayout } from './camera.js';
import type { Camera } from './camera.js';
import { CanvasSkin } from './skin.js';
import type { Skin } from './skin.js';

/** Fog shading fill for unexplored cells (re-exported for spec-039 tests). */
export { FOG_CELL_FILL } from './theme.js';
/** Object state-line formatting (re-exported for issue-#105 tests). */
export { formatStateLine } from './format.js';

/** A canvas-like rendering context (CanvasRenderingContext2D or a mock). */
type RenderContext = CanvasRenderingContext2D;

export interface RenderOptions {
  /** Space the DOM HUD occupies; measured by the client (spec 062, R7). */
  insets?: Insets;
  /**
   * CSS-pixel viewport size. The canvas backing store is DPR-scaled (spec 062,
   * R7) while the 2D context carries a DPR transform, so layout must work in
   * CSS pixels — passing the backing-store size here made phones draw rooms
   * `dpr` times too large and off-screen.
   */
  width?: number;
  height?: number;
  /** Agent selected for the detail card (draws a highlight ring). */
  selectedAgentId?: string;
  /**
   * Fog of war as a VIEW, not a state change (spec 062, R6). Default true.
   * False lifts the shading AND the fog-based entity hiding so the whole world
   * is observable.
   */
  showFog?: boolean;
  /**
   * Smoothed screen positions by agent id (spec 062, R2). The client owns the
   * time dimension; when supplied these override the layout's projected cell
   * centres so agents glide between snapshots instead of teleporting.
   */
  agentPositions?: ReadonlyMap<string, Point>;
  /**
   * View transform over the WORLD layer only (spec 063, R1). The HUD is DOM
   * and the canvas status line is drawn untransformed, so the camera never
   * moves the chrome.
   */
  camera?: Camera;
}

/**
 * Draws the full simulation scene to a `<canvas>` element's 2D context. Each
 * `render()` call clears the canvas and redraws everything from the provided
 * `VisualizerState` — the renderer keeps no scene state of its own.
 */
export class CanvasRenderer {
  private readonly ctx: RenderContext;
  private readonly skin: Skin;

  constructor(ctx: RenderContext, skin?: Skin) {
    this.ctx = ctx;
    this.skin = skin ?? new CanvasSkin();
  }

  /** Render the full scene from a `VisualizerState` snapshot. */
  render(state: VisualizerState, options: RenderOptions = {}): void {
    const ctx = this.ctx;
    // Read dimensions from the canvas each frame — never cache them at
    // construction (spec 062: the old constructor capture went stale on
    // resize/rotation). Tests pass a mock with a `canvas` object.
    const canvas = (ctx as unknown as { canvas?: { width?: number; height?: number } }).canvas;
    const width = options.width ?? canvas?.width ?? 800;
    const height = options.height ?? canvas?.height ?? 600;
    const viewport = { width, height, insets: options.insets ?? ZERO_INSETS };
    const baseLayout = layoutWorld(state, viewport);
    const scale = Math.max(0.72, Math.min(baseLayout.size / 300, 1.5));

    if (options.agentPositions !== undefined) {
      for (const at of baseLayout.agents) {
        const override = options.agentPositions.get(at.id);
        if (override !== undefined) {
          at.x = override.x;
          at.y = override.y;
        }
      }
    }
    const layout =
      options.camera !== undefined ? transformLayout(baseLayout, options.camera) : baseLayout;

    this.skin.drawBackground(ctx, viewport);

    // Corridors are drawn BEFORE rooms so any segment crossing a room interior
    // is painted over and only the gutter portion remains visible (R1).
    for (const door of layout.doors) {
      if (door.kind === 'corridor') this.skin.drawCorridor(ctx, door, scale);
    }

    const viewer = state.agents.find((a) => a.fog !== undefined) ?? null;
    const fogOn = options.showFog ?? true;
    const fogActive = fogOn && viewer?.fog !== undefined;
    for (const room of layout.rooms) {
      const fogRects = fogActive
        ? unexploredRects(room.rect, new Set(viewer?.fog?.exploredCells[room.roomId] ?? []))
        : [];
      this.skin.drawRoom(ctx, room, { fogRects, showFog: fogActive, scale });
    }

    for (const door of layout.doors) {
      if (door.kind === 'opening') this.skin.drawDoorOpening(ctx, door, scale);
    }

    const roomById = new Map(layout.rooms.map((r) => [r.roomId, r]));
    for (const at of layout.objects) {
      if (!fogOn && at.visible === false) {
        // Fog off is a view override: draw everything (spec 062, R6).
      } else if (!at.visible) {
        continue;
      }
      const room = state.rooms.find((r) => r.id === at.roomId);
      const obj = room?.objects.find((o) => o.id === at.id);
      const rl = roomById.get(at.roomId);
      if (obj === undefined || rl === undefined) continue;
      this.skin.drawObject(ctx, obj, at, rl.rect, scale);
    }

    const positions = new Map<string, Point>();
    state.agents.forEach((agent, index) => {
      const at = layout.agents.find((e) => e.id === agent.agentId);
      if (at === undefined) return;
      positions.set(agent.agentId, { x: at.x, y: at.y });
      if (at.visible === false && fogOn) return;
      this.skin.drawAgent(ctx, agent, at, {
        index,
        scale,
        selected: options.selectedAgentId === agent.agentId,
      });
    });

    for (const agent of state.agents) {
      const from = positions.get(agent.agentId);
      if (from === undefined) continue;
      for (const rel of agent.relationships) {
        const to = positions.get(rel.agentId);
        if (to === undefined) continue;
        this.skin.drawRelationship(ctx, from, to, rel.trust);
      }
    }

    this.skin.drawStatus(ctx, state, viewport);
  }
}
