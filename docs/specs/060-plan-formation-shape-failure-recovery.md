# Feature: Plan-Formation Shape-Failure Diagnostics, Bounded Repair & Fallback Floor (Issue #214)

## Context

- Architecture: [§5 — Fast-Path Classifier](../architecture/05-fast-path-classifier.md) (the pruned affordance value space the plan tool enum binds to), [§6 — PPER Loop](../architecture/06-pper-loop.md) (Perceive → Plan → Execute → Reflect; the Plan phase is the only place a plan can be formulated), [§7 — Structured Outputs](../architecture/07-structured-outputs.md) (tool-calling arguments are the engine's parse contract; shape validation is the backstop), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (mechanism 3: plan validation), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (`currentPlan`, `isThinking`), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (plan-memory context growth is a candidate mechanism)
- Related specs: [037 — Enum-Bound Plan Formulation](037-enum-bound-plan-formulation.md) (the service-layer shape no-retry decision §7 / Req 15, and the client-side bounded empty-args repair this spec extends), [055 — World Saturation & Plan-Memory Horizon](055-world-saturation-plan-memory-horizon.md) (the one-retry-with-feedback and diagnostic precedents; the raised step cap), [058 — Eligibility-Bound Plan Affordances](058-eligibility-bound-plan-affordances.md) (the pruned enum the floor binds to), [059 — Plan-Retention Re-Validation](059-plan-retention-revalidation.md) (the run this defect was observed in; re-formulation frequency was deliberately raised there), [049 — Diagnostic Pattern](049-dialogue-completion-urge-observability-reply-window.md) (zero-LLM stderr diagnostics, never break a cycle), [021 — KV-Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (dynamic-section-only prompt changes), [008 — PPER Error Recovery](008-pper-error-recovery.md) (`maxConsecutiveFailures` cooldown), [052 — Greenhouse Drive Bottoming-Out](052-greenhouse-drive-restoration-diagnostics.md) (the all-`wait` guard the floor must not trip), [057 — Plan Skip Outcome Honesty](057-plan-skip-outcome-honesty.md) (honest outcome vocabulary), [002 — Plan Phase](002-plan-phase.md) (plan stickiness)
- Package: `shared` (one pure shape-classifier over the existing `FormulatePlanResult`), `cognition` (prompt-size estimator, client shape detection/repair, service backstop diagnostics, fallback floor)
- Issue: [#214 — Plan formation returns shape-invalid plans at a rising rate](https://github.com/Redna/evol-hive/issues/214)

## Problem Summary

In the 40-minute AC-11 live run for spec 059 (`/home/anima/059run.log`, main `9d0be9d`, 3 agents, `gemma4:31b-cloud`, `ENGINE_MAX_CONCURRENT_LLM=3`), plan **formation** degrades from ~10% to **96%** of attempts in the final tick-quintile (`[plan-failed]` 14 → 17 → 18 → 32 → **1456**). 1,494 of 1,537 failures carry the string `LLM returned an invalid plan: missing description or steps`; the rest are `Tool call loop exceeded max iterations (3)`. Every failure is paired with `[plan-bind] … steps=N bound=0 violations=["missing description or steps"]` — the model **does** return a steps array (usually N=2), so the response is shaped but fails the service's shape check. Each failure burns a full plan cycle and the agent gets no plan, throttling throughput to near-zero.

**Reachable-failure deduction (to be confirmed by the R2 diagnostic, not assumed).** The observed string is emitted by `PlanServiceImpl.plan` via `checkPlanBinding`'s shape branch (`packages/cognition/src/pper/plan-service.ts`). `OpenAICompatibleLLMClient.completePlan` already performs a **top-level** shape check (`shapeBad`: non-empty `description` + non-empty `steps` array) and, on failure, emits `[llm-raw]` and performs one bounded repair-retry before throwing `LLMResponseError` with a _different_ message. Therefore a shape failure that reaches plan-service through this client **cannot** be a missing/empty top-level `description` or a missing/empty `steps` array. The only condition `isValidFormulatePlanResult` checks that the client does not is the **per-step `description`**. So the live reason is almost certainly `empty-step-description` — but this must be named by a diagnostic (R2), not inferred, because the same symptom could come from a non-default client or a future backend.

Because spec-037 §7 / Req 15 deliberately treats shape failures as hard failures with **no repair**, each malformed response costs a whole cycle. Spec 059 increased re-formulation frequency (every invalidation forces a fresh plan), so a latent provider/prompt defect now dominates the run.

## Requirements

### R1 — One pure shape classifier, shared by client and service (`shared`)

Add a pure classifier over the already-decoded `FormulatePlanResult`:

- `type PlanShapeReason = 'missing-description' | 'missing-steps' | 'empty-step-description'`
- `classifyPlanShape(result: FormulatePlanResult): PlanShapeReason | null` — returns `null` when the shape is valid, otherwise the **first** failing condition in the order `missing-description` → `missing-steps` → `empty-step-description` (deterministic, so the diagnostic reason is stable).

The classifier is the single decision point: `isValidFormulatePlanResult` in `plan-service.ts` delegates to it, and the client decodes the raw tool arguments defensively (a non-array `steps` decodes to `[]`) before classifying, so client and service cannot drift. `PlanBindingVerdict` gains an additive-optional `shapeReason?: PlanShapeReason` set on the shape branch; the existing `violations: ['missing description or steps']` string and `feedback` text are **byte-identical** (spec-037 tests stay green).

### R2 — `[plan-invalid]` and `[plan-prompt]` zero-LLM diagnostics (`cognition`)

- `estimatePlanPrompt({ systemPrompt, perceptionContext, tools }): { chars: number; estTokens: number }` — deterministic, zero-LLM size estimate of the actual plan prompt (system prompt + perception context + serialized tool definitions); `estTokens = ceil(chars / 4)`. Both emission sites use it so the two lines are comparable.
- `[plan-prompt] agent=<id> chars=<n> estTokens=<n>` — **one line per plan LLM request**, emitted at the point the prompt is assembled (client), so prompt growth can be correlated with shape-failure rate (issue hypothesis 1).
- `[plan-invalid] agent=<id> reason=<missing-description|missing-steps|empty-step-description> chars=<n> estTokens=<n>` — one line per shape detection:
  - in `completePlan` when the client detects the bad shape (before repair), and again if the repair result is still bad;
  - in `PlanServiceImpl` on the shape backstop branch (`shapeReason` from `checkPlanBinding`), covering non-default clients.
- Extend the existing `[llm-raw]` emission (bounded, truncated args) to fire for **every** `PlanShapeReason`, not only the top-level empty case (issue hypothesis 3: client-side parsing).
- All three lines are zero-LLM, pure string arithmetic, and individually wrapped so a diagnostic failure can never break a cycle (spec-049 discipline). No line is added to the stable system prompt prefix (spec-021).

### R3 — Bounded shape repair at the client seam, reusing the existing one-retry (`cognition`)

`OpenAICompatibleLLMClient.completePlan` already owns one bounded raw-tool-call repair (the empty-args repair). Extend its shape detection to **all** `PlanShapeReason`s and reuse that single repair exactly once:

- reason-specific `CORRECTION` feedback (e.g. an empty step description is named: `step <i> has an empty description; every step needs a non-empty description`);
- exactly **one** repair request per `completePlan` call; if the repaired response is still shape-invalid, throw `LLMResponseError` as today (no second retry);
- emit `[plan-repair] agent=<id> attempt=1 reason=<reason>` when the retry is issued, so recovery rate is measurable.

`PlanServiceImpl`'s deliberate shape **no-retry** contract is **not** changed: the service remains the backstop, and a shape-invalid result that reaches it (non-default client) still fails the cycle with the existing message. This keeps the retry budget at one and never compounds a shape retry with the binding retry (max two `completePlan` calls per cycle).

### R4 — Bounded, self-resetting fallback floor (`cognition`)

When plan formation fails `PLAN_FLOOR_AFTER_FAILURES` (default `3`, `0` disables, env-overridable) **consecutive** times for an agent, `PlanServiceImpl` synthesizes and stores a trivially-valid floor plan instead of failing:

- a single step whose `targetAffordance` is chosen in the order **`observe` → a direct restorer for a critical drive → `wait`**; a non-empty `description` (e.g. `"Take stock of the room"`);
- **wait-guard-compatible by construction** (spec 052): the existing plan-level wait guard rejects an all-`wait` plan when a hintable drive is below `DRIVE_CRITICAL_THRESHOLD` **and** a directly-restoring affordance (declared `effects`, positive entry for that drive) is present in the post-prune enum. A floor that emitted `wait` while a restorer sits in the enum would be rejected by the guard on the very next line of `PlanServiceImpl` — i.e. self-defeating exactly in the starving-agent case it exists for. The floor therefore consults the same predicate (`checkWaitSuppression` over `perceptionResult.passive.drives` + `payload.availableAffordances`) when picking its binding;
- if **no** binding survives that order (`observe` absent, no direct restorer, and `wait` rejected), the cycle stays an honest formation failure: nothing is stored and the counter is **not** reset (the floor never reports success it did not achieve; the spec-008 recovery path still owns the cycle);
- valid by construction (R1 shape + spec-037 binding), so it cannot fail formation;
- stored sticky (spec-002), so it cannot livelock — the next cycle continues/exits the plan rather than re-formulating;
- emits `[plan-floor] agent=<id> failures=<n> target=<affordanceId>` and **resets the counter to 0**, so the next formation attempt consults the LLM again (a periodic safety valve, not a permanent cognition bypass);
- the counter increments only on shape/binding formation failures and resets on any successful formulation.

### R5 — Regression discipline (`shared`, `cognition`)

The existing plan/guardrail suites pass **unmodified**: spec 031/037/039/051/055/056/057/058/059. In particular the spec-037 "shape-invalid plans fail immediately WITHOUT a binding retry" service test and the `checkPlanBinding` shape-violation string are unchanged, because the repair lives at the client seam and the service contract is untouched.

### R6 — Diagnosis and discriminating probes (evidence, issue-owned)

Turn the 96% symptom into a named mechanism using R2 + probes, and record the verdict in the spec notes:

1. **Prompt growth (H1)** — correlate `[plan-prompt] chars/estTokens` and `[plan-invalid]` lines; replay one failing payload standalone at concurrency 1.
2. **Provider load/queue (H2)** — replay one fixed realistic payload 100× at `cc=1` vs `cc=3`; repeat with a second model and after restarting the client process.
3. **Client-side parse (H3)** — inspect the bounded `[llm-raw]` args for shape failures and unit-test `completePlan` with a malformed multi-call/multi-part fixture.

The spec does **not** prescribe the fix for a prompt-growth root cause; if that is the mechanism, memory/context budgeting for the plan prompt is a separate spec (see _Deferred_).

### R7 — Live validation (evidence — owned by the issue, not the unit suite)

A 40-minute real-LLM run of the #206 AC-7 harness (freshly built `dist`; live sims resolve built `dist/`) is the acceptance instrument for the ramp.

## Acceptance Criteria

- [ ] **AC-1** (R1): Unit tests — `classifyPlanShape` returns each of the three reasons for the corresponding malformed result and `null` for a valid plan; the order is deterministic when several conditions fail; `checkPlanBinding` surfaces the matching additive-optional `shapeReason` while `violations` stays exactly `['missing description or steps']`. _(maps to R1)_
- [ ] **AC-2** (R1): Unit test — `isValidFormulatePlanResult` and the client's `shapeBad` agree with `classifyPlanShape` on all four cases (valid, missing-description, missing-steps, empty-step-description) **on the decoded result**, including a bare string step (spec 019 Req 13 — the string _is_ the `targetAffordance` and the step description) and the alias mapping (`reason`→description, `action`/`affordance`/`tool`/`target`→targetAffordance), so the decode-before-classify restructure does not silently change what counts as a described step. _(maps to R1)_
- [ ] **AC-3** (R2): Diagnostic test — `[plan-invalid]` names the failing reason for every shape failure and carries `chars`/`estTokens`; `[plan-prompt]` is emitted once per plan request with the same size units; `[llm-raw]` fires for every reason; a diagnostic writer that throws never propagates (the cycle still returns a result), and an LLM-count spy confirms zero extra calls. _(maps to R2)_
- [ ] **AC-4** (R3): Unit tests — an empty-step-description response is repaired by exactly one retry and returns a valid plan; an always-empty response throws `LLMResponseError` after exactly two `completePlan` requests; the `CORRECTION` message names the empty step; an always-invalid completer never produces more than two requests per `completePlan` call. _(maps to R3)_
- [ ] **AC-5** (R4): Floor test — with the threshold `N`: `N-1` consecutive formation failures do not floor; the `N`th stores a shape-valid, binding-valid single-step plan, returns `success: true`, emits `[plan-floor]`, and resets the counter; the binding follows the `observe` → critical-drive restorer → `wait` order, and a floor under a critical drive with a restorer in the enum binds the restorer (an all-`wait` floor plan must never be emitted where `checkWaitSuppression` would reject it); when no binding survives the order the cycle fails honestly with the counter **unreset**; an always-invalid completer with the floor enabled makes at most `N` LLM attempts before flooring and a bounded number over many cycles (never unbounded). _(maps to R4)_
- [ ] **AC-6** (R5): Regression — spec 031/037/039/051/055/056/057/058/059 suites pass **unmodified**; `pnpm -r test && pnpm typecheck && pnpm lint` pass; a legacy/default client still behaves byte-identically for a valid plan. If any listed suite needs editing, the implementation has left this spec's scope. _(maps to R5)_
- [ ] **AC-7** (R6): Mechanism recorded — the spec notes name prompt growth, provider load, or client parse as the mechanism, with the discriminating probe's numbers attached to issue #214; the `[plan-invalid]` reason distribution is reported. _(maps to R6)_
- [ ] **AC-8** (R7): Live run (QA/live-env) — the final tick-quintile invalid-plan rate, **measured pre-repair from `[plan-invalid]` against `[plan-prompt]`** (a successful repair must not be able to mask a provider ramp), is ≤ the run-wide rate and ≤ 10%, with `[plan-repair]` recovery and `[plan-floor]` lines explaining any residual failures; `[plan-repeat]` stays bounded (spec 055) and no plan+step is handed to Execute unboundedly (spec 059). Evidence attached to issue #214. _(maps to R7)_

## Constraints

- **Package boundaries (ADR-0001)**: only `shared` (pure `classifyPlanShape` + `PlanShapeReason`) and `cognition` (`estimatePlanPrompt`, client repair/diagnostics, service backstop diagnostic, floor) may change. No new cross-package dependency; `shared ← cognition` holds; `engine` and `memory` are untouched. No import cycles.
- **Boundedness, not retry loops**: at most **one** repair request per `completePlan` call; a second shape failure throws (spec 008). The floor is stored sticky and resets its counter, so it cannot loop. The service-side shape path remains a hard failure — no unbounded repair.
- **Do not change the spec-037 service contract**: `PlanServiceImpl` must not gain a shape retry, and `checkPlanBinding`'s `violations`/`feedback` strings must not change. The repair is a client-seam concern (raw tool-call hygiene), consistent with the existing empty-args repair.
- **Prompt discipline (spec 021)**: no new line is added to the stable system prompt prefix; the repair `CORRECTION` appends to the per-cycle perception context, as the existing binding/empty-args repairs do.
- **Diagnostic discipline (spec 049)**: every new line is one line per event, zero LLM, pure string arithmetic, wrapped so logging can never break a cycle.
- **Floor must not trip the spec-052 wait-guard**: prefer `observe`; fall back to `wait` only when it is the sole legal binding. The floor is a valid plan, not a forced action.
- **What NOT to do**:
  - **Do not** re-enable a service-layer shape retry or remove the shape hard-fail in `checkPlanBinding` (spec-037 §7 / Req 15 stays).
  - **Do not** silently drop, coerce, or auto-fill empty step descriptions; the repair must be a real LLM resubmission with feedback, and unrepaired failures must stay honest.
  - **Do not** make the floor bypass cognition permanently — always reset the counter after flooring.
  - **Do not** put the reason code or prompt size in the system prompt or the `formulate_plan` schema (no KV-cache/prefix churn, no schema surface change).

## Design Decisions

**Decision 1 — Diagnose by reason code, not a boolean.** The 96% symptom has three live mechanisms (prompt growth, provider load, client parse). A boolean shape check cannot distinguish them; a first-class `PlanShapeReason` plus `[plan-prompt]` size turns the issue into a measurement. The reason is confirmed by a diagnostic, never guessed.

**Decision 2 — Repair at the client seam, not a new service retry.** The client already owns bounded raw-tool-call repair (the spec-037 empty-args repair). Its current shape check is _top-level only_, which is precisely why an `empty-step-description` response slips through to the service and hard-fails. Extending that one existing bounded repair to every shape reason fixes the reachable failure while keeping the service's deliberate no-retry contract and all pinned suites unmodified (issue AC-4). A service-layer retry would be a second mechanism, could compound shape + binding retries into three LLM calls per cycle, and would force edits to the spec-037 tests.

**Decision 3 — Fallback floor is a safety valve, not a cognition bypass.** After N consecutive failures the floor guarantees an agent never spins without a plan even when the provider is persistently malformed. It selects its binding with the same predicate the spec-052 wait-guard uses (`observe` → critical-drive direct restorer → `wait`), so it is executable under a critical drive and cannot hand the guard a plan it is guaranteed to reject; when no binding survives it stays an honest failure (nothing stored, counter unreset). It resets its counter on a stored floor so the next cycle tries the LLM again.

**Decision 4 — One shared classifier in `shared`, one estimator in `cognition`.** Client and service must agree on what "shape" means, or a repaired shape could still fail the backstop. A pure `classifyPlanShape` over the shared `FormulatePlanResult` respects the dependency direction and prevents drift; the prompt-size estimator stays in `cognition` because it is a prompt-construction concern over the cognition-owned `LLMContextPayload`, and both emission sites use it so their sizes are comparable.

**Decision 5 — Scope the durable root-cause fix out.** If R6 names prompt growth, the durable fix (plan-context memory budgeting) is a different change with its own architecture impact and belongs in its own spec. This spec stays a bounded contract for diagnosis + recovery + the no-spin floor.

## Deferred / Out of Scope

- **Prompt-growth root cause.** If H1 is confirmed, plan-prompt context budgeting (the 1,217-node memory injection) is a separate spec; this spec only measures it.
- **Provider-side load mitigation.** If H2 is confirmed, concurrency/queue tuning is operational and belongs with the #206/#214 live-run protocol, not in this code contract.
- **Conversation-affordance plan-enum executability** (spec 059 _Deferred_) remains tracked separately.
