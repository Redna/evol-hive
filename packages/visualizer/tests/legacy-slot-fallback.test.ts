/**
 * Spec 042 — Visualizer Single Renderer (issue #155) — QA coverage.
 * Decision 4 / R1: the legacy slot formula applies ONLY when
 * `agent.position === undefined`, so pre-grid saves and legacy states keep
 * rendering.
 *
 * Spec 062 replaced the old insertion-order layout, so the absolute worked
 * examples moved. The BEHAVIOUR under test is unchanged and is asserted
 * against the pure `layoutWorld` seam (spec 062, Decision 2) rather than
 * hardcoded old coordinates:
 *   - a positioned agent draws at its grid cell (`cellCenter`), never a slot;
 *   - an unpositioned agent draws at its legacy slot (`legacySlot`);
 *   - a positionless agent is never fog-hidden.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { VisualizerState } from '@evol-hive/shared';
import { CanvasRenderer } from '../src/renderer/canvas-renderer.js';
import { layoutWorld, cellCenter, legacySlot, ZERO_INSETS } from '../src/renderer/layout.js';

interface RecordedCall {
  method: string;
  args: unknown[];
}

/** Minimal CanvasRenderingContext2D mock that records every draw call. */
class MockContext {
  readonly calls: RecordedCall[] = [];
  canvas: { width: number; height: number } = { width: 800, height: 600 };

  private _fillStyle = '#000';
  private _strokeStyle = '#000';
  lineWidth = 1;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';

  get fillStyle(): string {
    return this._fillStyle;
  }
  set fillStyle(value: string) {
    this._fillStyle = value;
    this.calls.push({ method: 'fillStyle', args: [value] });
  }
  get strokeStyle(): string {
    return this._strokeStyle;
  }
  set strokeStyle(value: string) {
    this._strokeStyle = value;
    this.calls.push({ method: 'strokeStyle', args: [value] });
  }

  beginPath(): void {
    this.calls.push({ method: 'beginPath', args: [] });
  }
  moveTo(x: number, y: number): void {
    this.calls.push({ method: 'moveTo', args: [x, y] });
  }
  lineTo(x: number, y: number): void {
    this.calls.push({ method: 'lineTo', args: [x, y] });
  }
  arc(x: number, y: number, r: number, s: number, e: number): void {
    this.calls.push({ method: 'arc', args: [x, y, r, s, e] });
  }
  fill(): void {
    this.calls.push({ method: 'fill', args: [] });
  }
  stroke(): void {
    this.calls.push({ method: 'stroke', args: [] });
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.calls.push({ method: 'fillRect', args: [x, y, w, h] });
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.calls.push({ method: 'strokeRect', args: [x, y, w, h] });
  }
  fillText(text: string, x: number, y: number): void {
    this.calls.push({ method: 'fillText', args: [text, x, y] });
  }
  save(): void {
    this.calls.push({ method: 'save', args: [] });
  }
  restore(): void {
    this.calls.push({ method: 'restore', args: [] });
  }
}

function makeAgent(
  agentId: string,
  name: string,
  location: string,
  position?: { x: number; y: number },
): Record<string, unknown> {
  return {
    agentId,
    name,
    location,
    ...(position !== undefined ? { position } : {}),
    drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    currentGoal: '',
    currentPlan: null,
    pperPhase: 'perceive',
    isThinking: false,
    relationships: [],
  };
}

function makeState(agents: Record<string, unknown>[]): VisualizerState {
  return {
    tickNumber: 1,
    simulationTime: 1,
    isRunning: false,
    timeScale: 1,
    rooms: [
      { id: 'garden', name: 'Garden', description: '', connections: ['workshop'], objects: [] },
      { id: 'workshop', name: 'Workshop', description: '', connections: ['garden'], objects: [] },
    ],
    agents,
  } as unknown as VisualizerState;
}

const VIEWPORT = { width: 800, height: 600, insets: ZERO_INSETS };

function roomRect(state: VisualizerState, roomId: string) {
  const layout = layoutWorld(state, VIEWPORT);
  const room = layout.rooms.find((r) => r.roomId === roomId);
  if (room === undefined) throw new Error(`no room ${roomId}`);
  return room.rect;
}

let ctx: MockContext;

describe('CanvasRenderer legacy-slot fallback — position === undefined (spec 042, Decision 4 / R1)', () => {
  beforeEach(() => {
    ctx = new MockContext();
  });

  function arcsAt(): { x: number; y: number }[] {
    return ctx.calls
      .filter((c) => c.method === 'arc')
      .map((c) => ({ x: Number(c.args[0]), y: Number(c.args[1]) }));
  }

  function near(actual: { x: number; y: number }[], target: { x: number; y: number }) {
    return actual.filter((p) => Math.abs(p.x - target.x) < 0.01 && Math.abs(p.y - target.y) < 0.01);
  }

  it('renders an agent without position at the legacy slot, not its grid cell', () => {
    const state = makeState([makeAgent('a1', 'Alice', 'garden')]);
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(state);
    const rect = roomRect(state, 'garden');
    const slot = legacySlot(rect, 0);
    expect(near(arcsAt(), slot).length).toBeGreaterThanOrEqual(2); // ring + avatar
    // The grid-cell path was NOT taken for a positionless agent.
    expect(near(arcsAt(), cellCenter(rect, { x: 11, y: 4 })).length).toBe(0);
  });

  it('mixed state: positioned agent at its grid cell, unpositioned at its own slot', () => {
    const state = makeState([
      makeAgent('a1', 'Alice', 'garden', { x: 11, y: 4 }), // idx 0 → grid cell
      makeAgent('a2', 'Bob', 'workshop'), // idx 1 → workshop legacy slot
    ]);
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(state);
    const garden = roomRect(state, 'garden');
    const workshop = roomRect(state, 'workshop');
    expect(near(arcsAt(), cellCenter(garden, { x: 11, y: 4 })).length).toBeGreaterThanOrEqual(2);
    expect(near(arcsAt(), legacySlot(workshop, 1)).length).toBeGreaterThanOrEqual(2);
  });

  it('an unpositioned agent is never fog-hidden (old saves keep rendering)', () => {
    // The fog-hide branch (spec 039 R8) requires `agent.position !== undefined`
    // — a legacy agent without position always renders, even standing in a cell
    // the fogged viewer never explored.
    const a1 = {
      ...makeAgent('a1', 'Alice', 'garden', { x: 11, y: 4 }),
      fog: { visitedRooms: ['garden'], exploredCells: { garden: ['11,4'] } },
    };
    const state = makeState([a1, makeAgent('a2', 'Bob', 'workshop')]);
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(state);
    const workshop = roomRect(state, 'workshop');
    expect(near(arcsAt(), legacySlot(workshop, 1)).length).toBeGreaterThanOrEqual(2);
    const names = ctx.calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0]));
    expect(names).toContain('Bob');
  });
});
