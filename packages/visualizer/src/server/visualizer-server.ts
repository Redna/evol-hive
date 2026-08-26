/**
 * server/ — HTTP + WebSocket server for the visualizer (spec 023, Req 13–16)
 * ─────────────────────────────────────────────────────────────────────
 * Serves a single HTML page (with inline CSS + JS containing the canvas
 * renderer) at `GET /` and upgrades WebSocket connections at the same port.
 * The WebSocket layer is hand-rolled (RFC 6455 frame encoding/decoding using
 * only Node.js built-in `http`, `crypto`, and `Buffer`) — no external `ws`
 * library (spec 023, Constraint: no external dependencies).
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

  /** Build the single HTML page with inline CSS + JS (no build step, no deps). */
  private buildHtmlPage(): string {
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
${RENDERER_JS}
${CLIENT_JS}
</script>
</body>
</html>`;
  }
}

// ── Inline renderer JS (spec 023, Req 12/15) ────────────────────────────────
// A dependency-free JS port of the CanvasRenderer, embedded as a string so no
// separate file or build step is needed.

const RENDERER_JS = `\
var PHASE_COLORS = { perceive: '#4a90d9', plan: '#f1c40f', execute: '#e67e22', reflect: '#9b59b6' };
var DRIVES = [
  { key: 'energy', color: '#e74c3c' },
  { key: 'hunger', color: '#e67e22' },
  { key: 'social', color: '#3498db' },
  { key: 'comfort', color: '#2ecc71' },
  { key: 'curiosity', color: '#9b59b6' }
];
function layoutRooms(canvas, rooms) {
  var map = new Map();
  var cols = Math.ceil(Math.sqrt(rooms.length)) || 1;
  var cellW = Math.floor((canvas.width - 40) / cols);
  var rows = Math.ceil(rooms.length / cols) || 1;
  var cellH = Math.floor((canvas.height - 80) / rows);
  rooms.forEach(function (room, i) {
    var col = i % cols, row = Math.floor(i / cols);
    map.set(room.id, { x: 20 + col * cellW + 10, y: 40 + row * cellH + 10, w: Math.max(cellW - 20, 200), h: Math.max(cellH - 20, 150) });
  });
  return map;
}
function CanvasRenderer(ctx, canvas) { this.ctx = ctx; this.canvas = canvas; }
CanvasRenderer.prototype.render = function (state) {
  var ctx = this.ctx, c = this.canvas;
  ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, 0, c.width, c.height);
  var layout = layoutRooms(c, state.rooms);
  state.rooms.forEach(function (room) {
    var p = layout.get(room.id); if (!p) return;
    ctx.fillStyle = '#16213e'; ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = '#0f3460'; ctx.lineWidth = 2; ctx.strokeRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = '#e0e0e0'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(room.name, p.x + 8, p.y + 6);
  });
  ctx.strokeStyle = '#444466'; ctx.lineWidth = 2;
  state.rooms.forEach(function (room) {
    var from = layout.get(room.id); if (!from) return;
    room.connections.forEach(function (cid) {
      var to = layout.get(cid); if (!to) return;
      ctx.beginPath(); ctx.moveTo(from.x + from.w/2, from.y + from.h/2); ctx.lineTo(to.x + to.w/2, to.y + to.h/2); ctx.stroke();
    });
  });
  state.rooms.forEach(function (room) {
    var p = layout.get(room.id); if (!p) return;
    room.objects.forEach(function (obj, i) {
      var ox = p.x + 12 + (i % 3) * 70, oy = p.y + 30 + Math.floor(i / 3) * 50;
      ctx.fillStyle = '#2a2a4a'; ctx.fillRect(ox, oy, 60, 30);
      ctx.fillStyle = '#c0c0d0'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(obj.name.slice(0, 8), ox + 2, oy + 2);
      var e = Object.entries(obj.state)[0]; if (e) ctx.fillText(e[0] + ': ' + e[1], ox + 2, oy + 16);
    });
  });
  var positions = new Map();
  state.agents.forEach(function (agent, idx) {
    var rp = layout.get(agent.location); if (!rp) return;
    var x = rp.x + 40 + idx * 60, y = rp.y + rp.h - 50;
    positions.set(agent.agentId, { x: x, y: y });
    var r = 16;
    ctx.strokeStyle = PHASE_COLORS[agent.pperPhase] || '#888'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = agent.isThinking ? '#555577' : '#3498db';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(initials(agent.name), x, y);
    ctx.fillStyle = '#e0e0e0'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(agent.name, x, y + r + 6);
    DRIVES.forEach(function (d, i) {
      var by = y + r + 22 + i * 6, v = agent.drives[d.key];
      ctx.fillStyle = '#333355'; ctx.fillRect(x - r, by, r * 2, 4);
      ctx.fillStyle = d.color; ctx.fillRect(x - r, by, r * 2 * Math.max(0, Math.min(100, v)) / 100, 4);
    });
    if (agent.currentPlan) { ctx.fillStyle = '#888899'; ctx.font = '9px sans-serif'; ctx.fillText(agent.currentPlan.description.slice(0, 24), x, y + r + 50); }
  });
  state.agents.forEach(function (agent) {
    var from = positions.get(agent.agentId); if (!from) return;
    agent.relationships.forEach(function (rel) {
      var to = positions.get(rel.agentId); if (!to) return;
      var op = 0.1 + (Math.max(0, Math.min(100, rel.trust)) / 100) * 0.6;
      ctx.strokeStyle = 'rgba(255,255,255,' + op + ')'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    });
  });
  ctx.fillStyle = '#e0e0e0'; ctx.font = '12px monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText('tick ' + state.tickNumber + ' \\u00b7 ' + state.simulationTime.toFixed(1) + 's \\u00b7 ' + (state.isRunning ? 'running' : 'paused') + ' \\u00b7 ' + state.timeScale + 'x', c.width - 12, 8);
};
function initials(name) { var p = name.trim().split(/\\s+/); if (p.length === 1) return p[0].slice(0, 2).toUpperCase(); return (p[0][0] + p[1][0]).toUpperCase(); }
`;

const CLIENT_JS = `\
(function () {
  var canvas = document.getElementById('canvas');
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  var ctx = canvas.getContext('2d');
  var renderer = new CanvasRenderer(ctx, canvas);
  var ws = new WebSocket('ws://' + location.host + '/');
  ws.onmessage = function (ev) { try { renderer.render(JSON.parse(ev.data)); } catch (e) { console.error(e); } };
  function send(cmd) { if (ws.readyState === 1) ws.send(JSON.stringify(cmd)); }
  document.getElementById('btnPlay').onclick = function () { send({ type: 'play' }); };
  document.getElementById('btnPause').onclick = function () { send({ type: 'pause' }); };
  document.querySelectorAll('.speed').forEach(function (b) {
    b.onclick = function () { send({ type: 'setSpeed', timeScale: Number(b.dataset.speed) }); };
  });
  document.getElementById('btnSave').onclick = function () { send({ type: 'save' }); };
  document.getElementById('btnLoad').onclick = function () {
    var json = prompt('Paste save state JSON:'); if (json) send({ type: 'load', stateJson: json });
  };
  var sel = document.getElementById('sceneSelect');
  ['minimal', 'morning-routine', 'coffee-shop'].forEach(function (id) { var o = document.createElement('option'); o.value = id; o.text = id; sel.appendChild(o); });
  sel.onchange = function () { send({ type: 'selectScene', sceneId: sel.value }); };
  window.addEventListener('resize', function () { canvas.width = window.innerWidth; canvas.height = window.innerHeight; });
})();
`;
