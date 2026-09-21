/**
 * client/ — Browser entry for the served visualizer page (spec 042, issue #155;
 * mobile shell per spec 062, issue #231).
 * ────────────────────────────────────────────────────────────────────────────
 * DOM/WebSocket glue ONLY. Every visual rule lives in `../renderer/`, which
 * this file imports and the server bundles into the single HTML page with
 * esbuild (spec 042, Design Decisions 1–3). The browser therefore runs the
 * exact module the test suite covers.
 *
 * Keeps the spec-023 browser contract: the server inlines this bundle into one
 * HTML response (inline CSS + JS).
 *
 * Spec 062 responsibilities: device-pixel-ratio correct backing store, layout
 * recomputed from the CURRENT viewport (never cached), HUD insets measured from
 * the DOM and handed to the layout, and frame-rate-independent gliding between
 * snapshots.
 */

import { CanvasRenderer } from '../renderer/canvas-renderer.js';
import { layoutWorld, smoothTowards } from '../renderer/layout.js';
import type { Insets, Point } from '../renderer/layout.js';
import type { VisualizerState } from '@evol-hive/shared';

/** A control command sent to the server over the WebSocket. */
type Command =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'setSpeed'; timeScale: number }
  | { type: 'save' }
  | { type: 'load'; stateJson: string }
  | { type: 'selectScene'; sceneId: string };

/** Seconds for an agent to close half the distance to its new cell. */
const GLIDE_HALF_LIFE_S = 0.09;
const MAX_DPR = 3;

function getElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`visualizer: missing #${id}`);
  return el;
}

function main(): void {
  const canvas = getElement('canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('visualizer: 2D canvas context unavailable');

  const renderer = new CanvasRenderer(ctx);

  let viewportW = typeof window.innerWidth === 'number' ? window.innerWidth : 800;
  let viewportH = typeof window.innerHeight === 'number' ? window.innerHeight : 600;

  /** Size the backing store to CSS pixels × DPR (crisp on phones), guarded
   * for the test sandbox which provides only a stub canvas. */
  function resize(): void {
    viewportW = typeof window.innerWidth === 'number' ? window.innerWidth : viewportW;
    viewportH = typeof window.innerHeight === 'number' ? window.innerHeight : viewportH;
    const dpr = Math.min(
      typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1,
      MAX_DPR,
    );
    canvas.width = Math.round(viewportW * dpr);
    canvas.height = Math.round(viewportH * dpr);
    const style = (canvas as unknown as { style?: { width: string; height: string } }).style;
    if (style !== undefined) {
      style.width = `${viewportW}px`;
      style.height = `${viewportH}px`;
    }
    const anyCtx = ctx as unknown as { setTransform?: (...args: number[]) => void };
    if (typeof anyCtx.setTransform === 'function') anyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Measured HUD space so the world never hides behind the controls (R7). */
  function measureInsets(): Insets {
    const rectOf = (id: string): { top: number; bottom: number } | null => {
      const el = document.getElementById(id) as unknown as {
        getBoundingClientRect?: () => { top: number; bottom: number };
      } | null;
      if (el === null || typeof el.getBoundingClientRect !== 'function') return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    };
    const top = rectOf('top');
    const bottom = rectOf('bottom');
    return {
      top: top !== null ? Math.max(0, top.bottom) : 0,
      right: 0,
      bottom: bottom !== null ? Math.max(0, viewportH - bottom.top) : 0,
      left: 0,
    };
  }

  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));

  // ── Live state + glide ───────────────────────────────────────────────────
  let latest: VisualizerState | null = null;
  const smoothed = new Map<string, Point>();
  let lastTs = 0;
  let showFog = true;

  function draw(): void {
    if (latest === null) return;
    const insets = measureInsets();
    renderer.render(latest, {
      insets,
      width: viewportW,
      height: viewportH,
      agentPositions: smoothed,
      showFog,
    });
  }

  function frame(ts: number): void {
    const dt = lastTs === 0 ? 0 : Math.min((ts - lastTs) / 1000, 0.1);
    lastTs = ts;
    if (latest !== null) {
      // Targets come from the pure layout; the smoother owns time (R2).
      const layout = layoutWorld(latest, {
        width: viewportW,
        height: viewportH,
        insets: measureInsets(),
      });
      for (const at of layout.agents) {
        const current = smoothed.get(at.id) ?? { x: at.x, y: at.y };
        smoothed.set(at.id, {
          x: smoothTowards(current.x, at.x, dt, GLIDE_HALF_LIFE_S),
          y: smoothTowards(current.y, at.y, dt, GLIDE_HALF_LIFE_S),
        });
      }
      renderer.render(latest, {
        insets: measureInsets(),
        width: viewportW,
        height: viewportH,
        agentPositions: smoothed,
        showFog,
      });
    }
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(frame);
  }

  // WebSocket wiring: same origin, scheme follows the page (spec 063, R2 — an
  // https page cannot open ws://). Every snapshot updates the latest state;
  // the rAF loop above renders it.
  const scheme =
    typeof location.protocol === 'string' && location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/`);
  const net = document.getElementById('net');
  ws.onopen = () => {
    if (net !== null) {
      net.textContent = 'live';
      (net as unknown as { classList?: { add(c: string): void } }).classList?.add('live');
    }
  };
  ws.onclose = () => {
    if (net !== null) {
      net.textContent = 'offline';
      (net as unknown as { classList?: { remove(c: string): void } }).classList?.remove('live');
    }
  };
  ws.onmessage = (ev: MessageEvent) => {
    try {
      const parsed = JSON.parse(String(ev.data)) as VisualizerState;
      // Drop smoothing state for agents that disappeared.
      const ids = new Set(parsed.agents.map((a) => a.agentId));
      for (const id of [...smoothed.keys()]) if (!ids.has(id)) smoothed.delete(id);
      latest = parsed;
      if (typeof window.requestAnimationFrame !== 'function') draw();
    } catch (e) {
      console.error(e);
    }
  };

  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(frame);

  function send(command: Command): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(command));
  }

  // Controls (spec 023, Req 15).
  (getElement('btnPlay') as HTMLButtonElement).onclick = () => send({ type: 'play' });
  (getElement('btnPause') as HTMLButtonElement).onclick = () => send({ type: 'pause' });
  document.querySelectorAll<HTMLButtonElement>('.speed').forEach((button) => {
    button.onclick = () => {
      send({ type: 'setSpeed', timeScale: Number(button.dataset.speed) });
    };
  });
  (getElement('btnSave') as HTMLButtonElement).onclick = () => send({ type: 'save' });
  // Fog is a VIEW toggle, not a simulation command (spec 062, R6).
  const btnFog = getElement('btnFog') as HTMLButtonElement;
  btnFog.onclick = () => {
    showFog = !showFog;
    (
      btnFog as unknown as { classList?: { toggle(c: string, on: boolean): void } }
    ).classList?.toggle('on', showFog);
  };
  (getElement('btnLoad') as HTMLButtonElement).onclick = () => {
    const json = prompt('Paste save state JSON:');
    if (json !== null && json !== '') send({ type: 'load', stateJson: json });
  };
  const sceneSelect = getElement('sceneSelect') as HTMLSelectElement;
  for (const id of ['minimal', 'morning-routine', 'coffee-shop']) {
    const option = document.createElement('option');
    option.value = id;
    option.text = id;
    sceneSelect.appendChild(option);
  }
  sceneSelect.onchange = () => {
    send({ type: 'selectScene', sceneId: sceneSelect.value });
  };
}

main();
