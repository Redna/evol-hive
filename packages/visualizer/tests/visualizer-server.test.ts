/**
 * Spec 023 — Visual Output Canvas Renderer
 * VisualizerServer (AC-9, AC-10, AC-11, AC-12, AC-16).
 *
 * Starts a real HTTP + WebSocket server on a random port and connects a
 * browser-compatible WebSocket client (Node's built-in global) to verify the
 * handshake, snapshot pushing, command forwarding, scene resolution, and
 * clean shutdown.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { VisualizerState, VisualizerCommand, SceneDefinition } from '@evol-hive/shared';
import { VisualizerServer } from '../src/server/visualizer-server.js';

interface MockAdapter {
  getSnapshot: ReturnType<typeof vi.fn>;
  handleCommand: ReturnType<typeof vi.fn>;
}

function makeMockAdapter(): MockAdapter {
  const snapshot: VisualizerState = {
    tickNumber: 3,
    simulationTime: 0.05,
    isRunning: true,
    timeScale: 1,
    rooms: [
      {
        id: 'kitchen',
        name: 'Kitchen',
        description: '',
        connections: [],
        objects: [],
      },
    ],
    agents: [],
  };
  return {
    getSnapshot: vi.fn(() => snapshot),
    handleCommand: vi.fn(async (_cmd: VisualizerCommand) => {}),
  };
}

const minimalScene: SceneDefinition = {
  id: 'minimal',
  name: 'Minimal',
  rooms: [{ id: 'kitchen', name: 'Kitchen', description: '', connections: [], objectIds: [] }],
  objects: [],
  agents: [],
};

let server: VisualizerServer | null = null;

async function startServer(
  adapter: MockAdapter,
  scenes = new Map<string, SceneDefinition>([['minimal', minimalScene]]),
  opts: { snapshotRateMs?: number; port?: number } = {},
): Promise<{ server: VisualizerServer; port: number }> {
  const srv = new VisualizerServer({
    adapter,
    port: opts.port ?? 0,
    scenes,
    ...(opts.snapshotRateMs !== undefined ? { snapshotRateMs: opts.snapshotRateMs } : {}),
  });
  server = srv;
  await srv.start();
  const port = srv.getPort();
  return { server: srv, port };
}

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

describe('VisualizerServer — HTTP (AC-9)', () => {
  it('responds to GET / with an HTML page containing a canvas element', async () => {
    const adapter = makeMockAdapter();
    const { port } = await startServer(adapter);
    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<canvas');
  });

  it('includes Sec-WebSocket-Accept header on WebSocket upgrade', async () => {
    const adapter = makeMockAdapter();
    const { port } = await startServer(adapter);
    // Connect a WebSocket — the handshake response includes the accept header.
    // If the handshake fails, connectWs rejects.
    const ws = await connectWs(port);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe('VisualizerServer — snapshot pushing (AC-10)', () => {
  it('pushes VisualizerState snapshots containing required fields', async () => {
    const adapter = makeMockAdapter();
    const { port } = await startServer(adapter, undefined, { snapshotRateMs: 50 });
    const ws = await connectWs(port);
    const raw = await waitForMessage(ws);
    const parsed = JSON.parse(raw) as VisualizerState;
    expect(parsed).toHaveProperty('tickNumber');
    expect(parsed).toHaveProperty('rooms');
    expect(parsed).toHaveProperty('agents');
    expect(parsed).toHaveProperty('isRunning');
    expect(parsed).toHaveProperty('timeScale');
    ws.close();
  });

  it('calls adapter.getSnapshot() when pushing', async () => {
    const adapter = makeMockAdapter();
    const { port } = await startServer(adapter, undefined, { snapshotRateMs: 50 });
    const ws = await connectWs(port);
    await waitForMessage(ws);
    expect(adapter.getSnapshot).toHaveBeenCalled();
    ws.close();
  });
});

describe('VisualizerServer — command forwarding (AC-11)', () => {
  it('forwards a pause command to the adapter', async () => {
    const adapter = makeMockAdapter();
    const { port } = await startServer(adapter, undefined, { snapshotRateMs: 50 });
    const ws = await connectWs(port);
    // Wait for at least one snapshot so the connection is fully established.
    await waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'pause' }));
    // Wait a tick for the server to process.
    await new Promise((r) => setTimeout(r, 100));
    expect(adapter.handleCommand).toHaveBeenCalledWith({ type: 'pause' });
    ws.close();
  });

  it('forwards a setSpeed command with timeScale', async () => {
    const adapter = makeMockAdapter();
    const { port } = await startServer(adapter, undefined, { snapshotRateMs: 50 });
    const ws = await connectWs(port);
    await waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'setSpeed', timeScale: 5 }));
    await new Promise((r) => setTimeout(r, 100));
    expect(adapter.handleCommand).toHaveBeenCalledWith({ type: 'setSpeed', timeScale: 5 });
    ws.close();
  });
});

describe('VisualizerServer — selectScene resolution (AC-12)', () => {
  it('resolves sceneId and forwards selectScene to the adapter', async () => {
    const adapter = makeMockAdapter();
    const scenes = new Map<string, SceneDefinition>([['minimal', minimalScene]]);
    const { port } = await startServer(adapter, scenes, { snapshotRateMs: 50 });
    const ws = await connectWs(port);
    await waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'selectScene', sceneId: 'minimal' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(adapter.handleCommand).toHaveBeenCalledWith({
      type: 'selectScene',
      sceneId: 'minimal',
    });
    ws.close();
  });
});

describe('VisualizerServer — stop (AC-16)', () => {
  it('stop() closes the HTTP server and WebSocket connections', async () => {
    const adapter = makeMockAdapter();
    const { server: srv, port } = await startServer(adapter, undefined, { snapshotRateMs: 50 });
    const ws = await connectWs(port);
    await waitForMessage(ws);
    let closed = false;
    ws.addEventListener('close', () => {
      closed = true;
    });
    await srv.stop();
    server = null;
    // The WebSocket should be closed.
    await new Promise((r) => setTimeout(r, 200));
    expect(closed).toBe(true);
    // The HTTP server should no longer respond.
    await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow();
  });
});
