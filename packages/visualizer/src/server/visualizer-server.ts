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

  /** Serve the HTML page at GET /. */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this.buildHtmlPage());
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
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>evol-hive Visualizer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: monospace; overflow: hidden; }
  #canvas { display: block; width: 100vw; height: 100vh; }
  #controls {
    position: fixed; top: 8px; left: 8px; z-index: 10;
    background: rgba(22, 33, 62, 0.85); padding: 8px 12px; border-radius: 6px;
    display: flex; gap: 8px; align-items: center; font-size: 13px; flex-wrap: wrap;
  }
  #controls button, #controls select {
    background: #0f3460; color: #e0e0e0; border: 1px solid #4a6fa5;
    padding: 4px 10px; border-radius: 4px; cursor: pointer; font-family: monospace;
  }
  #controls button:hover { background: #1a4a80; }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<div id="controls">
  <button id="btnPlay">&#9654; Play</button>
  <button id="btnPause">&#9208; Pause</button>
  <span>Speed:</span>
  <button class="speed" data-speed="1">1&times;</button>
  <button class="speed" data-speed="2">2&times;</button>
  <button class="speed" data-speed="5">5&times;</button>
  <button id="btnSave">&#128190; Save</button>
  <button id="btnLoad">&#128194; Load</button>
  <select id="sceneSelect"></select>
</div>
<script>
${getClientBundle()}
</script>
</body>
</html>`;
  }
}
