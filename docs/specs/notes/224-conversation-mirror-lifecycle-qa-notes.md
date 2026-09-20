# QA Notes — Issue #224 / PR #227 (Conversation Mirror Lifecycle)

> QA verification of PR #227 `fix(engine): closing a conversation removes its
> SmartObject mirror (#224)` on branch `224-conversation-mirror-lifecycle`.
> Date: 2026-09-20 (session time). Verdict: **APPROVE** — coverage complete for
> every testable acceptance criterion; all suites green.

## Spec source

Issue #224 is a **bug report**, not a numbered spec, so there is no
`docs/specs/224-*.md`. The PR's own reference is the **spec 058 amendment**
("a closed conversation is removed, not filtered") plus **spec 033's**
bounded-state constraint ("No unbounded growth anywhere", Redna/yaam#124 class).
The acceptance criteria below are drawn from issue #224's **Direction** section
and the PR body's design claims; the spec-058 amendment supplies the
AC-4-RS/R1-R3 interaction.

## Acceptance-criterion coverage

| # | Acceptance criterion | Source | Test | Status |
| --- | --- | --- | --- | --- |
| AC-1 | `close()` removes **both** halves of registration: `registry.remove` + `room.objectIds` reference | #224 Direction | `spec-224-conversation-mirror-lifecycle.test.ts` ("removes the mirror from the registry AND the room") | ✅ dev |
| AC-2 | A closed conversation is not perceivable: absent from `getObjectsInRoom` / `passive.objectsPresent` | #224 Impact #2 / Direction | dev registry test + **QA E2E** `spec-058-...e2e.test.ts` ("leaves passive.objectsPresent") | ✅ QA added |
| AC-3 | No unbounded growth: repeated open/close leaves room state at baseline; affordance list does not grow per conversation ever opened | #224 Impact #1/#3, spec 033 Constraint | dev "no drift" + "affordance list" tests | ✅ dev |
| AC-4 | Conversation record retained in the manager for consolidation/history — the fix deletes the mirror, not the history | #224 Direction | **QA** "retains the CLOSED conversation record" + "exports the closed conversation" | ✅ QA added |
| AC-5 | Close-time consolidation still produces per-participant `interaction` memories | spec 033 R5 | **QA** "still consolidates … interaction memories" (spec 033 AC-4 also covers this) | ✅ QA added |
| AC-6 | Removal runs **before** `consolidate`, so the mirror is gone even if the consolidation sink throws | PR body design claim | **QA** "already removed … when the sink runs" + "leaves the room clean even when the sink throws" | ✅ QA added |
| AC-7 | Restoring a legacy snapshot containing a CLOSED conversation does not resurrect a mirror | PR body (second leak path) | dev "does not resurrect a mirror … CLOSED" | ✅ dev |
| AC-8 | An OPEN conversation stays registered, perceivable and offers its affordances (do-not-over-remove) | PR body | dev "keeps an OPEN conversation …" + "closing one does not disturb another" | ✅ dev |
| AC-9 | Idempotent for double closes and unknown ids | PR body | dev "is idempotent for double closes and for unknown ids" | ✅ dev |
| AC-10 | A closed conversation contributes nothing to `prunedAffordances` / `formulate_plan` enum / affordance tool list; the open R2 per-object collision filter still holds | spec 058 amendment (R1–R3) | dev E2E `spec-058-...e2e.test.ts` closed→absent + open-collision | ✅ dev |

`X/Y = 10/10` testable acceptance criteria covered.

## Tests added by QA

1. **`packages/engine/tests/spec-224-qa-coverage.test.ts`** (new, 5 tests) —
   history retention, consolidation intact, and the removal-before-consolidation
   ordering (including a throwing sink).
2. **`examples/tests/spec-058-eligibility-bound-plan-affordances-e2e.test.ts`**
   (+1 test) — after a **real** `talk_to` conversation is closed in the real
   assembled `DYNAMIC_WORLD_SCENE`, the conversation id leaves
   `perception.passive.objectsPresent`; while open it is present.

### Red-capability (verified)

Run against the pre-fix `conversation-manager.ts` (`HEAD^`), the new engine QA
suite is **4 failed / 1 passed**. The 4 failures are the leak assertions
(mirror still registered, sink sees it, room not cleaned even on throw). The one
pass is the history/export guard, which must pass in both states. The QA E2E
`objectsPresent` test is likewise red pre-fix (the dead mirror stays perceivable).

## Results

| check | result |
| --- | --- |
| `pnpm test` | **green** — engine 74 files / 919 passed (was 914), cognition 79 / 1240, assembly 11 / 89, examples 23 / 253 (was 252), shared 34 / 399, memory 13 / 101, visualizer 9 / 48, cli 4 / 15 |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm format:check` | clean |

## Gaps / notes

- **No live run.** AC-7-style 40-minute live evidence (skip-share, prompt-growth
  reversal) is not CI-testable and remains on the original live-validation track
  (issue #206 / spec 058 AC-7). The deterministic mechanism it observes is pinned
  by the existing spec-058 E2E suite.
- **YAAM observation:** no workspace was initialized for this feature
  (`workspace:feature-224-*` absent from the graph), so no Architect/Developer
  scratchpad notes existed to search. Findings are recorded in this file, which
  is itself YAAM-indexed under `docs/specs/notes/` (the spec-045 note documents
  that the daemon exposes search but no note-write method).
- Only test files were touched by QA; no implementation changes.
