/**
 * renderer/ — Canvas 2D renderer for the simulation (spec 023, Req 12)
 * ─────────────────────────────────────────────────────────────────────
 * Draws rooms (labeled rectangles), objects (icons + state text), agents
 * (avatars with name labels, drive bars, PPER phase rings, thought bubbles),
 * and relationship lines. Uses only the Canvas 2D API — no external
 * dependencies.
 */

import type { VisualizerState, VisualizerAgent } from '@evol-hive/shared';

/** PPER phase → ring color (spec 023, Req 12). */
const PHASE_COLORS: Record<string, string> = {
  perceive: '#4a90d9', // blue
  plan: '#f1c40f', // yellow
  execute: '#e67e22', // orange
  reflect: '#9b59b6', // purple
};

/** Drive keys in canonical order, with display labels and colors. */
const DRIVES: { key: keyof VisualizerAgent['drives']; label: string; color: string }[] = [
  { key: 'energy', label: 'E', color: '#e74c3c' },
  { key: 'hunger', label: 'H', color: '#e67e22' },
  { key: 'social', label: 'S', color: '#3498db' },
  { key: 'comfort', label: 'C', color: '#2ecc71' },
  { key: 'curiosity', label: 'B', color: '#9b59b6' },
];

/** A canvas-like rendering context (CanvasRenderingContext2D or a mock). */
type RenderContext = CanvasRenderingContext2D;

/**
 * Draws the full simulation scene to a `<canvas>` element's 2D context
 * (spec 023, Req 12). The renderer is stateless — each `render()` call clears
 * the canvas and redraws everything from the provided `VisualizerState`.
 */
export class CanvasRenderer {
  private readonly ctx: RenderContext;
  private readonly canvasWidth: number;
  private readonly canvasHeight: number;

  constructor(ctx: RenderContext) {
    this.ctx = ctx;
    // Read dimensions from the canvas if available (tests pass a mock).
    const canvas = (ctx as unknown as { canvas?: { width?: number; height?: number } }).canvas;
    this.canvasWidth = canvas?.width ?? 800;
    this.canvasHeight = canvas?.height ?? 600;
  }

  /** Render the full scene from a `VisualizerState` snapshot. */
  render(state: VisualizerState): void {
    const ctx = this.ctx;
    // Clear canvas with a dark background.
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);

    // Layout: position rooms in a grid.
    const roomLayout = this.layoutRooms(state.rooms);

    // (1) Draw rooms.
    for (const room of state.rooms) {
      const pos = roomLayout.get(room.id);
      if (!pos) continue;
      this.drawRoom(room, pos.x, pos.y, pos.w, pos.h);
    }

    // (2) Draw connection lines between rooms (doors).
    ctx.strokeStyle = '#444466';
    ctx.lineWidth = 2;
    for (const room of state.rooms) {
      const from = roomLayout.get(room.id);
      if (!from) continue;
      for (const connId of room.connections) {
        const to = roomLayout.get(connId);
        if (!to) continue;
        ctx.beginPath();
        ctx.moveTo(from.x + from.w / 2, from.y + from.h / 2);
        ctx.lineTo(to.x + to.w / 2, to.y + to.h / 2);
        ctx.stroke();
      }
    }

    // (3) Draw objects within rooms.
    for (const room of state.rooms) {
      const pos = roomLayout.get(room.id);
      if (!pos) continue;
      this.drawObjects(room.objects, pos.x, pos.y);
    }

    // (4) Draw agents within their rooms.
    const agentPositions = new Map<string, { x: number; y: number }>();
    for (const agent of state.agents) {
      const roomPos = roomLayout.get(agent.location);
      if (!roomPos) continue;
      const idx = state.agents.indexOf(agent);
      const ax = roomPos.x + 40 + idx * 60;
      const ay = roomPos.y + roomPos.h - 50;
      agentPositions.set(agent.agentId, { x: ax, y: ay });
      this.drawAgent(agent, ax, ay);
    }

    // (5) Draw relationship lines between agents.
    this.drawRelationships(state, agentPositions);

    // (6) Draw the status overlay (tick, running, speed).
    this.drawStatus(state);
  }

  /** Position rooms in a simple grid layout. */
  private layoutRooms(
    rooms: VisualizerState['rooms'],
  ): Map<string, { x: number; y: number; w: number; h: number }> {
    const layout = new Map<string, { x: number; y: number; w: number; h: number }>();
    const cols = Math.ceil(Math.sqrt(rooms.length));
    const cellW = Math.floor((this.canvasWidth - 40) / Math.max(cols, 1));
    const cellH = Math.floor(
      (this.canvasHeight - 80) / Math.max(Math.ceil(rooms.length / cols), 1),
    );
    const roomW = Math.max(cellW - 20, 200);
    const roomH = Math.max(cellH - 20, 150);
    rooms.forEach((room, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      layout.set(room.id, {
        x: 20 + col * cellW + 10,
        y: 40 + row * cellH + 10,
        w: roomW,
        h: roomH,
      });
    });
    return layout;
  }

  /** Draw a room as a labeled rectangle (spec 023, Req 12 — layer 1). */
  private drawRoom(
    room: VisualizerState['rooms'][number],
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#16213e';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#0f3460';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    // Room name label.
    ctx.fillStyle = '#e0e0e0';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(room.name, x + 8, y + 6);
  }

  /** Draw objects as icons with state text (spec 023, Req 12 — layer 2). */
  private drawObjects(
    objects: VisualizerState['rooms'][number]['objects'],
    roomX: number,
    roomY: number,
  ): void {
    const ctx = this.ctx;
    objects.forEach((obj, i) => {
      const ox = roomX + 12 + (i % 3) * 70;
      const oy = roomY + 30 + Math.floor(i / 3) * 50;
      // Icon background.
      ctx.fillStyle = '#2a2a4a';
      ctx.fillRect(ox, oy, 60, 30);
      // Object name.
      ctx.fillStyle = '#c0c0d0';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(obj.name.slice(0, 8), ox + 2, oy + 2);
      // State text — first key/value pair.
      const stateEntries = Object.entries(obj.state);
      if (stateEntries.length > 0) {
        const [key, val] = stateEntries[0]!;
        ctx.fillText(`${key}: ${val}`, ox + 2, oy + 16);
      }
    });
  }

  /** Draw an agent avatar with name, drive bars, and PPER phase ring (spec 023, Req 12 — layer 3). */
  private drawAgent(agent: VisualizerAgent, x: number, y: number): void {
    const ctx = this.ctx;
    const radius = 16;

    // PPER phase indicator ring.
    const phaseColor = PHASE_COLORS[agent.pperPhase] ?? '#888888';
    ctx.strokeStyle = phaseColor;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
    ctx.stroke();

    // Avatar circle.
    ctx.fillStyle = agent.isThinking ? '#555577' : '#3498db';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

    // Initials.
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.initials(agent.name), x, y);

    // Name label.
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(agent.name, x, y + radius + 6);

    // Drive bars (five horizontal bars below the avatar).
    const barX = x - radius;
    const barW = radius * 2;
    const barH = 4;
    DRIVES.forEach((drive, i) => {
      const by = y + radius + 22 + i * (barH + 2);
      const value = agent.drives[drive.key];
      // Background bar.
      ctx.fillStyle = '#333355';
      ctx.fillRect(barX, by, barW, barH);
      // Filled portion (value 0–100).
      ctx.fillStyle = drive.color;
      ctx.fillRect(barX, by, (barW * Math.max(0, Math.min(100, value))) / 100, barH);
    });

    // Thought bubble — current plan description.
    if (agent.currentPlan) {
      ctx.fillStyle = '#888899';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const text = agent.currentPlan.description.slice(0, 24);
      ctx.fillText(`💭 ${text}`, x, y + radius + 50);
    }
  }

  /** Draw relationship lines between agents (spec 023, Req 12 — layer 4). */
  private drawRelationships(
    state: VisualizerState,
    positions: Map<string, { x: number; y: number }>,
  ): void {
    const ctx = this.ctx;
    for (const agent of state.agents) {
      const from = positions.get(agent.agentId);
      if (!from) continue;
      for (const rel of agent.relationships) {
        const to = positions.get(rel.agentId);
        if (!to) continue;
        // Trust-based opacity (0–100 → 0.1–0.7).
        const opacity = 0.1 + (Math.max(0, Math.min(100, rel.trust)) / 100) * 0.6;
        ctx.strokeStyle = `rgba(255, 255, 255, ${opacity})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
    }
  }

  /** Draw a status overlay with tick/time/running info. */
  private drawStatus(state: VisualizerState): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '12px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    const status = state.isRunning ? '▶ running' : '⏸ paused';
    ctx.fillText(
      `tick ${state.tickNumber} · ${state.simulationTime.toFixed(1)}s · ${status} · ${state.timeScale}×`,
      this.canvasWidth - 12,
      8,
    );
  }

  /** Extract up to two initials from a name. */
  private initials(name: string): string {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
}
