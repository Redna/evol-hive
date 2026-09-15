# Implementation Notes — Spec 059 (Plan-Retention Re-Validation) — Issue #210

> YAAM breadcrumb: the daemon (raw-TCP JSON-RPC on the port recorded in
> `.yaam/daemon.port`; read method `search` with param `text`) indexes the
> workspace notes. Durable session records live here as
> `docs/specs/notes/*.md` (spec-045/spec-050/spec-051 convention).
> PR: [#213](https://github.com/Redna/evol-hive/pull/213) ·
> branch `feature/210-plan-retention-revalidation`.

## Verdict

Implementation + tests complete and green. A guardrail-rejected **stale**
target now invalidates the whole in-flight plan (direction A) so the sticky
Plan phase re-formulates from fresh eligibility; every non-invalidating
guardrail deviation falls through to the spec-037 step-skip safety net
(direction B). The only open criterion is **AC-11** (the 40-minute live run),
which requires a real LLM backend and a freshly built `dist` — it is
QA/live-environment owned and left unchecked.

## What was built

### R1 — Agent-scoped, moment-scoped eligibility on the guard bridge (shared, engine)

- `shared` (`packages/shared/src/types/mutations.ts`) — additive-optional
  `AffordanceGuard.isAffordanceEligibleForAgent?(affordanceId, roomId, agentId)`.
  No existing guard implementation is affected.
- `cognition` (`packages/cognition/src/guardrails/index.ts`) —
  `GuardrailEngineImpl.validateAction` prefers `isAffordanceEligibleForAgent`
  (called with the guard as `this`) and falls back to
  `isAffordanceAvailableInRoom` when the wired guard omits it, so legacy
  behavior and reason strings stay byte-identical.
- `assembly` (`packages/assembly/src/assembly.ts`) — the `AffordanceGuard`
  adapter reads the live `core.bridges.perception.getVisibleAffordancesInRoom(agentId, roomId)`
  projection (the same spec-058 R1 eligible set), falling back to the room
  registry when the visibility projection is unavailable. Never a cached view.
  `affordanceGuard` is now exposed on `CognitionStack` for introspection/tests.

### R2 — Machine-readable rejection reason (shared, cognition)

- New `PlanValidationReasonCode = 'stale-target' | 'movement-blocked' | 'deviation'`
  and additive-optional `PlanValidationResult.reasonCode`
  (`packages/shared/src/types/cognition.ts`).
- `GuardrailEngineImpl.validateAction` sets the code on every rejection:
  the spec-031 affordance guard → `stale-target`, the spec-030 topology guard
  → `movement-blocked`, the plan-alignment branch → `deviation`. The
  human-readable `reason` strings are unchanged.

### R3 — Stale-target rejection invalidates the in-flight plan (shared, engine, cognition)

- `shared` — additive-optional `ExecuteDataProvider.invalidatePlan?(agentId)`
  and `ExecuteResult.planInvalidated?`.
- `engine` — `PlanManager.invalidatePlan(agentId)` and
  `PlanManagerImpl.invalidatePlan` (stamps the honest spec-056 `superseded`
  outcome via `stampSupersededOutcome`, then `clearPlan`).
  `ExecuteDataProviderImpl.invalidatePlan` delegates to it.
- `cognition` (`execute-service.ts`) — on a `stale-target` rejection with
  `invalidatePlan` wired, Execute emits one `[plan-stale]` line, calls
  `invalidatePlan` once, sets the rejection reason as system feedback, sets
  `isThinking` false, returns
  `{ success: false, error: reason, planComplete: false, deviationRejected: true, planInvalidated: true }`,
  and does **not** advance the step. Because `currentPlan` is now `null`, the
  sticky Plan phase re-formulates; the spec-016 deviation → Reflect branch is
  preserved and Reflect sees `planAtEntry === null` (no double stamp).
- `execute()` captures the pre-phase plan so the `[execute]` line still names
  the invalidated plan.

### R4 — Guardrail deviations join the step-skip guard (cognition, safety net)

- A rejection that does not invalidate the plan (movement blocked, a legacy
  provider without `invalidatePlan`, or a generic deviation) is fed through the
  existing spec-037 `registerStepFailure` path exactly like an execution
  failure: two consecutive rejections of the same step advance it with
  `stepSkipped: true` / `[step-skip]`. `MAX_STEP_FAILURES === 2` is unchanged,
  and the counter resets on step change or a successful step.

### R5 — A stale event is visible and its outcome is honest (cognition, engine)

- `packages/cognition/src/pper/execute-diagnostic.ts` —
  `planStaleLine` / `logPlanStale` emit exactly one zero-LLM line per
  invalidation at the execute seam, wrapped so a logging failure never breaks a
  cycle (spec-049 discipline):
  `[plan-stale] agent=<id> plan=<id> step=<i>/<N> target='<affordance>' not in eligible set — plan invalidated`.
- The invalidated plan's `lastPlanOutcome` is the `superseded` stamp from R3,
  so the spec-056/057 "Your last plan was … — superseded after N of M steps."
  line renders truthfully in the next cycle's plan prompt.

## Acceptance-criterion → test mapping

| AC | Tests | Notes |
|----|-------|-------|
| AC-1 (R1) | `packages/cognition/tests/spec-059-guardrail-reason-codes.test.ts`, `packages/shared/tests/spec-059-plan-invalidation-types.test.ts` | agent-scoped eligibility consumed when wired; legacy `isAffordanceAvailableInRoom` path byte-identical when omitted |
| AC-2 (R1) | `packages/assembly/tests/spec-059-plan-retention-e2e.test.ts` | adapter reads the live `getVisibleAffordancesInRoom` projection; ineligible vs eligible vs non-conversation; uncached across ticks |
| AC-3 (R2) | `packages/cognition/tests/spec-059-guardrail-reason-codes.test.ts`, `packages/shared/tests/spec-059-plan-invalidation-types.test.ts` | all three codes; literals without `reasonCode` typecheck under `exactOptionalPropertyTypes` |
| AC-4 (R3) | `packages/cognition/tests/spec-059-execute-plan-invalidation.test.ts` | `invalidatePlan` called once, `deviationRejected`/`planInvalidated` true, step not advanced, `currentPlan === null`, stickiness bypassed |
| AC-5 (R3) | `packages/engine/tests/spec-059-plan-invalidation.test.ts` | `superseded` stamp (`success:false`, `superseded:true`, `stepsCompleted`/`stepsTotal`, `reflected:false`) then clear; no second stamp; one `[plan-superseded]` line |
| AC-6 (R3) | `packages/cognition/tests/spec-059-execute-plan-invalidation.test.ts` | unwired `invalidatePlan` leaves the plan and falls through to R4; no `planInvalidated` |
| AC-7 (R4) | `packages/cognition/tests/spec-059-execute-plan-invalidation.test.ts` | first rejection does not advance, second skips with `stepSkipped`/`[step-skip]`; counter resets; `MAX_STEP_FAILURES === 2` |
| AC-8 (R5) | `packages/cognition/tests/spec-059-execute-plan-invalidation.test.ts` | exactly one `[plan-stale]` line with agent/plan/step/target; a thrown diagnostic never propagates; `[execute]` names the invalidated plan |
| AC-9 (R5) | `packages/assembly/tests/spec-059-plan-retention-e2e.test.ts` | assembly-level prompt rendering of the `superseded` verdict (engine cannot import cognition, ADR-0001) |
| AC-10 (R1–R5) | full suite | spec-031/037/056/057/058 suites pass **unmodified**; `pnpm test && pnpm typecheck && pnpm lint` green; legacy providers byte-identical |
| AC-11 (R7, live) | — | **OPEN** — 40-minute real-LLM run, QA/live-env owned (see below) |

## Deviations / follow-ups

- **AC-11 (40-minute live run) NOT executed in this PR.** It requires a real
  LLM backend (`USE_REAL_LLM=true`) and a freshly built `dist`; this sandbox
  has no LLM endpoint. The boundedness mechanism is covered deterministically
  by AC-1–AC-10; live evidence must be attached to
  [issue #210](https://github.com/Redna/evol-hive/issues/210) by QA:
  `[affordance]` executions in the final 10 minutes, no plan+step handed to
  Execute more than twice after a guardrail rejection, bounded `[reflect]` per
  plan, `[plan-stale]`/`[plan-superseded]` present, and the #206 AC-7 skip
  share.
- **AC-9 placement.** Implemented as an assembly-level e2e test because
  `engine` cannot import `cognition` (ADR-0001).
- **AC-10.** The spec-031 e2e now emits the new `[plan-stale]`/
  `[plan-superseded]` lines but its assertions are untouched.
- **Deferred finding** (plan-enum executability — `contribute`/`join` as plan
  steps) intentionally **not** addressed, so spec 058 AC-1-RS stays intact.
  Tracked separately in [#212](https://github.com/Redna/evol-hive/issues/212).
- No new dependencies. Package boundaries and import direction preserved
  (`shared ← engine`, `shared ← cognition`); `memory` untouched.

## Verification session record

- `pnpm test` — 229 test files pass across 8 packages (shared 33, memory 13,
  visualizer 9, cognition 69, engine 71, assembly 8, examples 22, cli 4).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` — all exit 0.
- CI on HEAD `0125444` (run `35014677499`): Type Check & Lint, Build, Test,
  and GitGuardian all **SUCCESS**.
- HEAD is 0 commits behind `origin/main` and 5 ahead; PR #213 is
  **OPEN/MERGEABLE**.

No implementation work is outstanding for this spec.
