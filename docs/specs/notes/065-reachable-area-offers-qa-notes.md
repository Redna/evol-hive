# QA Notes — Spec 065 (Reachable Area Offers) — Issue #225 (slice 2)

> QA verification of PR #267 (`fix/065-reachable-area-offers`). Independent
> test-coverage review against `docs/specs/065-reachable-area-offers.md`.
> Engine-only change; QA added tests only, touched no implementation.

## Verdict

**Coverage complete for every testable acceptance criterion (7/7).** The
Developer's `spec-065-reachable-area-offers.test.ts` already exercised the
primary projection (AC-1…AC-6) plus the engine assembly wire. QA closed the
remaining gaps at the projection and at the production composition root:

- **R3 on a second projection** — the knowledge view (`getUnexploredAreas`)
  still lists a door-only room after the door closes while the offer
  (`getKnownAreas`) drops it.
- **R2 + R4 integration** — a relocated anchor, once reconciled, resolves
  through the injected reachability port to its **new** room, so
  `canReachArea` / `navigateToArea` follow the corrected anchor and not the
  stale room.
- **R2 idempotence** — reconciliation writes `spatialMemory` once; repeated
  `getKnownAreas` calls do not churn state per tick.
- **E2E at the composition root** — the value the LLM actually receives, the
  `targetArea` enum on `formulate_plan`, follows door state through
  `assembleWorld`; a removed anchor leaves both `knownAreas` and the enum.
- **E2E guard** — the formulated enum is checked against the same cycle's grid
  route for every non-exempt offered area.

AC-6's guard was already present and red-verified by the Developer; QA
additionally asserts it end-to-end through the assembled stack.

## Coverage map

| AC     | Requirement                                    | Test(s)                                                                 | Status |
| ------ | ---------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| AC-1   | Open door offers neighbour; closed does not, knowledge retained | Dev `spec-065-…test.ts` (2); QA R3 test                                 | ✅     |
| AC-2   | Reopen re-offers without re-observation; visited room stays | Dev (2); QA visited/unexplored test                                     | ✅     |
| AC-3   | Removed anchor gone from offer + perception; relocated re-pointed | Dev (2); QA relocation/removal tests; Assembly E2E removal test         | ✅     |
| AC-4   | Reachable behaviour unchanged (spec 039 regression) | Dev (1); Assembly E2E open-door assertions                              | ✅     |
| AC-5   | Reachability from the existing spatial authority, one decision | Dev (3) + engine assembly test; Assembly E2E door flip                   | ✅     |
| AC-6   | Class guard fails when a stale area is re-admitted | Dev (2, one red-verified); Assembly E2E guard for non-exempt areas       | ✅     |
| AC-7   | Existing suites stay green (038/039/030, cognition knownAreas) | Full monorepo run, all green                                            | ✅     |

## Tests added (QA)

- `packages/engine/tests/spec-065-qa-coverage.test.ts` — 6 tests:
  - `getUnexploredAreas` retains a door-only room after close while
    `getKnownAreas` gates it; a visited room leaves `getUnexploredAreas` and
    stays offered.
  - Relocated anchor: `canReachArea` / `navigateToArea` route to the new room
    and go `no-route` when the new room's door is shut; removed anchor is
    unresolvable (`unknown-area`).
  - Reconciliation is idempotent — the second and third `getKnownAreas` calls
    do not call `updateState`; an unchanged map never writes.
- `packages/assembly/tests/spec-065-target-area-enum-e2e.test.ts` — 3 tests:
  - `assembleWorld` → real `PerceptionServiceImpl` + `PlanBuilderImpl`: the
    `formulate_plan` `targetArea` enum drops a door-only neighbour when the
    door closes and restores it on reopen, while `knownDoors` is retained.
  - A removed object anchor disappears from `perception.knownAreas` and the
    `targetArea` enum, and is pruned from `spatialMemory`.
  - Guard: every non-exempt offered area has an open grid route this cycle.

All QA additions fail red against pre-065 projection (door-only area still
offered; removed anchor still remembered; enum does not follow door state) —
they are behavioural, not crashes (except the new `canReachArea` calls, which
exercised the new port).

## Test results (this run)

Run per the monorepo script (`pnpm test`):

| package    | result                                       | baseline (spec notes) |
| ---------- | -------------------------------------------- | --------------------- |
| shared     | 399 passed / 34 files                        | 399                   |
| memory     | 101 passed + 24 todo / 13 files              | 101                   |
| visualizer | 125 passed / 17 files                        | 125                   |
| engine     | **942 passed** + 141 todo / **77 files**     | 936 + 141 / 76        |
| cognition  | 1252 passed + 1 skipped + 26 todo / 81 files | 1252                  |
| assembly   | **92 passed** / **12 files**                 | 89 / 11               |
| examples   | 253 passed + 3 todo / 23 files               | 253                   |
| cli        | 119 passed / 14 files                       | 119                   |

- `pnpm test` exit 0 — no failures, no skips added.
- `pnpm typecheck` clean; `pnpm lint` clean; `prettier --check` clean on both
  added files.
- Delta is exactly the 9 QA tests (engine 936→942; assembly 89→92). Nothing
  disabled, no implementation file modified.

## Gaps / findings

1. **Spec wording contradiction (R5 vs AC-2) — needs a spec rewording, not a
   test.** R5 says a test MUST fail if the enum contains any area whose same-
   cycle navigation returns `'no-route'`; AC-2 says a personally visited room
   stays offered with the door closed. In a two-room world those are mutually
   exclusive. The Developer implemented R1's narrowing clause literally (gate
   door-only areas; visited exempt) and scoped the guard to non-exempt
   knowledge. QA's E2E guard encodes the same exemption. This is the honest
   reading, but the spec should be amended so a future leg does not
   "implement R5 broadly" and break AC-2. Same class as spec 066 AC-8.
2. **Live object anchors are not route-filtered (residual defect class).** An
   anchor whose object sits behind a closed door is still offered (R1 says
   anchors stay offered "exactly as today"), while navigation reports
   `'no-route'` for it. The Developer flagged this; QA's guard exempts
   anchors. Not testable as a pass until a later slice decides anchors are
   knowledge or offers.
3. **`PerceptionDataProviderOptions.reachability` is inert.** The constructor
   remains positional; only `setReachabilityPort` is wired. A future refactor
   to an options object would silently activate a path no test currently
   covers. Documentation-only for now — flagged, not a coverage gap.
4. **No live-sim validation.** Out of scope for QA; dispatcher-owned. The
   engine/assembly/E2E layers are covered.

## Verdict on the PR

Mergeable from a test-coverage standpoint: 7/7 acceptance criteria have
tests, all tests pass, typecheck/lint/prettier clean. Findings 1 and 2 are
spec/scope concerns for the review conversation, not blockers.
