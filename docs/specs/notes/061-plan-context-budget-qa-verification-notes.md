# Spec 061 QA Verification Notes — Implementation PR #223 (issue #219)

> QA coverage verification for PR #223 (`219-plan-context-budget`), the
> implementation of [spec 061](../061-plan-context-budget.md) (R1–R4; R5/R6
> deferred to the live dispatcher). The earlier docs-only PR #220 record lives
> in [`061-plan-context-budget-qa-notes.md`](061-plan-context-budget-qa-notes.md).
> Convention as in `060-…-qa-verification-notes.md`.

## Verdict

**Coverage complete for the code-testable ACs (AC-1, AC-3, AC-4, AC-6).
AC-2 and AC-5 are live/issue-owned evidence and remain unchecked in the spec.**
All gates pass. QA added **5 tests** in one new cognition file and fixed one
stale cross-package source-grep assertion (details below).

> YAAM tooling note: the `yaam_*` pi tools were **not exposed in this session**
> (only `read`/`write`/`edit`/`bash`), so — as in the PR #220 QA record — this
> markdown file is the durable record. The repo convention
> (`docs/specs/notes/*.md`) is the authoritative workspace note store.

## Coverage map (AC → tests)

| AC | Status | Tests |
| --- | --- | --- |
| AC-1 (R1, R2, R4) | ✅ | Impl: `spec-061-plan-context-budget.test.ts` — under/over-budget bounding, separator in-stream, `budgetChars`/`keptChars`/`top`/`dropped` diagnostic, `[plan-context]` exact line, `writeLargestPlanPayload` largest-wins. **QA added:** over-prefix case (prefix byte-identical + `perceptionContext === ''` + `budget=0 kept=0`), `[plan-prompt]`+`[plan-context]` co-emitted once with the spec-060 format preserved, env-gated dump inert when unset / full payload when set, and the built payload's `formulate_plan` enum byte-identical **on the wire**. |
| AC-2 (R6) | 📋 issue-owned | 40-minute real-LLM run (shared gate with #214 AC-8); requires a live backend + freshly built `dist`. **Not runnable in CI.** |
| AC-3 (R1, R2) | ✅ | Impl: byte-identity vs `join`, Tier-5-first drop order, required-only truncation (`…[truncated]`, never throws, negative/zero budget), `estimatePlanPrompt ≤ ceiling`, `planPromptMaxChars()` env parsing incl. invalid → default. Spec-021/055 goldens pass unmodified. |
| AC-4 (R3) | ✅ | Impl: reserved `recall` tier 3.5 drop order (after Tier 4, before Tier 3), line/char caps preserving provider order (no ranking), `PLAN_RECALL_MAX_LINES`/`PLAN_RECALL_MAX_CHARS` env + invalid fallback. |
| AC-5 (R5) | 📋 issue-owned | H1/H2 discriminator replay (late payload at cc=1/cc=3 + early control) and the per-quintile ceiling re-run; numbers must be attached to #219/#214. **Not runnable in CI.** |
| AC-6 (R7) | ✅ | Listed suites unmodified (git-verified). `pnpm -r test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` all green. `shared`/`engine`/`memory` source untouched by the PR. **QA fixed** one stale structural assertion — see below. |

## Tests added

`packages/cognition/tests/spec-061-qa-coverage.test.ts` — 5 tests:

1. **AC-1 / R2 / Decision 3 — over-prefix.** With `PLAN_PROMPT_MAX_CHARS` below
   `systemPrompt + serialized tools`, the prefix stays byte-identical, the
   budgeted `perceptionContext` is `''`, `budgetChars === 0`, `keptChars === 0`,
   and the effective prompt is exactly the unchanged prefix — proving AC-1 can
   never be satisfied by shrinking the `formulate_plan` enum.
2. **AC-1 / R4 — client seam co-emission.** A real `PlanBuilderImpl` payload
   through `OpenAICompatibleLLMClient.completePlan` emits exactly one
   `[plan-prompt]` (byte-format preserved: `chars`/`estTokens`) and exactly one
   `[plan-context]` (`orig`/`budget`/`kept`/`dropped`/`top`).
3. **R4 — dump inert when unset.** `PLAN_PAYLOAD_DUMP_DIR` unset → no
   `plan-payload-*.json` written.
4. **R4 — dump full payload when set.** `PLAN_PAYLOAD_DUMP_DIR` set →
   `<dir>/plan-payload-<agent>.json` contains `{messages, tools, systemPrompt,
   perceptionContext, agentId}`.
5. **AC-1 / AC-6 — legality on the wire (meso builder→client).** The request
   body actually sent to the provider carries a context within the ceiling and
   a `formulate_plan` tool identical to the unbudgeted build, with the
   byte-identical `systemPrompt`.

## Cross-package regression fixed (AC-6 gate)

`packages/engine/tests/spec-018-coverage.test.ts` (scaffolding check:
"PerceptionServiceImpl and PlanBuilderImpl already exist in cognition") greps
`packages/cognition/src/pper/plan-builder.ts` for the literal `contextLines`.
The spec-061 R2 refactor replaced that local with the ordered
`PlanContextBlock[]` stream, so the assertion failed and `pnpm -r test` was
**red** — the Developer's PR verification only ran the cognition suite, so the
cross-package break was not caught.

QA updated the stale structural markers to `budgetPlanContext` and
`PlanContextBlock` (intent unchanged: the builder assembles plan context). It
did **not** touch the implementation, and no listed regression suite was
modified. spec-018 is not in AC-6's "must pass unmodified" list; the listed
suites (021/031/037/039/051/055/056/057/058/059/060) are untouched and green.

## Gate results

Baseline `dist` rebuilt first (`pnpm build`; live sims resolve built `dist/`).

- `pnpm test` — all 9 projects green, 0 failures:
  shared **399**, visualizer **48**, memory **101** (+24 todo),
  cognition **1219** (+1 skipped, +26 todo) — 75 files (was 1214 / 74),
  engine **903** (+141 todo), assembly **85**, examples **248** (+3 todo),
  cli **15**.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0, 0 findings.
- `pnpm format:check` — clean.

## Gaps (blocked, with reason)

| AC | Status | Blocker / note |
|----|--------|----------------|
| AC-2 (R6) | 📋 LIVE | 40-minute real-LLM run; needs live backend + rebuilt `dist`; shared gate with #214 AC-8. |
| AC-5 (R5) | 📋 LIVE | H1/H2 standalone replay + ceiling re-run; live/issue-owned numbers must land on #219/#214. |
| AC-1 (partial) | ⚠️ OBSERVABILITY | The spec says "the `over-prefix` case is logged". The implementation emits **no distinct `over-prefix` token**; the case is observable only as `[plan-context] … budget=0 kept=0` (and the spec's own Decision/Constraint wording is ambiguous — one line says "the builder logs the `over-prefix` case rather than emitting an empty context", while AC-1 requires an empty context). Behaviour is correct and tested; the named diagnostic is a minor spec-vs-implementation deviation. Not blocking AC-1's testable clauses. |
| AC-1 (partial) | ✅/⚠️ | R5/R6 deferred by the PR (issue-owned) — the H1/H2 dump and `top=` instrument exist and are tested, but the live calibration of `DEFAULT_PLAN_PROMPT_MAX_CHARS` is a follow-up. |

## Recommendation

All code-testable ACs are covered; gates are green after the AC-6 regression
fix. `Status: In Review/QA` is appropriate. AC-2/AC-5 remain the only open
items and are owned by the live dispatcher run (shared with #214 AC-8).
