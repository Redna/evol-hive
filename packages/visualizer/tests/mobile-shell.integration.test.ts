/**
 * Spec 062 — Visualizer World View (1/2) — QA additions.
 *
 * Integration coverage for AC-8 (R7): the SERVED page JS is executed in a
 * sandbox with a mock canvas and a mock DOM, and we assert that
 *   (a) the backing store equals CSS pixels × devicePixelRatio (clamped),
 *   (b) a `resize` event recomputes layout for the NEW viewport (the old
 *       renderer cached dimensions at construction and went stale), and
 *   (c) HUD insets measured from the DOM reach `layoutWorld` / the renderer.
 *
 * Also covers the spec-062 R2 "a single snapshot renders exactly at its
 * projected position" leg (no jump to a default on first sight) through the
 * same served bundle.
 *
 * The page JS is obtained from `getClientBundle()` — the exact string the
 * server inlines into `GET /` (spec 042, Decision 1) — so this exercises the
 * shipped glue, not a copy.
 */

import { describe, it, expect } from 'vitest';
import type { VisualizerState } from '@evol-hive/shared';
import { getClientBundle } from '../src/server/client-bundle.js';
import { layoutWorld, cellCenter, ZERO_INSETS } from '../src/renderer/layout.js';
import type { Insets } from '../src/renderer/layout.js';
import { THEME } from '../src/renderer/theme.js';

interface RecordedCall {
  method: string;
  args: unknown[];
}

/** Records every canvas call the served page makes, incl. state setters. */
class RecordingContext {
  readonly calls: RecordedCall[] = [];
  readonly transforms: number[][] = [];

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

  setTransform(...args: number[]): void {
    this.transforms.push(args);
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

/** fillRect calls grouped with the fillStyle in effect at call time. */
function fillRects(ctx: RecordingContext): { fill: string; rect: number[] }[] {
  const out: { fill: string; rect: number[] }[] = [];
  let current = '';
  for (const call of ctx.calls) {
    if (call.method === 'fillStyle') current = String(call.args[0]);
    else if (call.method === 'fillRect') out.push({ fill: current, rect: call.args as number[] });
  }
  return out;
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 1;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(_data: string): void {}
  close(): void {}
}

interface SandboxOptions {
  width: number;
  height: number;
  dpr: number;
  topInset?: number;
  bottomInset?: number;
  protocol?: string;
  /** Install a manually-driven requestAnimationFrame (advanced by `tick`). */
  raf?: boolean;
}

interface Sandbox {
  ctx: RecordingContext;
  canvas: { width: number; height: number; style: { width?: string; height?: string } };
  listeners: Record<string, ((ev?: unknown) => void)[]>;
  canvasListeners: Record<string, ((ev?: unknown) => void)[]>;
  detailEl: { classList: { contains(c: string): boolean } };
  nameEl: { textContent: string };
  fogButton: { onclick: (() => void) | null };
  setViewport(width: number, height: number): void;
  tick(ts?: number): void;
  ws: MockWebSocket;
}

/** Execute the served page bundle against a mock canvas/DOM. */
function makeSandbox(opts: SandboxOptions): Sandbox {
  const ctx = new RecordingContext();
  const canvasListeners: Record<string, ((ev?: unknown) => void)[]> = {};
  const canvas = {
    width: 0,
    height: 0,
    style: {} as { width?: string; height?: string },
    getContext: (_type: string) => ctx,
    addEventListener(type: string, fn: (ev?: unknown) => void): void {
      (canvasListeners[type] ??= []).push(fn);
    },
  };
  const view = {
    w: opts.width,
    h: opts.height,
    dpr: opts.dpr,
    topInset: opts.topInset ?? 0,
    bottomInset: opts.bottomInset ?? 0,
  };
  const listeners: Record<string, ((ev?: unknown) => void)[]> = {};
  function makeClassList(): {
    add(c: string): void;
    remove(c: string): void;
    toggle(c: string, on?: boolean): boolean;
    contains(c: string): boolean;
  } {
    const set = new Set<string>();
    return {
      add: (c) => {
        set.add(c);
      },
      remove: (c) => {
        set.delete(c);
      },
      toggle: (c, on) => {
        const next = on ?? !set.has(c);
        if (next) set.add(c);
        else set.delete(c);
        return next;
      },
      contains: (c) => set.has(c),
    };
  }
  const detailEl = { classList: makeClassList(), innerHTML: '', textContent: '' };
  const nameEl = { textContent: '' };
  const fogButton = { onclick: null as (() => void) | null, classList: makeClassList() };
  const win = {
    get innerWidth(): number {
      return view.w;
    },
    get innerHeight(): number {
      return view.h;
    },
    get devicePixelRatio(): number {
      return view.dpr;
    },
    addEventListener(type: string, fn: (ev?: unknown) => void): void {
      (listeners[type] ??= []).push(fn);
    },
  };
  const topEl = {
    getBoundingClientRect: () => ({ top: 0, bottom: view.topInset }),
    classList: { add() {}, remove() {}, toggle() {} },
  };
  const bottomEl = {
    getBoundingClientRect: () => ({ top: view.h - view.bottomInset, bottom: view.h }),
    classList: { add() {}, remove() {}, toggle() {} },
  };
  const makeStub = (): Record<string, unknown> => ({
    onclick: null,
    onchange: null,
    dataset: {},
    value: '',
    text: '',
    textContent: '',
    innerHTML: '',
    appendChild() {},
    classList: makeClassList(),
  });
  const doc = {
    getElementById(id: string): Record<string, unknown> {
      if (id === 'canvas') return canvas as unknown as Record<string, unknown>;
      if (id === 'top') return topEl as unknown as Record<string, unknown>;
      if (id === 'bottom') return bottomEl as unknown as Record<string, unknown>;
      if (id === 'detail') return detailEl as unknown as Record<string, unknown>;
      if (id === 'dName') return nameEl as unknown as Record<string, unknown>;
      if (id === 'btnFog') return fogButton as unknown as Record<string, unknown>;
      return makeStub();
    },
    querySelectorAll(_sel: string): Record<string, unknown>[] {
      return [makeStub(), makeStub(), makeStub()];
    },
    createElement(_tag: string): Record<string, unknown> {
      return makeStub();
    },
  };
  const location = { host: 'localhost:9', protocol: opts.protocol ?? 'http:' };

  // Optional, manually-driven rAF so a test can advance the camera pan.
  let rafCallback: ((ts: number) => void) | null = null;
  if (opts.raf === true) {
    (
      win as unknown as { requestAnimationFrame: (fn: (ts: number) => void) => number }
    ).requestAnimationFrame = (fn) => {
      rafCallback = fn;
      return 1;
    };
  }

  MockWebSocket.instances = [];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const run = new Function(
    'document',
    'window',
    'WebSocket',
    'location',
    'prompt',
    getClientBundle(),
  );
  run(doc, win, MockWebSocket, location, () => '');
  const ws = MockWebSocket.instances.at(-1);
  if (!ws) throw new Error('served page did not open a WebSocket');

  function setViewport(width: number, height: number): void {
    view.w = width;
    view.h = height;
  }

  function tick(ts = 1000): void {
    const fn = rafCallback;
    if (fn !== null) fn(ts);
  }

  return {
    ctx,
    canvas,
    listeners,
    canvasListeners,
    detailEl,
    nameEl,
    fogButton,
    setViewport,
    tick,
    ws,
  };
}

/** One room, one positioned agent — enough to assert geometry and draws. */
function makeState(): VisualizerState {
  return {
    tickNumber: 1,
    simulationTime: 1,
    isRunning: true,
    timeScale: 1,
    rooms: [
      {
        id: 'kitchen',
        name: 'Kitchen',
        description: '',
        connections: [],
        objects: [
          {
            id: 'coffee-1',
            name: 'Coffee Machine',
            type: 'appliance',
            state: { water_level: 5 },
            cell: { x: 2, y: 2 },
            affordances: [],
          },
        ],
      },
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

function expectedInsets(opts: { topInset?: number; bottomInset?: number }): Insets {
  return { top: opts.topInset ?? 0, right: 0, bottom: opts.bottomInset ?? 0, left: 0 };
}

describe('served mobile shell integration (spec 062, AC-8 / R7)', () => {
  it('(a) sizes the backing store to CSS pixels × DPR and applies the DPR transform', () => {
    const sb = makeSandbox({ width: 390, height: 844, dpr: 2 });
    expect(sb.canvas.width).toBe(780);
    expect(sb.canvas.height).toBe(1688);
    expect(sb.canvas.style.width).toBe('390px');
    expect(sb.canvas.style.height).toBe('844px');
    expect(sb.ctx.transforms.at(-1)).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it('(a) clamps the device pixel ratio (e.g. ≤ 3) on very high-DPR screens', () => {
    const sb = makeSandbox({ width: 390, height: 844, dpr: 8 });
    expect(sb.canvas.width).toBe(390 * 3);
    expect(sb.canvas.height).toBe(844 * 3);
    expect(sb.ctx.transforms.at(-1)).toEqual([3, 0, 0, 3, 0, 0]);
  });

  it('(c) measures HUD insets from the DOM and passes them to layoutWorld', () => {
    const sb = makeSandbox({ width: 1280, height: 720, dpr: 1, topInset: 44, bottomInset: 72 });
    const state = makeState();
    sb.ws.onmessage?.({ data: JSON.stringify(state) });

    const insets = expectedInsets({ topInset: 44, bottomInset: 72 });
    // drawBackground paints the top inset band with bgHi; its height is the
    // measured top inset — proof the DOM measurement reached the renderer.
    const bgHi = fillRects(sb.ctx).filter((r) => r.fill === THEME.bgHi);
    expect(bgHi.at(-1)?.rect[3]).toBe(44);

    // The room floor is placed exactly where the pure seam places it for the
    // measured-inset viewport — proof the insets reached layoutWorld.
    const expected = layoutWorld(state, { width: 1280, height: 720, insets }).rooms[0]!.rect;
    const floor = fillRects(sb.ctx).filter((r) => r.fill === THEME.roomFloor);
    expect(floor.at(-1)?.rect).toEqual([expected.x, expected.y, expected.w, expected.h]);
    expect(expected.y).toBeGreaterThanOrEqual(insets.top);
    expect(expected.y + expected.h).toBeLessThanOrEqual(720 - insets.bottom);
  });

  it('(b) recomputes layout for the new viewport after a resize event (never cached)', () => {
    const sb = makeSandbox({ width: 1280, height: 720, dpr: 1, topInset: 44, bottomInset: 72 });
    const state = makeState();
    const insets = expectedInsets({ topInset: 44, bottomInset: 72 });

    sb.ws.onmessage?.({ data: JSON.stringify(state) });
    const before = fillRects(sb.ctx)
      .filter((r) => r.fill === THEME.roomFloor)
      .at(-1)?.rect;
    const expectedBefore = layoutWorld(state, { width: 1280, height: 720, insets }).rooms[0]!.rect;
    expect(before).toEqual([
      expectedBefore.x,
      expectedBefore.y,
      expectedBefore.w,
      expectedBefore.h,
    ]);

    // Emulate an orientation change / window resize.
    sb.setViewport(390, 844);
    for (const fn of sb.listeners['resize'] ?? []) fn();
    expect(sb.canvas.width).toBe(390); // backing store followed the new CSS size
    expect(sb.canvas.style.width).toBe('390px');

    sb.ctx.calls.length = 0;
    sb.ws.onmessage?.({ data: JSON.stringify(state) });
    const after = fillRects(sb.ctx)
      .filter((r) => r.fill === THEME.roomFloor)
      .at(-1)?.rect;
    const expectedAfter = layoutWorld(state, { width: 390, height: 844, insets }).rooms[0]!.rect;
    expect(after).toEqual([expectedAfter.x, expectedAfter.y, expectedAfter.w, expectedAfter.h]);
    // The layout genuinely changed — this is not the constructor-time size.
    expect(expectedAfter).not.toEqual(expectedBefore);
    expect(expectedAfter.x + expectedAfter.w).toBeLessThanOrEqual(390);
  });

  it('(R2) renders a single snapshot exactly at its projected cell (no first-sight default)', () => {
    const sb = makeSandbox({ width: 800, height: 600, dpr: 1 });
    const state = makeState();
    sb.ws.onmessage?.({ data: JSON.stringify(state) });

    const room = layoutWorld(state, { width: 800, height: 600, insets: ZERO_INSETS }).rooms[0]!;
    const projected = cellCenter(room.rect, { x: 11, y: 4 });
    const arcs = sb.ctx.calls
      .filter((c) => c.method === 'arc')
      .map((c) => c.args as [number, number, number, number, number]);
    const atCell = arcs.filter(
      ([x, y]) => Math.abs(x - projected.x) < 0.01 && Math.abs(y - projected.y) < 0.01,
    );
    expect(atCell.length).toBeGreaterThanOrEqual(2); // phase ring + avatar
  });
});

describe('served selection + follow camera (spec 063, AC-7)', () => {
  it('selects an agent on tap, follows it, and clears on an empty tap', () => {
    const sb = makeSandbox({ width: 800, height: 600, dpr: 1, raf: true });
    const state = makeState();
    sb.ws.onmessage?.({ data: JSON.stringify(state) });

    // First frame: fit-all, card hidden, world at the layout's own origin.
    sb.tick(1000);
    expect(sb.detailEl.classList.contains('hidden')).toBe(true);
    const floorBefore = fillRects(sb.ctx)
      .filter((r) => r.fill === THEME.roomFloor)
      .at(-1)?.rect;
    expect(floorBefore?.[0]).toBe(0);

    // Tap the agent (screen coords from the pure seam).
    const layout = layoutWorld(state, { width: 800, height: 600, insets: ZERO_INSETS });
    const agent = layout.agents[0]!;
    const handlers = sb.canvasListeners['pointerdown'] ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    for (const fn of handlers) fn({ clientX: agent.x, clientY: agent.y });
    expect(sb.detailEl.classList.contains('hidden')).toBe(false);

    // Advance frames: the camera zooms to FOLLOW_SCALE and pans toward the agent.
    sb.ctx.calls.length = 0;
    sb.tick(1100);
    sb.tick(1200);
    sb.tick(1300);
    const floorAfter = fillRects(sb.ctx)
      .filter((r) => r.fill === THEME.roomFloor)
      .at(-1)?.rect;
    expect(floorAfter?.[0]).not.toBe(floorBefore?.[0]); // world layer moved
    expect(floorAfter?.[2] ?? 0).toBeGreaterThan(floorBefore?.[2] ?? 0); // follow zoom

    // Tap empty space → selection cleared, card hidden again.
    for (const fn of handlers) fn({ clientX: 1, clientY: 599 });
    expect(sb.detailEl.classList.contains('hidden')).toBe(true);
  });

  it('makes a fog-hidden agent selectable once the fog view toggle is off', () => {
    // Regression (found only in the live check): with fog OFF the renderer
    // draws everything, but hit-testing still consulted the fog-derived
    // `visible` flag, so drawn agents were not tappable.
    const sb = makeSandbox({ width: 800, height: 600, dpr: 1 });
    const state = {
      ...makeState(),
      agents: [
        {
          agentId: 'a1',
          name: 'Watcher',
          location: 'kitchen',
          position: { x: 1, y: 1 },
          drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
          currentGoal: '',
          currentPlan: null,
          pperPhase: 'perceive',
          isThinking: false,
          relationships: [],
          fog: { visitedRooms: ['kitchen'], exploredCells: { kitchen: ['1,1'] } },
        },
        {
          agentId: 'a2',
          name: 'Hidden',
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
    sb.ws.onmessage?.({ data: JSON.stringify(state) });

    const layout = layoutWorld(state, { width: 800, height: 600, insets: ZERO_INSETS });
    const hidden = layout.agents.find((a) => a.id === 'a2')!;
    const handlers = sb.canvasListeners['pointerdown'] ?? [];

    // Fog ON: a2 is outside the viewer's explored cells → not selectable.
    for (const fn of handlers) fn({ clientX: hidden.x, clientY: hidden.y });
    expect(sb.nameEl.textContent).not.toBe('Hidden');

    // Fog OFF (view override) → drawn, therefore selectable.
    sb.fogButton.onclick?.();
    for (const fn of handlers) fn({ clientX: hidden.x, clientY: hidden.y });
    expect(sb.nameEl.textContent).toBe('Hidden');
  });
});
