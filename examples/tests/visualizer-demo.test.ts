/**
 * Spec 023 — Visual Output Canvas Renderer
 * Smoke test for the visualizer-demo entry point (AC-13).
 *
 * Verifies the demo can be assembled (engine core + adapter + server), starts
 * listening on a port, logs a URL, and serves an HTML page at GET /.
 */
import { describe, it, expect } from 'vitest';
import { startVisualizerDemo } from '../visualizer-demo.js';

describe('visualizer-demo (AC-13)', () => {
  it('starts a server and serves HTML at GET /', async () => {
    const { port, stop } = await startVisualizerDemo({ port: 0 });
    try {
      expect(port).toBeGreaterThan(0);
      const res = await fetch(`http://localhost:${port}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<canvas');
    } finally {
      await stop();
    }
  });

  it('creates an engine core, adapter, and server without errors', async () => {
    const handle = await startVisualizerDemo({ port: 0 });
    expect(handle.server).toBeDefined();
    expect(handle.adapter).toBeDefined();
    expect(handle.core).toBeDefined();
    await handle.stop();
  });
});
