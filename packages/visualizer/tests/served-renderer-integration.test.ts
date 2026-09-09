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
          { id: 'workbench-1', name: 'Bench', type: 'furniture', state: {}, cell: { x: 3, y: 3 }, affordances: [] },
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

    // ── Grid-cell positioning (canvas-renderer.ts math) ────────────────────
    // Layout for 2 rooms on an 800×600 canvas: cols=2, cellW=380, cellH=520,
    // room 360×500; garden at (30, 50). Grid cell (11, 4) →
    //   x = 30 + (11.5 × 360) / 12 = 375
    //   y = 50 + (4.5 × 500) / 8 = 331.25
    const arcsAt = ctx.calls
      .filter((c) => c.method === 'arc')
      .map((c) => c.args as number[]);
    const agentCenter = arcsAt.filter(
      ([x, y]) => Math.abs(x - 375) < 0.01 && Math.abs(y - 331.25) < 0.01,
    );
    expect(agentCenter.length).toBeGreaterThanOrEqual(2); // phase ring + avatar
    // The legacy static row would place agent 0 at (30 + 40 + 0, 50 + 500 − 50).
    const legacySlot = arcsAt.filter(([x, y]) => x === 70 && y === 500);
    expect(legacySlot.length).toBe(0);

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
    const texts = ctx.calls
      .filter((c) => c.method === 'fillText')
      .map((c) => String(c.args[0]));
    expect(texts).toContain('Planter'); // explored cell — visible
    expect(texts).not.toContain('Shed'); // fogged cell — hidden
  });
});