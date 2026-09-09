/**
 * Spec 042 — Visualizer Single Renderer (issue #155) — QA coverage.
 * Decision 4 / R1: the legacy slot formula (`roomPos.x + 40 + idx * 60`,
 * `roomPos.y + roomPos.h - 50`) applies ONLY when `agent.position ===
 * undefined`, so pre-grid saves and legacy states keep rendering.
 *
 * Before this file the fallback branch had zero coverage at any level: the
 * grid-cell path was asserted (canvas-renderer-fog.test.ts,
 * served-renderer-integration.test.ts) but every fixture carried a position,
 * so the `position === undefined` ternary arms were never executed.
 *
 * Layout math (canvas 800×600, 2 rooms → cols 2): garden room is 360×500 at
 * (30, 50), workshop room is 360×500 at (410, 50). Legacy slots:
 *   garden agent idx 0 → (30 + 40 + 0×60, 50 + 500 − 50) = (70, 500)
 *   workshop agent idx 1 → (410 + 40 + 1×60, 50 + 500 − 50) = (510, 500)
 * Grid cell for position (11, 4) in the garden:
 *   x = 30 + (11.5 × 360) / 12 = 375 · y = 50 + (4.5 × 500) / 8 = 331.25
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { VisualizerState } from '@evol-hive/shared';
import { CanvasRenderer } from '../src/renderer/canvas-renderer.js';

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
      {
        id: 'garden',
        name: 'Garden',
        description: '',
        connections: ['workshop'],
        objects: [],
      },
      {
        id: 'workshop',
        name: 'Workshop',
        description: '',
        connections: ['garden'],
        objects: [],
      },
    ],
    agents,
  } as unknown as VisualizerState;
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

  it('renders an agent without position at the legacy slot (70, 500)', () => {
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(makeState([makeAgent('a1', 'Alice', 'garden')]));
    // The avatar circle (r=16) and phase ring (r=20) both center on the slot.
    const atSlot = arcsAt().filter((p) => p.x === 70 && p.y === 500);
    expect(atSlot.length).toBeGreaterThanOrEqual(2);
    // And the grid-cell math is NOT applied to a positionless agent.
    const atGrid = arcsAt().filter((p) => p.x === 375 && p.y === 331.25);
    expect(atGrid.length).toBe(0);
  });

  it('mixed state: positioned agent at its grid cell, unpositioned at its own slot', () => {
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(
      makeState([
        makeAgent('a1', 'Alice', 'garden', { x: 11, y: 4 }), // idx 0 → grid cell
        makeAgent('a2', 'Bob', 'workshop'), // idx 1 → workshop legacy slot
      ]),
    );
    const arcs = arcsAt();
    const grid = arcs.filter((p) => Math.abs(p.x - 375) < 0.01 && Math.abs(p.y - 331.25) < 0.01);
    expect(grid.length).toBeGreaterThanOrEqual(2); // Alice: phase ring + avatar
    // Bob: workshop room at (410, 50, 360×500), idx 1 → (410+40+60, 50+500−50).
    const slot = arcs.filter((p) => p.x === 510 && p.y === 500);
    expect(slot.length).toBeGreaterThanOrEqual(2);
  });

  it('an unpositioned agent is never fog-hidden (old saves keep rendering)', () => {
    // The fog-hide branch (spec 039 R8) requires `agent.position !==
    // undefined` — a legacy agent without position always renders, even
    // standing in a cell the fogged viewer never explored.
    const a1 = {
      ...makeAgent('a1', 'Alice', 'garden', { x: 11, y: 4 }),
      fog: { visitedRooms: ['garden'], exploredCells: { garden: ['11,4'] } },
    };
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(makeState([a1, makeAgent('a2', 'Bob', 'workshop')]));
    // Bob stands in the never-explored workshop but has no grid position →
    // the hide branch cannot evaluate him, and he renders at his slot.
    const slot = arcsAt().filter((p) => p.x === 510 && p.y === 500);
    expect(slot.length).toBeGreaterThanOrEqual(2);
    const names = ctx.calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0]));
    expect(names).toContain('Bob');
  });
});
