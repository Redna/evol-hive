/**
 * Spec 042 — Visualizer Single Renderer (issue #155)
 * Client bundle helper (`src/server/client-bundle.ts`) — AC-3.
 *
 * The served page's JS must be produced by bundling the real renderer module
 * (`src/renderer/canvas-renderer.ts`) plus the DOM/WS glue
 * (`src/client/main.ts`) with esbuild — not by a hand-maintained template
 * string. These tests assert the bundle's provenance (esbuild path comments),
 * its module formulas (kept verbatim because minification is off), and the
 * cache contract.
 */
import { describe, it, expect } from 'vitest';
import { getClientBundle, getBundleBuildCount } from '../src/server/client-bundle.js';

describe('client bundle (spec 042, AC-3)', () => {
  it('returns non-minified JavaScript', () => {
    const js = getClientBundle();
    expect(js.length).toBeGreaterThan(1000);
    // minify: false → the bundle keeps newlines and indentation, which keeps
    // the parity-test greps readable (spec 042, Constraint).
    expect(js).toContain('\n');
  });

  it('bundles from src/client/main.ts and includes canvas-renderer.ts (AC-3)', () => {
    const js = getClientBundle();
    // esbuild's unminified bundle output carries a path comment per module.
    expect(js).toMatch(/src\/client\/main\.ts/);
    expect(js).toMatch(/src\/renderer\/canvas-renderer\.ts/);
  });

  it('keeps the module grid-cell positioning formulas verbatim (AC-1)', () => {
    const js = getClientBundle();
    expect(js).toContain('agent.position.x + 0.5');
    expect(js).toContain('agent.position.y + 0.5');
    expect(js).toContain('* roomPos.w / 12');
    expect(js).toContain('* roomPos.h / 8');
  });

  it('keeps the fog fill, anchor-cell math, and sentiment tint verbatim (AC-2)', () => {
    const js = getClientBundle();
    expect(js).toContain('rgba(10, 10, 24, 0.78)'); // FOG_CELL_FILL
    expect(js).toContain('obj.cell.x * roomW / 12');
    expect(js).toContain('obj.cell.y * roomH / 8');
    expect(js).toContain('sentimentTint');
  });

  it('is a self-contained bundle with no imports/exports and erased types', () => {
    const js = getClientBundle();
    // format: 'iife', bundle: true → everything inlined, nothing left to resolve.
    expect(js).not.toMatch(/^\s*import[\s(']/m);
    expect(js).not.toMatch(/^\s*export[\s{]/m);
    expect(js).not.toContain('@evol-hive/shared');
    // `import type` members from @evol-hive/shared are erased during bundling.
    expect(js).not.toContain('VisualizerState');
    expect(js).not.toContain('VisualizerAgent');
  });

  it('contains the DOM/WebSocket glue from main.ts', () => {
    const js = getClientBundle();
    expect(js).toContain("getElementById('canvas')");
    expect(js).toContain('new WebSocket(');
  });

  it('caches its output — repeated calls do not rebuild', () => {
    const before = getBundleBuildCount();
    const first = getClientBundle();
    const second = getClientBundle();
    expect(second).toBe(first);
    expect(getBundleBuildCount()).toBe(before === 0 ? 1 : before);
  });
});