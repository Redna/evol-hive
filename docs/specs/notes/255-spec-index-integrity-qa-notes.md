# PR #255 QA Notes — spec INDEX bijection fix + integrity guard

> QA coverage verification for PR #255 (`fix/spec-index-integrity`), "docs(specs):
> fix the INDEX bijection, and guard it against drift".
>
> **There is no spec document for this change.** `closingIssuesReferences` is
> empty and no issue references the PR, so the reference acceptance criteria are
> the claims in the PR body/commit message. That is the same situation as issue
> #217 (see `217-docs-only-qa-skip-qa-notes.md`); the four tests the developer
> shipped are treated as the ACs, and QA adds the criteria they do **not** cover.

> Tooling note: only `read`/`write`/`edit`/`bash` were exposed in this session
> (no `yaam_*` tools), so — per the established convention
> (`061-…-qa-verification-notes.md`, `060-…-qa-verification-notes.md`) — this
> markdown file is the durable record.

## Verdict

The fix is correct and the guard is real. All gates pass:

- `pnpm test` — **exit 0** (all 8 projects green)
- `pnpm typecheck` — exit 0
- `pnpm lint` — exit 0
- `prettier --check` on both test files — clean

QA added **4 tests** in one new file. The developer's 6-test guard covers the
bijection; QA adds the two substantive *content* fixes (provenance) plus two
independent cross-checks that a shared bug in the guard cannot hide.

## Coverage map (PR body claim → test)

| PR claim | Status | Evidence |
| --- | --- | --- |
| every spec file has exactly one row | ✅ covered | `spec-index-integrity.test.ts` ("every spec file has exactly one INDEX row" + "no spec file is listed twice") |
| every row resolves to a real file | ✅ covered | same guard, "every INDEX row resolves to a real spec file" |
| no file is listed twice | ✅ covered | same guard, "no spec file is listed twice" |
| a row's link number matches the file it names | ✅ covered | same guard, "a row's link number matches the file it names" |
| summary tally equals the rows; `Total` equals file count | ✅ covered | same guard, "the summary tally equals the rows, and Total equals the file count" |
| **fix #1:** duplicate `019-affordance-as-tools.md` row removed, its PR `#80` carried into the survivor | ⚠️ only cardinality covered by the guard → **QA added** | `spec-index-integrity-qa.test.ts`: exactly one 019 row, issue `#71`, PR contains `#80` |
| **fix #2:** missing `022-performance-tuning.md` row added with issue `#91` / PR `#97` | ⚠️ existence only covered by the guard → **QA added** | `spec-index-integrity-qa.test.ts`: exactly one 022 row, issue `#91`, PR `#97` |
| guard deliberately does NOT assert unique spec numbers (008/018/019/022 are shared) | ✅ verified | The ledger genuinely carries 4 rows numbered `019`; a uniqueness guard would fail on valid data. The developer's guard does not assert it, correctly. |

## Red-first reproduced (not accepted on faith)

The PR claims the guard was written red first and that the duplicate + missing
row **cancelled** so the count assertion passed. QA reproduced this exactly:

- **Against the pre-fix `main` ledger** (`git show HEAD~1:docs/specs/INDEX.md`):
  `files = 71`, `rows = 71` — the count is balanced — yet the guard fails on
  precisely `022-performance-tuning.md` (missing) and `019-affordance-as-tools.md ×2`
  (duplicate). The summary-tally assertion **passed**. This is the blind spot the
  PR describes, reproduced rather than asserted theoretically.
- **Mutation testing** (temporary edits to `INDEX.md`, restored after each):

  | mutation | guard test that goes red |
  | --- | --- |
  | duplicate a row | `no spec file is listed twice` (+ summary tally) |
  | delete a row | `every spec file has exactly one INDEX row` (+ summary tally) |
  | duplicate one **and** delete another | `exactly one` + `listed twice`; **summary-tally stays green** |
  | point a row at a non-existent file | `every INDEX row resolves to a real spec file` (+ missing) |
  | change a row's link number | `a row's link number matches the file it names` |
  | change `✅ Done: 68` → `67` | `summary tally` |

  Every guard assertion except the "found the ledger" sanity check was driven red.
  The pre-fix ledger itself was restored and verified byte-identical afterwards.

## Tests added

`packages/cli/tests/spec-index-integrity-qa.test.ts` — 4 tests:

1. `019-affordance-as-tools.md` has exactly one row, numbered `019`, issue `#71`,
   and its PR cell contains `#80` (the provenance the duplicate was hiding — the
   survivor previously held an em-dash).
2. `022-performance-tuning.md` has exactly one row, issue `#91`, PR `#97`.
3. files ↔ rows are set-equal via an independent sorted-set symmetric-difference
   (different algorithm from the guard's `.some`/`.filter`), plus set-size ==
   row-count to restate no-duplicates.
4. every row's status is one of the six legend values (the guard only compares
   declared labels to rows; this pins the vocabulary).

These go **red on pre-fix `main`** (tests 1–3 fail, test 4 passes) and green on
the PR head, so they are not vacuous.

## Tests not added (and why)

- No integration or E2E test: this change has no runtime surface. `docs/specs/*.md`
  and a CLI policy test are the entire diff. The correct layer is the policy test
  in `packages/cli/tests/`, matching `spec-217-docs-only-qa-gate.test.ts`.
- No test asserting unique spec numbers: the ledger legitimately shares `019`
  across four rows (and 008/018/022), so such a test would be wrong.

## Gate results

`pnpm build` was run first (CLI tests spawn the built binary and resolve
workspace packages to `dist/`; an unbuilt tree shows 4 spurious `cli.test.ts`
failures).

- `pnpm test` — **exit 0**, all 8 projects:
  shared 399, memory 101 (+24 todo), visualizer 93, engine 922 (+141 todo),
  cognition 1252 (+1 skipped, +26 todo), assembly 89, examples 253 (+3 todo),
  **cli 115 (was 111; +4 QA)**.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.
- `prettier --check` on `spec-index-integrity.test.ts` +
  `spec-index-integrity-qa.test.ts` — clean.

## Gaps / observations for the reviewer

1. **No spec document and no linked issue.** The 6 PR-body assertions plus the
   two stated fixes are the only acceptance criteria. QA covers all of them.
   Consequently the `Status: In Review/QA` label is applied to the PR itself
   (there is no issue to label).
2. **Pre-existing `INDEX.md` layout oddity (not introduced here).** The
   `## Spec Status Summary` block sits *before* the tail of the spec table: rows
   `019-configurable-drive-decay-rate` onward appear *after* the summary
   (both on `main` and on this branch). This is cosmetic debt — the guard still
   sees every row because it scans the whole file — but a human reading the
   ledger sees the summary mid-table. Worth a follow-up cleanup; out of scope for
   a bijection fix and deliberately not "fixed" by QA.
3. **Guard test name vs body (cosmetic).** "every spec file has exactly one
   INDEX row" asserts the lower bound only (`missing`); the upper bound is
   asserted separately by "no spec file is listed twice". Combined they are
   exactly-one. No gap, just a name that reads stronger than the single test.
4. **Status-tally masking is only indirectly guarded.** The developer guard
   catches a mis-typed status by the resulting count mismatch. QA's test 4 pins
   the vocabulary directly so a future edit that adds a seventh status (and
   updates the summary to match) cannot slip through unnoticed.
