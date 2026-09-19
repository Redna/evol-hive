# QA Notes — Spec 059 Hardening / Issue #215 (PR #222)

> YAAM breadcrumb: the daemon (raw-TCP JSON-RPC, port in `.yaam/daemon.port`;
> read method `search` with param `text`) indexes this file. PR:
> [#222](https://github.com/Redna/evol-hive/pull/222) ·
> branch `215-stepfailures-invalidation` · HEAD `f861de1` + QA commit.

## Verdict

All five items of #215 are delivered. Test coverage for items 1, 2, 3 and 5 is
complete and green; item 4's literal acceptance wording ("a broken test double
fails `pnpm typecheck`") is **not satisfiable under the chosen route (b)** —
the gap is inherent to the route, not a missing test, and is documented below.
One engine-layer coverage gap was found and closed with two new tests
(`spec-215-legacy-plan-manager-noop.test.ts`).

## Item → coverage map

| #         | Requirement / AC                                                                                                                                                                                | Status     | Evidence                                                                                                                                                                                                                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | `stepFailures` cleared on the stale-target invalidation path; a new plan reusing the step description gets the full two attempts                                                                | ✅ COVERED | `packages/cognition/tests/spec-215-stepfailures-cleared-on-invalidation.test.ts` (1 test) — drives deviation→count 1, stale invalidation, then a new plan reusing the description                                                                                                                                                                                                |
| 2         | Legacy guard (no `isAffordanceEligibleForAgent`) still rejects and **falls through to R4**: first rejection counts, second → `stepSkipped` + `[step-skip]`, plan not cleared, no `[plan-stale]` | ✅ COVERED | new test in `packages/cognition/tests/spec-059-execute-plan-invalidation.test.ts` (AC-6 legacy fall-through)                                                                                                                                                                                                                                                                     |
| 3         | Orchestrator-level single stamp: invalidating Execute → Reflect yields exactly one `lastPlanOutcome` write and one `[plan-superseded]`                                                          | ✅ COVERED | `packages/cognition/tests/spec-215-orchestrator-reflect-non-double-stamp.test.ts` (1 test, recording provider)                                                                                                                                                                                                                                                                   |
| 4         | Tests-inclusive typecheck / a broken test double fails `pnpm typecheck`; guard demonstrated                                                                                                     | ⚠️ PARTIAL | Route (a) rejected on measured evidence (703 tests-inclusive errors). Route (b): `planManager.invalidatePlan?.()` + `PlanManagerInvalidating` compile guard. **Gap:** plain `pnpm typecheck` still excludes `tests/**`, so a broken test double is _intentionally_ not caught. Added runtime mirror: `packages/engine/tests/spec-215-legacy-plan-manager-noop.test.ts` (2 tests) |
| 5a        | Integration — stale target through the **real** assembly bridge invalidates, emits `[plan-stale]`+`[plan-superseded]`, no `[step-skip]`, next cycle re-formulates                               | ✅ COVERED | `packages/assembly/tests/spec-059-plan-invalidation-integration.test.ts` (2 tests, real `assembleWorld` → real registry/perception → real `ExecuteDataProviderImpl.invalidatePlan` → real `PlanManagerImpl`)                                                                                                                                                                     |
| 5b        | Livelock E2E — N cycles with an always-ineligible step: no plan+step handed to Execute more than twice, `[reflect]` bounded; legacy R4 path exactly twice then `[step-skip]`                    | ✅ COVERED | `packages/assembly/tests/spec-059-plan-retention-livelock-e2e.test.ts` (2 tests)                                                                                                                                                                                                                                                                                                 |
| 059 AC-10 | Regression suites (031/037/056/057/058) pass unmodified                                                                                                                                         | ✅ COVERED | full `pnpm test` run, no assertions amended by this QA pass                                                                                                                                                                                                                                                                                                                      |

## QA action taken (new test)

`packages/engine/tests/spec-215-legacy-plan-manager-noop.test.ts` (2 tests):

1. **Legacy manager no-op through the real bridge** — a `PlanManager` that
   predates spec 059 (no `invalidatePlan`) wired into `ExecuteDataProviderImpl`
   makes `bridge.invalidatePlan(agentId)` a no-op: plan retained,
   `lastPlanOutcome` untouched, no throw. This is the engine-layer twin of
   spec 059 AC-6, which was only pinned for an **unwired provider**, never for a
   wired provider backed by a legacy manager — the exact configuration item 4's
   optionality introduced.
2. **Runtime mirror of the compile gate** — `typeof
PlanManagerImpl.prototype.invalidatePlan === 'function'`, and a real
   invalidation clears/stamps. Documents the guarded capability next to its
   fall-through contract.

## Verification results

| Gate                | Result                                                               |
| ------------------- | -------------------------------------------------------------------- |
| `pnpm build`        | exit 0 (required: examples-reaching tests resolve workspace `dist/`) |
| `pnpm test`         | exit 0 — 8/8 packages green (details below)                          |
| `pnpm typecheck`    | exit 0                                                               |
| `pnpm lint`         | exit 0                                                               |
| `pnpm format:check` | exit 0 (all matched files use Prettier)                              |

`pnpm test` totals (my QA commit adds **+2** tests to engine, 903 → 905):

| package    | files | tests                      |
| ---------- | ----- | -------------------------- |
| shared     | 34    | 399                        |
| visualizer | 9     | 48                         |
| memory     | 13    | 101 (+24 todo)             |
| engine     | 72    | 905 (+141 todo)            |
| cognition  | 75    | 1197 (+1 skipped, 26 todo) |
| assembly   | 11    | 89                         |
| examples   | 22    | 248 (+3 todo)              |
| cli        | 4     | 15                         |

Focused spec-215/059 files: cognition 16 tests, assembly 8 tests, engine 13
tests — all pass.

## Gaps / notes

- **#215 item 4 (partial).** The AC's literal clause — "a broken test double
  fails `pnpm typecheck`" — contradicts the chosen route (b): making
  `invalidatePlan` optional is precisely what lets a legacy test double
  typecheck. Only route (a) (include `tests/**` in `tsc --noEmit`) satisfies it,
  and that route was rejected with a measured 703-error backlog. No automated
  test can assert a `tsc` exclusion; recommend amending the item-4 AC to "the
  production implementation must still provide it via a compile-checked guard,
  and a legacy test double must remain assignable".
- **Spec 059 AC-11 (live 40-minute run).** Out of scope for this hardening PR;
  already validated post-merge on #210 (max 2 hand-offs/plan+step, 1:1
  `[plan-stale]`:`[plan-superseded]`, executions continuing). The deterministic
  assembly E2E here is the standing proxy.
- No implementation code was modified by QA; only the new engine test and this
  note were added.
