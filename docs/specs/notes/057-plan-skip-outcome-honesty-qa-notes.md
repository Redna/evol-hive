# Spec 057 QA Notes — Test-Coverage Verification for PR #207

> YAAM note (QA session record): QA coverage verification for PR #207
> (spec 057, issue #204). Same convention as
> `056-plan-supersession-stamping-qa-notes.md` /
> `055-world-saturation-plan-memory-horizon-qa-notes.md`: notes are written as
> `docs/specs/notes/*.md` files, indexed by the YAAM daemon's document adapter
> and findable via `search` (raw-TCP JSON-RPC on `127.0.0.1:<daemon.port>`,
> method `search`, param `text`).

## Verdict

**Coverage complete — 8/8 acceptance criteria mapped; all suites green.
Recommend approve/merge. QA added one cross-package E2E (2 tests); the
remaining ACs were already pinned by the PR's test-first suites.**

## What was verified (PR head `c682162` on `feature/204-plan-skip-outcome-honesty`)

- `pnpm build` first, then `pnpm test` — **8/8 projects green, 0 failures**:
  shared 382, visualizer 48, memory 101 (+24 todo), cognition 1105 (+1 skipped
  / +26 todo), engine 865 (+141 todo), assembly 76, examples 243 (+3 todo; +2
  QA tests), cli 15 — 2,835 passing (exit 0).
- `pnpm typecheck` — exit 0 (runs under `exactOptionalPropertyTypes`, the
  type-level teeth of AC-4).
- `pnpm lint` — exit 0, 0 findings.
- `prettier --check` on the new/PR-057 test files — clean.

## Acceptance-criterion → test mapping

| AC | Tests | Notes |
|----|-------|-------|
| AC-1 (R1) | `packages/cognition/tests/spec-057-plan-skip-outcome-honesty.test.ts` — cumulative 0→1→1→1→2 across a 3-step plan; intermediate skip result 1, final 2 | mock `ExecuteDataProvider`, real `ExecuteServiceImpl` |
| AC-2 (R1) | same file ×2 | skip-free result omits the key (`Object.keys` + `toBeUndefined`); new plan id resets a previously-accumulated count |
| AC-3 (R1, R6) | same file ×2 + spec-037 suite | 2-consecutive-failure guard, exact `[step-skip]` string, skip-free result shape `toEqual`; `spec-037-enum-bound-planning.test.ts` (skip/wait semantics) unchanged and green |
| AC-4 (R2) | `packages/shared/tests/spec-057-last-plan-outcome-steps-skipped.test.ts` ×3 + `pnpm typecheck` | additive-optional / conditionally-spread / no undefined-valued keys |
| AC-5 (R3) | cognition suite ×3 | stamps `stepsSkipped` when `> 0`; omits when absent; treats `0` as absent. `reflected`/`driveChanges` coexist |
| AC-6 (R4) | cognition suite ×6 | exact golden line, dynamic-section-only (stable prefix untouched), deltas before the period + reflection adjacency, superseded precedence, spec-055 byte-identity, empty-step-list fallback |
| AC-7 (R5) | cognition suite ×3 | `skipped=2` present; byte-identical with no `skipped=` when absent; superseded line carries both `steps=` and `skipped=`; spec-056 exact-string suite unchanged |
| AC-8 (R1–R5) | live run on PR/issue evidence + **QA E2E gap-fill** `examples/tests/spec-057-plan-skip-honesty-e2e.test.ts` ×2 | real `PlanManagerImpl` → real `ExecuteServiceImpl` → real `ReflectServiceImpl` → real `PlanBuilderImpl` / `PlanServiceImpl` diagnostic |

## Coverage gap found and fixed by QA

**Gap**: the PR's suites pin every seam in isolation but **no test ran the
accumulated count across the package boundary** — AC-1 used a mock
`ExecuteDataProvider`, AC-5 fed a *hand-built* `ExecuteResult` into Reflect, and
AC-6/AC-7 called the builder/diagnostic with *hand-built* outcomes. The exact
chain the AC-8 live run rides (Execute accumulator → stamped
`AgentInternalState.lastPlanOutcome` → next prompt + `[plan-memory]`) was
unexercised at the integration level.

**QA fix** (`examples/tests/spec-057-plan-skip-honesty-e2e.test.ts`, 2 tests,
green, zero LLM calls, mirrored on the spec-056 E2E precedent):
1. **Skipping path**: real `PlanManagerImpl` (fake clock) hosts the 3-step plan;
   the real `ExecuteServiceImpl` fails step 0 twice → skip (`stepsSkipped: 1`),
   succeeds step 1 (total **not** reset), fails step 2 twice → skip
   (`stepsSkipped: 2`, `planComplete: true`); real `ReflectServiceImpl` stamps
   `{success: true, stepsSkipped: 2, reflected: true}` on the agent state; the
   real `PlanBuilderImpl` renders
   `Your last plan was "plant_seeds, brew_coffee, harvest" — 2 of 3 steps were skipped.`
   in the dynamic section only; real `PlanServiceImpl` emits exactly one
   `[plan-memory] agent=gardener-1 verdict=succeeded steps=- skipped=2 reflected=true`.
   The two `[step-skip]` lines are asserted byte-exact (Req 6).
2. **Skip-free control**: the same real chain omits the field end-to-end
   (`stepsSkipped` key absent on results and stamp), renders the spec-055
   `— it succeeded.` verdict, and emits no `skipped=` diagnostic — the
   additive/byte-identity property pinned across the boundary.

No production code touched by QA — one test file only.

## Gaps / notes

1. AC-8's live-run clause is satisfied by the attached real-LLM run
   (`USE_REAL_LLM=true SCENE_DURATION_MS=420000`, ~7 min: 11 `[step-skip]`,
   9 `[plan-memory]` with `skipped=`, Σ`skipped`=10 ≤ 11, `[plan-repeat]`=0).
   The deterministic E2E added here makes the same chain CI-reproducible.
2. AC-1..AC-8 are all `[x]` in the spec; INDEX lists spec 057 as 🔍 In Review.
3. Environment note (pre-existing, not a regression): a bare `pnpm test` on a
   fresh checkout needs `pnpm build` first (workspace `@evol-hive/*` dists).
4. Observation (not a defect): only the spec-037 livelock-guard advance
   (`registerStepFailure`) increments the count. The "unresolvable affordance"
   skip path returns `stepSkipped: true` **without** incrementing
   `stepsSkipped` — consistent with R1's wording ("exactly once per
   `[step-skip]` advance"), and worth keeping in mind when reading live logs
   (a skipped narrative step with an unresolvable affordance reports no count).

## Pipeline actions taken

- QA report posted on PR #207 (comment).
- Issue #204 labeled `Status: In Review/QA`.
- This note + the E2E gap-fill committed to the PR branch
  (precedent: spec-056 QA note committed to PR #203).
