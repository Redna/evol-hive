# Feature: Cognitive Guardrails — Affordance Masking, Contextual Forcing, Plan Validation

## Context
- Architecture: [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md)
- Related specs: [001 — Perceive Phase](001-perceive-phase.md) (affordance pruning), [002 — Plan Phase](002-plan-phase.md) (system prompt construction), [003 — Execute Phase](003-execute-phase.md) (action execution), [008 — PPER Error Recovery](008-pper-error-recovery.md) (forced reflection), [011 — Structured Output to Tool Calling](011-structured-output-to-tool-calling.md) (tool definitions)
- Package: `shared`, `cognition`, `engine`
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#54](https://github.com/Redna/evol-hive/issues/54)

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **GuardrailConfig on EngineConfig** — The existing `EngineConfig` interface (in `packages/shared/src/types/engine.ts`) must be extended with a `guardrails: GuardrailConfig` field so the engine can carry per-guardrail toggle flags. The existing `guardrailsEnabled: boolean` field is retained as a master toggle; when `false`, all three guardrails are disabled regardless of individual flags. The `GuardrailConfig` type already exists in `packages/shared/src/types/cognition.ts` and does not require changes.

2. **Default guardrail config** — A `defaultGuardrailConfig()` function must be exported from `packages/shared/src/types/engine.ts` returning `{ affordanceMasking: true, contextualForcing: true, planValidation: true }`. A `defaultEngineConfig()` function must also be exported, returning the full `EngineConfig` with `guardrailsEnabled: true` and `guardrails: defaultGuardrailConfig()`, plus existing defaults (`fps: 60`, `spatialDebounceSeconds: 5`, `maxConcurrentLLM: 8`).

3. **PlanValidationResult type** — A new interface `PlanValidationResult` must be defined in `packages/shared/src/types/cognition.ts`: `{ valid: boolean; reason?: string }`. This standardizes the return type of plan validation (the existing `GuardrailEngine.validateAction` interface already returns this shape — this makes it a named, exported type).

4. **GuardrailFeedback constants** — Two string constants must be exported from `packages/shared/src/types/cognition.ts`:
   - `GUARDRAIL_FORCING_DIRECTIVE`: `"You have no active plan. You must use formulate_plan to create a plan before taking any physical action."`
   - `GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE`: `"Action '{action}' deviates from your plan. Use reflect to reconsider."`

### Cognition Layer (`@evol-hive/cognition`)

5. **GuardrailEngineImpl** — A concrete `GuardrailEngineImpl` class must be implemented in `packages/cognition/src/guardrails/index.ts` implementing the existing `GuardrailEngine` interface. It is constructed with a `GuardrailConfig` and exposes `config`, `maskAffordances(affordances, hasPlan)`, and `validateAction(action, plan)`.

6. **Affordance masking logic** — `GuardrailEngineImpl.maskAffordances(affordances, hasPlan)` must:
   - Return `affordances` unchanged when `config.affordanceMasking === false` OR `hasPlan === true`.
   - Return an empty array `[]` when `config.affordanceMasking === true` AND `hasPlan === false` — hiding all physical affordances so only cognitive tools remain available to the LLM.

7. **Plan validation logic** — `GuardrailEngineImpl.validateAction(action, plan)` must:
   - Return `{ valid: true }` when `config.planValidation === false` OR `plan === null` (no plan to validate against — the guardrail does not block actions when there's no plan; that is the job of affordance masking).
   - Return `{ valid: true }` when `plan` is non-null and the current step's `targetAffordance` matches `action`.
   - Return `{ valid: false, reason: "Action '{action}' deviates from your plan. Use reflect to reconsider." }` when `plan` is non-null and the current step's `targetAffordance` does not match `action` (or the current step has no `targetAffordance` but the action is a physical affordance ID).
   - Cognitive tool names (`formulate_plan`, `query_memory`, `update_internal_state`) are always valid — they are never rejected by plan validation.

8. **Affordance masking in Perceive phase** — `PerceptionServiceImpl.perceive()` must accept an optional `GuardrailEngine` via its constructor options. After classifier pruning, if a guardrail engine is present, it calls `guardrail.maskAffordances(prunedAffordances, hasPlan)` where `hasPlan` is determined from the agent's `currentPlan` (via `perceptionProvider.getAgentState` — this requires the `PerceptionDataProvider` to expose agent state, which it currently does not; the `PerceptionDataProvider` interface must be extended with an optional `getAgentState(agentId: string): AgentInternalState | null` method). The masked result is stored in a new `maskedAffordances` field on `PerceptionResult`. The `prunedAffordances` field retains the **unmasked** classifier output for use by the Plan builder. *(Amended by spec 020, Req 13 — previously: "The masked result replaces `prunedAffordances` in the returned `PerceptionResult`.")*

9. **Contextual forcing in Plan phase** — `PlanServiceImpl` must accept an optional `GuardrailEngine` via its constructor options. When the agent has no plan and `config.contextualForcing === true`, the `PlanBuilderImpl.build()` must append the `GUARDRAIL_FORCING_DIRECTIVE` string to the system prompt. This is achieved by passing a `hasPlan: boolean` and `forcingEnabled: boolean` flag through to the plan builder, or by having the plan builder accept the `GuardrailEngine` and the agent state directly.

10. **Contextual forcing in Perception/Action-choice phase** — `PerceptionBuilderImpl.build()` must accept an optional `hasPlan: boolean` and `forcingEnabled: boolean`. When `hasPlan === false` and `forcingEnabled === true`, the `GUARDRAIL_FORCING_DIRECTIVE` is appended to the system prompt. When `hasPlan === false` and `affordanceMasking === true`, the `availableAffordances` in the `LLMContextPayload` are set to `[]` and the `tools` array is reduced to only cognitive tool definitions (no `chooseActionTool`). The Perception builder reads from `maskedAffordances` (falling back to `prunedAffordances` when `maskedAffordances` is `undefined`). Affordance masking applies **only** to the Perceive/Choose phase. The Plan phase always sees unmasked affordances via `prunedAffordances` so the LLM can reference exact affordance IDs in plan steps. *(Amended by spec 020, Req 14 — clarified masking scope and the `maskedAffordances` read source.)*

11. **Plan validation in Execute phase** — `ExecuteServiceImpl` must accept an optional `GuardrailEngine` via its constructor options. Before resolving and executing the affordance, it calls `guardrail.validateAction(step.targetAffordance, agentState.currentPlan)`. If `valid === false`, it:
    - Calls `dataProvider.setSystemFeedback(agentId, reason)` so the next Perceive tick surfaces the deviation message.
    - Calls `dataProvider.setThinking(agentId, false)`.
    - Returns `{ success: false, error: reason, planComplete: false }` without executing the affordance.
    - The orchestrator then proceeds to the Reflect phase naturally (the reflect phase runs when execute returns `success: false` with a non-"No active plan" error — this requires the orchestrator to route to reflect on plan-validation failures; see Req 12).

12. **Orchestrator routing for plan-validation failures** — The `PPEROrchestratorImpl` must be constructed with an optional `GuardrailEngine`. It passes the guardrail engine to the `PerceptionServiceImpl`, `PlanServiceImpl`, and `ExecuteServiceImpl` constructors. When the Execute phase returns `success: false` due to plan validation (error does not match "No active plan"), the orchestrator must route to the Reflect phase (instead of recording a failure and aborting) so the agent can reflect on the deviation and potentially create a new plan. This requires distinguishing plan-validation failures from other execute failures — the `ExecuteResult.error` will contain the deviation feedback string which can be matched, or a new `deviationRejected?: boolean` field can be added to `ExecuteResult`.

13. **ExecuteResult extension** — The `ExecuteResult` interface must be extended with an optional `deviationRejected?: boolean` field. When `true`, the orchestrator routes to Reflect instead of recording a cycle failure.

### Engine Layer (`@evol-hive/engine`)

14. **Engine config loading** — The engine config loader (in `config/engine.config.ts`) must populate `guardrails` from environment variables: `ENGINE_GUARDRAILS_AFFORDANCE_MASKING` (default `true`), `ENGINE_GUARDRAILS_CONTEXTUAL_FORCING` (default `true`), `ENGINE_GUARDRAILS_PLAN_VALIDATION` (default `true`). The master `ENGINE_GUARDRAILS_ENABLED` (default `true`) remains; when `false`, all guardrails are disabled.

15. **PerceptionDataProvider extension** — The engine's implementation of `PerceptionDataProvider` must implement the new optional `getAgentState(agentId: string): AgentInternalState | null` method so the cognition layer can determine `hasPlan` during the Perceive phase.

16. **GuardrailEngine wiring** — When the engine constructs the `PPEROrchestrator` (via `createPPEROrchestrator`), it must create a `GuardrailEngineImpl` from the engine config's guardrail settings (only when `guardrailsEnabled === true`; otherwise `undefined` is passed) and pass it to the orchestrator options.

## Acceptance Criteria

- [ ] AC-1: `defaultGuardrailConfig()` returns `{ affordanceMasking: true, contextualForcing: true, planValidation: true }`.
- [ ] AC-2: `defaultEngineConfig()` returns an `EngineConfig` with `guardrailsEnabled: true` and `guardrails: defaultGuardrailConfig()`.
- [ ] AC-3: `EngineConfig` interface includes a `guardrails: GuardrailConfig` field. *(Maps to Req 1)*
- [ ] AC-4: `PlanValidationResult` type is exported from shared and matches `{ valid: boolean; reason?: string }`. *(Maps to Req 3)*
- [ ] AC-5: `GUARDRAIL_FORCING_DIRECTIVE` constant equals `"You have no active plan. You must use formulate_plan to create a plan before taking any physical action."`. *(Maps to Req 4)*
- [ ] AC-6: `GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE` constant equals `"Action '{action}' deviates from your plan. Use reflect to reconsider."`. *(Maps to Req 4)*
- [ ] AC-7: `GuardrailEngineImpl.maskAffordances(affordances, false)` returns `[]` when `affordanceMasking === true`. *(Maps to Req 6)*
- [ ] AC-8: `GuardrailEngineImpl.maskAffordances(affordances, true)` returns `affordances` unchanged regardless of config. *(Maps to Req 6)*
- [ ] AC-9: `GuardrailEngineImpl.maskAffordances(affordances, false)` returns `affordances` unchanged when `affordanceMasking === false`. *(Maps to Req 6)*
- [ ] AC-10: `GuardrailEngineImpl.validateAction("brew_coffee", planWithCurrentStepTargetBrewCoffee)` returns `{ valid: true }`. *(Maps to Req 7)*
- [ ] AC-11: `GuardrailEngineImpl.validateAction("sleep", planWithCurrentStepTargetBrewCoffee)` returns `{ valid: false, reason: "Action 'sleep' deviates from your plan. Use reflect to reconsider." }`. *(Maps to Req 7)*
- [ ] AC-12: `GuardrailEngineImpl.validateAction("formulate_plan", anyPlan)` returns `{ valid: true }` — cognitive tools are never rejected. *(Maps to Req 7)*
- [ ] AC-13: `GuardrailEngineImpl.validateAction("brew_coffee", null)` returns `{ valid: true }` — no plan means no validation. *(Maps to Req 7)*
- [ ] AC-14: `GuardrailEngineImpl.validateAction("brew_coffee", plan)` returns `{ valid: true }` when `planValidation === false`. *(Maps to Req 7)*
- [ ] AC-15: When the agent has no plan and affordance masking is enabled, the `PerceptionResult.maskedAffordances` is an empty array and `PerceptionResult.prunedAffordances` retains the unmasked classifier output. *(Maps to Req 8. Amended by spec 020, Req 15 — previously asserted `prunedAffordances` is an empty array.)*
- [ ] AC-16: When the agent has a plan and affordance masking is enabled, both `PerceptionResult.prunedAffordances` and `PerceptionResult.maskedAffordances` are unchanged from classifier output (masking is a no-op when a plan exists). *(Maps to Req 8. Amended by spec 020, Req 16 — previously asserted only `prunedAffordances` is unchanged.)*
- [ ] AC-17: When the agent has no plan and contextual forcing is enabled, the `LLMContextPayload.systemPrompt` for the Plan phase contains the `GUARDRAIL_FORCING_DIRECTIVE` text. *(Maps to Req 9)*
- [ ] AC-18: When the agent has no plan and contextual forcing is enabled, the `LLMContextPayload.systemPrompt` for the Perception/Action-choice phase contains the `GUARDRAIL_FORCING_DIRECTIVE` text. *(Maps to Req 10)*
- [ ] AC-19: When the agent has no plan and affordance masking is enabled, the `LLMContextPayload.tools` for the Perception/Action-choice phase contains only cognitive tool definitions (no `chooseActionTool`). *(Maps to Req 10)*
- [ ] AC-20: When plan validation is enabled and the Execute phase detects a deviation, `ExecuteResult` has `success: false`, `deviationRejected: true`, and `error` containing the deviation feedback. *(Maps to Req 11, 13)*
- [ ] AC-21: When the Execute phase rejects an action due to plan validation, `setSystemFeedback` is called with the deviation reason and the affordance is NOT executed. *(Maps to Req 11)*
- [ ] AC-22: When `ExecuteResult.deviationRejected === true`, the orchestrator routes to the Reflect phase (does not record a cycle failure or abort). *(Maps to Req 12, 13)*
- [ ] AC-23: When `guardrailsEnabled === false` on the engine config, no `GuardrailEngine` is created and all three guardrails are inactive (no masking, no forcing, no validation). *(Maps to Req 16)*
- [ ] AC-24: The engine config loader reads `ENGINE_GUARDRAILS_AFFORDANCE_MASKING`, `ENGINE_GUARDRAILS_CONTEXTUAL_FORCING`, and `ENGINE_GUARDRAILS_PLAN_VALIDATION` from environment variables with default `true`. *(Maps to Req 14)*
- [ ] AC-25: The `PerceptionDataProvider` interface includes an optional `getAgentState(agentId: string): AgentInternalState | null` method. *(Maps to Req 8, 15)*
- [ ] AC-26: When all three guardrails are disabled via individual flags (all `false`) but `guardrailsEnabled === true`, no masking, forcing, or validation occurs. *(Maps to Req 5, 6, 7)*

## Constraints

- **Package boundaries**: The `GuardrailEngineImpl` lives in `@evol-hive/cognition` (per architecture §10). The `GuardrailConfig` and `PlanValidationResult` types live in `@evol-hive/shared`. The engine config loading lives in `config/`. The cognition layer must not import from engine — all engine state is accessed via bridge interfaces (`PerceptionDataProvider`, `ExecuteDataProvider`).
- **No new bridge interfaces**: The existing `PerceptionDataProvider`, `ExecuteDataProvider`, and `PlanDataProvider` interfaces are extended with optional methods only. The engine implements them; the cognition layer consumes them. No new bridge interfaces are introduced.
- **Backward compatibility**: All guardrail-related constructor parameters are optional. Existing code that constructs `PerceptionServiceImpl`, `PlanServiceImpl`, `ExecuteServiceImpl`, `PerceptionBuilderImpl`, `PlanBuilderImpl`, or `PPEROrchestratorImpl` without guardrail arguments must continue to work (guardrails default to inactive when not provided).
- **Deterministic Execute**: The Execute phase remains deterministic (System 1, no LLM). Plan validation is a pre-execution check, not an LLM call.
- **Reflect phase integration**: Plan-validation failures route to Reflect, not to the error-recovery cooldown path (spec 008). The deviation is not counted as a consecutive failure.
- **Affordance masking vs. classifier pruning**: Affordance masking is applied AFTER classifier pruning. The classifier still runs on all affordances (it may be useful for future plan formulation context). Masking only hides affordances from the LLM's tool list — the full pruned list remains in the `PerceptionResult` for the plan builder to reference.
- **Cognitive tools are never masked**: `formulate_plan`, `query_memory`, and `update_internal_state` are always available to the LLM regardless of guardrail state. Affordance masking only hides physical affordances (those with `engineEffect` on smart objects).
- **Performance**: Guardrail checks are O(1) for masking (array filter or empty return) and O(1) for validation (string comparison against current step). No additional LLM calls are introduced.
- **Do NOT**: Add guardrail logic directly into the orchestrator's `runCycle` method. The guardrail engine is a separate concern applied within the phase services. The orchestrator only wires the guardrail engine and handles `deviationRejected` routing.
