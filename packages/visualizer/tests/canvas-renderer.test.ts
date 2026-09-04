/**
 * Spec 023 — Visual Output Canvas Renderer
 * CanvasRenderer (AC-7, AC-8).
 * Spec 029 — Object State Text: Round Decimals & Truncate Overflow (AC-1..AC-9).
 *
 * Uses a mock CanvasRenderingContext2D that records every draw call so we can
 * assert the renderer produces the expected primitives without a real
 * browser canvas. For spec 029 the mock also implements `measureText`, which
 * defaults to a benign linear width model and is overridable per test.
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
  fillStyle = '#000';
  strokeStyle = '#000';
  lineWidth = 1;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';

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

  // Text measurement (spec 029)
  /**
   * Width model backing `measureText` — overridable per test (AC-8). The
   * default linear model (2.5px/char) keeps the ≤19-char state lines from the
   * rounding acceptance criteria inside the 56px usable chip width, so those
   * tests are not confounded by truncation; overflow tests override it
   * (e.g. `(t) => t.length * 5`) to exercise the clipping path.
   */
  measureWidth: (text: string) => number = (text) => text.length * 2.5;

  measureText(text: string): { width: number } {
    this.record('measureText', text);
    return { width: this.measureWidth(text) };
  }

  // Clear
  clearRect(x: number, y: number, w: number, h: number): void {
    this.record('clearRect', x, y, w, h);
  }

  // Misc used by renderer
  save(): void {
    this.record('save');
  }
  restore(): void {
    this.record('restore');
  }
  set fillStyleSetter(_: string) {
    this.fillStyle = _;
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
});

// ─── Spec 029 — Object state text: round decimals & truncate overflow ───────

describe('Spec 029 — object state numeric rounding (Req 1/2)', () => {
  it('AC-1: rounds 95.666666674 to "water_supply: 95.67" — no long decimal tail', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    const state = makeState();
    state.rooms[0]!.objects[0]!.state = { water_supply: 95.666666674 };
    renderer.render(state);
    const texts = ctx.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0] as string);
    expect(texts).toContain('water_supply: 95.67');
    const stateLine = texts.find((t) => t.startsWith('water_supply'))!;
    expect(stateLine).toMatch(/^water_supply: 95\.6\d?$/);
    expect(stateLine).toBe('water_supply: 95.67');
  });

  it('AC-2: renders integer 5 as "bloom_count: 5" — no .0/.00 suffix', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    const state = makeState();
    state.rooms[0]!.objects[0]!.state = { bloom_count: 5 };
    renderer.render(state);
    const texts = ctx.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0] as string);
    expect(texts).toContain('bloom_count: 5');
  });

  it('AC-3: renders 95.5 as "water_supply: 95.5" — one decimal, not padded to two', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    const state = makeState();
    state.rooms[0]!.objects[0]!.state = { water_supply: 95.5 };
    renderer.render(state);
    const texts = ctx.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0] as string);
    expect(texts).toContain('water_supply: 95.5');
    expect(texts).not.toContain('water_supply: 95.50');
  });

  it('AC-4: renders string and boolean state values verbatim', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    const state = makeState();
    state.rooms[0]!.objects[0]!.state = { status: 'blooming', open: true };
    renderer.render(state);
    const texts = ctx.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0] as string);
    // Only the FIRST state entry is drawn — split across two renders.
    expect(texts).toContain('status: blooming');

    const ctx2 = new MockContext();
    const renderer2 = new CanvasRenderer(ctx2 as unknown as CanvasRenderingContext2D);
    state.rooms[0]!.objects[0]!.state = { open: true };
    renderer2.render(state);
    const texts2 = ctx2.calls
      .filter((c) => c.method === 'fillText')
      .map((c) => c.args[0] as string);
    expect(texts2).toContain('open: true');
  });

  it('AC-5: does not mutate the source obj.state — display-only rounding', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    const state = makeState();
    state.rooms[0]!.objects[0]!.state = { water_supply: 95.666666674 };
    renderer.render(state);
    expect(state.rooms[0]!.objects[0]!.state.water_supply).toBe(95.666666674);
  });
});

describe('Spec 029 — state text overflow protection via measureText (Req 3/4)', () => {
  it('AC-6: a line wider than 56px renders with a single trailing … within the chip', () => {
    const ctx = new MockContext();
    ctx.measureWidth = (text) => text.length * 5; // AC-6 mock width model
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    const state = makeState();
    state.rooms[0]!.name = 'Hall';
    state.rooms[0]!.objects[0]!.name = 'M';
    state.rooms[0]!.objects[0]!.state = { water_supply: 95.666666674 };
    state.agents = []; // keep only the object texts in play
    renderer.render(state);
    const texts = ctx.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0] as string);
    const clipped = texts.filter((t) => t.endsWith('…'));
    expect(clipped).toHaveLength(1);
    const line = clipped[0]!;
    expect(line.match(/…/g)).toHaveLength(1);
    expect(line.length * 5).toBeLessThanOrEqual(56);
    expect(line.length).toBeLessThan('water_supply: 95.67'.length);
  });

  it('AC-7: a line measuring ≤ 56px renders verbatim with no ellipsis', () => {
    const ctx = new MockContext();
    ctx.measureWidth = (text) => text.length * 5; // same mock width model
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    const state = makeState();
    state.rooms[0]!.name = 'Hall';
    state.rooms[0]!.objects[0]!.name = 'M';
    state.rooms[0]!.objects[0]!.state = { made: true }; // "made: true" → 50px
    state.agents = [];
    renderer.render(state);
    const texts = ctx.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0] as string);
    expect(texts).toContain('made: true');
    expect(texts.some((t) => t.includes('…'))).toBe(false);
  });

  it('AC-8: clips via ctx.measureText under 10px sans-serif — model changes truncation', () => {
    const state = makeState();
    state.rooms[0]!.name = 'Hall';
    state.rooms[0]!.objects[0]!.name = 'M';
    state.rooms[0]!.objects[0]!.state = { water_supply: 95.666666674 };
    state.agents = [];

    // (a) measureText is called with the composed state line...
    const ctx = new MockContext();
    ctx.measureWidth = (text) => text.length * 5;
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    renderer.render(state);
    const measured = ctx.calls
      .filter((c) => c.method === 'measureText')
      .map((c) => c.args[0] as string);
    expect(measured).toContain('water_supply: 95.67');

    // (b) ...under the 10px sans-serif font.
    const fontsAtMeasure: string[] = [];
    const ctxFont = new MockContext();
    ctxFont.measureWidth = (text) => {
      fontsAtMeasure.push(ctxFont.font);
      return text.length * 5;
    };
    const rendererFont = new CanvasRenderer(ctxFont as unknown as CanvasRenderingContext2D);
    rendererFont.render(state);
    expect(fontsAtMeasure.length).toBeGreaterThan(0);
    expect(fontsAtMeasure.every((f) => f === '10px sans-serif')).toBe(true);

    // (c) changing the width model changes the truncation point (no fixed count).
    const ctxWide = new MockContext();
    ctxWide.measureWidth = (text) => text.length * 10;
    const rendererWide = new CanvasRenderer(ctxWide as unknown as CanvasRenderingContext2D);
    rendererWide.render(state);
    const texts5 = ctx.calls
      .filter((c) => c.method === 'fillText')
      .map((c) => c.args[0] as string)
      .filter((t) => t.endsWith('…'));
    const texts10 = ctxWide.calls
      .filter((c) => c.method === 'fillText')
      .map((c) => c.args[0] as string)
      .filter((t) => t.endsWith('…'));
    expect(texts5).toHaveLength(1);
    expect(texts10).toHaveLength(1);
    expect(texts10[0]).not.toBe(texts5[0]);
    expect(texts10[0]!.length).toBeLessThan(texts5[0]!.length);
  });
});

describe('Spec 029 — non-regression (Req 5 / AC-9)', () => {
  it('drawObjects still draws 60×30 chips at the same grid positions', () => {
    const ctx = new MockContext();
    const renderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);
    const state = makeState({
      rooms: [
        {
          id: 'kitchen',
          name: 'Kitchen',
          description: '',
          connections: [],
          objects: [
            {
              id: 'o1',
              name: 'One',
              type: 'appliance',
              state: {},
              affordances: [],
            },
            {
              id: 'o2',
              name: 'Two',
              type: 'appliance',
              state: {},
              affordances: [],
            },
          ],
        },
      ],
    });
    renderer.render(state);
    const rects = ctx.calls
      .filter((c) => c.method === 'fillRect')
      .map((c) => c.args as [number, number, number, number]);
    // Room at (30, 50, 740, 500); object i at (roomX + 12 + (i % 3) * 70, roomY + 30).
    expect(rects).toContainEqual([42, 80, 60, 30]);
    expect(rects).toContainEqual([112, 80, 60, 30]);
  });
});
