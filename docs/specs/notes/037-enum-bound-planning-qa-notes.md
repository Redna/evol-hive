# QA Notes — Spec 037 (Enum-Bound Plan Formulation) — PR #141 coverage audit

## Scope

QA pass over PR #141 ("spec 037: enum-bound plan formulation — constrain
targetAffordance via dynamic tool signature", closes #140). Every acceptance
criterion was mapped to existing tests; missing tests were written, committed
to the PR branch (`50481dd`), and the full suite + typecheck + lint + prettier
were run. QA report posted as
[PR comment](https://github.com/Redna/evol-hive/pull/141#issuecomment-5560712876);
label `Status: In Review/QA` applied to PR #141.

## AC → test coverage map

| AC | Status | Evidence |
|----|--------|----------|
| AC-1 (dynamic enum of pruned affordance IDs) | ✅ PASS | `formulatePlanSchemaFor` enum = pruned IDs + `wait`; masked room → `['wait']`; PlanBuilder payload carries enum-bound tool; **new:** social-primary ordering (spec 024 Req 2) keeps the dynamic tool LAST |
| AC-2 (unavailable affordance fails validation + exactly one feedback retry) | ✅ PASS | `checkPlanBinding` units (narrative / hallucinated / wait / shape-invalid / masking-skip); service retry-then-succeed, retry-then-fail, shape-fail-no-retry; **new:** retry payload asserts `CORRECTION:` feedback naming the violation, exactly 2 LLM calls, original context unmutated |
| AC-3 (`[plan-bind]` telemetry per cycle) | ✅ PASS | original bound-count log test; **new:** retry cycle emits a second `[plan-bind]` line |
| AC-4 (>50% binding rate in grand validation run) | ⏸ N/A — live metric | Real-LLM evidence belongs on issue #140; not automatable |
| AC-5 (affordance executions > 0 in 20-min live run) | ⏸ N/A live metric; ✅ unit-level | **new:** `wait` escape exercised in `ExecuteServiceImpl` |

## QA actions taken (commit `50481dd`, pushed to PR branch)

1. **Wait-escape execution tests (the big gap).** The PR's own test-file header
   claimed *"AC-5 (unit level): a bound plan stores and executes past the
   'wait' escape"* but no such test existed — the new `ExecuteServiceImpl`
   `wait` branch shipped untested. Added 5 tests: wait advances past without
   touching the world (no resolve/execute/feedback/drive calls) and without the
   legacy `stepSkipped` flag; wait is never resolved as a room affordance even
   when the room resolves nothing; wait **bypasses plan validation** (guardrail
   never consulted — a deviation-reject on `wait` would trap the agent
   mid-plan); bound-step→wait two-step arc completes the plan; narrative steps
   still take the distinct legacy skip path (`stepSkipped: true`).
2. **Retry-feedback content test.** Req 2 says "re-prompt once with the
   specific error" — the retry payload now asserts the `CORRECTION:` block
   contains the hallucinated ID and the resubmit instruction, and that the
   first-call perception context is not mutated (KV-cache-safe append, spec 021).
3. **Ordering × dynamic-tool test.** Spec 024 boundary preserved with the
   per-cycle tool: in the social-primary branch, `formulate_plan` is asserted
   LAST and carries the room's enum.
4. **Retry telemetry test.** Second `[plan-bind]` log line asserted per retry cycle.

File grew **15 → 23 tests**, all passing.

## Verification results

- `pnpm test` (after `pnpm build` — CI parity): **2,088 passed / 0 failed**
  (shared 306, visualizer 23, memory 101+24 todo, cognition 802+1 skipped+26
  todo, engine 717+141 todo, examples 135, cli 4).
- `pnpm typecheck` clean; `pnpm lint` clean; `prettier --check` clean
  (CI enforces `format:check` — the QA commit is formatted).

## Observations (not product bugs)

- The "8 pre-existing failures" in the PR body are the fresh-checkout
  dist-resolution artifacts (`@evol-hive/memory` / `@evol-hive/cognition`
  entry points) already documented in the spec-035 QA notes. With packages
  built, the suite is fully green. Repeat recommendation: pretest build hook
  or a `pnpm verify` convenience script.
- AC-4/AC-5 remain open by design until the grand validation run posts
  binding-rate and execution evidence to issue #140.

## Verdict

- Automatable criteria (AC-1..AC-3 + AC-5 unit level): **complete coverage**.
- Suite/typecheck/lint/format: **green**.
- PR is mergeable from a QA standpoint once AC-4/AC-5 live-run evidence lands.