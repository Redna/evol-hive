# Spec 060 QA Verification Notes — Implementation PR #218 (issue #214)

> QA coverage verification for PR #218 (`feature/214-plan-formation-shape-failure-recovery`),
> the implementation of [spec 060](../060-plan-formation-shape-failure-recovery.md).
> This is the implementation-PR QA record; the earlier docs-only PR #216 record
> lives in [`060-plan-formation-shape-failure-recovery-qa-notes.md`](060-plan-formation-shape-failure-recovery-qa-notes.md).
> Convention as in `058-…-qa-notes.md` / `055-…-qa-reverify-notes.md`.

## Verdict

**Coverage complete for the code-testable ACs (AC-1–AC-6). AC-7/AC-8 are
issue/live-owned evidence and remain unchecked in the spec.** All gates pass.
QA added **10 tests** (8 cognition unit + 2 assembly E2E) closing three gaps.

## Coverage map (AC → tests)

| AC | Status | Tests |
| --- | --- | --- |
| AC-1 (R1) | ✅ | `packages/shared/tests/spec-060-plan-shape.test.ts` (10); `checkPlanBinding shapeReason` block in `spec-060-plan-shape-diagnostic.test.ts` (4) |
| AC-2 (R1) | ✅ | `classifier agreement and client decode` block (7); `[plan-invalid]` all-reasons block asserts the decode path per reason |
| AC-3 (R2) | ✅ | `estimatePlanPrompt` (2); client `[plan-prompt]`/`[plan-invalid]`/`[llm-raw]`; throwing-writer safety; service backstop. **QA added:** `[plan-invalid]` named for all three reasons, `[plan-prompt]` size equality + once-per-call, throwing `[plan-repair]` writer |
| AC-4 (R3) | ✅ | client-seam repair block (4); QA all-reasons block re-pins one-retry + named empty step |
| AC-5 (R4) | ✅ | `spec-060-plan-floor.test.ts` (7) + `spec-060-plan-floor-honest-failure.test.ts` (1). **QA added:** precise `N`-attempts-before-floor + zero floor LLM calls, throwing `[plan-floor]` writer, and the full-stack floor E2E |
| AC-6 (R5) | ✅ | listed suites unmodified (git-verified), `pnpm test/typecheck/lint/format:check` green. **QA added:** byte-identical valid multi-step plan round-trip on the default client |
| AC-7 (R6) | 📋 issue-owned | live mechanism diagnosis + probe numbers on #214 |
| AC-8 (R7) | 📋 issue-owned | 40-minute real-LLM run; live env only |

## Tests added

- `packages/cognition/tests/spec-060-qa-coverage.test.ts` — 8 tests:
  - AC-3: `[plan-invalid] reason=<each of missing-description|missing-steps|empty-step-description>` at the client seam, each with `chars`/`estTokens`, each repaired in exactly one retry.
  - AC-3: `[plan-prompt]` carries exactly `estimatePlanPrompt`'s `chars`/`estTokens` and fires once per `completePlan` call (even when a repair follows — the AC-8 pre-repair denominator).
  - AC-3/discipline: a throwing `[plan-repair]` writer never propagates.
  - AC-6: the default client decodes a valid multi-step plan (alias map + bare string) byte-identically (`toEqual` on the full object, and `toEqual(decodeFormulatePlanArgs(raw))`).
  - AC-5: with `N=3`, exactly 3 plan LLM attempts before the first floor, the floor adds **zero** calls, and the reset bounds the budget (6 attempts / 2 floors over 6 cycles).
  - AC-5/discipline: a throwing `[plan-floor]` writer never propagates.
- `packages/assembly/tests/spec-060-plan-floor-e2e.test.ts` — 2 E2E tests through `assembleWorld` (real engine + cognition + orchestrator):
  - AC-5 macro: a persistently shape-invalid provider floors after `N=2` cycles; the stored plan is single-step and binds `observe`/the critical-drive restorer, **never** `wait`; `[plan-floor] agent=… failures=2 target=…`; no extra plan LLM call.
  - AC-5: `PLAN_FLOOR_AFTER_FAILURES=0` disables the floor end-to-end (5 cycles, no plan, no `[plan-floor]`).

## Gate results (branch head + QA tests)

- `pnpm test` — exit 0. All 8 projects green: shared **399**, visualizer **48**, memory **101** (+24 todo), cognition **1194** (+1 skipped, +26 todo), engine **903** (+141 todo), assembly **85**, examples **248** (+3 todo), cli **15** — **2,993 passing, 0 failures**.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0, 0 findings.
- `pnpm format:check` — exit 0.
- `pnpm build` — exit 0 (required before the assembly E2E, which resolves `@evol-hive/*` from `dist/`).

## Regression / scope checks

- `git diff --name-only origin/main...HEAD` shows **no** changes to spec 031/037/039/051/055/056/057/058/059 test files (AC-6's pinned set). The only pre-existing test touched is `packages/cognition/tests/pper-error-recovery.test.ts` (spec 008), which stubs `PLAN_FLOOR_AFTER_FAILURES=0` — a documented, in-scope deviation (spec 008 is not in AC-6's list).
- `shared` imports from no other package; `engine`/`memory` untouched (constraint holds).

## Gaps / notes

- **AC-7 and AC-8 cannot be tested here** — they require the live mechanism probe and a 40-minute real-LLM run with a freshly built `dist`, owned by issue #214. No test fabricated.
- **`[plan-prompt]` per-call, not per-LLM-request (documented deviation).** R2's wording is "one line per plan LLM request"; the implementation emits it on the initial request only, and the spec's AC-8 explicitly requires the pre-repair invalid rate to be measured against `[plan-prompt]` (a repair must not dilute the denominator). The QA test pins the implemented (and AC-8-consistent) once-per-`completePlan` behavior.
- **No `tests/integration/` or `tests/e2e/` root directories exist in this repo.** The established layers are per-package: micro in `packages/*/tests/`, macro/E2E in `packages/assembly/tests/*-e2e.test.ts` and `examples/tests/*e2e.test.ts` (see spec 058/059). The spec-060 E2E follows that convention; a root-level directory would not be picked up by `pnpm -r test`.

## Label

`Status: In Review/QA` applied to issue #214 (label already present on #204/#206/#210 with the same "Ready for Dev + In Review/QA" pairing).
