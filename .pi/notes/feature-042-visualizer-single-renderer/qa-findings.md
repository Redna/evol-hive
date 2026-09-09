# QA Findings — Feature 042 (Visualizer Single Renderer) — PR #157

**Date**: 2026-09-09 · **Branch**: `feature/042-visualizer-single-renderer` ·
**PR**: #157 · **Spec**: `docs/specs/042-visualizer-single-renderer.md` ·
**Issue**: #155 · **QA verdict**: ✅ Approve — all 6 ACs covered, 2 gaps found
and closed, suite green (this file mirrors the YAAM note
`note_qa_042_*` and PR comment issuecomment-5600550255).

## Verification (fresh run, HEAD 32703e7)

- `pnpm build` → `pnpm test` (CI order): **2,241 tests, 0 failures** —
  shared 314 · **visualizer 48** (42 pre-existing unmodified + 6 new) ·
  memory 101 · cognition 866 · engine 765 · examples 135 · cli 12 (AC-5 ✅)
- `pnpm typecheck` ✅ (7/7 packages) · `pnpm lint` ✅ · `pnpm format:check` ✅

## AC → test coverage map

| AC | Automated coverage |
|---|---|
| AC-1 grid-cell expressions, no unconditional legacy slot | visualizer-server-html.test ×2 · client-bundle.test · **NEW** dist-bundle.e2e.test |
| AC-2 fog fill + anchor math + sentimentTint in served HTML | visualizer-server-html.test · client-bundle.test · **NEW** dist E2E |
| AC-3 no RENDERER_JS/CLIENT_JS, single renderer source, page from main.ts | visualizer-server-html.test ×3 (package-wide scan) · client-bundle.test ×2 (provenance + self-contained IIFE) |
| AC-4 served code passes fog-test assertions | served-renderer-integration.test (WS + served JS on canvas mock) · **NEW** 2nd integration test: Decision-4 fallback through served code |
| AC-5 pre-existing tests pass unmodified; monorepo green | 2,235 → 2,241 additive-only, 0 failures |
| AC-6 live demo | manual-by-design (verified in implementation session); **NEW**: production leg automated via dist E2E |

## Gaps found and closed (6 new tests, commit 32703e7)

1. **Legacy-slot fallback (Decision 4 / R1) had zero coverage at any level.**
   Every fixture carried a `position`, so the `position === undefined`
   branch — the old-saves compatibility R1 mandates — was untested at module
   level, through fog, and through served code. Closed with
   `legacy-slot-fallback.test.ts` (3 tests: positionless agent at the legacy
   slot (70, 500); mixed state — grid cell + own slot; unpositioned agent
   never fog-hidden) + a second `served-renderer-integration.test.ts` case
   running the fallback through the SERVED page JS.
2. **The built `dist/index.js` artifact was never exercised by tests.** All
   package vitest configs alias workspace deps to `src/`, so the tsup-built
   production artifact consumed by `examples`/`cli` — exactly where the
   tsup `external: ['esbuild']` regression appeared ("Dynamic require of
   fs") — had no automated check. Closed with `dist-bundle.e2e.test.ts`
   (2 tests): import the built artifact, serve a page from it, assert AC-1/
   AC-2 formula parity + the `agent.position !== void 0` guard + no
   unconditional legacy slot line + single inline script (spec-023
   contract); plus a source-level assert that `esbuild` stays an external
   runtime import of the dist bundle. Guard verified to bite: removing
   `external` makes the visualizer suite fail/hang. Skips when `dist/` is
   absent (repo convention: package tests run without a prior build; CI
   always builds first).

## Confirmations

- The AC-1 ↔ Decision-4 tension documented in the PR body is resolved
  correctly: the guarded fallback (`agent.position !== void 0 ? grid :
  legacySlot`) is required by R1/Decision 4 for old saves and is now pinned
  by tests at module AND served-code level; the legacy template's
  *unconditional* slot line stays absent from the served page.
- AC-6 remains the only manual-by-design item (browser canvas observation);
  everything automatable about it is now automated.
- QA report posted to PR #157 (issuecomment-5600550255); label
  `Status: In Review/QA` added to issue #155; CI run 34341637578 approved
  past the app-token `action_required` gate.

## What remains

Human review + merge of PR #157. No code, test, or doc work outstanding.