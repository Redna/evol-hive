/**
 * Spec 042 — Visualizer Single Renderer (issue #155)
 * Served-renderer integration test (AC-4).
 *
 * Connects a WebSocket client to the running VisualizerServer, receives the
 * exact state JSON a browser would receive (position + fog payload), then
 * executes the SERVED page JavaScript (extracted from `GET /`) in a sandbox
 * with a mock 2D canvas — proving the *served* code, not just the module,
 * passes the `canvas-renderer-fog.test.ts` assertions: the agent draws at its
 * grid cell (not the legacy static row) and unexplored cells get fog shading.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { VisualizerState, VisualizerCommand, SceneDefinition } from '@evol-hive/shared';
import { VisualizerServer } from '../src/server/visualizer-server.js';
import { layoutWorld, cellCenter, legacySlot, ZERO_INSETS } from '../src/renderer/layout.js';

interface RecordedCall {
  method: string;
  args: unknown[];
}

/** Minimal CanvasRenderingContext2D mock that records every draw call. */
class MockContext {
  readonly calls: RecordedCall[] = [];
  canvas: { width: number; height: number };

  private _fillStyle = '#000';
  lineWidth = 1;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';

  constructor(canvas: { width: number; height: number }) {
    this.canvas = canvas;
  }

  get fillStyle(): string {
    return this._fillStyle;
  }
  set fillStyle(value: string) {
    this._fillStyle = value;
    this.calls.push({ method: 'fillStyle', args: [value] });
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

/** WebSocket stand-in captured by the sandbox; the test drives `onmessage`. */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readyState = 1;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(_data: string): void {}
  close(): void {}
}

function makeStubElement(): Record<string, unknown> {
  return { onclick: null, onchange: null, dataset: {}, value: '', text: '', appendChild() {} };
}

/** Run the page JS with DOM/WS mocks; returns the captured WebSocket. */
function executePageJs(pageJs: string): MockWebSocket {
  MockWebSocket.instances = [];
  const canvas = {
    width: 800,
    height: 600,
    getContext: (_type: string) => ctx,
  };
  const doc = {
    getElementById(id: string): Record<string, unknown> {
      if (id === 'canvas') return canvas as unknown as Record<string, unknown>;
      return makeStubElement();
    },
    querySelectorAll(_sel: string): Record<string, unknown>[] {
      return [makeStubElement(), makeStubElement(), makeStubElement()];
    },
    createElement(_tag: string): Record<string, unknown> {
      return makeStubElement();
    },
  };
  const win = {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: (_: string, __: () => void) => {},
  };
  const location = { host: 'localhost:9' };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const run = new Function('document', 'window', 'WebSocket', 'location', 'prompt', pageJs);
  run(doc, win, MockWebSocket, location, () => '');
  const ws = MockWebSocket.instances.at(-1);
  if (!ws) throw new Error('page JS did not open a WebSocket');
  return ws;
}

// ── Fixtures (mirror canvas-renderer-fog.test.ts) ───────────────────────────

const FOG_CELL_FILL = 'rgba(10, 10, 24, 0.78)';

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
    ],
  } as unknown as VisualizerState;
}

// ── Server scaffolding ──────────────────────────────────────────────────────

const minimalScene: SceneDefinition = {
  id: 'minimal',
  name: 'Minimal',
  rooms: [{ id: 'kitchen', name: 'Kitchen', description: '', connections: [], objectIds: [] }],
  objects: [],
  agents: [],
};

let server: VisualizerServer | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

/** Connect a WebSocket client and resolve on open. */
function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/`);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(e));
  });
}

/** Wait for the next message on a WebSocket. */
function waitForMessage(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    ws.addEventListener('message', (e: MessageEvent) => {
      clearTimeout(timer);
      resolve(typeof e.data === 'string' ? e.data : String(e.data));
    });
  });
}

let ctx: MockContext;

describe('served renderer integration (spec 042, AC-4)', () => {
  it('draws the fogged state at grid cells using the SERVED page code', async () => {
    ctx = new MockContext({ width: 800, height: 600 });
    const fogState = makeFogState();
    server = new VisualizerServer({
      adapter: {
        getSnapshot: () => fogState,
        handleCommand: async (_cmd: VisualizerCommand) => {},
      },
      port: 0,
      snapshotRateMs: 50,
      scenes: new Map<string, SceneDefinition>([['minimal', minimalScene]]),
    });
    await server.start();
    const port = server.getPort();

    // 1. A real WebSocket client receives the exact browser payload.
    const ws = await connectWs(port);
    const snapshotJson = await waitForMessage(ws);
    const parsed = JSON.parse(snapshotJson) as VisualizerState;
    expect(parsed.agents[0]?.position).toEqual({ x: 11, y: 4 });
    expect(parsed.agents[0]?.fog).toBeDefined();
    ws.close();

    // 2. Fetch the page and execute the SERVED JavaScript on a canvas mock.
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const match = /<script>([\s\S]*)<\/script>/.exec(html);
    if (!match) throw new Error('no inline script found in served page');
    const wsMock = executePageJs(match[1]!);

    // 3. Feed the real snapshot through the page's WebSocket wiring.
    wsMock.onmessage?.({ data: snapshotJson });

    // ── Grid-cell positioning (spec 062 pure layout seam) ─────────────────
    // Expected positions come from the module's own `layoutWorld` seam, so the
    // assertion stays stable under layout tuning while still proving the
    // SERVED code renders where the module says.
    const garden = layoutWorld(fogState, {
      width: 800,
      height: 600,
      insets: ZERO_INSETS,
    }).rooms.find((r) => r.roomId === 'garden');
    if (garden === undefined) throw new Error('no garden room');
    const gridCell = cellCenter(garden.rect, { x: 11, y: 4 });
    const arcsAt = ctx.calls.filter((c) => c.method === 'arc').map((c) => c.args as number[]);
    const agentCenter = arcsAt.filter(
      ([x, y]) => Math.abs(x - gridCell.x) < 0.01 && Math.abs(y - gridCell.y) < 0.01,
    );
    expect(agentCenter.length).toBeGreaterThanOrEqual(2); // phase ring + avatar
    // A positioned agent must never use the legacy slot.
    const slot = legacySlot(garden.rect, 0);
    const atSlot = arcsAt.filter(
      ([x, y]) => Math.abs(x - slot.x) < 0.01 && Math.abs(y - slot.y) < 0.01,
    );
    expect(atSlot.length).toBe(0);

    // ── Fog shading (spec 039, R8) ─────────────────────────────────────────
    // 12×8 = 96 cells per room; 4 garden cells explored, workshop unseen →
    // 92 garden fog cells + 96 workshop cells = 188.
    const fogRects: { fill: string; args: unknown[] }[] = [];
    let current = '';
    for (const call of ctx.calls) {
      if (call.method === 'fillStyle') current = String(call.args[0]);
      else if (call.method === 'fillRect' && current === FOG_CELL_FILL)
        fogRects.push({ fill: current, args: call.args });
    }
    expect(fogRects.length).toBe(92 + 96);

    // ── Fog hides out-of-fog objects (spec 039, R8) ────────────────────────
    const texts = ctx.calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0]));
    expect(texts).toContain('Planter'); // explored cell — visible
    expect(texts).not.toContain('Shed'); // fogged cell — hidden
  });

  it('keeps the Decision-4 legacy-slot fallback working through the SERVED code', async () => {
    // Spec 042, Decision 4 / R1: when `agent.position === undefined` (old
    // saves, legacy states) the served renderer must fall back to the legacy
    // slot formula — `roomPos.x + 40 + idx * 60`, `roomPos.y + roomPos.h -
    // 50` — exactly as the module does. This is the branch the grid-cell
    // test above does not exercise (its fixture carries a position).
    ctx = new MockContext({ width: 800, height: 600 });
    const legacyState = makeFogState();
    delete (legacyState.agents[0] as { position?: unknown }).position;
    server = new VisualizerServer({
      adapter: {
        getSnapshot: () => legacyState,
        handleCommand: async (_cmd: VisualizerCommand) => {},
      },
      port: 0,
      snapshotRateMs: 50,
      scenes: new Map<string, SceneDefinition>([['minimal', minimalScene]]),
    });
    await server.start();
    const port = server.getPort();

    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const match = /<script>([\s\S]*)<\/script>/.exec(html);
    if (!match) throw new Error('no inline script found in served page');
    const wsMock = executePageJs(match[1]!);
    wsMock.onmessage?.({ data: JSON.stringify(legacyState) });

    const garden = layoutWorld(legacyState, {
      width: 800,
      height: 600,
      insets: ZERO_INSETS,
    }).rooms.find((r) => r.roomId === 'garden');
    if (garden === undefined) throw new Error('no garden room');
    const arcsAt = ctx.calls.filter((c) => c.method === 'arc').map((c) => c.args as number[]);
    const slot = legacySlot(garden.rect, 0);
    const atSlot = arcsAt.filter(
      ([x, y]) => Math.abs(x - slot.x) < 0.01 && Math.abs(y - slot.y) < 0.01,
    );
    expect(atSlot.length).toBeGreaterThanOrEqual(2); // phase ring + avatar
    // No grid cell was computed for the positionless agent.
    const cell = cellCenter(garden.rect, { x: 11, y: 4 });
    const atCell = arcsAt.filter(
      ([x, y]) => Math.abs(x - cell.x) < 0.01 && Math.abs(y - cell.y) < 0.01,
    );
    expect(atCell.length).toBe(0);
  });
});
