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
import { layoutWorld, smoothTowards } from '../renderer/layout.js';
import type { Insets, Point, WorldLayout } from '../renderer/layout.js';
import { FIT_ALL_CAMERA, cameraFor, transformLayout } from '../renderer/camera.js';
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

/** Seconds for an agent to close half the distance to its new cell. */
const GLIDE_HALF_LIFE_S = 0.09;
/** Seconds for the camera to close half the distance to its target. */
const CAMERA_HALF_LIFE_S = 0.25;
const MAX_DPR = 3;
/** Tap radius for selecting an agent, in CSS pixels. */
const TAP_RADIUS = 44;

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
  const smoothed = new Map<string, Point>();
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
      // Agent glide: targets come from the pure layout (spec 062, R2).
      for (const at of layout.agents) {
        const current = smoothed.get(at.id) ?? { x: at.x, y: at.y };
        smoothed.set(at.id, {
          x: smoothTowards(current.x, at.x, dt, GLIDE_HALF_LIFE_S),
          y: smoothTowards(current.y, at.y, dt, GLIDE_HALF_LIFE_S),
        });
      }
      // Camera follow: pure target + the same smoother (spec 063, R1).
      const target = cameraFor(selectedAgentId, layout, camera);
      camera = {
        scale: target.scale,
        offsetX: smoothTowards(camera.offsetX, target.offsetX, dt, CAMERA_HALF_LIFE_S),
        offsetY: smoothTowards(camera.offsetY, target.offsetY, dt, CAMERA_HALF_LIFE_S),
      };
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
      const ids = new Set(parsed.agents.map((a) => a.agentId));
      for (const id of [...smoothed.keys()]) if (!ids.has(id)) smoothed.delete(id);
      latest = parsed;
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
