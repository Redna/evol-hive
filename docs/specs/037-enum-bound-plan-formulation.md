# Spec 037 — Enum-Bound Plan Formulation: Constrain `targetAffordance` via a Dynamic Tool Signature

## Context

- Architecture: [§5 Fast-Path Classifier](../architecture/05-fast-path-classifier.md), [§7 Structured Outputs](../architecture/07-structured-outputs.md), [§8 Cognitive Tools](../architecture/08-cognitive-tools.md), [§10 Guardrails](../architecture/10-cognitive-guardrails.md)
- Related specs: [011 — Tool Calling](011-cognitive-tools-via-tool-calling.md), [019 — Affordance-as-Tools](019-affordance-tool-definitions.md), [021 — KV-Cache-Stable Prompts](021-kv-cache-stable-prompts.md), [034 — Drive→Affordance Hints](034-drive-affordance-hints-hunger-chain.md)
- Package: shared, cognition
- Issue: [#140](https://github.com/Redna/evol-hive/issues/140) · PR: [#141](https://github.com/Redna/evol-hive/pull/141)
- Status: ✅ Implemented (validated live — see Evidence)

## Problem

Across all live validation runs, agents emitted plans with **zero affordance bindings**: `targetAffordance` stayed unset, execute-service silently advanced narrative steps (`[system1-narrative]`), and no affordance ever executed. Agents decayed drives in lockstep and starved.

Root cause: affordance binding was enforced by **prompt instruction only** ("EVERY step MUST set targetAffordance…"). The plan schema declared `targetAffordance` optional/nullable — and making it `required` broke gemma4's tool-calling entirely (empty args, every plan failed; reverted in `2267354`). Prompt-level binding proved insufficient.

## Requirements

1. **Dynamic enum schema (Req 1)**: `formulatePlanSchemaFor(ids)` / `formulatePlanToolFor(ids)` build the per-cycle `formulate_plan` tool definition with `steps[].targetAffordance` as `{ type: 'string', enum: [...prunedIds, 'wait'] }`. The System 0 pruner's top-K output becomes a **value-space constraint**, not just prompt context. `targetAffordance` deliberately stays OUT of `required` (required broke the backend — issue #130 arc); presence is enforced by the validator instead.
2. **Escape hatch**: the enum always contains `wait` so the model is never trapped; execute-service treats a `wait` step as an intentional no-op.
3. **Validator + one retry (Req 2)**: `checkPlanBinding(result, availableIds)` enforces shape (§7, no retry) then binding membership (one retry with explicit CORRECTION feedback appended to the perception context). When `availableAffordances` is empty (guardrail masking, spec 016), binding enforcement is skipped — enforcing membership against an invisible set would guarantee failure.
4. **Parameter boundary (Req 3)**: enum constrains _values only_. No nested per-step args — handlers resolve concrete targets at execute time (spec 031 co-location guard validates).
5. **Telemetry (Req 4)**: `[plan-bind]` per plan cycle (steps, bound, violations), `[step-skip]` on livelock skips, `[llm-raw]` on malformed tool-call args.

## Amendments delivered during validation (2026-09-06)

- **Empty-args repair-retry** (`openai-client.completePlan`): the cloud backend intermittently emits `formulate_plan` with a bare `args: {}` (99 occurrences in a 15-min run — `[llm-raw]` evidence). One bounded repair-retry with an explicit correction message before throwing; a second failure still fails (spec 008).
- **Step-skip livelock guard** (`execute-service`): a failed affordance does NOT advance the plan, so an unsatisfiable step retried forever (observed: 108 failed `plant_seeds` re-executions while the plan's `harvest` step was unreachable). After 2 consecutive failures of the SAME step it advances past with feedback (`[step-skip]`), counter resets on step change or success.
- **Chain-label discoverability** (`examples/dynamic-world.ts`): affordance labels are the model's world knowledge. `plant_seeds` → "Plant seeds (after 3 plantings, vegetables ripen for harvest)" makes the condition-gated `harvest → eat` chain discoverable from tool descriptions alone (cross-ref spec 034 Req 4: no phantom _drive_ hints — these are static world facts, not remedies).

## Acceptance Criteria

- [x] AC-1: Plan tool schema carries a dynamic enum of the pruned affordance IDs (+ `wait`) — `formulatePlanSchemaFor` unit-tested
- [x] AC-2: Unbound/unknown steps fail validation; exactly one feedback retry; shape failures fail immediately — `checkPlanBinding` + `PlanServiceImpl` tested
- [x] AC-3: `[plan-bind]` telemetry per plan cycle — tested
- [x] AC-4: >50% of emitted plan steps carry valid bindings — **measured 48/48 (100%)** across two live runs (gemma4:31b-cloud)
- [x] AC-5: Affordance executions > 0 in a live run — **8 executions in the first validating run** (`plant_seeds`, `take_tool`); follow-up run: full hunger chain (`plant_seeds ×15 → harvest ×5 → eat ×5`, `water_plants ×10`, `open_gate ×7`) with **drive oscillation** (hunger 39 → 97 → decay; energy 44 → 100 → decay)

## Constraints

- KV-cache (spec 021): the enum lives inside the per-cycle tool-definition block, never in the stable system prompt prefix; the retry CORRECTION appends to the per-cycle perception context.
- No nested per-step typed arguments — known backend failure surface (required-field revert, `2267354`).
- The validator stays the backstop: Ollama tool calling does not hard-enforce enums (grammar-constrained only). Telemetry measures the actual constraint rate.
- Parameter boundary: handlers own target resolution; the signature owns the value space.

## Evidence (live, 2026-09-06)

- `[plan-bind] agent=gardener-1 steps=2 bound=2 violations=[]` — first fully-bound plan
- `[affordance] gardener-1 plant_seeds @ planter-1 → ok drives={"curiosity":12,"comfort":4}` — first affordance execution in project history
- Drive trajectory (trace9): `e=44 h=39` → `e=100 h=97` (restored) → decay — **oscillation, not monotone decay**; AC-5 of issue #139 mechanism-verified
- Operational note: live sims import **built dist** (`@evol-hive/engine` → `packages/engine/dist`), not source. Rebuild packages before validation runs — a stale dist silently runs old code (this cost a full diagnostic arc on 2026-09-06).
