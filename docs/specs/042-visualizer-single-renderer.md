# Feature: Visualizer Single Renderer — Bundle `canvas-renderer.ts` Into the Served Page (Kill the Divergent Inline Template)

## Context
- Architecture: [§2 — System Overview (visualizer transport)](../architecture/02-system-overview.md), [§3 — Agent State Schema (`position`, `spatialMemory`)](../architecture/03-agent-state-schema.md)
- Related specs: [023 — Canvas 2D Visualizer (Req 12/15 inline page)](023-visual-output-canvas-renderer.md), [038 — Spatial Navigation & Fog of War (AC-5)](038-spatial-navigation-fog-of-war.md), [039 — Spatial Phase 2 (R6/R8 fog shading, anchor cells)](039-spatial-phase2-targetarea-fog.md), [033 — conversation chips](033-conversations-identity-evolution.md), [029 — state-line rounding/truncation](029-visualizer-state-text-overflow.md)
- Package: `visualizer`
- Issue: [#155](https://github.com/Redna/evol-hive/issues/155)
- Status: 🔍 In Review

## Problem

The visualizer ships **two divergent renderers**, and the browser runs the wrong one:

1. `packages/visualizer/src/renderer/canvas-renderer.ts` — the spec-038/039 module:
   grid-cell agent positioning (`(agent.position.x + 0.5) * roomPos.w / 12`),
   cell-level fog shading, anchor-cell objects, out-of-fog hiding, conversation
   chips (spec 033), state-line rounding (issue #105). Fully tested (23
   visualizer tests incl. `canvas-renderer-fog.test.ts`). **Exported from the
   package index but imported by nothing at runtime.**
2. `RENDERER_JS` in `buildHtmlPage()` (`visualizer-server.ts`) — a hand-copied
   legacy JS port embedded as a string: zero references to `agent.position`,
   no fog, no anchor cells, no conversation tint, no state rounding. **This is
   what every browser executes.**

Verified live (issue #155): the WebSocket payload carries positions
(`{"x":11,"y":4}`), yet agents render in a static row at the legacy slot
formula `roomPos.x + 40 + idx * 60`. Spec 038 AC-5 and spec 039 R6/R8 shipped
to tests, not to the UI.

The two copies are the bug. Any future renderer fix must land twice, and the
untested copy always loses.

## Design Decisions

1. **Bundle the real module into the page at runtime; delete the inline template.**
   A new browser entry `src/client/main.ts` imports the actual `CanvasRenderer`
   from `src/renderer/canvas-renderer.ts` and adds only DOM/WebSocket glue
   (canvas sizing, controls, WS `onmessage → renderer.render(state)`). The
   server produces the page JS with esbuild's build API
   (`bundle: true, format: 'iife', platform: 'browser', target: 'es2020',
   write: false, minify: false`), reading the entry relative to
   `import.meta.url`, and caches the result. The page keeps the spec-023
   browser contract — single HTML, inline JS, zero external requests.
   *Alternative considered*: keep a hand-synced `RENDERER_JS` string and add a
   parity test asserting shared formulas. Rejected — that is the current bug
   plus a tripwire; the module is the only source, so duplication is gone by
   construction. *Alternative considered*: a second tsup entry producing
   `dist/client.js` read by the server. Rejected — vitest and tsx-from-src run
   the server before/without a dist build, so the served page would depend on
   build ordering; the in-memory bundle works identically in tests, dev
   (`tsx examples/visualizer-demo.ts`), and production.

2. **The client entry contains no drawing rules.** `main.ts` is glue only:
   element lookup, resize, WS wiring, control commands. Every visual rule
   (grid math, fog fill, colors, chip layout) lives in `canvas-renderer.ts`.
   This keeps the R4 parity check meaningful: if the served page renders
   correctly at all, it rendered from the module.

3. **`esbuild` becomes an explicit devDependency of `@evol-hive/visualizer`.**
   tsup already pulls esbuild transitively; declaring it pins the API the
   server uses. It stays out of the runtime browser bundle (types from
   `@evol-hive/shared` are `import type` and erased during bundling).

4. **Legacy-slot fallback is inherited, not reimplemented.** The module already
   renders agents at the legacy slot when `position === undefined` — old
   states (saves, tests without grid data) keep working with zero extra code
   (satisfies R1's "legacy slot only when `position === undefined`").

## Requirements

- **R1** — Agents render at their true grid cell: `(position.x + 0.5) * roomW / 12`,
  `(position.y + 0.5) * roomH / 8`, exactly as `canvas-renderer.ts` computes; the
  legacy slot formula applies only when `agent.position === undefined`.
- **R2** — The served page renders the full spec-038/039/033 behavior from the
  module: cell-level fog shading (`FOG_CELL_FILL` over unexplored cells), objects
  at their anchor `cell` with legacy chip grid fallback, out-of-fog agents/objects
  hidden for the fog viewer, conversation sentiment-tinted chips, and
  issue-#105 state-line rounding.
- **R3** — No duplicated drawing logic: `RENDERER_JS` (and any second copy of
  drawing rules) is deleted; the page's JS is generated from
  `canvas-renderer.ts` (+ `main.ts` glue) by bundling, not hand-maintained.
- **R4** — No visual regressions: the existing 23 visualizer tests keep
  passing, and a new parity test proves the served HTML contains the module's
  key formulas and none of the legacy-only ones.

## Acceptance Criteria

- [ ] **AC-1** (R1): the HTML served by `VisualizerServer` contains the module's grid-cell positioning expressions (`position.x + 0.5` scaled by room width / 12, `position.y + 0.5` scaled by room height / 8) and does **not** contain the legacy `idx * 60` slot formula
- [ ] **AC-2** (R2): the served HTML contains the fog fill constant `rgba(10, 10, 24, 0.78)` (`FOG_CELL_FILL`), the anchor-cell object math (`obj.cell` scaled by `12`/`8`), and the conversation `sentimentTint` usage
- [ ] **AC-3** (R3): `RENDERER_JS` and `CLIENT_JS` template strings no longer exist in `visualizer-server.ts`; the only renderer source in the package is `canvas-renderer.ts` (a repo-wide search finds drawing formulas only there); the page bundles from `src/client/main.ts`
- [ ] **AC-4** (R1, R2): an integration test connects a WebSocket client to the server, feeds a state with `position` + `fog` payload, and the page's bundled renderer (executed against a canvas mock in Node) draws the agent at the grid cell and paints fog cells — i.e., the *served* code, not just the module, passes the `canvas-renderer-fog.test.ts` assertions
- [ ] **AC-5** (R4): all 23 existing visualizer tests pass unmodified (or with only import-path updates); full monorepo suite has ≤ pre-existing failures
- [ ] **AC-6** (R1, live): running `tsx examples/visualizer-demo.ts` and opening the page shows agents positioned inside rooms at their grid cells (manually verified against the issue's screenshots) — legacy static row gone

## Constraints

- Package boundaries: only `packages/visualizer` changes (+ one devDependency);
  `@evol-hive/shared` types and the WebSocket payload are already correct and
  must not be touched.
- Keep the spec-023 browser contract: single HTML response, inline CSS/JS, no
  external script requests, no server-side rendering framework.
- No minification of the client bundle (keeps the parity-test greps readable
  and stack traces debuggable); target ES2020 for modern-browser support.
- Patterns to follow: module-first testing (mock 2D context per
  `canvas-renderer.test.ts`); the bundle helper lives in
  `src/server/client-bundle.ts` and caches its output.
- What NOT to do: do not fork the module into a "browser variant", do not
  re-implement fog/grid math in the client entry, do not add a bundler
  build-ordering requirement to tests or `tsx` dev runs.
