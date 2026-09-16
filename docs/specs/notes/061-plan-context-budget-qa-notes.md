# Spec 061 QA Notes — Test-Coverage Verification for PR #220

> YAAM note (QA session record): QA coverage verification for PR #220
> (spec 061, issue #219, parent #214). Convention as in
> `060-plan-formation-shape-failure-recovery-qa-notes.md`: durable notes live
> as `docs/specs/notes/*.md`. The `yaam_search` / `yaam_graph_explore` /
> `yaam_workspace_*` tools were **not exposed in this session** (the sandbox
> exposes only `read`/`write`/`edit`/`bash`), so this file is the record.

## Verdict

**No tests written — this PR delivers no implementation.** PR #220 is
**documentation only**: it adds `docs/specs/061-plan-context-budget.md`,
`docs/specs/notes/061-plan-context-budget-design-notes.md`, and updates
`docs/specs/INDEX.md`. The PR body states it explicitly:

> _Documentation-only spec PR. This PR does not deliver #219 — the
> implementation PR delivers it; #219 and #214 AC-8 stay open._

Every acceptance criterion in spec 061 is stated over `cognition` code that
**does not exist on this branch or on `origin/main`**. A grep over `packages/`,
`examples/`, and `tests/` finds **zero** occurrences of `budgetPlanContext`,
`planPromptMaxChars`, `DEFAULT_PLAN_PROMPT_MAX_CHARS`, `PlanContextBlock`,
`BudgetedPlanContext`, `PLAN_PROMPT_MAX_CHARS`, `PLAN_RECALL_MAX_LINES`,
`PLAN_RECALL_MAX_CHARS`, `PLAN_PAYLOAD_DUMP_DIR`, or `[plan-context]`. Per the
QA rules, a test that cannot be written because its dependency does not exist
yet is recorded as a **gap**, not fabricated or disabled.

**Coverage: 0/4 code ACs testable in this PR (AC-1, AC-3, AC-4, AC-6);
AC-2/AC-5 are live/issue-owned evidence. QA added 0 tests.
No `Status: In Review/QA` label applied** — the spec is 📝 Drafted; the
implementation PR owns QA.

## What was verified (PR head `4eba675` on `spec/061-plan-context-budget`)

- `git diff --name-only origin/main...HEAD` → exactly the three `docs/` files
  above. No `packages/*/src`, no `packages/*/tests`, no `examples`, no `tests/`.
- Spec's external cross-references resolve: all 10 related specs
  (002, 008, 014, 021, 037, 049, 055, 058, 059, 060) and the referenced
  architecture sections exist.
- `docs/specs/INDEX.md` counts are internally consistent:
  `36 Done + 0 In Development + 25 In Review + 4 Drafted + 0 Blocked +
  2 Superseded = 67 total`.
- The spec's **codebase finding** is confirmed against the live tree:
  `PassivePerception.associativeMemories` is referenced in 4 source files
  (populated by the assembler) but **not rendered by `plan-builder.ts` or
  `perception-builder.ts`** — so the spec's R3/deferred decision to reserve
  the recall tier without wiring it is factually grounded.
- The env-parsing pattern the spec cites as precedent
  (`planFloorAfterFailures` in `packages/cognition/src/pper/plan-service.ts`)
  exists as described.
- `estimatePlanPrompt` (spec 060, the R1 total-size invariant) exists in
  `plan-shape-diagnostic.ts` and is unchanged by this PR.

## Gate results (baseline of the docs-only branch, post-build)

Fresh checkout has no `dist/`; `pnpm build` ran first (AGENTS.md rule).

- `pnpm build` — exit 0.
- `pnpm test` — **all 8 projects green, 0 failures**:
  shared **399**, visualizer **48**, memory **101** (+24 todo),
  cognition **1194** (+1 skipped, +26 todo), engine **903** (+141 todo),
  assembly **85**, examples **248** (+3 todo), cli **15**
  — **2,993 passing**.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0, 0 findings.

These gates are unchanged by this PR (docs only); they are recorded so the
implementation PR has a known-green baseline to diff against. Note that the
spec's AC-6 regression clause over spec 021/031/037/039/051/055/056/057/058/
059/060 suites cannot be exercised as a *delta* until changed code exists.

## Gaps (blocked, with reason)

| AC | Maps to | Status | Blocker |
|----|---------|--------|---------|
| AC-1 (R1, R2, R4) | `cognition` | ⛔ BLOCKED | `plan-context-budget.ts` (budgeter + `planPromptMaxChars`), the `plan-builder.ts` block refactor, and the `[plan-context]`/`PLAN_PAYLOAD_DUMP_DIR` diagnostics are all absent. |
| AC-2 (R6) | live run | 📋 ISSUE-EVIDENCE | 40-minute real-LLM run; requires a live backend and a freshly built `dist`; shared live gate with #214 AC-8. |
| AC-3 (R1, R2) | unit | ⛔ BLOCKED | Byte-identity / priority-drop / required-truncation / `estimatePlanPrompt ≤ ceiling` / env-override tests all need the budgeter and the refactored builder. |
| AC-4 (R3) | unit | ⛔ BLOCKED | Recall-tier caps (`PLAN_RECALL_MAX_LINES`/`PLAN_RECALL_MAX_CHARS`) and order-preservation tests need the reserved tier implementation. |
| AC-5 (R5) | live evidence | 📋 ISSUE-EVIDENCE | H1/H2 discriminator replay + ceiling re-run; live/issue-owned numbers must be attached to #219/#214. |
| AC-6 (R7) | regression | ⛔ BLOCKED | Regression clauses over changed code; no changed code. Baseline suites are green (above). |

## Recommendation

Do **not** merge #220 as a delivery of #219 and do **not** apply
`Status: In Review/QA`. The spec is internally consistent, its cross-references
resolve, its INDEX bookkeeping balances, and its codebase finding
(`associativeMemories` populated-but-unrendered; system prompt/tools constant)
matches the current tree. Hand off to the Developer on the implementation PR;
QA will then map AC-1/AC-3/AC-4/AC-6 to concrete unit/integration tests
(`packages/cognition/tests/spec-061-*.test.ts`) and re-run the live AC-2/AC-5
instruments.
