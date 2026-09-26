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
import { FOLLOW_SCALE } from '../src/renderer/camera.js';
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
  /** Path the page was served from (e.g. `/viz/` behind a reverse proxy). */
  pathname?: string;
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
  fogButton: { onclick: (() => void) | null; classList: { contains(c: string): boolean } };
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
  const location = {
    host: 'localhost:9',
    protocol: opts.protocol ?? 'http:',
    pathname: opts.pathname ?? '/',
  };

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

/** One positioned agent for the co-location (spec 066, R1) cases. */
function coLocatedAgent(
  agentId: string,
  name: string,
  position: { x: number; y: number },
): Record<string, unknown> {
  return {
    agentId,
    name,
    location: 'kitchen',
    position,
    drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    currentGoal: '',
    currentPlan: null,
    pperPhase: 'perceive',
    isThinking: false,
    relationships: [],
  };
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

  it('dials the socket on the page base path, with the scheme following the page', () => {
    // Behind a path-prefixed reverse proxy the socket must stay on that route
    // (`/viz/`), otherwise `host/` is routed to whatever else owns the root.
    const proxied = makeSandbox({
      width: 390,
      height: 844,
      dpr: 1,
      protocol: 'https:',
      pathname: '/viz/',
    });
    expect(proxied.ws.url).toBe('wss://localhost:9/viz/');

    const local = makeSandbox({
      width: 390,
      height: 844,
      dpr: 1,
      protocol: 'http:',
      pathname: '/',
    });
    expect(local.ws.url).toBe('ws://localhost:9/');
  });
});

/**
 * Spec 066 leg 1, R2 — the SERVED release (AC-4, AC-5).
 *
 * The pure `cameraFor`/`smoothCamera` tests (`spec-066-camera-release.test.ts`)
 * prove the seam's behaviour, but the shipped defect (D2) lived in the client
 * glue: `main.ts` smoothed the offsets and assigned `scale` outright. The pure
 * tests cannot catch a regression that puts that asymmetry back — reverting
 * `main.ts` to `scale: target.scale` would leave them all green. Spec 066's
 * Test Seam 4 therefore names the served bundle + mock-DOM harness for AC-5.
 *
 * The camera scale is observed through the rendered world layer: the room floor
 * is `transformLayout`-scaled by the camera, so `floorWidth / fitAllFloorWidth`
 * is the live camera scale. The manual rAF makes the glide deterministic — no
 * real timers, no browser.
 */
describe('spec 066 leg 1 — the served release returns to fit-all and glides (AC-4, AC-5)', () => {
  it('glides the scale back to fit-all on release instead of snapping (AC-5, shipped glue)', () => {
    const W = 800;
    const H = 600;
    const sb = makeSandbox({ width: W, height: H, dpr: 1, raf: true });
    const state = makeState();
    sb.ws.onmessage?.({ data: JSON.stringify(state) });

    const base = layoutWorld(state, { width: W, height: H, insets: ZERO_INSETS });
    const fitAllFloor = base.rooms[0]!.rect;
    /** The most recent room-floor fill, in world-layer screen coordinates. */
    const floor = (): number[] | undefined =>
      fillRects(sb.ctx)
        .filter((r) => r.fill === THEME.roomFloor)
        .at(-1)?.rect;
    /** Live camera scale, read off the scaled floor width. */
    const scaleNow = (): number => (floor()?.[2] ?? 0) / fitAllFloor.w;

    // Follow the agent to the 1.6x zoom (the production camera shape, AC-4).
    const agent = base.agents[0]!;
    const handlers = sb.canvasListeners['pointerdown'] ?? [];
    for (const fn of handlers) fn({ clientX: agent.x, clientY: agent.y });
    for (let t = 1000; t <= 4000; t += 100) sb.tick(t);
    expect(scaleNow()).toBeCloseTo(FOLLOW_SCALE, 2);

    // Release on empty canvas.
    for (const fn of handlers) fn({ clientX: 1, clientY: H - 1 });
    expect(sb.detailEl.classList.contains('hidden')).toBe(true);

    // One frame later the scale has moved but has NOT snapped to fit-all.
    sb.ctx.calls.length = 0;
    sb.tick(4016);
    const oneFrame = scaleNow();
    expect(oneFrame).toBeLessThan(FOLLOW_SCALE); // ...it moved
    expect(oneFrame).toBeGreaterThan(1); // ...but did not snap

    // And it converges to fit-all within a bounded time (AC-5).
    sb.ctx.calls.length = 0;
    for (let t = 4032; t <= 4016 + 240 * 16; t += 16) sb.tick(t);
    const settled = floor()!;
    expect(settled[2] / fitAllFloor.w).toBeCloseTo(1, 2);
    expect(settled[0]).toBeCloseTo(fitAllFloor.x, 1);
    expect(settled[1]).toBeCloseTo(fitAllFloor.y, 1);
  });
});

/**
 * Spec 066 leg 2, R1 — the SERVED tap selects the agent it drew (AC-3).
 *
 * AC-1/AC-2 are asserted purely in `spec-066-co-located-agents.test.ts`: the
 * layout now hands co-located agents distinct points. But the reported defect
 * (D1) was the *inversion* between the two consumers of that layout — the
 * renderer paints in order (last on top) while `hitTestAgent` returned the
 * nearest/first — so a tap on the visible chip opened a different agent's card.
 * A pure `layoutWorld` test never touches the shipped glue, so a regression
 * that decoupled the hit test from the layout (the exact shape of D1) would
 * leave it green.
 *
 * Spec 066's Test Seam 4 names the served bundle + mock-DOM harness for AC-3,
 * so this drives the page the server actually ships: feed a snapshot with two
 * agents sharing one cell, locate each drawn chip, tap it, and require the card
 * to open for *that* agent.
 */
describe('spec 066 leg 2 — the served tap selects the agent it drew (AC-3)', () => {
  it('tapping a co-located agent’s drawn chip selects that agent, not its cell-mate', () => {
    const W = 800;
    const H = 600;
    const sb = makeSandbox({ width: W, height: H, dpr: 1 });

    // Both agents share the same room and the same grid cell — the D1 shape.
    // Alice is first in the array; Bob is last, so his chip is painted on top.
    const coLocated = {
      ...makeState(),
      agents: [
        coLocatedAgent('alice', 'Alice', { x: 5, y: 4 }),
        coLocatedAgent('bob', 'Bob', { x: 5, y: 4 }),
      ],
    } as unknown as VisualizerState;

    sb.ws.onmessage?.({ data: JSON.stringify(coLocated) });

    const layout = layoutWorld(coLocated, { width: W, height: H, insets: ZERO_INSETS });
    const at = new Map(layout.agents.map((a) => [a.id, a]));

    // The drawn chips: each agent's name pill is painted at that agent's own
    // layout point, so the coordinates below are genuinely the drawn positions,
    // not a second derivation.
    const drawn = sb.ctx.calls
      .filter((c) => c.method === 'fillText')
      .map((c) => c.args as [string, number, number]);
    for (const [id, name] of [
      ['alice', 'Alice'],
      ['bob', 'Bob'],
    ] as const) {
      expect(
        drawn.filter(([text, x]) => text === name && Math.abs(x - at.get(id)!.x) < 0.5).length,
      ).toBeGreaterThan(0);
    }

    const handlers = sb.canvasListeners['pointerdown'] ?? [];
    expect(handlers.length).toBeGreaterThan(0);

    // Tap Bob's drawn chip first. Before the fix Alice and Bob shared one
    // point, the renderer drew Bob on top, and the hit test returned Alice — so
    // this is exactly the reported "tapping the visible agent opens another".
    for (const fn of handlers) fn({ clientX: at.get('bob')!.x, clientY: at.get('bob')!.y });
    expect(sb.nameEl.textContent).toBe('Bob');

    // And Alice's own chip still selects Alice.
    for (const fn of handlers) fn({ clientX: at.get('alice')!.x, clientY: at.get('alice')!.y });
    expect(sb.nameEl.textContent).toBe('Alice');
  });
});

/**
 * Spec 066 leg 3, R3 — the SERVED glide is paced against the snapshot interval
 * (AC-6, AC-7).
 *
 * The pure `motionTowards` tests (`spec-066-motion-aliasing.test.ts`) prove the
 * seam, but the reported defect (D3) lived in the shipped glue: `main.ts`
 * smoothed agents with a fixed `GLIDE_HALF_LIFE_S = 0.09`, so a delta delivered
 * over a 0.1 s snapshot interval was never traversed over that interval. Leg 3's
 * Test Seam 4 therefore names the served bundle + mock-DOM harness for the glue
 * wiring: a regression that puts the old fixed half-life back would leave every
 * pure `motionTowards` test green.
 *
 * The manual rAF makes the pacing deterministic — snapshots are observed on
 * frames 0.1 s apart (10/s, the server default), and the agent's drawn x is read
 * off the shipped skin's name pill, whose x is exactly the position the layout
 * glide produced.
 */
describe('spec 066 leg 3 — the served glide bridges each delta over its interval (AC-6, AC-7)', () => {
  it('traverses the delta across the measured interval and arrives as it completes', () => {
    const W = 800;
    const H = 600;
    const sb = makeSandbox({ width: W, height: H, dpr: 1, raf: true });
    const viewport = { width: W, height: H, insets: ZERO_INSETS };

    // Two snapshots 0.1 s apart; the agent walks 9 cells along one row.
    const before = {
      ...makeState(),
      agents: [coLocatedAgent('a1', 'Alice', { x: 2, y: 4 })],
    } as unknown as VisualizerState;
    const after = {
      ...makeState(),
      agents: [coLocatedAgent('a1', 'Alice', { x: 11, y: 4 })],
    } as unknown as VisualizerState;
    const p1 = layoutWorld(before, viewport).agents[0]!;
    const p2 = layoutWorld(after, viewport).agents[0]!;
    expect(p2.x).toBeGreaterThan(p1.x);

    /** The shipped skin paints the agent's name pill at the layout position. */
    const drawnX = (): number => {
      const names = sb.ctx.calls
        .filter((c) => c.method === 'fillText' && c.args[0] === 'Alice')
        .map((c) => c.args as [string, number, number]);
      expect(names.length).toBeGreaterThan(0);
      return names.at(-1)![1];
    };

    // Snapshot 1 at frame 1000: first sight renders exactly at its cell.
    sb.ws.onmessage?.({ data: JSON.stringify(before) });
    sb.tick(1000);
    expect(drawnX()).toBeCloseTo(p1.x, 3);

    // Snapshot 2 is observed at frame 1100 (0.1 s later). On that frame the
    // glide has elapsed 0, so the agent is still at p1 — no one-frame teleport.
    sb.ws.onmessage?.({ data: JSON.stringify(after) });
    sb.tick(1100);
    expect(drawnX()).toBeCloseTo(p1.x, 3);

    // Half-way through the interval the agent is half-way across the delta.
    sb.tick(1150);
    expect(drawnX()).toBeCloseTo((p1.x + p2.x) / 2, 3);

    // As the interval completes it arrives exactly at the new cell.
    sb.tick(1200);
    expect(drawnX()).toBeCloseTo(p2.x, 3);

    // Beyond the interval it holds there — clamped, never overshooting.
    sb.tick(1232);
    expect(drawnX()).toBeCloseTo(p2.x, 3);
  });

  it('moves a 5× delta proportionally faster with no constant change (AC-7)', () => {
    const W = 800;
    const H = 600;
    const viewport = { width: W, height: H, insets: ZERO_INSETS };

    /** Drive one snapshot pair and read how far the drawn agent has moved at a
     *  chosen elapsed time, plus the full delta the snapshot delivered. */
    const glideAt = (deltaCells: number, elapsedMs: number): { moved: number; full: number } => {
      const sb = makeSandbox({ width: W, height: H, dpr: 1, raf: true });
      const before = {
        ...makeState(),
        agents: [coLocatedAgent('a1', 'Alice', { x: 0, y: 4 })],
      } as unknown as VisualizerState;
      const after = {
        ...makeState(),
        agents: [coLocatedAgent('a1', 'Alice', { x: deltaCells, y: 4 })],
      } as unknown as VisualizerState;
      sb.ws.onmessage?.({ data: JSON.stringify(before) });
      sb.tick(1000);
      sb.ws.onmessage?.({ data: JSON.stringify(after) });
      sb.tick(1100);
      sb.tick(1100 + elapsedMs);
      const p1 = layoutWorld(before, viewport).agents[0]!;
      const p2 = layoutWorld(after, viewport).agents[0]!;
      const names = sb.ctx.calls
        .filter((c) => c.method === 'fillText' && c.args[0] === 'Alice')
        .map((c) => c.args as [string, number, number]);
      return { moved: names.at(-1)![1] - p1.x, full: p2.x - p1.x };
    };

    // Same interval (0.1 s), same elapsed (0.05 s): only the delta changes.
    // Cell x must stay inside the 12-column grid, so 2 cells vs 10 cells is the
    // same 5× ratio the spec's 6-vs-30 example states.
    const at1x = glideAt(2, 50);
    const at5x = glideAt(10, 50);

    // Half the interval elapsed ⇒ half each delta traversed. This is what the
    // fixed half-life got wrong (it closed ~32% in 0.05 s), and it is the part
    // the scale-invariant ratio cannot see.
    expect(at1x.moved).toBeCloseTo(at1x.full / 2, 2);
    expect(at5x.moved).toBeCloseTo(at5x.full / 2, 2);
    // And the larger delta moved proportionally faster, with no constant change.
    expect(at5x.full / at1x.full).toBeCloseTo(5, 2);
    expect(at5x.moved / at1x.moved).toBeCloseTo(5, 2);
  });

  it('caps the measured interval so a stalled tab does not crawl on resume', () => {
    const W = 800;
    const H = 600;
    const sb = makeSandbox({ width: W, height: H, dpr: 1, raf: true });
    const viewport = { width: W, height: H, insets: ZERO_INSETS };
    const before = {
      ...makeState(),
      agents: [coLocatedAgent('a1', 'Alice', { x: 2, y: 4 })],
    } as unknown as VisualizerState;
    const after = {
      ...makeState(),
      agents: [coLocatedAgent('a1', 'Alice', { x: 11, y: 4 })],
    } as unknown as VisualizerState;
    const p1 = layoutWorld(before, viewport).agents[0]!;
    const p2 = layoutWorld(after, viewport).agents[0]!;
    const drawnX = (): number => {
      const names = sb.ctx.calls
        .filter((c) => c.method === 'fillText' && c.args[0] === 'Alice')
        .map((c) => c.args as [string, number, number]);
      return names.at(-1)![1];
    };

    sb.ws.onmessage?.({ data: JSON.stringify(before) });
    sb.tick(1000);
    // rAF was paused for 4 s (a backgrounded tab) while snapshots kept coming.
    sb.ws.onmessage?.({ data: JSON.stringify(after) });
    sb.tick(5000);
    // The resume frame is still continuous — no teleport to the new cell...
    expect(drawnX()).toBeCloseTo(p1.x, 3);
    // ...but the interval was capped at 1 s, not the 4 s gap, so it arrives
    // within a bounded time rather than crawling for the whole stall.
    sb.tick(5500);
    expect(drawnX()).toBeGreaterThan(p1.x);
    sb.tick(6000);
    expect(drawnX()).toBeCloseTo(p2.x, 3);
  });
});

/**
 * Spec 066 leg 3, R3 — the pacing interval is MEASURED, not the 0.1 s default
 * (AC-6).
 *
 * Every case above observes snapshots 0.1 s apart, which is exactly
 * `DEFAULT_SNAPSHOT_INTERVAL_S`. They would therefore all stay green if the
 * shipped glue ignored the measured cadence and hardcoded the default — the
 * original D3 bug in a different coat. The design's headline claim is the
 * opposite: the interval comes from actual snapshot arrivals, so a server with
 * a different `snapshotRateMs` (or a jittery mesh link) is paced correctly with
 * no protocol change. This case drives non-default cadences and asserts the
 * delta is traversed over THAT interval.
 */
describe('spec 066 leg 3 — the glide interval is measured from snapshot arrivals (AC-6)', () => {
  /**
   * Observe two snapshots `intervalMs` apart, then read the drawn x `elapsedMs`
   * into the second delta. The snapshot pair always bridges the same 9-cell gap,
   * so only the cadence and the elapsed time differ.
   */
  function glideAtElapsed(
    intervalMs: number,
    elapsedMs: number,
  ): { drawn: number; p1: number; p2: number } {
    const W = 800;
    const H = 600;
    const sb = makeSandbox({ width: W, height: H, dpr: 1, raf: true });
    const viewport = { width: W, height: H, insets: ZERO_INSETS };
    const before = {
      ...makeState(),
      agents: [coLocatedAgent('a1', 'Alice', { x: 2, y: 4 })],
    } as unknown as VisualizerState;
    const after = {
      ...makeState(),
      agents: [coLocatedAgent('a1', 'Alice', { x: 11, y: 4 })],
    } as unknown as VisualizerState;

    sb.ws.onmessage?.({ data: JSON.stringify(before) });
    sb.tick(1000);
    sb.ws.onmessage?.({ data: JSON.stringify(after) });
    sb.tick(1000 + intervalMs);
    sb.tick(1000 + intervalMs + elapsedMs);

    const names = sb.ctx.calls
      .filter((c) => c.method === 'fillText' && c.args[0] === 'Alice')
      .map((c) => c.args as [string, number, number]);
    return {
      drawn: names.at(-1)![1],
      p1: layoutWorld(before, viewport).agents[0]!.x,
      p2: layoutWorld(after, viewport).agents[0]!.x,
    };
  }

  it('paces a slower 0.2 s cadence over 0.2 s, not the 0.1 s default', () => {
    // Half the measured interval elapsed ⇒ half-way. A hardcoded 0.1 s interval
    // would have already arrived here.
    const r = glideAtElapsed(200, 100);
    expect(r.drawn).toBeCloseTo((r.p1 + r.p2) / 2, 3);
  });

  it('paces a faster 0.05 s cadence over 0.05 s, not the 0.1 s default', () => {
    // Half the measured interval elapsed ⇒ half-way. A hardcoded 0.1 s interval
    // would have moved only a quarter of the delta.
    const r = glideAtElapsed(50, 25);
    expect(r.drawn).toBeCloseTo((r.p1 + r.p2) / 2, 3);
  });
});

/**
 * Spec 066 leg 4, R4 — the control bar reports the true state (AC-8, AC-9, AC-10).
 *
 * D4 observed on a live phone run: the Fog button looked off while the view
 * started fogged, and the scene selector showed `minimal` while the coffee-shop
 * scene was running. The selector could not be made truthful in scope —
 * `VisualizerState` carries no scene id, and spec 066's Constraints forbid
 * adding one — so it was removed at the human gate, together with Save/Load
 * (which no-op silently without persistence). These cases pin the removals
 * and the startup fog class on the *served bundle*, not a copy.
 */
describe('spec 066 leg 4 — truthful controls (AC-8, AC-9, AC-10)', () => {
  it('the Fog button carries `on` at startup, matching the fogged initial view (AC-9)', () => {
    // `showFog` initialises to `true` (agents hidden) but the `on` class was
    // only ever toggled on click, so the button looked off while the view was
    // fogged. Red on current `main`.
    const sb = makeSandbox({ width: 800, height: 600, dpr: 1, raf: true });
    expect(sb.fogButton.classList.contains('on')).toBe(true);
  });

  it('the Fog button toggles `on` off and back on with the fog state (AC-9)', () => {
    const sb = makeSandbox({ width: 800, height: 600, dpr: 1, raf: true });
    expect(sb.fogButton.classList.contains('on')).toBe(true);
    sb.fogButton.onclick?.();
    expect(sb.fogButton.classList.contains('on')).toBe(false);
    sb.fogButton.onclick?.();
    expect(sb.fogButton.classList.contains('on')).toBe(true);
  });

  it('the Fog button’s active class tracks the actual fog view at startup and after each toggle (AC-9)', () => {
    // D4's harm was not cosmetic: a dispatcher diagnostic keyed off this class,
    // so the class must match the *view*, not merely be present. Read the view
    // through the selection card (a fogged agent is not hit-tested), which is
    // independent of the class the same variable already feeds.
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
        coLocatedAgent('a2', 'Hidden', { x: 11, y: 4 }),
      ],
    } as unknown as VisualizerState;
    sb.ws.onmessage?.({ data: JSON.stringify(state) });
    const layout = layoutWorld(state, { width: 800, height: 600, insets: ZERO_INSETS });
    const hidden = layout.agents.find((a) => a.id === 'a2')!;
    const handlers = sb.canvasListeners['pointerdown'] ?? [];
    const tapHidden = (): void => {
      for (const fn of handlers) fn({ clientX: hidden.x, clientY: hidden.y });
    };
    const cardHidden = (): boolean => sb.detailEl.classList.contains('hidden');

    // Startup: the view is fogged, so the class is `on` and the hidden agent
    // is not selectable.
    expect(sb.fogButton.classList.contains('on')).toBe(true);
    tapHidden();
    expect(cardHidden()).toBe(true);

    // Toggle off: class off, and the agent becomes drawn and selectable.
    sb.fogButton.onclick?.();
    expect(sb.fogButton.classList.contains('on')).toBe(false);
    tapHidden();
    expect(cardHidden()).toBe(false);

    // Toggle back on: class on, and the agent is hidden again.
    sb.fogButton.onclick?.();
    expect(sb.fogButton.classList.contains('on')).toBe(true);
    tapHidden();
    expect(cardHidden()).toBe(true);
  });

  it('the client bundle hardcodes no scene list and sends no selectScene (AC-8)', () => {
    const js = getClientBundle();
    expect(js).not.toContain('sceneSelect');
    expect(js).not.toContain('selectScene');
    expect(js).not.toContain('coffee-shop');
    expect(js).not.toContain('morning-routine');
  });

  it('the client bundle keeps no Save/Load controls and no prompt() path (AC-10)', () => {
    const js = getClientBundle();
    expect(js).not.toContain('btnSave');
    expect(js).not.toContain('btnLoad');
    expect(js).not.toContain('prompt(');
    // The server-side command protocol is unchanged (out of scope); only the
    // client stops sending these.
    expect(js).not.toContain("{ type: 'save' }");
    expect(js).not.toContain("{ type: 'load'");
  });
});
