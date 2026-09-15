# Spec 060 QA Notes — Test-Coverage Verification for PR #216

> YAAM note (QA session record): QA coverage verification for PR #216
> (spec 060, issue #214). Convention as in
> `059-plan-retention-revalidation-implementation-notes.md` /
> `058-eligibility-bound-plan-affordances-qa-notes.md`: durable notes live as
> `docs/specs/notes/*.md` and are indexed by the YAAM daemon's document adapter.
> `yaam_search` / `graph_explore` are not exposed in this sandbox; the daemon
> port file is absent, so the notes file itself is the record.

## Verdict

**No tests written — this PR delivers no implementation.** PR #216 is
**documentation only**: it adds `docs/specs/060-plan-formation-shape-failure-recovery.md`
and updates `docs/specs/INDEX.md`. The PR body states it explicitly:
_"This PR is documentation only — it does not deliver #214; the implementation
PR will close it."_

Every acceptance criterion in spec 060 is stated over code (`shared` +
`cognition`) that **does not exist on this branch or on `origin/main`**. A
`git grep` over `packages/` and `examples/` finds **zero** occurrences of
`classifyPlanShape`, `PlanShapeReason`, `estimatePlanPrompt`,
`PLAN_FLOOR_AFTER_FAILURES`, `shapeReason`, `[plan-invalid]`, `[plan-prompt]`,
`[plan-repair]`, or `[plan-floor]`. Per the QA rules, a test that cannot be
written because its dependency does not exist yet is recorded as a **gap**, not
fabricated or disabled.

**Coverage: 0/6 code ACs testable in this PR (AC-1–AC-6); AC-7/AC-8 are
issue/live-owned evidence. QA added 0 tests. No `Status: In Review/QA` label
applied** — the spec is 📝 Drafted; the implementation PR owns QA.

## What was verified (PR head `f4e85e9` on `spec/060-plan-formation-shape-failure-recovery`)

The spec was revised during this QA pass (`f4e85e9`, "spec 060 review: make the
fallback floor wait-guard-compatible"): R4/AC-5 now bind the floor in the order
**`observe` → a direct restorer for a critical drive → `wait`**, using the same
`checkWaitSuppression` predicate as the spec-052 plan-level wait guard, and if
no binding survives that order the cycle stays an honest formation failure with
the counter **not** reset. The audit below holds unchanged — the revision is
still documentation only.

- `git diff --name-only origin/main...HEAD` → exactly
  `docs/specs/060-plan-formation-shape-failure-recovery.md` and
  `docs/specs/INDEX.md`. No `packages/*/src`, no `packages/*/tests`, no `examples`.
- The spec's ACs map 1:1 to the missing code surface:
  - **AC-1/AC-2 (R1)** → need `classifyPlanShape` + `PlanShapeReason` in
    `@evol-hive/shared` and the `shapeReason` field on `PlanBindingVerdict`.
    Absent. `isValidFormulatePlanResult` (plan-service.ts) is still the private
    boolean-only check.
  - **AC-3 (R2)** → need `estimatePlanPrompt` + the three zero-LLM diagnostic
    lines. Absent.
  - **AC-4 (R3)** → need the client shape repair at
    `OpenAICompatibleLLMClient.completePlan`. The current `shapeBad` is only
    top-level, exactly as the spec's "reachable-failure deduction" describes.
  - **AC-5 (R4)** → need `PLAN_FLOOR_AFTER_FAILURES` + the wait-guard-compatible
    floor (`observe` → critical-drive direct restorer → `wait`; honest failure
    with the counter unreset when none survives) in `PlanServiceImpl`. Absent.
  - **AC-6 (R5)** → regression gate over the implementation; the pre-existing
    suites are green (below), but the "changed code behaves byte-identically"
    clauses cannot be exercised until the code exists.
  - **AC-7 (R6)** → issue #214-owned mechanism/probe numbers (live/evidence).
  - **AC-8 (R7)** → 40-minute real-LLM live run; requires a live backend and a
    freshly built `dist`, owned by the issue.

## Gate results (baseline of the docs-only branch, post-build)

Fresh checkout has no `dist/`; `pnpm build` ran first (AGENTS.md rule).

- `pnpm build` — exit 0.
- `pnpm test` — **all 8 projects green, 0 failures**:
  shared **389**, visualizer **48**, memory **101** (+24 todo),
  cognition **1154** (+1 skipped, +26 todo), engine **903** (+141 todo),
  assembly **83**, examples **248** (+3 todo), cli **15**
  — **2,941 passing**.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0, 0 findings.

These gates are unchanged by this PR (docs only); they are recorded so the
implementation PR has a known-green baseline to diff against.

## Gaps (blocked, with reason)

| AC | Status | Blocker |
|----|--------|---------|
| AC-1 (R1) | ⛔ BLOCKED | `classifyPlanShape` / `PlanShapeReason` / `shapeReason` not implemented |
| AC-2 (R1) | ⛔ BLOCKED | client `shapeBad` not extended to delegate to the classifier |
| AC-3 (R2) | ⛔ BLOCKED | `estimatePlanPrompt` + `[plan-invalid]`/`[plan-prompt]`/`[llm-raw]` emissions absent |
| AC-4 (R3) | ⛔ BLOCKED | all-reason client repair + `[plan-repair]` absent |
| AC-5 (R4) | ⛔ BLOCKED | wait-guard-compatible floor + `PLAN_FLOOR_AFTER_FAILURES` + `[plan-floor]` absent |
| AC-6 (R5) | ⛔ BLOCKED | regression clauses over changed code; no changed code |
| AC-7 (R6) | 📋 ISSUE-EVIDENCE | live probe numbers must be attached to #214 |
| AC-8 (R7) | 📋 ISSUE-EVIDENCE | 40-min real-LLM run; live env only |

## Recommendation

Do **not** merge #216 as a delivery of #214 and do **not** apply
`Status: In Review/QA`. The spec is internally consistent and its
reachable-failure deduction matches the current code (top-level-only
`shapeBad` in `openai-client.ts`; boolean-only `isValidFormulatePlanResult` in
`plan-service.ts`; the spec-037 hard-fail at `plan-service.ts` shape branch).
Hand off to the Developer on the implementation PR; QA will then map AC-1–AC-6
to concrete unit/integration tests and re-run the live AC-8 instrument.
