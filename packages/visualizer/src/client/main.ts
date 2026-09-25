/**
 * client/ — Browser entry for the served visualizer page (spec 042, issue #155;
 * mobile shell per specs 062/063, issues #231/#232).
 * ────────────────────────────────────────────────────────────────────────────
 * DOM/WebSocket glue ONLY. Every visual rule lives in `../renderer/`, which
 * this file imports and the server bundles into the single HTML page with
 * esbuild (spec 042, Design Decisions 1–3). The browser therefore runs the
 * exact module the test suite covers.
 *
 * Spec 062: device-pixel-ratio correct backing store, layout recomputed from
 * the CURRENT CSS-pixel viewport, HUD insets measured from the DOM, and
 * frame-rate-independent gliding between snapshots.
 * Spec 063: follow-camera (tap an agent to select and follow it), the
 * selected-agent card, the WebSocket scheme following the page scheme
 * (`wss:` under `https:` — an https page cannot open `ws://`), and PWA
 * registration + install affordance.
 */

import { CanvasRenderer } from '../renderer/canvas-renderer.js';
import { layoutWorld, motionTowards } from '../renderer/layout.js';
import type { Insets, Point, WorldLayout } from '../renderer/layout.js';
import {
  CAMERA_HALF_LIFE_S,
  FIT_ALL_CAMERA,
  cameraFor,
  smoothCamera,
  transformLayout,
} from '../renderer/camera.js';
import type { Camera } from '../renderer/camera.js';
import { DRIVES } from '../renderer/theme.js';
import type { VisualizerState } from '@evol-hive/shared';

/** A control command sent to the server over the WebSocket. */
type Command =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'setSpeed'; timeScale: number }
  | { type: 'save' }
  | { type: 'load'; stateJson: string }
  | { type: 'selectScene'; sceneId: string };

/**
 * Snapshot-cadence fallback, in seconds, used only until the first interval is
 * measured (the server's default `snapshotRateMs = 100`). Motion is paced
 * against the MEASURED interval thereafter (spec 066, R3) — a bootstrap value,
 * never a tuning knob for a given `timeScale`.
 */
const DEFAULT_SNAPSHOT_INTERVAL_S = 0.1;
/**
 * Clamp on the MEASURED interval (s). The minimum keeps a coalesced snapshot
 * pair from dividing by zero; the maximum stops a stalled tab (rAF paused while
 * snapshots kept arriving) from crawling across a multi-second gap when the view
 * resumes. Neither is a pacing constant for a given `timeScale`.
 */
const MIN_SNAPSHOT_INTERVAL_S = 1 / 60;
const MAX_SNAPSHOT_INTERVAL_S = 1;
const MAX_DPR = 3;
/** Tap radius for selecting an agent, in CSS pixels. */
const TAP_RADIUS = 44;

/**
 * In-flight glide for one agent: the delta it is bridging and the pacing it was
 * given. The position is recomputed from `motionTowards` every frame, so this
 * holds no clock — the frame's timestamp is the only time source (spec 066, R3).
 */
interface AgentGlide {
  /** Position currently on screen. */
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
  /** Frame timestamp (ms) at which this delta was delivered. */
  startTs: number;
  /** Seconds over which this delta is traversed — the measured snapshot interval. */
  intervalS: number;
}

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

  /** Size the backing store to CSS pixels × DPR (crisp on phones); guarded for
   * the test sandbox which provides only a stub canvas. */
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

  // ── Live state, glide and camera ─────────────────────────────────────────
  let latest: VisualizerState | null = null;
  /** Screen position handed to the renderer each frame (spec 062, R2). */
  const smoothed = new Map<string, Point>();
  /** In-flight glides, keyed by agent id (spec 066, R3). */
  const glides = new Map<string, AgentGlide>();
  /** Set when a snapshot arrives; consumed by the next frame to measure its cadence. */
  let pendingSnapshot = false;
  let lastSnapshotTs = 0;
  let snapshotIntervalS = DEFAULT_SNAPSHOT_INTERVAL_S;
  let lastTs = 0;
  let showFog = true;
  let selectedAgentId: string | null = null;
  let camera: Camera = FIT_ALL_CAMERA;

  function baseLayout(): WorldLayout | null {
    if (latest === null) return null;
    return layoutWorld(latest, { width: viewportW, height: viewportH, insets: measureInsets() });
  }

  function draw(): void {
    if (latest === null) return;
    renderer.render(latest, {
      insets: measureInsets(),
      width: viewportW,
      height: viewportH,
      agentPositions: smoothed,
      camera,
      showFog,
      ...(selectedAgentId !== null ? { selectedAgentId } : {}),
    });
  }

  function frame(ts: number): void {
    const dt = lastTs === 0 ? 0 : Math.min((ts - lastTs) / 1000, 0.1);
    lastTs = ts;
    const layout = baseLayout();
    if (latest !== null && layout !== null) {
      // Measure the snapshot cadence at the frame that first sees each snapshot.
      // It paces every delta delivered since the previous one (spec 066, R3).
      if (pendingSnapshot) {
        if (lastSnapshotTs > 0) {
          const measured = (ts - lastSnapshotTs) / 1000;
          snapshotIntervalS = Math.min(
            Math.max(measured, MIN_SNAPSHOT_INTERVAL_S),
            MAX_SNAPSHOT_INTERVAL_S,
          );
        }
        lastSnapshotTs = ts;
        pendingSnapshot = false;
      }
      const present = new Set<string>();
      for (const at of layout.agents) {
        present.add(at.id);
        let glide = glides.get(at.id);
        if (glide === undefined) {
          // First sight renders exactly at its projected cell (spec 062, R2).
          glide = {
            x: at.x,
            y: at.y,
            fromX: at.x,
            fromY: at.y,
            targetX: at.x,
            targetY: at.y,
            startTs: ts,
            intervalS: snapshotIntervalS,
          };
          glides.set(at.id, glide);
        } else if (at.x !== glide.targetX || at.y !== glide.targetY) {
          // A snapshot (or a resize) delivered a new target: bridge the delta
          // from what is on screen now, paced over the interval it represents.
          glide.fromX = glide.x;
          glide.fromY = glide.y;
          glide.targetX = at.x;
          glide.targetY = at.y;
          glide.startTs = ts;
          glide.intervalS = snapshotIntervalS;
        }
        const next = motionTowards(
          { x: glide.fromX, y: glide.fromY },
          { x: glide.targetX, y: glide.targetY },
          (ts - glide.startTs) / 1000,
          glide.intervalS,
        );
        glide.x = next.x;
        glide.y = next.y;
        smoothed.set(at.id, next);
      }
      for (const id of [...smoothed.keys()]) if (!present.has(id)) smoothed.delete(id);
      for (const id of [...glides.keys()]) if (!present.has(id)) glides.delete(id);

      // Camera follow: pure target + the same smoother (spec 063, R1). Scale is
      // smoothed too — assigning it outright made a release a hard zoom-out
      // followed by a slide (spec 066, AC-5).
      const target = cameraFor(selectedAgentId, layout, camera);
      camera = smoothCamera(camera, target, dt, CAMERA_HALF_LIFE_S);
      renderer.render(latest, {
        insets: measureInsets(),
        width: viewportW,
        height: viewportH,
        agentPositions: smoothed,
        camera,
        showFog,
        ...(selectedAgentId !== null ? { selectedAgentId } : {}),
      });
    }
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(frame);
  }

  // ── Selection card (spec 063, R5) ────────────────────────────────────────
  function setCardVisible(visible: boolean): void {
    const el = document.getElementById('detail');
    const cls = (
      el as unknown as { classList?: { add(c: string): void; remove(c: string): void } } | null
    )?.classList;
    if (cls === undefined) return;
    if (visible) cls.remove('hidden');
    else cls.add('hidden');
  }

  function renderCard(): void {
    if (latest === null || selectedAgentId === null) {
      setCardVisible(false);
      return;
    }
    const agent = latest.agents.find((a) => a.agentId === selectedAgentId);
    if (agent === undefined) {
      selectedAgentId = null;
      setCardVisible(false);
      return;
    }
    const name = document.getElementById('dName');
    if (name !== null) name.textContent = agent.name;
    const sub = document.getElementById('dSub');
    if (sub !== null) {
      sub.textContent = `${agent.location.replace(/_/g, ' ')} · ${agent.pperPhase}${
        agent.isThinking ? ' · thinking' : ''
      }`;
    }
    const drives = document.getElementById('dDrives');
    if (drives !== null) {
      drives.innerHTML = DRIVES.map((drive) => {
        const value = Math.max(0, Math.min(100, agent.drives[drive.key]));
        return `<div class="drive"><div class="bar"><i style="width:${value}%;background:${drive.color}"></i></div>${drive.label}</div>`;
      }).join('');
    }
    const plan = document.getElementById('dPlan');
    if (plan !== null) {
      const current = agent.currentPlan;
      plan.innerHTML =
        current !== null
          ? `<em>plan</em> ${current.description} (${current.currentStepIndex}/${current.totalSteps})`
          : '<em>no active plan</em>';
    }
    setCardVisible(true);
  }

  function select(agentId: string | null): void {
    selectedAgentId = agentId;
    renderCard();
  }

  function hitTestAgent(clientX: number, clientY: number): string | null {
    const layout = baseLayout();
    if (layout === null) return null;
    const view = transformLayout(layout, camera);
    let best: string | null = null;
    let bestDistance = TAP_RADIUS;
    for (const at of view.agents) {
      // The fog toggle is a view override (spec 062, R6): when fog is off the
      // renderer draws everything, so everything must be tappable too. Using
      // the fog-derived `visible` here made drawn agents unselectable.
      if (showFog && !at.visible) continue;
      const distance = Math.hypot(at.x - clientX, at.y - clientY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = at.id;
      }
    }
    return best;
  }

  canvas.addEventListener('pointerdown', (ev: PointerEvent) => {
    select(hitTestAgent(ev.clientX, ev.clientY));
  });

  // Read-only debug aid for live verification of the follow-camera (spec 063):
  // open the page with `?debug=1` to expose `window.__viz`. Inert by default.
  if (typeof location.search === 'string' && location.search.includes('debug=1')) {
    (window as unknown as { __viz?: unknown }).__viz = {
      hitTest: hitTestAgent,
      select,
      snapshot: () => ({ selected: selectedAgentId, camera, agents: latest?.agents.length ?? 0 }),
    };
  }

  // ── WebSocket (same origin; scheme follows the page — spec 063, R2) ──────
  const scheme =
    typeof location.protocol === 'string' && location.protocol === 'https:' ? 'wss' : 'ws';
  // Same-origin includes the PATH: when the app is served behind a
  // path-prefixed reverse proxy (e.g. `/viz/`), a socket to `host/` would be
  // routed to whatever else owns the root. Carry the page's base path so the
  // same proxy route carries the live channel.
  const rawPath = typeof location.pathname === 'string' ? location.pathname : '/';
  const basePath = rawPath.slice(0, Math.max(0, rawPath.lastIndexOf('/') + 1));
  const ws = new WebSocket(`${scheme}://${location.host}${basePath === '' ? '/' : basePath}`);
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
      latest = parsed;
      pendingSnapshot = true;
      renderCard();
      if (typeof window.requestAnimationFrame !== 'function') draw();
    } catch (e) {
      console.error(e);
    }
  };

  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(frame);

  function send(command: Command): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(command));
  }

  // ── Controls (spec 023, Req 15) ──────────────────────────────────────────
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
  const close = document.getElementById('dClose');
  if (close !== null) close.onclick = () => select(null);
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

  // ── PWA: install affordance + service worker (spec 063, R4/R5) ───────────
  const btnInstall = document.getElementById('btnInstall');
  let deferredPrompt: { prompt?: () => void } | null = null;
  window.addEventListener('beforeinstallprompt', (event: Event) => {
    event.preventDefault();
    deferredPrompt = event as unknown as { prompt?: () => void };
    (
      btnInstall as unknown as { classList?: { remove(c: string): void } } | null
    )?.classList?.remove('hidden');
  });
  if (btnInstall !== null) {
    btnInstall.onclick = () => {
      deferredPrompt?.prompt?.();
      deferredPrompt = null;
      (btnInstall as unknown as { classList?: { add(c: string): void } }).classList?.add('hidden');
    };
  }
  // Registration is a no-op outside a secure context (https / localhost).
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

main();
