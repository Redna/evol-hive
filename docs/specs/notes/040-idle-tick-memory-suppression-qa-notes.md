# QA Notes — Spec 040 (Idle-Tick Memory Suppression) — PR #151 coverage audit

> Note: the YAAM daemon IS reachable in this environment (local TCP daemon on
> `127.0.0.1:41147`, port recorded in `.yaam/daemon.port`), but it exposes a
> single `search` method (semantic index over the workspace) — no note-write
> method exists (probed ~30 candidate names: `note_*`, `scratchpad_*`,
> `memory_*`, `save/put/append/ingest` — all `Method not found`). Findings are
> recorded here per the notes-directory convention; the existing scratchpad
> note `note_1788902533119` (prior resume-audit session) already carries the
> session state. This file is itself YAAM-indexed (docs sections are in the
> index), so it is discoverable via `yaam_search`.

## Scope

QA pass over PR #151 ("feat: idle-tick memory suppression — wait-only cycles
store nothing (spec 040)"), closing issue #149. Branch
`feature/149-idle-tick-memory-suppression`, HEAD `b65e69b`, state OPEN /
MERGEABLE. Every acceptance criterion (AC-1..AC-6) was mapped to tests; one
coverage gap was found and closed with a new cross-package E2E test; full
suite + typecheck + lint + format:check were run.

## AC → test coverage map

| AC | Status | Evidence |
|----|--------|----------|
| AC-1 (skipped cycle, no LLM memory → nothing stored) | ✅ COVERED | `packages/cognition/tests/spec-040-idle-tick-memory-suppression.test.ts` — 6 suppression tests (R2.1/R2.2), incl. empty/whitespace `memoryContent` (spec 025 semantics) and "never writes Idle tick content"; amended spec-025 superseded-AC-14 tests assert suppression |
| AC-2 (explicit `memoryContent`/`memoryEntry` on skipped cycle stored) | ✅ COVERED | Same file — flattened + legacy + precedence tests (R2.3); cognition E2E chain; now also through the real recorder (new E2E, see actions) |
| AC-3 (`wait` → `stepSkipped: true` from Execute) | ✅ COVERED | Same file — R1.1 block (wait branch, final-step `planComplete`, R1.2 narrative unchanged, physical-step regression guard); amended spec-037 wait-escape tests (2) |
| AC-4 (System 1 label IGNORE for wait-only cycle; spec 035 gating intact) | ✅ COVERED (gap closed) | `packages/engine/tests/spec-040-idle-tick-suppression-label.test.ts` — 4 tests, real `System1OutcomeRecorderImpl` (flat `memoryCount` → IGNORE; pre-spec-040 growth → REACT). **Gap:** probe snapshots there are scripted — nothing bound cognition's real suppression → a real probe → the recorder. Closed by the new cli E2E (3 tests). Spec 035 gating re-run: 19/19 pass |
| AC-5 (≥20% ignore rate, ~0 idle-node growth, live run) | ⏸ MANUAL (by design) | Real-LLM 20-min run; evidence → issue #149 post-merge. Not CI-automatable; no test added |
| AC-6 (failed-action fallbacks intact; suites green) | ✅ COVERED | R3 block (4 tests: success/failed content+importance+type, explicit `stepSkipped: false`, absent flag); amended spec-025 suites; full suite green |

## QA actions taken

1. Added `packages/cli/tests/spec-040-idle-tick-suppression-e2e.test.ts` —
   3 cross-package E2E tests: real `ExecuteServiceImpl` + `ReflectServiceImpl`
   → probe adapter over the real reflect data provider's memory store
   (`memoryCount = storeMemoryCalls.length`, the production wiring shape) →
   real `System1OutcomeRecorderImpl` → label. Covers: suppressed wait-only
   cycle → IGNORE (`memoryWritten: false`); explicit LLM memory → REACT
   (R2.3 end-to-end); legacy idle-write simulation → REACT (the exact domino
   the spec removes). Placed in `packages/cli` — the only workspace package
   whose dependency direction allows importing both cognition and engine
   (ADR-0001 boundary); no `src/` changes.
2. Fixed a latent bug in `packages/cli/vitest.config.ts`: workspace aliases
   pointed to `../packages/<pkg>/src/index.ts` (copied from the root-level
   `examples/vitest.config.ts`), which resolves to
   `packages/packages/<pkg>` from `packages/cli` — every in-process workspace
   import in cli tests failed with `ERR_MODULE_NOT_FOUND` (prior cli tests
   dodged it by spawning tsx subprocesses). Corrected to
   `../<pkg>/src/index.ts`, mirroring `packages/visualizer/vitest.config.ts`.
   Existing cli tests unaffected (4/4 still pass).
3. Mutation check on the new E2E: disabled the `resolveMemoryEntry`
   suppression (`if (false && …)`) → the IGNORE test fails (labels REACT,
   `memoryStored: true`); restored source afterwards. The test binds real
   behavior — not vacuous.

## Verification runs (HEAD `b65e69b` + QA additions)

- `pnpm test` — **2,190 passed / 0 failed** (shared 310, visualizer 27,
  memory 101, cognition 853 + 1 skipped, engine 757, examples 135, cli 7;
  todos excluded).
- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm format:check` ✅
- Spec-040 suites: cognition 21/21, engine 4/4, cli E2E 3/3.

## Constraint check (spec 040)

- Diff touches only cognition (`execute-service.ts`, `reflect-service.ts`) +
  tests + `docs/specs/INDEX.md` — no shared/engine schema changes, no
  recorder changes (R4.2 honored).
- Suppression keyed only on `stepSkipped` (constraint test present); failed
  actions keep fallbacks (R3); explicit-vs-legacy precedence unchanged (R2.3).
- Zero LLM calls added (pure early-return in `resolveMemoryEntry`).

## Verdict

- Coverage of all testable ACs: **PASS** (AC-1..AC-4, AC-6).
- AC-5: manual by design — deferred to issue #149 evidence (not a gap).
- Issue #149 label moved: `Status: Ready for Dev` → `Status: In Review/QA`.
- QA report posted on PR #151.