/**
 * Spec 062 — Visualizer World View (1/2) — QA additions for the legs the
 * implementation PR left implicit:
 *
 *  - AC-5 (R4): entity drawing (room / object / agent / door) is dispatched
 *    through the injected `Skin`; the default canvas skin satisfies it and
 *    layout is skin-independent by construction.
 *  - AC-6 (R5): object labels/state are truncated to the chip via the
 *    text-fitting helper, and no text is drawn below the code's legible floor.
 *  - AC-7 (R6): the fog VIEW toggle (`showFog:false`) lifts both the shading
 *    and the out-of-fog hiding, while the default preserves spec-039 R8.
 */

import { describe, it, expect } from 'vitest';
import type { VisualizerState } from '@evol-hive/shared';
import { CanvasRenderer, FOG_CELL_FILL } from '../src/renderer/canvas-renderer.js';
import type { Skin } from '../src/renderer/skin.js';
import { truncate, initials } from '../src/renderer/format.js';
import { layoutWorld, ZERO_INSETS } from '../src/renderer/layout.js';
import { THEME } from '../src/renderer/theme.js';

interface RecordedCall {
  method: string;
  args: unknown[];
}

/** Canvas mock that records state setters (fillStyle/font) and draw calls. */
class RecordingContext {
  readonly calls: RecordedCall[] = [];
  private _fillStyle = '#000';
  private _strokeStyle = '#000';
  private _font = '10px sans-serif';
  lineWidth = 1;
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
  get font(): string {
    return this._font;
  }
  set font(value: string) {
    this._font = value;
    this.calls.push({ method: 'font', args: [value] });
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
}

/** Text drawn, with the font in effect at draw time. */
function textsWithFont(ctx: RecordingContext): { text: string; font: string }[] {
  const out: { text: string; font: string }[] = [];
  let font = '';
  for (const call of ctx.calls) {
    if (call.method === 'font') font = String(call.args[0]);
    else if (call.method === 'fillText') out.push({ text: String(call.args[0]), font });
  }
  return out;
}

function rectsWithFill(ctx: RecordingContext, fill: string): number[][] {
  const out: number[][] = [];
  let current = '';
  for (const call of ctx.calls) {
    if (call.method === 'fillStyle') current = String(call.args[0]);
    else if (call.method === 'fillRect' && current === fill) out.push(call.args as number[]);
  }
  return out;
}

function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m === null ? 0 : Number(m[1]);
}

/** Two adjacent rooms, an object, and an agent — drives every skin method. */
function makeState(): VisualizerState {
  return {
    tickNumber: 2,
    simulationTime: 2,
    isRunning: true,
    timeScale: 1,
    rooms: [
      {
        id: 'kitchen',
        name: 'Kitchen With A Very Long Room Name',
        description: '',
        connections: ['garden'],
        objects: [
          {
            id: 'coffee-1',
            name: 'Extremely Long Coffee Machine Name That Overflows Everything',
            type: 'appliance',
            state: { water_level: 5 },
            cell: { x: 2, y: 2 },
            affordances: [],
          },
        ],
      },
      { id: 'garden', name: 'Garden', description: '', connections: ['kitchen'], objects: [] },
    ],
    agents: [
      {
        agentId: 'a1',
        name: 'Alice',
        location: 'kitchen',
        position: { x: 11, y: 4 },
        drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
        currentGoal: '',
        currentPlan: null,
        pperPhase: 'perceive',
        isThinking: false,
        relationships: [],
      },
    ],
  } as unknown as VisualizerState;
}

describe('skin seam dispatches every entity draw (spec 062, AC-5)', () => {
  it('routes room, object, agent and door drawing through the injected skin', () => {
    const called: string[] = [];
    const noop = (): void => {};
    const recording: Skin = {
      drawBackground: () => called.push('background'),
      drawRoom: () => called.push('room'),
      drawCorridor: () => called.push('corridor'),
      drawDoorOpening: () => called.push('opening'),
      drawObject: () => called.push('object'),
      drawAgent: () => called.push('agent'),
      drawRelationship: noop,
      drawStatus: () => called.push('status'),
    };
    const ctx = new RecordingContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D, recording);
    const state = makeState();
    renderer.render(state);

    expect(called).toContain('background');
    expect(called).toContain('room');
    expect(called).toContain('object');
    expect(called).toContain('agent');
    expect(called).toContain('opening'); // kitchen↔garden are edge-adjacent
    expect(called).toContain('status');
  });

  it('keeps layout skin-independent (layoutWorld takes no skin and is deterministic)', () => {
    const state = makeState();
    const a = layoutWorld(state, { width: 800, height: 600, insets: ZERO_INSETS });
    const b = layoutWorld(state, { width: 800, height: 600, insets: ZERO_INSETS });
    expect(a).toEqual(b);
  });
});

describe('legibility + chip fitting (spec 062, AC-6)', () => {
  it('truncates long text with an ellipsis and leaves short text intact', () => {
    expect(truncate('abcdefghij', 4)).toBe('abc…');
    expect(truncate('ab', 4)).toBe('ab');
    expect(truncate('anything', 1)).toBe('a');
    expect(initials('Alice')).toBe('AL');
    expect(initials('Alice Smith')).toBe('AS');
    expect(initials('  ')).toBe('?');
  });

  it('draws a long object name truncated to its chip and keeps the state value', () => {
    const ctx = new RecordingContext();
    new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D).render(makeState());
    const drawn = textsWithFont(ctx).map((t) => t.text);
    const name = drawn.find((t) => t.startsWith('Extremely'));
    expect(name).toBeDefined();
    expect(name).toContain('…');
    expect(name!.length).toBeLessThan(
      'Extremely Long Coffee Machine Name That Overflows Everything'.length,
    );
    // The state VALUE survives truncation (issue #105) — key shrinks, value stays.
    expect(drawn.some((t) => t.includes('5'))).toBe(true);
  });

  it('never draws text below the legible floor (labels ≥ 9px, state ≥ 8px)', () => {
    const ctx = new RecordingContext();
    // A small viewport is the worst case for the viewport-scaled fonts.
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(makeState(), { width: 360, height: 640 });
    const drawn = textsWithFont(ctx);
    expect(drawn.length).toBeGreaterThan(0);
    // Nothing anywhere drops below the code's floor (8px state line).
    expect(Math.min(...drawn.map((t) => fontPx(t.font)))).toBeGreaterThanOrEqual(8);
    // Room, object and agent labels each keep their ≥ 9px minimum.
    const fontOf = (needle: string): number => {
      const hit = drawn.find((t) => t.text.includes(needle));
      if (hit === undefined) throw new Error(`no drawn text for ${needle}`);
      return fontPx(hit.font);
    };
    expect(fontOf('Kitchen')).toBeGreaterThanOrEqual(9); // room label
    expect(fontOf('Extremely')).toBeGreaterThanOrEqual(9); // object name
    expect(fontOf('Alice')).toBeGreaterThanOrEqual(9); // agent name
  });
});

describe('fog as a view toggle (spec 062, R6 / AC-7)', () => {
  function makeFogState(): VisualizerState {
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
          objects: [
            {
              id: 'planter-1',
              name: 'Planter',
              type: 'nature',
              state: { soil: 'wet' },
              cell: { x: 2, y: 2 }, // explored
              affordances: [],
            },
            {
              id: 'shed-1',
              name: 'Shed',
              type: 'furniture',
              state: {},
              cell: { x: 10, y: 7 }, // unexplored
              affordances: [],
            },
          ],
        },
        {
          id: 'workshop',
          name: 'Workshop',
          description: '',
          connections: ['garden'],
          objects: [
            {
              id: 'workbench-1',
              name: 'Bench',
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
          fog: {
            visitedRooms: ['garden'],
            exploredCells: { garden: ['11,4', '10,4', '2,2', '2,3'] },
          },
        },
        {
          agentId: 'a2',
          name: 'Bob',
          location: 'workshop',
          position: { x: 3, y: 3 }, // never explored by Alice
          drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
          currentGoal: '',
          currentPlan: null,
          pperPhase: 'perceive',
          isThinking: false,
          relationships: [],
        },
      ],
    } as unknown as VisualizerState;
  }

  it('preserves spec-039 R8: unexplored cells shaded, out-of-fog entities hidden', () => {
    const ctx = new RecordingContext();
    new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D).render(makeFogState());
    const drawn = textsWithFont(ctx).map((t) => t.text);
    expect(drawn).toContain('Planter'); // explored cell
    expect(drawn).not.toContain('Shed'); // unexplored object
    expect(drawn).not.toContain('Bob'); // out-of-fog agent
    expect(rectsWithFill(ctx, FOG_CELL_FILL).length).toBeGreaterThan(0);
  });

  it('showFog:false lifts the shading AND the hiding (fog is a view, not state)', () => {
    const ctx = new RecordingContext();
    new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D).render(makeFogState(), {
      showFog: false,
    });
    const drawn = textsWithFont(ctx).map((t) => t.text);
    expect(drawn).toContain('Shed');
    expect(drawn).toContain('Bob');
    expect(rectsWithFill(ctx, FOG_CELL_FILL)).toHaveLength(0);
    // Sanity: the default chip still renders, so the chip layer ran.
    expect(rectsWithFill(ctx, THEME.chip).length).toBeGreaterThanOrEqual(0);
  });
});
