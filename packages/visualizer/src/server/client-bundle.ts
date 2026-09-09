/**
 * server/client-bundle.ts — produces the browser page JS by bundling the real
 * renderer module (spec 042, Design Decisions 1–3, issue #155)
 * ────────────────────────────────────────────────────────────────────────────
 * The visualizer used to ship TWO renderers: the tested
 * `src/renderer/canvas-renderer.ts` module and a hand-copied legacy JS string
 * (`RENDERER_JS`) that the browser actually executed. This helper makes the
 * duplication impossible: the page's JS is built by bundling the real module
 * (+ the `src/client/main.ts` DOM/WS glue) with esbuild at server start —
 * once, in memory, cached. No build-ordering requirement: the bundle works
 * identically in vitest, `tsx examples/visualizer-demo.ts` dev runs, and
 * production (esbuild is resolved from source relative to this file, never
 * from a `dist` artifact).
 *
 * Bundle options follow spec 042 Design Decision 1: `bundle: true,
 * format: 'iife', platform: 'browser', target: 'es2020', write: false,
 * minify: false`. Minification stays off so the parity tests can grep the
 * served HTML for the module's formulas verbatim (spec 042, Constraint) and
 * stack traces stay debuggable. Type-only imports from `@evol-hive/shared`
 * are erased during bundling — the output is fully self-contained.
 */

import { buildSync } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cached page JS (null until the first `getClientBundle()` call). */
let cachedBundle: string | null = null;

/** How many times esbuild has actually run (exported for the cache test). */
let buildCount = 0;

/**
 * Locate the `@evol-hive/visualizer` package root — the nearest ancestor
 * directory holding a `package.json`, starting from THIS file's location
 * (`import.meta.url`). That resolves `src/client/main.ts` correctly whether
 * the server runs from source (vitest, tsx — file lives in `src/server/`) or
 * from a bundled `dist/` artifact.
 */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('client-bundle: could not locate the visualizer package root');
    }
    dir = parent;
  }
}

/** Bundle `src/client/main.ts` (which imports `canvas-renderer.ts`) in memory. */
function buildClientBundle(): string {
  const entry = resolve(packageRoot(), 'src', 'client', 'main.ts');
  const result = buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    minify: false,
    outfile: 'client.js', // naming only — write: false keeps this in memory
    logLevel: 'silent',
  });
  const js = result.outputFiles?.[0]?.text;
  if (js === undefined || js.length === 0) {
    throw new Error('client-bundle: esbuild produced no output');
  }
  return js;
}

/**
 * The page's JavaScript, built once and cached (spec 042, Design Decision 1).
 * Every `GET /` response inlines this string — the browser runs the exact
 * module the visualizer tests cover.
 */
export function getClientBundle(): string {
  if (cachedBundle === null) {
    cachedBundle = buildClientBundle();
    buildCount++;
  }
  return cachedBundle;
}

/** Number of esbuild builds performed (test observability for the cache). */
export function getBundleBuildCount(): number {
  return buildCount;
}
