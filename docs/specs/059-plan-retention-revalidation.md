# Feature: Plan-Retention Re-Validation — Guardrail-Rejected Stale Steps Invalidate the Plan (Issue #210)

## Context

- Architecture: [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (the affordance value space; `engineEffect` is the engine's contract), [§6 — PPER Loop](../architecture/06-pper-loop.md) (Perceive → Plan → Execute → Reflect, and the guardrail deviation → Reflect branch), [§7 — Structured Outputs](../architecture/07-structured-outputs.md) (enum binding as a value-space constraint; the validator as backstop), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (mechanism 3: plan validation → reflection tick), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (`currentPlan`, `lastPlanOutcome`), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (outcome stamps as episodic self-model data)
- Related specs: [058 — Eligibility-Bound Plan Affordances](058-eligibility-bound-plan-affordances.md) (bounds plan _formation_; this spec extends the same principle to plan _retention_ — the preferred direction in issue #210), [031 — Execute-Time Co-Location Guard & Stale Plan Re-Validation](031-execute-colocation-guard.md) (the stale-target rejection that never invalidated), [037 — Enum-Bound Plan Formulation](037-enum-bound-plan-formulation.md) (`MAX_STEP_FAILURES` step-skip livelock guard, reused as the safety net), [016 — Cognitive Guardrails](016-cognitive-guardrails.md) (`deviationRejected` → Reflect, preserved), [056 — Plan Supersession Stamping](056-plan-supersession-stamping.md) (`superseded` outcome stamped at replacement — reused at invalidation), [057 — Plan Skip Honesty](057-plan-skip-outcome-honesty.md) (honest skip/outcome vocabulary), [002 — Plan Phase](002-plan-phase.md) (plan stickiness — the property that made the loop unavoidable), [003 — Execute Phase](003-execute-phase.md), [049 — Diagnostic Pattern](049-dialogue-completion-urge-observability-reply-window.md) (zero-LLM stderr diagnostics), [021 — KV-Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (dynamic-section-only prompt changes), [051 — Enum-Bound Conversation Targeting](051-enum-bound-talk-targets.md) (the conversation channel is the `talk_to` route, not a plan target), [030 — Dynamic Scenes](030-dynamic-scenes-living-worlds.md) (runtime mutation makes plans go stale)
- Package: `shared` (one additive bridge method, one additive result field, one additive reason-code field), `engine` (plan invalidation + the agent-scoped eligibility adapter), `cognition` (guardrail reason codes, execute-time invalidation + deviation skip, plan-enum executability filter, one diagnostic)
- Issue: [#210 — Plan-retention livelock](https://github.com/Redna/evol-hive/issues/210)

## Problem Summary (live-run verified, issue #210)

A plan step the guardrail rejects as stale is **never re-validated, never skipped, and never invalidates its plan**. The same plan + step is handed to Execute forever, each iteration costing one Reflect LLM call, with zero executions and zero plan re-formulation. In the 10-minute probe (`/home/anima/058probe-devloop.log`, 4,480 lines):

| Signal                                  | Value                                                |
| --------------------------------------- | ---------------------------------------------------- |
| `[execute]` guardrail rejections        | 896                                                  |
| `[reflect]` (one paid LLM call each)    | 963                                                  |
| `[plan-create]`                         | 41                                                   |
| `[affordance]` executions               | 38 (last at line 798)                                |
| consecutive rejections on one plan+step | 324 / 297 / 273 (apprentice-1 / gardener-1 / iris-1) |

All three agents end `thinking=true`, rooms frozen, drives decaying. The 40-minute #206 AC-7 run stalled at ~t+3min for the same reason.

**Root cause chain.** (1) A plan is formulated while its step target is eligible. (2) The world moves on (object harvested / moved / state changed) or a connection closes. (3) Execute's plan validation rejects the step (`packages/cognition/src/guardrails/index.ts`, the spec-031 affordance guard / spec-030 topology guard) and returns `deviationRejected: true`. (4) The orchestrator's deviation branch routes to Reflect and returns to Perceive **without advancing the step and without recording a failure** (spec 016 Req 12 / AC-22). (5) Reflect cannot rewrite plan steps (plans are rewritten only in the Plan phase) and `clearPlanIfComplete` is a no-op for an incomplete plan; the sticky Plan phase (spec 002) hands the same plan back to Execute. Nothing in the loop can break it: the spec-037 step-skip guard is reachable only from the execution-failure path, never from a deviation.

Spec 058 bounded plan **formation** but not plan **retention**, so step targets absent from the live eligible enum (e.g. `pick_herbs`, `water_plants` in the `[plan-enum]` evidence) remain selected as the current step indefinitely.

**Secondary finding.** The plan enum offers affordances that can never execute: a step targeting the conversation affordance `contribute` fails with `No handler registered for affordance: contribute` (conversation handlers are registered under the `conversation_*` engine-effect namespace, while physics dispatches by affordance id). It self-heals through the step-skip guard after two cycles, but every occurrence is a wasted plan + skipped step.

## Requirements

### R1 — Agent-scoped, moment-scoped eligibility on the guard bridge (shared, engine)

Extend the existing `AffordanceGuard` bridge (spec 031 Req 5) with an optional agent-scoped method:

`isAffordanceEligibleForAgent?(affordanceId: string, roomId: string, agentId: string): boolean`

`true` when `affordanceId` is in the agent's live moment-scoped eligible set for `roomId` — the same projection spec 058 R1 already feeds the plan enum (`PerceptionProvider.getVisibleAffordancesInRoom(agentId, roomId)`, which composes conversation eligibility and fog). The engine's assembly adapter implements it against that live read (falling back to `isAffordanceAvailableInRoom` only when the visibility projection is unavailable), never a cached view and never a flat-id scan across the room. The method is optional so existing guard implementations compile and behave byte-identically.

### R2 — Machine-readable rejection reason (shared, cognition)

Add an optional `reasonCode` to `PlanValidationResult`: `'stale-target' | 'movement-blocked' | 'deviation'`. `GuardrailEngineImpl.validateAction` sets it on every rejection — the spec-031 affordance guard sets `'stale-target'`, the spec-030 topology guard sets `'movement-blocked'`, the plan-alignment branch sets `'deviation'`. The field is additive and optional; the human-readable `reason` strings are unchanged so existing consumers and tests are untouched. The guard uses `isAffordanceEligibleForAgent` when the wired guard provides it, otherwise `isAffordanceAvailableInRoom` (legacy path unchanged).

### R3 — Stale-target rejection invalidates the in-flight plan (shared, engine, cognition)

Before handing a `'stale-target'` rejection back, Execute invalidates the agent's plan so the next cycle re-formulates from fresh eligibility:

- Add an optional `invalidatePlan?(agentId: string): void` to `ExecuteDataProvider` (shared) and an `invalidatePlan(agentId: string): void` to the engine's `PlanManager`. `PlanManagerImpl.invalidatePlan` stamps a `superseded` outcome for the in-flight plan (reusing the spec-056 `stampSupersededOutcome` semantics: `success: false`, `superseded: true`, `stepsCompleted`, `stepsTotal`, `reflected: false`, and the `[plan-superseded]` diagnostic) and then clears `currentPlan`.
- In `ExecuteServiceImpl.executeImpl`, when plan validation returns `reasonCode === 'stale-target'` and `invalidatePlan` is wired, call it once, retain the pre-invalidation plan id for diagnostics, set system feedback to the rejection reason, set `isThinking` false, and return `{ success: false, error: reason, planComplete: false, deviationRejected: true, planInvalidated: true }`.
- Because `currentPlan` is now `null`, the sticky Plan phase (spec 002) no longer returns the stale plan; the next cycle formulates a fresh plan from the spec-058 eligible enum. The orchestrator's existing deviation → Reflect branch (spec 016 Req 12) is preserved; Reflect observes `planAtEntry === null` and does not double-stamp.
- Add the optional `planInvalidated?: boolean` to `ExecuteResult` (shared). When `invalidatePlan` is not wired, Execute falls through to R4.

### R4 — Guardrail deviations join the step-skip guard (cognition, safety net)

A guardrail rejection that does not invalidate the plan (movement blocked, a legacy guard without `invalidatePlan`, or a generic deviation) is fed through the existing spec-037 `registerStepFailure` path exactly like an execution failure: consecutive rejections of the **same step** are counted, and after `MAX_STEP_FAILURES` (2) the step is advanced (`stepSkipped: true`, `[step-skip]`), so no plan+step can be handed to Execute more than the bounded number of times. A successful step or a step change resets the counter. `MAX_STEP_FAILURES` and the skip semantics are unchanged.

### R5 — A stale event is visible and its outcome is honest (cognition, engine)

Emit one zero-LLM `[plan-stale]` line per invalidation at the execute seam, carrying agent id, plan id, step index/total, and the offending `targetAffordance`; the line is wrapped so a logging failure can never break a cycle (spec-049 discipline). The invalidated plan's `lastPlanOutcome` is the honest `superseded` stamp from R3 (spec 056/057 vocabulary), so the "Your last plan was" prompt renders truthfully. The existing `[execute]` outcome line continues to name the invalidated plan (the plan snapshot is captured before invalidation).

### R6 — Bound the plan enum by executability (cognition, amendment to spec 058 R3/AC-4)

Conversation-channel affordances must never be offered as plan steps. The plan `targetAffordance` value space and its binding validator exclude affordances whose `engineEffect` names the conversation channel (`conversation_*`): the plan builder filters them out before building the `formulate_plan` tool **and** before setting `payload.availableAffordances` (so `checkPlanBinding` enforces the same set). Conversation affordances remain in `PerceptionResult.prunedAffordances` and the affordance-tool list per spec 058 (the perception/tool surfaces keep the eligibility projection); only the plan value space is executability-bound. This is the deliberate resolution of the issue's secondary finding — the conversation channel is the `talk_to` cognitive tool (spec 051), and the `conversation_*` handlers are not addressable by affordance id, so routing plan steps through them would be a larger, separate change.

### R7 — Live-run validation (evidence)

A 40-minute real-LLM run of the #206 AC-7 harness (`USE_REAL_LLM=true SCENE_DURATION_MS=2400000 npx tsx examples/dynamic-world-sim.ts`, cc=3, 3 agents, freshly built dist) is the acceptance instrument: `[affordance]` executions keep appearing in the final 10 minutes; no plan+step is handed to Execute more than twice after a guardrail rejection; `[plan-stale]` lines are present for stale events and `[reflect]` calls per plan are bounded; `[plan-superseded]` outcomes are stamped for invalidated plans. Evidence attached to issue #210.

## Acceptance Criteria

- [ ] **AC-1** (R1): Unit test — `GUARDRAIL.validateAction` rejects a non-movement step whose target is absent from the wired `isAffordanceEligibleForAgent` projection with `reasonCode === 'stale-target'`; passes when it is present; with a guard that omits the new method, the existing `isAffordanceAvailableInRoom` behavior and reason string are byte-identical. _(maps to R1)_
- [ ] **AC-2** (R1): Engine/assembly test — the adapter's `isAffordanceEligibleForAgent` reads the live `getVisibleAffordancesInRoom(agentId, roomId)` projection: an ineligible conversation affordance for that agent is not eligible, an eligible one is, and a non-conversation affordance is unaffected; the read is uncached across ticks. _(maps to R1)_
- [ ] **AC-3** (R2): Type/test — all three rejection kinds carry the documented `reasonCode`; `PlanValidationResult` literals without `reasonCode` typecheck and render as before; `pnpm typecheck` passes under `exactOptionalPropertyTypes`. _(maps to R2)_
- [ ] **AC-4** (R3): Execute unit test — an agent with an in-flight plan and a stale-target rejection calls `invalidatePlan` exactly once, returns `deviationRejected: true` and `planInvalidated: true`, does not advance the step, and leaves `currentPlan === null`; a subsequent `PlanService.plan()` does **not** return the invalidated plan (stickiness bypassed) and invokes the LLM for a fresh formulation. _(maps to R3)_
- [ ] **AC-5** (R3): Engine unit test — `invalidatePlan` stamps `lastPlanOutcome` with `superseded: true`, `success: false`, the plan's `stepsCompleted`/`stepsTotal`, and `reflected: false`, then clears `currentPlan`; a subsequent `createPlan` does not stamp a second superseded outcome for the same plan; the `[plan-superseded]` line is emitted once. _(maps to R3)_
- [ ] **AC-6** (R3): Fallback test — with `invalidatePlan` unwired, a stale-target rejection does not clear the plan and instead falls through to R4; the result carries no `planInvalidated`. _(maps to R3)_
- [ ] **AC-7** (R4): Deviation-skip test — two consecutive `'movement-blocked'` (or generic `'deviation'`) rejections of the same step: the first does not advance, the second advances with `stepSkipped: true` and emits `[step-skip]`; the counter resets on step change or a successful step; `MAX_STEP_FAILURES === 2` is unchanged. _(maps to R4)_
- [ ] **AC-8** (R5): Diagnostic test — one `[plan-stale]` line per invalidation containing agent id, plan id, `step=i/N`, and the target affordance (e.g. `[plan-stale] agent=iris-1 plan=plan_iris-1_150.6_40 step=3/3 target='water_plants' not in eligible set — plan invalidated`); a thrown diagnostic never propagates; the `[execute]` line names the invalidated plan. _(maps to R5)_
- [ ] **AC-9** (R5, R6): Prompt/validator test — a `superseded` outcome renders the spec-056 "Your last plan was … — superseded after N of M steps." line; the `formulate_plan` tool enum and `checkPlanBinding` both exclude `conversation_*` affordances while `PerceptionResult.prunedAffordances` and the affordance-tool list still include eligible conversation affordances (the documented spec-058 amendment). _(maps to R5, R6)_
- [ ] **AC-10** (R1–R6): Regression suite — the spec-031 guardrail suite, spec-037 enum/skip suite, spec-056 supersession suite, spec-057 skip-honesty suite, and spec-058 eligibility suite pass unmodified; `pnpm -r test && pnpm typecheck && pnpm lint` pass; a legacy provider without `invalidatePlan`/`isAffordanceEligibleForAgent` behaves byte-identically. _(maps to R1, R2, R3, R4, R6)_
- [ ] **AC-11** (R7): 40-minute live run — affordance executions continue in the final 10 minutes; no plan+step is handed to Execute more than twice after a guardrail rejection; bounded `[reflect]` per plan; `[plan-stale]` and `[plan-superseded]` present for stale events. Evidence attached to issue #210. _(maps to R1–R7)_

## Constraints

- **Package boundaries (ADR-0001)**: only `shared` (the additive `AffordanceGuard` method, `ExecuteDataProvider.invalidatePlan`, `ExecuteResult.planInvalidated`, `PlanValidationResult.reasonCode`), `engine` (`PlanManagerImpl.invalidatePlan`, the assembly adapter), and `cognition` (guardrail reason codes, execute invalidation/deviation skip, plan-builder executability filter, `[plan-stale]`) may change. No new cross-package dependency; `shared ← engine`, `shared ← cognition`, `memory ← cognition` hold; no import cycles. `memory` untouched.
- **One source of truth for eligibility**: the agent-scoped eligible set is the engine's `getVisibleAffordancesInRoom` projection (spec 058 R1). Retention must consume it, not re-derive it; cognition never inspects conversation state.
- **Additive-optional discipline**: every new field/method is optional and conditionally used; skip-free and legacy executions keep their exact `ExecuteResult` shape, plan-validation results without `reasonCode` are unchanged, and unwired guards/providers are byte-identical.
- **Boundedness, not force**: invalidation removes a plan that can no longer progress; it does not force an action, rewrite remaining steps, or change the eligible set. The step-skip safety net keeps the spec-037 threshold.
- **Reflection contract preserved**: a stale-target rejection still routes to Reflect exactly as spec 016 Req 12 / AC-22 specifies; invalidation guarantees the loop cannot repeat, so LLM spend is bounded at one Reflect per invalidated plan. The deviation branch and its counter-reset behavior are unchanged for non-stale deviations.
- **Prompt discipline (spec 021)**: no new line is added to the stable system prefix; the plan-enum executability filter changes only the per-cycle tool-definition block.
- **Diagnostic discipline (spec 049)**: `[plan-stale]` is one line per event, zero LLM, pure string arithmetic, and a diagnostic failure never breaks a cycle.
- **What NOT to do**:
  - **Do not clear the plan inside `GuardrailEngineImpl`.** The guard remains advisory (spec 031 Req 7); invalidation belongs to the Execute phase, which owns the `ExecuteDataProvider`.
  - **Do not skip or advance the step on a stale-target rejection that invalidated the plan.** The whole plan is stale, not merely the step; advancing is R4's fallback only.
  - **Do not remove the spec-031 rejection or its reason string.** The guard still rejects; this spec changes what happens after the rejection.
  - **Do not short-circuit the Reflect call for stale deviations.** Spec 016 Req 12 reflection-on-world-change is preserved; invalidation, not call suppression, is the bound.
  - **Do not re-derive conversation eligibility in cognition** or filter conversation affordances by a flat affordance-id list (`observe` collides with non-conversation objects) — use the `conversation_*` engine-effect namespace (R6) and the engine projection (R1).
  - **Do not touch `PerceptionResult.prunedAffordances` or the affordance-tool list for R6** — spec 058's eligibility projection there is intentional; only the plan value space is executability-bound.

## Design Decisions

**Decision 1 — Plan invalidation (direction A) as the primary fix, step-skip (direction B) as the safety net.** In `ExecuteServiceImpl` the action passed to `validateAction` is always the current step's `targetAffordance`, so a `deviationRejected` result can only be a stale-plan-premise rejection (spec-031 stale target or spec-030 blocked movement) — never the generic plan-alignment deviation. Reflect cannot rewrite incomplete plans and the Plan phase is sticky (spec 002), so only mutating plan state or advancing the step can break the cycle. Invalidation is semantically correct for an irreversibly stale target (the plan's premise is gone); the step-skip counter bounds transient/blocked-movement rejections and any legacy path without `invalidatePlan`.

**Decision 2 — Reuse the spec-058 projection rather than add a cognition-side check.** The plan enum already consumes the engine's moment-scoped eligible set. Extending the existing `AffordanceGuard` bridge (spec 031's stale-step mechanism) keeps one source of truth and prevents formation/retention drift. Eligibility lives engine-side because conversation state and agent location live there (ADR-0001).

**Decision 3 — A reason code, not reason-string parsing.** Execute must act differently for an irreversibly stale target (invalidate the whole plan) versus a blocked movement (skip after two). A machine-readable additive `reasonCode` keeps the decision robust and the human-readable `reason` strings unchanged for existing tests.

**Decision 4 — Stamp `superseded` at invalidation.** Spec 056 only stamps when a plan is replaced by a new formulation; once Execute clears the plan, Reflect's `planAtEntry` is null and `stampPlanOutcome` cannot run. Stamping the honest `superseded` outcome before clearing preserves the self-visibility spec 055/056 built and satisfies spec 057's honesty vocabulary.

**Decision 5 — Keep one Reflect call per invalidated plan.** Spec 016 Req 12 / AC-22 deliberately reflects on a deviation. Invalidation already guarantees the plan cannot be handed back, so spend is bounded at one Reflect per plan (the issue's bounded-spend criterion) without removing reflection.

**Decision 6 — Exclude conversation affordances from the plan enum (secondary finding).** They carry the `conversation_*` engine effect and have no physics handler reachable by affordance id; the conversation channel is the `talk_to` cognitive tool (spec 051), and `conversation_contribute` returns a guidance failure anyway. Routing plan steps into the bridge would put plan-driven conversation membership in tension with the spec-044 influence-not-force urge model and is a larger, separate change. This amends spec 058 R3/AC-4 **for the plan enum only**; the eligibility projection for perception and affordance tools is unchanged.
