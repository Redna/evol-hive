/**
 * client/ — Browser entry for the served visualizer page (spec 042, issue #155)
 * ────────────────────────────────────────────────────────────────────────────
 * DOM/WebSocket glue ONLY. Every visual rule (grid math, fog shading, colors,
 * chip layout, state-line rounding) lives in `../renderer/canvas-renderer.ts`,
 * which this file imports and the server bundles into the single HTML page
 * with esbuild (spec 042, Design Decisions 1–3). The browser therefore runs
 * the exact module the test suite covers — the divergent hand-copied inline
 * template is gone.
 *
 * Keeps the spec-023 browser contract: the server inlines this bundle into
 * one HTML response (inline CSS + JS, zero external requests).
 */

import { CanvasRenderer } from '../renderer/canvas-renderer.js';

/** A control command sent to the server over the WebSocket. */
type Command =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'setSpeed'; timeScale: number }
  | { type: 'save' }
  | { type: 'load'; stateJson: string }
  | { type: 'selectScene'; sceneId: string };

function getElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`visualizer: missing #${id}`);
  return el;
}

function main(): void {
  // Canvas sizing (spec 023, Req 15).
  const canvas = getElement('canvas') as HTMLCanvasElement;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('visualizer: 2D canvas context unavailable');

  // The real renderer module — the only source of drawing rules (spec 042).
  const renderer = new CanvasRenderer(ctx);

  // WebSocket wiring: every snapshot frame re-renders the scene.
  const ws = new WebSocket(`ws://${location.host}/`);
  ws.onmessage = (ev: MessageEvent) => {
    try {
      renderer.render(JSON.parse(String(ev.data)));
    } catch (e) {
      console.error(e);
    }
  };

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

  // Keep the canvas full-viewport on resize; the next snapshot re-renders.
  window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  });
}

main();
