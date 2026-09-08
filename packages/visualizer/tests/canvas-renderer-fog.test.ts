/**
 * Spec 039 — Visualizer fog shading (spec 038 AC-5 remainder, R8).
 *
 * Unexplored cells render with fog shading; objects/agents outside the
 * viewed agent's fog do not render for that viewer. Explored cells render
 * normally.
 *
 * AC coverage: AC-7 (R8).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { VisualizerState } from '@evol-hive/shared';
import { CanvasRenderer, FOG_CELL_FILL } from '../src/renderer/canvas-renderer.js';

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

/** The fillStyle in effect at each fillRect call (renderer sets it first). */
function fillRectsWithFill(ctx: MockContext): { fill: string; args: unknown[] }[] {
  const out: { fill: string; args: unknown[] }[] = [];
  let current = '';
  for (const call of ctx.calls) {
    if (call.method === 'fillStyle') current = String(call.args[0]);
    else if (call.method === 'fillRect') out.push({ fill: current, args: call.args });
  }
  return out;
}

function makeState(fog?: {
  visitedRooms: string[];
  exploredCells: Record<string, string[]>;
}): VisualizerState {
  return {
    tickNumber: 1,
    simulationTime: 1,
    isRunning: false,
    timeScale: 1,
    rooms: [
      {
        id: 'garden',
        name: 'Garden',
        connections: ['workshop'],
        objects: [
          {
            id: 'planter-1',
            name: 'Planter',
            type: 'nature',
            state: { soil: 'wet' },
            cell: { x: 2, y: 2 }, // near the spawn cell — explored
            affordances: [],
          },
          {
            id: 'shed-1',
            name: 'Shed',
            type: 'furniture',
            state: {},
            cell: { x: 10, y: 7 }, // far corner — unexplored
            affordances: [],
          },
        ],
      },
      {
        id: 'workshop',
        name: 'Workshop',
        connections: ['garden'],
        objects: [
          {
            id: 'workbench-1',
            name: 'Workbench',
            type: 'furniture',
            state: {},
            cell: { x: 3, y: 3 },
            affordances: [],
          },
        ],
      },
    ],
    agents: [
      {
        agentId: 'a1',
        name: 'Alice',
        location: 'garden',
        position: { x: 11, y: 4 },
        drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
        currentGoal: '',
        currentPlan: null,
        pperPhase: 'perceive',
        isThinking: false,
        relationships: [],
        ...(fog !== undefined ? { fog } : {}),
      },
    ],
  } as unknown as VisualizerState;
}

describe('CanvasRenderer fog shading (spec 039, AC-7)', () => {
  let ctx: MockContext;

  beforeEach(() => {
    ctx = new MockContext();
  });

  it('paints fog shading over every unexplored cell of the viewed agent', () => {
    const fog = {
      visitedRooms: ['garden'],
      exploredCells: { garden: ['11,4', '10,4', '2,2', '2,3'] },
    };
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(makeState(fog));
    // 12x8 = 96 cells per room. The viewer explored 4 garden cells and has
    // never seen the workshop → 92 garden fog cells + 96 workshop cells.
    const fogRects = fillRectsWithFill(ctx).filter((r) => r.fill === FOG_CELL_FILL);
    expect(fogRects.length).toBe(92 + 96);
  });

  it('hides objects anchored in unexplored cells from the viewer', () => {
    const fog = {
      visitedRooms: ['garden'],
      exploredCells: { garden: ['11,4', '10,4', '2,2', '2,3'] },
    };
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(makeState(fog));
    const drawn = ctx.calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0]));
    expect(drawn).toContain('Planter'); // explored cell — visible
    expect(drawn).not.toContain('Shed'); // fogged cell — hidden
  });

  it('renders objects in cells the viewer has explored (fog lifted)', () => {
    const fog = {
      visitedRooms: ['garden', 'workshop'],
      exploredCells: { garden: ['11,4', '10,4', '2,2', '2,3'], workshop: ['3,3'] },
    };
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(makeState(fog));
    const drawn = ctx.calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0]));
    expect(drawn).toContain('Workbench');
  });

  it('renders everything when the viewer has no fog (legacy state, backward compat)', () => {
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(makeState(undefined));
    const fogRects = fillRectsWithFill(ctx).filter((r) => r.fill === FOG_CELL_FILL);
    expect(fogRects.length).toBe(0);
    const drawn = ctx.calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0]));
    expect(drawn).toContain('Planter');
    expect(drawn).toContain('Shed');
  });
});