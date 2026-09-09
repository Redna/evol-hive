# Implementation — Feature 042: Visualizer Single Renderer (Spec 042, Issue #155)

**Branch**: `feature/042-visualizer-single-renderer` · **PR**: #157 · **Status**: 🔍 In Review

## What was built

The visualizer served TWO divergent renderers: the tested spec-038/039 module
(`canvas-renderer.ts` — grid positions, cell fog, anchor cells, conversation
chips, state rounding) and a hand-copied legacy inline template (`RENDERER_JS`
in `buildHtmlPage()`), of which only the second actually reached the browser
(issue #155: payload carried `{"x":11,"y":4}` yet agents rendered in a static
row at `roomPos.x + 40 + idx * 60`). This change bundles the real module into
the served page and deletes the inline template — duplication gone by
construction (spec 042 Decision 1).

## Files

- **`src/client/main.ts`** (new) — browser entry, DOM/WS glue only: canvas
  sizing, controls (play/pause/speed/save/load/scene), `onmessage →`
  `renderer.render(JSON.parse(ev.data))`, resize handler. Zero drawing rules
  (Decision 3). Imports `CanvasRenderer` from `../renderer/canvas-renderer.js`.
- **`src/server/client-bundle.ts`** (new) — `getClientBundle()` / 
  `getBundleBuildCount()`: esbuild `buildSync` with `bundle: true,
  format: 'iife', platform: 'browser', target: 'es2020', write: false,
  minify: false`, entry `src/client/main.ts` resolved by walking up from
  `import.meta.url` to the nearest `package.json` (works from `src/server/`
  in vitest/tsx AND from a bundled `dist/`), cached after first build.
- **`src/server/visualizer-server.ts`** — `RENDERER_JS` + `CLIENT_JS` template
  strings deleted (488 → 363 lines); `buildHtmlPage()` inlines
  `${getClientBundle()}`. `getClientBundle` imported from `./client-bundle.js`.
- **`tsup.config.ts`** — `external: ['esbuild']`. CRITICAL GOTCHA (found by the
  examples E2E test): tsup bundles devDependencies, so leaving esbuild inlined
  put its CJS `require("fs")` into the ESM `dist/index.js` → "Dynamic require
  of fs is not supported" at runtime. External keeps it a runtime import.
- **`package.json`** — `esbuild: ^0.27.7` as explicit devDependency (Decision 3;
  matches the version tsup already pulled transitively).

## Tests (TDD — written first, all failed for the right reasons, then green)

1. **`tests/client-bundle.test.ts`** (7) — bundle provenance via esbuild path
   comments (`// src/client/main.ts`, `// src/renderer/canvas-renderer.ts`),
   verbatim module formulas, self-contained IIFE (no import/export,
   `@evol-hive/shared` never resolved, type-only imports erased), glue markers,
   cache (buildCount stays 1 across calls). → AC-3.
2. **`tests/visualizer-server-html.test.ts`** (5) — served-HTML parity:
   grid expressions present (`agent.position.x + 0.5`, `* roomPos.w / 12`,
   y/8), legacy template's unconditional slot line absent
   (`rp.x + 40 + idx * 60`), fog fill `rgba(10, 10, 24, 0.78)`,
   `obj.cell.x * roomW / 12`, `sentimentTint`; source-level: no
   RENDERER_JS/CLIENT_JS, drawing formulas only in `canvas-renderer.ts`
   (package-wide scan), glue has no drawing calls; spec-023 contract (one
   inline script, no `src=`). → AC-1/2/3.
3. **`tests/served-renderer-integration.test.ts`** (1) — real WS client
   receives the snapshot from the running server, served page JS executed on a
   Node canvas-mock sandbox (`new Function` + mock document/WebSocket),
   passes the `canvas-renderer-fog.test.ts` assertions: agent arc at grid cell
   (375, 331.25) not legacy slot (70, 500); 188 FOG_CELL_FILL rects (92+96);
   'Planter' visible, 'Shed' hidden. → AC-4.

## Result

- Visualizer: 42/42 (28 pre-existing unmodified + 14 new). AC-5 ✅.
- Full monorepo (CI order build→test): 314+42+101+866+765+135+12 = 2,235 pass,
  0 failures.
- typecheck/lint/format:check/build all clean.
- AC-6 live check: `tsx examples/visualizer-demo.ts` → `curl` of the page
  shows the grid formula + fog fill, zero legacy-template matches.

## Learnings / gotchas

- **esbuild output normalization** (matters for grep tests): single quotes →
  double quotes; `undefined` → `void 0`; redundant parens dropped
  (`(x * w) / 12` → `x * w / 12`); JSDoc comments ARE preserved (so a type
  name can survive in a comment even though the import is erased). Grep for
  `agent.position !== void 0`, `* roomPos.w / 12`, `getElementById(`.
- **tsup inlines devDependencies** — any build-tool imported from package src
  must be listed in tsup `external`, or the dist ESM bundle breaks on the
  tool's CJS requires. Caught by `examples/tests/real-llm-visualizer.e2e.test.ts`.
- **Spec tension noted**: AC-1/Decision 5 say "the legacy `idx * 60` formula is
  gone" from the HTML, but Decision 4 inherits the module's guarded legacy-slot
  fallback (R1: applies only when `position === undefined`; old saves keep
  working). Resolution: fallback stays (Decision 4, most-specific), the parity
  test asserts the old template's UNCONDITIONAL slot line is gone and the
  guard exists. `idx * 60` remains exactly once in the served page — inside
  the guarded ternary fallback. Documented for QA.
- **pnpm in CI env defaults to frozen lockfile** — after adding a dependency,
  run `pnpm install --no-frozen-lockfile` to update `pnpm-lock.yaml`.