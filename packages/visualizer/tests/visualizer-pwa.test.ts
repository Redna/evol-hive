/**
 * Spec 063 — Visualizer Mobile Shell (2/2) — PWA surface.
 *
 * AC-5 (manifest route + page link), AC-6 (service worker route, versioned
 * shell cache, never caches the live WebSocket channel).
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { VisualizerState, VisualizerCommand, SceneDefinition } from '@evol-hive/shared';
import { VisualizerServer } from '../src/server/visualizer-server.js';

const snapshot: VisualizerState = {
  tickNumber: 1,
  simulationTime: 0,
  isRunning: true,
  timeScale: 1,
  rooms: [{ id: 'kitchen', name: 'Kitchen', description: '', connections: [], objects: [] }],
  agents: [],
};

const scene: SceneDefinition = {
  id: 'minimal',
  name: 'Minimal',
  rooms: [{ id: 'kitchen', name: 'Kitchen', description: '', connections: [], objectIds: [] }],
  objects: [],
  agents: [],
};

let server: VisualizerServer | null = null;

async function startServer(): Promise<number> {
  server = new VisualizerServer({
    adapter: {
      getSnapshot: () => snapshot,
      handleCommand: async (_cmd: VisualizerCommand) => {},
    },
    port: 0,
    scenes: new Map<string, SceneDefinition>([['minimal', scene]]),
  });
  await server.start();
  return server.getPort();
}

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

describe('PWA — manifest (spec 063, AC-5)', () => {
  it('serves a web app manifest with the fields installability needs', async () => {
    const port = await startServer();
    const res = await fetch(`http://localhost:${port}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('manifest+json');
    const manifest = (await res.json()) as {
      name: string;
      short_name: string;
      start_url: string;
      display: string;
      background_color: string;
      theme_color: string;
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.display).toBe('standalone');
    expect(manifest.background_color).toBeTruthy();
    expect(manifest.theme_color).toBeTruthy();
    // Relative start_url so the app works behind a path-prefixed proxy.
    expect(manifest.start_url).toBe('./');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    expect(manifest.icons.some((i) => i.sizes === 'any')).toBe(true);
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) {
      expect(icon.src).not.toMatch(/^https?:\/\//); // same-origin, relative
    }
  });

  it('links the manifest, theme colour and an apple touch icon from the page', async () => {
    const port = await startServer();
    const html = await (await fetch(`http://localhost:${port}/`)).text();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('rel="apple-touch-icon"');
    // Registration lives in the served bundle (inline script).
    expect(html).toContain('serviceWorker.register');
    expect(html).toContain('sw.js');
  });
});

describe('PWA — service worker (spec 063, AC-6)', () => {
  it('serves the worker as JavaScript at root scope', async () => {
    const port = await startServer();
    const res = await fetch(`http://localhost:${port}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    const body = await res.text();
    expect(body).toContain('addEventListener');
    expect(body).toContain('self.skipWaiting');
  });

  it('uses a versioned shell cache containing only shell resources', async () => {
    const port = await startServer();
    const body = await (await fetch(`http://localhost:${port}/sw.js`)).text();
    // Versioned cache name → a changed page is picked up on the next load.
    expect(body).toMatch(/SHELL_CACHE = 'evol-hive-visualizer-shell-v\d+'/);
    // The shell list must not contain the live channel.
    expect(body).not.toMatch(/SHELL = \[[^\]]*wss?:\/\//);
    expect(body).not.toContain('WebSocket');
  });

  it('serves the app icon as a same-origin SVG', async () => {
    const port = await startServer();
    const res = await fetch(`http://localhost:${port}/icon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    expect(await res.text()).toContain('<svg');
  });
});
