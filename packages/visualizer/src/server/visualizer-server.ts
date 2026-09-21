/**
 * server/ — HTTP + WebSocket server for the visualizer (spec 023, Req 13–16)
 * ─────────────────────────────────────────────────────────────────────────
 * Serves a single HTML page (with inline CSS + the bundled renderer JS) at
 * `GET /` and upgrades WebSocket connections at the same port. The page's JS
 * is produced by bundling the real renderer module
 * (`src/renderer/canvas-renderer.ts`) with the DOM/WebSocket glue
 * (`src/client/main.ts`) via `getClientBundle()` — there is no hand-maintained
 * inline template (spec 042, issue #155). The WebSocket layer is hand-rolled
 * (RFC 6455 frame encoding/decoding using only Node.js built-in `http`,
 * `crypto`, and `Buffer`) — no external `ws` library (spec 023, Constraint:
 * no external dependencies).
 *
 * The server pushes `VisualizerState` snapshots at a configurable rate
 * (default 10 FPS) by calling `adapter.getSnapshot()` and sending the
 * JSON-serialized state as a WebSocket text frame. Incoming WebSocket
 * messages are parsed as `VisualizerCommand` JSON and passed to
 * `adapter.handleCommand()`.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { VisualizerInterface, VisualizerCommand, SceneDefinition } from '@evol-hive/shared';
import { getClientBundle } from './client-bundle.js';

/** The WebSocket GUID from RFC 6455. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Hand-written service worker (spec 063, R4). No dependency, no build step.
 * Network-first for same-origin GETs with a shell cache fallback; the live
 * channel is a WebSocket, which never reaches this handler and is never cached.
 * Bump `SHELL_CACHE` whenever the page shell changes.
 */
const SERVICE_WORKER_JS = `
const SHELL_CACHE = 'evol-hive-visualizer-shell-v1';
const SHELL = ['./', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('./'))),
  );
});
`;

/** App icon served at `/icon.svg` (relative URLs keep it working behind a path prefix). */
const APP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0b0f1a"/><circle cx="256" cy="256" r="150" fill="none" stroke="#5eead4" stroke-width="26"/><circle cx="256" cy="256" r="58" fill="#5eead4"/></svg>`;

/** Constructor options for {@link VisualizerServer}. */
export interface VisualizerServerOptions {
  adapter: VisualizerInterface;
  port: number;
  scenes: Map<string, SceneDefinition>;
  /** Snapshot push rate in milliseconds (default 100 = 10 FPS). */
  snapshotRateMs?: number;
}

/** A single connected WebSocket client. */
interface WsConnection {
  socket: Duplex;
  buffer: Buffer;
  closed: boolean;
}

/**
 * HTTP + WebSocket server that streams simulation state to a browser and
 * receives control commands (spec 023, Req 13–16).
 */
export class VisualizerServer {
  private readonly adapter: VisualizerInterface;
  private readonly scenes: Map<string, SceneDefinition>;
  private readonly snapshotRateMs: number;
  private readonly configuredPort: number;
  private readonly httpServer: http.Server;
  private readonly connections = new Set<WsConnection>();
  private pushInterval: ReturnType<typeof setInterval> | null = null;
  private listeningPort = 0;

  constructor(options: VisualizerServerOptions) {
    this.adapter = options.adapter;
    this.scenes = options.scenes;
    this.snapshotRateMs = options.snapshotRateMs ?? 100;
    this.configuredPort = options.port;
    this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
    this.httpServer.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
  }

  /** Start listening on the configured port (spec 023, Req 16). */
  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.configuredPort, () => {
        const addr = this.httpServer.address();
        this.listeningPort = typeof addr === 'object' && addr ? addr.port : this.configuredPort;
        resolve();
      });
    });
    this.pushInterval = setInterval(() => this.pushSnapshots(), this.snapshotRateMs);
  }

  /** Stop the server and close all connections (spec 023, Req 16). */
  async stop(): Promise<void> {
    if (this.pushInterval !== null) {
      clearInterval(this.pushInterval);
      this.pushInterval = null;
    }
    for (const conn of this.connections) {
      if (!conn.closed) {
        this.sendCloseFrame(conn);
        conn.socket.destroy();
        conn.closed = true;
      }
    }
    this.connections.clear();
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  /** The actual port the server is listening on (useful when port 0 is passed). */
  getPort(): number {
    return this.listeningPort;
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  /** Serve the HTML page at GET /. Query strings are ignored (cache-busters). */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // The page is rebuilt from source at dev time; never cache it.
        'Cache-Control': 'no-store',
      });
      res.end(this.buildHtmlPage());
      return;
    }
    if (req.method === 'GET' && pathname === '/manifest.webmanifest') {
      res.writeHead(200, {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(this.buildManifest());
      return;
    }
    if (req.method === 'GET' && pathname === '/sw.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(SERVICE_WORKER_JS);
      return;
    }
    if (req.method === 'GET' && pathname === '/icon.svg') {
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(APP_ICON_SVG);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  // ── WebSocket upgrade & handshake (spec 023, Req 13) ──────────────────────

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, _head: Buffer): void {
    const key = req.headers['sec-websocket-key'] as string | undefined;
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    // Compute the accept value: base64(sha1(key + GUID)) (spec 023, Req 13).
    const accept = crypto
      .createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    );

    const conn: WsConnection = { socket, buffer: Buffer.alloc(0), closed: false };
    this.connections.add(conn);

    socket.on('data', (data: Buffer) => this.handleData(conn, data));
    socket.on('close', () => {
      conn.closed = true;
      this.connections.delete(conn);
    });
    socket.on('error', () => {
      conn.closed = true;
      this.connections.delete(conn);
    });
  }

  // ── WebSocket frame parsing (client → server, masked) — spec 023, Req 14 ──

  private handleData(conn: WsConnection, data: Buffer): void {
    conn.buffer = Buffer.concat([conn.buffer, data]);
    while (conn.buffer.length >= 2) {
      const frame = this.tryParseFrame(conn.buffer);
      if (frame === null) break;
      conn.buffer = conn.buffer.subarray(frame.consumed);
      this.handleFrame(conn, frame);
      if (conn.closed) break;
    }
  }

  /** Parse a single WebSocket frame from the buffer. Returns null if incomplete. */
  private tryParseFrame(buf: Buffer): {
    opcode: number;
    payload: Buffer;
    consumed: number;
  } | null {
    if (buf.length < 2) return null;
    const opcode = (buf[0] ?? 0) & 0x0f;
    const masked = ((buf[1] ?? 0) & 0x80) !== 0;
    let payloadLen = (buf[1] ?? 0) & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < offset + 2) return null;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return null;
      payloadLen = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }

    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLen) return null;

    let payload = buf.subarray(offset, offset + payloadLen);
    if (masked && maskKey) {
      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = (payload[i] ?? 0) ^ (maskKey[i % 4] ?? 0);
      }
      payload = unmasked;
    }

    return { opcode, payload, consumed: offset + payloadLen };
  }

  /** Handle a parsed WebSocket frame (spec 023, Req 14). */
  private handleFrame(conn: WsConnection, frame: { opcode: number; payload: Buffer }): void {
    switch (frame.opcode) {
      case 0x1: {
        // Text frame — parse as VisualizerCommand JSON.
        this.handleCommandMessage(frame.payload.toString('utf8'));
        break;
      }
      case 0x8: {
        // Close frame.
        this.sendCloseFrame(conn);
        conn.socket.destroy();
        conn.closed = true;
        this.connections.delete(conn);
        break;
      }
      case 0x9: {
        // Ping → respond with pong.
        this.sendFrame(conn, 0xa, frame.payload);
        break;
      }
      case 0xa:
        // Pong — ignore.
        break;
    }
  }

  /** Parse a command message and forward to the adapter (spec 023, Req 13). */
  private handleCommandMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const command = parsed as VisualizerCommand;
    if (
      !command ||
      typeof command !== 'object' ||
      typeof (command as { type?: unknown }).type !== 'string'
    ) {
      return;
    }
    // For selectScene, validate the scene exists before forwarding.
    if (command.type === 'selectScene') {
      const sceneId = (command as { sceneId?: string }).sceneId;
      if (sceneId !== undefined && !this.scenes.has(sceneId)) {
        return; // unknown scene — ignore
      }
    }
    void this.adapter.handleCommand(command);
  }

  // ── WebSocket frame encoding (server → client, unmasked) — spec 023, Req 14

  /** Send a text frame with the latest snapshot to all connected clients. */
  private pushSnapshots(): void {
    if (this.connections.size === 0) return;
    let json: string;
    try {
      json = JSON.stringify(this.adapter.getSnapshot());
    } catch {
      return;
    }
    const payload = Buffer.from(json, 'utf8');
    for (const conn of this.connections) {
      if (!conn.closed) {
        this.sendFrame(conn, 0x1, payload);
      }
    }
  }

  /** Construct and write an unmasked WebSocket frame (spec 023, Req 14). */
  private sendFrame(conn: WsConnection, opcode: number, payload: Buffer): void {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    conn.socket.write(Buffer.concat([header, payload]));
  }

  /** Send a close frame (opcode 0x8). */
  private sendCloseFrame(conn: WsConnection): void {
    this.sendFrame(conn, 0x8, Buffer.alloc(0));
  }

  // ── HTML page (spec 023, Req 15) ──────────────────────────────────────────

  /** Web app manifest (spec 063, R4). Relative URLs so a path prefix works. */
  private buildManifest(): string {
    return JSON.stringify(
      {
        name: 'evol-hive visualizer',
        short_name: 'evol-hive',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#0b0f1a',
        theme_color: '#0b0f1a',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      null,
      2,
    );
  }

  /** Build the single HTML page with inline CSS + bundled JS (spec 042). */
  private buildHtmlPage(): string {
    // The page JS is the esbuild bundle of `src/client/main.ts` +
    // `src/renderer/canvas-renderer.ts` (spec 042, Design Decision 1) — built
    // once, cached, and inlined so the browser runs the exact module the test
    // suite covers (spec-023 contract: single HTML, inline JS, no requests).
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0b0f1a" />
<link rel="manifest" href="manifest.webmanifest" />
<link rel="apple-touch-icon" href="icon.svg" />
<title>evol-hive Visualizer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; overflow: hidden; }
  body {
    background: #0b0f1a; color: #e6edf7; overscroll-behavior: none;
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
  }
  #canvas { display: block; width: 100vw; height: 100vh; }
  #top {
    position: fixed; top: calc(env(safe-area-inset-top, 0px) + 8px); left: 12px; right: 12px;
    z-index: 10; display: flex; justify-content: space-between; pointer-events: none;
  }
  .pill {
    background: rgba(18, 25, 41, 0.82); border: 1px solid #26344d; border-radius: 999px;
    padding: 6px 12px; font-size: 12px; color: #8b9bb4;
  }
  #net.live { color: #5eead4; border-color: rgba(94, 234, 212, 0.5); }
  #bottom {
    position: fixed; bottom: calc(env(safe-area-inset-bottom, 0px) + 8px); z-index: 10;
    left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    width: max-content; max-width: calc(100vw - 24px);
    background: rgba(18, 25, 41, 0.82); border: 1px solid #26344d; border-radius: 16px;
    padding: 8px; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
  }
  #bottom button, #bottom select {
    -webkit-appearance: none; appearance: none;
    background: #1b2438; color: #e6edf7; border: 1px solid #26344d;
    border-radius: 11px; padding: 11px 14px; font: inherit; font-size: 13px; font-weight: 600;
    cursor: pointer; min-height: 44px;
  }
  #bottom button:active { background: #243149; }
  #bottom button.on { border-color: rgba(94, 234, 212, 0.5); color: #5eead4; }
  .hidden { display: none !important; }
  #detail {
    position: fixed; left: 12px; right: 12px; z-index: 12;
    top: calc(env(safe-area-inset-top, 0px) + 56px);
    background: rgba(18, 25, 41, 0.92); border: 1px solid #26344d; border-radius: 16px;
    padding: 12px 14px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
  }
  #detail .row { display: flex; align-items: center; gap: 10px; }
  #detail h2 { font-size: 16px; font-weight: 700; }
  #detail .sub { color: #8b9bb4; font-size: 12px; margin-top: 2px; }
  #detail .close { margin-left: auto; border: none; background: transparent; color: #8b9bb4; font-size: 22px; line-height: 1; padding: 4px 8px; cursor: pointer; }
  #detail .drives { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-top: 10px; }
  #detail .drive { font-size: 10px; color: #8b9bb4; text-align: center; }
  #detail .drive .bar { height: 6px; border-radius: 4px; background: #1e2941; overflow: hidden; margin-bottom: 4px; }
  #detail .drive .bar > i { display: block; height: 100%; border-radius: 4px; }
  #detail .plan { margin-top: 10px; font-size: 12px; }
  #detail .plan em { color: #8b9bb4; font-style: normal; }
  .seg { display: flex; gap: 2px; background: #161e30; border-radius: 12px; padding: 2px; border: 1px solid #26344d; }
  .seg button { border: none; background: transparent; color: #8b9bb4; padding: 10px 12px; min-height: 40px; }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<div id="top">
  <span class="pill" id="net">connecting…</span>
</div>
<div id="detail" class="hidden">
  <div class="row">
    <div>
      <h2 id="dName">—</h2>
      <div class="sub" id="dSub">—</div>
    </div>
    <button class="close" id="dClose" aria-label="Clear selection">&#215;</button>
  </div>
  <div class="drives" id="dDrives"></div>
  <div class="plan" id="dPlan"></div>
</div>
<div id="bottom">
  <button id="btnPlay">&#9654; Play</button>
  <button id="btnPause">&#9208; Pause</button>
  <span class="seg">
    <button class="speed" data-speed="1">1&times;</button>
    <button class="speed" data-speed="2">2&times;</button>
    <button class="speed" data-speed="5">5&times;</button>
  </span>
  <button id="btnFog">Fog</button>
  <button id="btnInstall" class="hidden">Install</button>
  <button id="btnSave">Save</button>
  <button id="btnLoad">Load</button>
  <select id="sceneSelect"></select>
</div>
<script>
${getClientBundle()}
</script>
</body>
</html>`;
  }
}
