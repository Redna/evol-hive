# Design Decisions — Spec 016 (Cognitive Guardrails, Issue #54)

## Decision 1: GuardrailEngineImpl as a Separate Class, Not Inline Logic
**Context:** The `GuardrailEngine` interface already exists in `packages/cognition/src/index.ts` with `maskAffordances` and `validateAction` methods. The guardrails stub at `packages/cognition/src/guardrails/index.ts` is empty.

**Decision:** Implement a concrete `GuardrailEngineImpl` class in `packages/cognition/src/guardrails/index.ts` that takes a `GuardrailConfig` in its constructor. All three guardrail mechanisms are methods on this single class.

**Rationale:** The interface already defines the contract. A single class keeps all guardrail logic co-located and testable. Each guardrail is independently toggleable via the config flags, so the class checks each flag before applying its logic. This is simpler than three separate strategy classes for what are essentially three boolean-gated functions.

**Alternative considered:** Three separate strategy classes (AffordanceMasker, ContextualForcer, PlanValidator). Rejected as over-engineering — each guardrail is a single function with a boolean gate, not a complex algorithm warranting its own class hierarchy.

## Decision 2: Affordance Masking Applied AFTER Classifier Pruning
**Context:** The Perceive phase runs the System 0 classifier to prune affordances (spec 001). Affordance masking hides physical affordances when no plan exists. The question is: should masking replace pruning (skip the classifier when no plan), or run after it?

**Decision:** Masking runs AFTER classifier pruning. The classifier still processes all affordances. The `PerceptionResult.prunedAffordances` field is then set to `[]` when masking is active and no plan exists.

**Rationale:** The plan builder may still need to see the pruned affordances to formulate a plan (the LLM needs to know what actions are possible to create steps). If we skip pruning, the plan builder loses context. By running masking after pruning, we can pass the full pruned list to the plan builder while hiding it from the action-choice LLM context. The masking specifically targets the `LLMContextPayload.availableAffordances` and `tools` — not the `PerceptionResult` itself.

**Alternative considered:** Skip classifier when no plan (performance optimization). Rejected because the plan builder needs the affordance list, and the classifier is fast (System 0).

## Decision 3: Plan Validation Checks Current Step's targetAffordance
**Context:** The Execute phase is deterministic — it reads `PlanStep.targetAffordance` from the current plan step and executes it. There is no LLM action choice in the current Execute flow. So what does plan validation validate?

**Decision:** Plan validation checks that the action being executed matches the current plan step's `targetAffordance`. In the current deterministic flow, this is inherently satisfied (the execute service reads from the plan). However, the `GuardrailEngine.validateAction(action, plan)` interface is designed for a future where the LLM may choose actions via `chooseActionTool` (already defined in the perception builder). The spec wires the validation into the execute service so it's ready for that path and provides defense-in-depth even in the deterministic flow (e.g., if a future code change accidentally bypasses the plan step).

**Rationale:** The architecture (§10) clearly states that physical actions deviating from the plan should be rejected. Even though the current flow is deterministic, the guardrail provides a safety net. The `validateAction` method is designed to be called with any action string — whether from a plan step or an LLM choice. Cognitive tool names are always valid (they're not physical actions).

**Alternative considered:** Skip plan validation in the spec since the current Execute flow is deterministic. Rejected because the `GuardrailEngine` interface already exists and the issue explicitly requires it. Implementing it now ensures it's ready when the LLM action-choice path is wired.

## Decision 4: deviationRejected Field on ExecuteResult Instead of Error String Matching
**Context:** When plan validation rejects an action, the orchestrator needs to distinguish this from other execute failures. Spec 008 says "No active plan" is not a failure. Plan validation failures should route to Reflect, not the error-recovery cooldown.

**Decision:** Add an optional `deviationRejected?: boolean` field to `ExecuteResult`. When `true`, the orchestrator routes to Reflect instead of recording a cycle failure.

**Rationale:** String matching on error messages is brittle (the error text could change). A boolean flag is explicit and type-safe. This is a minimal, backward-compatible extension to `ExecuteResult` (the field is optional, so existing code is unaffected).

**Alternative considered:** Match on the error string containing "deviates from your plan". Rejected as fragile — if the feedback template changes, the routing breaks silently.

## Decision 5: Contextual Forcing in Both Plan and Perception Builders
**Context:** The issue says contextual forcing happens in the "Plan/Perceive builder." The perception builder produces the action-choice context; the plan builder produces the plan-formulation context.

**Decision:** The `GUARDRAIL_FORCING_DIRECTIVE` is injected into the system prompt of both the `PlanBuilderImpl` and `PerceptionBuilderImpl` when the agent has no plan and contextual forcing is enabled. In the plan builder, it reinforces "use formulate_plan." In the perception builder, it prevents the LLM from choosing physical actions when it should be planning.

**Rationale:** The two builders serve different LLM call contexts. The plan builder is called when the agent needs to formulate a plan. The perception builder is called when the agent is choosing an action. Both need the directive to steer the LLM toward planning behavior. Without it in the perception builder, an LLM might attempt to choose a physical action even when no plan exists (especially if affordance masking is disabled).

**Alternative considered:** Only inject in the plan builder. Rejected because the perception/action-choice path is a separate LLM call that wouldn't see the plan builder's system prompt.

## Decision 6: All Guardrail Parameters Optional for Backward Compatibility
**Context:** The `PerceptionServiceImpl`, `PlanServiceImpl`, `ExecuteServiceImpl`, `PerceptionBuilderImpl`, `PlanBuilderImpl`, and `PPEROrchestratorImpl` are already constructed in many places (tests, examples, engine wiring). Adding required guardrail parameters would break all of these.

**Decision:** All guardrail-related constructor parameters and method arguments are optional. When not provided, guardrails are inactive. The `GuardrailEngine` is passed as an optional field on the existing options objects.

**Rationale:** This follows the pattern established by spec 012 (persona) where optional parameters were added to existing builders. It ensures all existing tests and code continue to work without modification, while new code can opt into guardrails.

**Alternative considered:** Make guardrails required and update all call sites. Rejected as too invasive for a feature that should be independently toggleable.

## Decision 7: Master Toggle + Individual Flags
**Context:** The existing `EngineConfig.guardrailsEnabled: boolean` is a master toggle. The issue wants each guardrail independently toggleable via `GuardrailConfig`.

**Decision:** Keep `guardrailsEnabled` as the master toggle. Add `guardrails: GuardrailConfig` to `EngineConfig`. When `guardrailsEnabled === false`, no `GuardrailEngine` is created at all (all guardrails inactive). When `true`, the individual flags in `GuardrailConfig` control each guardrail independently.

**Rationale:** This gives operators a quick kill switch (`guardrailsEnabled = false`) while also allowing fine-grained control. The engine wiring checks `guardrailsEnabled` first; only if `true` does it construct a `GuardrailEngineImpl` with the individual flags. This is simpler than checking all four flags at every guardrail call site.

**Alternative considered:** Remove `guardrailsEnabled` and use only individual flags (set all to `false` to disable). Rejected because the master toggle is already in use across many test fixtures and config files. Removing it would be a breaking change.
