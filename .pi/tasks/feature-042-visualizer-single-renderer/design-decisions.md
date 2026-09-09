# Design Decisions — Feature 042: Visualizer Single Renderer (Spec 042, Issue #155)

## Decision 1: Bundle the real `canvas-renderer.ts` into the page; delete the inline template
**Why**: The bug's root cause is two divergent renderers — the tested spec-038/039
module (grid positions, fog, anchor cells) and the hand-copied legacy `RENDERER_JS`
string the browser actually executes (`roomPos.x + 40 + idx * 60`). Any sync-by-hand
or parity-test-only approach preserves the failure mode. Bundling the module makes
duplication impossible by construction: the served page renders from the one source
that the 23 visualizer tests already cover.
**Implementation**: new `src/client/main.ts` (DOM/WS glue only, zero drawing rules)
importing `CanvasRenderer`; `buildHtmlPage()` produces the page JS via esbuild build
API (`bundle: true, format: 'iife', platform: 'browser', target: 'es2020',
write: false, minify: false`), resolved relative to `import.meta.url`, cached after
first build.

## Decision 2: In-memory esbuild bundle rather than a second tsup entry
**Why**: vitest and `tsx examples/visualizer-demo.ts` run the server from source,
before/without `pnpm build`; a `dist/client.js` file read by the server would make
the served page depend on build ordering and break tests/dev. The in-memory bundle
works identically in tests, dev, and production. esbuild is already in the tree via
tsup — it becomes an explicit devDependency of `@evol-hive/visualizer`.
**Alternative rejected**: runtime codegen from `Function.prototype.toString()` of the
class — fragile against TS toolchain output shape.

## Decision 3: The client entry contains no drawing rules
**Why**: `main.ts` is glue (canvas sizing, resize, WebSocket onmessage, control
commands). Every visual rule stays in `canvas-renderer.ts`. This is what keeps the
R4 parity check honest — if the served page renders correctly at all, it rendered
from the module.

## Decision 4: Legacy-slot fallback is inherited, not reimplemented
**Why**: The module already falls back to the legacy slot when
`agent.position === undefined` (old saves, grid-less test states). R1's escape hatch
comes for free; no extra code paths in the client.

## Decision 5: Parity test greps the served HTML for module formulas
**Why**: With no minification, the bundle keeps the module's expressions verbatim
(`position.x + 0.5` scaled /12 and /8, `rgba(10, 10, 24, 0.78)` fog fill,
`obj.cell` anchor math, `sentimentTint`), and the legacy `idx * 60` formula is gone.
A test asserts presence/absence on the actual served HTML — proving what the browser
receives, not what a module contains.
