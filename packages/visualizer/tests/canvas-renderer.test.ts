/**
 * Spec 023 — Visual Output Canvas Renderer
 * CanvasRenderer (AC-7, AC-8).
 *
 * Uses a mock CanvasRenderingContext2D that records every draw call so we can
 * assert the renderer produces the expected primitives without a real
 * browser canvas.
 */
import { describe, it, expect } from 'vitest';
import { CanvasRenderer } from '../src/renderer/canvas-renderer.js';
import type { VisualizerState } from '@evol-hive/shared';

interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * A minimal mock of CanvasRenderingContext2D that records every method call.
 * Only the methods used by CanvasRenderer are implemented; the rest throw so
 * we catch unexpected usage early.
 */
class MockContext {
  readonly calls: RecordedCall[] = [];
  canvas: { width: number; height: number } = { width: 800, height: 600 };

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  // State setters (record the value)
  private _fillStyle = '#000';
  private _strokeStyle = '#000';
  lineWidth = 1;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';

  /** fillStyle assignments are recorded so tests can assert icon tints. */
  get fillStyle(): string {
    return this._fillStyle;
  }
  set fillStyle(value: string) {
    this._fillStyle = value;
    this.record('fillStyle', value);
  }
  get strokeStyle(): string {
    return this._strokeStyle;
  }
  set strokeStyle(value: string) {
    this._strokeStyle = value;
    this.record('strokeStyle', value);
  }

  // Path methods
  beginPath(): void {
    this.record('beginPath');
  }
  moveTo(x: number, y: number): void {
    this.record('moveTo', x, y);
  }
  lineTo(x: number, y: number): void {
    this.record('lineTo', x, y);
  }
  arc(x: number, y: number, r: number, start: number, end: number): void {
    this.record('arc', x, y, r, start, end);
  }
  closePath(): void {
    this.record('closePath');
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.record('rect', x, y, w, h);
  }

  // Fill / stroke
  fill(): void {
    this.record('fill');
  }
  stroke(): void {
    this.record('stroke');
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.record('fillRect', x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.record('strokeRect', x, y, w, h);
  }
  fillText(text: string, x: number, y: number): void {
    this.record('fillText', text, x, y);
  }
  strokeText(text: string, x: number, y: number): void {
    this.record('strokeText', text, x, y);
  }

  // Misc used by renderer
  save(): void {
    this.record('save');
  }
  restore(): void {
    this.record('restore');
  }
}

function makeState(overrides: Partial<VisualizerState> = {}): VisualizerState {
  return {
    tickNumber: 0,
    simulationTime: 0,
    isRunning: true,
    timeScale: 1,
    rooms: [
      {
        id: 'kitchen',
        name: 'Kitchen',
        description: 'A small kitchen.',
        connections: [],
        objects: [
          {
            id: 'coffee-1',
            name: 'Coffee Machine',
            type: 'appliance',
            state: { water_level: 5 },
            affordances: [{ id: 'brew_coffee', label: 'Brew coffee' }],
          },
        ],
      },
    ],
    agents: [
      {
        agentId: 'agent-1',
        name: 'Alice',
        location: 'kitchen',
        drives: { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
        currentGoal: 'Get coffee',
        currentPlan: {
          description: 'Brew and drink coffee',
          currentStepIndex: 1,
          totalSteps: 3,
        },
        pperPhase: 'plan',
        isThinking: true,
        relationships: [],
      },
    ],
    ...overrides,
  };
}

describe('CanvasRenderer.render — rooms, objects, agents (AC-7)', () => {
  it('draws at least one fillRect per room', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(makeState());
    const fillRects = ctx.calls.filter((c) => c.method === 'fillRect');
    expect(fillRects.length).toBeGreaterThanOrEqual(1);
  });

  it('draws at least one arc per agent', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(makeState());
    const arcs = ctx.calls.filter((c) => c.method === 'arc');
    expect(arcs.length).toBeGreaterThanOrEqual(1);
  });

  it('draws the agent name as fillText', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(makeState());
    const texts = ctx.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0] as string);
    expect(texts.some((t) => t.includes('Alice'))).toBe(true);
  });

  it('draws drive bars (5 fillRect calls for drive bars)', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(makeState());
    // The renderer draws 5 drive bars per agent. Each bar uses fillRect.
    const fillRects = ctx.calls.filter((c) => c.method === 'fillRect');
    // 1 room background + 5 drive bars + object backgrounds etc. => at least 6.
    expect(fillRects.length).toBeGreaterThanOrEqual(6);
  });

  it('draws the PPER phase indicator ring (arc with stroke)', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(makeState());
    // The phase ring is drawn via arc + stroke. At least 1 stroke call.
    const strokes = ctx.calls.filter((c) => c.method === 'stroke');
    expect(strokes.length).toBeGreaterThanOrEqual(1);
  });

  it('draws object state text', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(makeState());
    const texts = ctx.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0] as string);
    // Object state text includes the water_level value.
    expect(texts.some((t) => t.includes('5'))).toBe(true);
  });
});

describe('CanvasRenderer.render — relationship lines (AC-8)', () => {
  it('draws a line between two related agents in the same room', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    const state = makeState({
      agents: [
        {
          agentId: 'agent-1',
          name: 'Alice',
          location: 'kitchen',
          drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
          currentGoal: '',
          currentPlan: null,
          pperPhase: 'perceive',
          isThinking: false,
          relationships: [{ agentId: 'agent-2', trust: 70, familiarity: 40 }],
        },
        {
          agentId: 'agent-2',
          name: 'Bob',
          location: 'kitchen',
          drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
          currentGoal: '',
          currentPlan: null,
          pperPhase: 'perceive',
          isThinking: false,
          relationships: [{ agentId: 'agent-1', trust: 70, familiarity: 40 }],
        },
      ],
    });
    renderer.render(state);
    // A relationship line uses moveTo + lineTo + stroke.
    const moveTos = ctx.calls.filter((c) => c.method === 'moveTo');
    const lineTos = ctx.calls.filter((c) => c.method === 'lineTo');
    expect(moveTos.length).toBeGreaterThanOrEqual(1);
    expect(lineTos.length).toBeGreaterThanOrEqual(1);
  });

  it('does not draw relationship lines when agents have no relationships', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    const state = makeState({
      agents: [
        {
          agentId: 'agent-1',
          name: 'Alice',
          location: 'kitchen',
          drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
          currentGoal: '',
          currentPlan: null,
          pperPhase: 'perceive',
          isThinking: false,
          relationships: [],
        },
      ],
    });
    renderer.render(state);
    // With a single agent and no relationships, no moveTo/lineTo pair for lines.
    // (Room border strokes use strokeRect, not moveTo/lineTo.)
    const lineTos = ctx.calls.filter((c) => c.method === 'lineTo');
    expect(lineTos.length).toBe(0);
  });

  // ── Spec 033 (AC-10, R9): conversation objects render with sentiment tint ──

  it('renders a conversation object with its sentiment-derived tint as icon background', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    const state = makeState({
      rooms: [
        {
          id: 'garden',
          name: 'Garden',
          description: '',
          connections: [],
          objects: [
            {
              id: 'conv-1',
              name: 'Conversation',
              type: 'conversation',
              state: { topic: 'roses' },
              affordances: [],
              conversation: {
                topic: 'roses',
                participants: ['agent-a', 'agent-b'],
                sentimentTint: '#e06c75',
              },
            },
          ],
        },
      ],
      agents: [],
    });
    renderer.render(state);
    // The icon background fillRect for the conversation object uses the tint.
    const fillStyleChanges = ctx.calls.filter((c) => c.method === 'fillStyle');
    expect(fillStyleChanges.some((c) => c.args[0] === '#e06c75')).toBe(true);
    // The topic is rendered in the chip text.
    const fills = ctx.calls.filter((c) => c.method === 'fillText');
    expect(fills.some((c) => String(c.args[0]).includes('roses'))).toBe(true);
  });

  it('renders plain objects without a tint (no conversation projection)', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    const state = makeState();
    renderer.render(state);
    const fillStyleChanges = ctx.calls.filter((c) => c.method === 'fillStyle');
    expect(fillStyleChanges.some((c) => c.args[0] === '#e06c75')).toBe(false);
  });
});
