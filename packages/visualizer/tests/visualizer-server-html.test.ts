/**
 * Spec 042 — Visualizer Single Renderer (issue #155)
 * Served-page parity test (AC-1, AC-2, AC-3) + spec-023 browser contract.
 *
 * Proves what the browser actually receives from `GET /`: the module's key
 * formulas (kept verbatim because the bundle is not minified) and the absence
 * of the legacy inline template. Also verifies, at the source level, that the
 * duplicated drawing logic is gone: `RENDERER_JS`/`CLIENT_JS` no longer exist
 * in `visualizer-server.ts` and drawing formulas exist only in
 * `canvas-renderer.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import type { VisualizerState, VisualizerCommand, SceneDefinition } from '@evol-hive/shared';
import { VisualizerServer } from '../src/server/visualizer-server.js';

// ── Server scaffolding (mirrors visualizer-server.test.ts) ─────────────────

interface MockAdapter {
  getSnapshot: () => VisualizerState;
  handleCommand: (cmd: VisualizerCommand) => Promise<void>;
}

function makeMockAdapter(): MockAdapter {
  const snapshot: VisualizerState = {
    tickNumber: 3,
    simulationTime: 0.05,
    isRunning: true,
    timeScale: 1,
    rooms: [
      { id: 'kitchen', name: 'Kitchen', description: '', connections: [], objects: [] },
    ],
    agents: [],
  };
  return {
    getSnapshot: () => snapshot,
    handleCommand: async (_cmd: VisualizerCommand) => {},
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

async function startServer(): Promise<number> {
  server = new VisualizerServer({
    adapter: makeMockAdapter(),
    port: 0,
    scenes: new Map<string, SceneDefinition>([['minimal', minimalScene]]),
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

async function fetchPage(): Promise<string> {
  const port = await startServer();
  const res = await fetch(`http://localhost:${port}/`);
  expect(res.status).toBe(200);
  return res.text();
}

/** Read a package source file relative to this test file. */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('served HTML — grid-cell positioning (spec 042, AC-1)', () => {
  it('contains the module grid-cell positioning expressions', async () => {
    const html = await fetchPage();
    // canvas-renderer.ts computes:
    //   roomPos.x + (agent.position.x + 0.5) * roomPos.w / 12
    //   roomPos.y + (agent.position.y + 0.5) * roomPos.h / 8
    expect(html).toContain('agent.position.x + 0.5');
    expect(html).toContain('agent.position.y + 0.5');
    expect(html).toContain('* roomPos.w / 12');
    expect(html).toContain('* roomPos.h / 8');
  });

  it('no longer serves the legacy static-row slot formula', async () => {
    const html = await fetchPage();
    // The deleted RENDERER_JS positioned every agent unconditionally at
    // `var x = rp.x + 40 + idx * 60, y = rp.y + rp.h - 50` — the static row
    // from issue #155. That template (and its unconditional slot line) is
    // gone from the served page.
    expect(html).not.toContain('rp.x + 40 + idx * 60');
    // Decision 4 (spec 042): the module's legacy-slot fallback is inherited,
    // not reimplemented — the only remaining legacy slot arithmetic is the
    // module's, behind the `position === undefined` guard for old states.
    expect(html).toContain('agent.position !== undefined');
  });
});

describe('served HTML — spec-038/039/033 behavior from the module (spec 042, AC-2)', () => {
  it('contains the fog fill constant, anchor-cell math, and sentiment tint', async () => {
    const html = await fetchPage();
    expect(html).toContain('rgba(10, 10, 24, 0.78)'); // FOG_CELL_FILL (spec 039)
    expect(html).toContain('obj.cell.x * roomW / 12'); // anchor cell (spec 038)
    expect(html).toContain('obj.cell.y * roomH / 8');
    expect(html).toContain('sentimentTint'); // conversation chips (spec 033)
  });
});

describe('served HTML — no duplicated drawing logic (spec 042, AC-3)', () => {
  it('no longer defines RENDERER_JS or CLIENT_JS in visualizer-server.ts', () => {
    const src = readSource('../src/server/visualizer-server.ts');
    expect(src).not.toContain('RENDERER_JS');
    expect(src).not.toContain('CLIENT_JS');
    // The page JS comes from the bundle helper.
    expect(src).toContain('getClientBundle');
  });

  it('keeps drawing formulas only in canvas-renderer.ts (repo-wide search)', () => {
    // A repo-wide (package-wide) search: drawing calls may appear only in the
    // renderer module. The server, bundle helper, and client glue hold none.
    const srcRoot = new URL('../src/', import.meta.url);
    const files = readdirSync(srcRoot, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => `${e.parentPath ?? e.path}/${e.name}`.replace(/^file:\/\//, ''));
    expect(files.length).toBeGreaterThan(0);
    const drawingCall = /fillRect\(|fillText\(|strokeRect\(|beginPath\(/;
    for (const file of files) {
      if (file.endsWith('renderer/canvas-renderer.ts')) continue; // the one source
      const content = readFileSync(new URL(file, srcRoot), 'utf8');
      expect(drawingCall.test(content), `${file} contains drawing calls`).toBe(false);
      expect(content.includes('idx * 60'), `${file} contains the legacy slot formula`).toBe(
        false,
      );
    }
  });

  it('bundles the page from src/client/main.ts with no drawing rules in the glue', () => {
    const glue = readSource('../src/client/main.ts');
    expect(glue).toContain('CanvasRenderer'); // imports the real module
    // Glue only: DOM/WebSocket wiring — no drawing rules here.
    expect(/fillRect\(|fillText\(|strokeRect\(|beginPath\(/.test(glue)).toBe(false);
    expect(glue.includes('idx * 60')).toBe(false);
  });
});

describe('served HTML — spec-023 browser contract intact', () => {
  it('is a single HTML response with one inline script and no external requests', async () => {
    const html = await fetchPage();
    expect(html).toContain('<canvas');
    // Exactly one script tag, inline (no src=).
    expect(html.match(/<script/g)?.length).toBe(1);
    expect(html).not.toMatch(/<script[^>]*src=/);
    // Controls still wired (spec 023 glue).
    expect(html).toContain('btnPlay');
    expect(html).toContain('btnPause');
    expect(html).toContain('sceneSelect');
  });
});