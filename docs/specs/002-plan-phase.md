# Feature: Plan Phase of the PPER Loop

## Context
- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md) (Plan section), [§7 — Structured Outputs](../architecture/07-structured-outputs.md), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (§8.1 `formulate_plan`), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (`AgentPlan`, `PlanStep`), [§9 — Engine Routing](../architecture/09-engine-routing.md) (§9.1 `is_thinking`, §9.2 Action Feedback Loop), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (interaction with PPER loop)
- Related specs: [001 — Perceive Phase](001-perceive-phase.md) (produces `PerceptionResult` consumed by this spec)
- Package: `cognition`, `engine`, `shared`
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#4](https://github.com/Redna/evol-hive/issues/4)

## Requirements

### Cognition Layer (`@evol-hive/cognition`)

1. **`PlanService` interface** — A new interface `PlanService` must be defined in `packages/cognition/src/index.ts` with a method `plan(agentId: string, perceptionResult: PerceptionResult): Promise<PlanResult>`. This is the entry point for the Plan phase, invoked by the PPER orchestrator after the Perceive phase completes.

2. **`PlanResult` type** — A new interface `PlanResult` must be defined in `packages/shared/src/types/cognition.ts` representing the outcome of the Plan phase: `{ success: boolean; plan?: AgentPlan; error?: string }`. On success, `plan` contains the stored `AgentPlan`. On failure, `error` contains the failure reason and `plan` is `undefined`.

3. **`PlanBuilder` interface** — A new interface `PlanBuilder` must be defined in `packages/cognition/src/index.ts` with a method `build(perceptionResult: PerceptionResult): LLMContextPayload`. This constructs the LLM context payload specifically for plan formulation. The payload must use `formulatePlanSchema` (from `packages/shared/src/schemas/llm-schemas.ts`) as the `responseSchema` — **not** `llmActionResponseSchema`. The `systemPrompt` must be plan-focused (e.g., instructing the LLM to formulate a plan to satisfy the agent's most urgent drive). The `perceptionContext` must include the room name, object names, and drive summary (same compact format as `PerceptionBuilder`). The `availableAffordances` must be the pruned affordances from the `PerceptionResult`. The `cognitiveTools` must include the default cognitive tool catalog.

4. **`PlanBuilderImpl` implementation** — A concrete `PlanBuilderImpl` class must be implemented in `packages/cognition/src/pper/plan-builder.ts`, exported from `packages/cognition/src/pper/index.ts`. The system prompt must include a directive to formulate a plan using the `formulate_plan` cognitive tool, referencing the agent's primary drive label from the `PerceptionResult`. When `systemFeedback` is present in the `PerceptionResult.passive`, it must be appended to the perception context so the LLM is aware of prior action failures (per §9.2).

5. **`LLMClient.completePlan()` method** — A new method `completePlan(payload: LLMContextPayload): Promise<FormulatePlanResult>` must be added to the `LLMClient` interface in `packages/cognition/src/index.ts`. This method sends the context payload to the LLM backend with `formulatePlanSchema` as the grammar constraint / `response_format`, and parses the response into a `FormulatePlanResult`. This follows the existing pattern of distinct methods per response type (`completeStructured` → `LLMActionResponse`, `completeReflection` → `ReflectionResult`).

6. **`PlanServiceImpl` — orchestration** — A concrete `PlanServiceImpl` class must be implemented in `packages/cognition/src/pper/plan-service.ts`, exported from `packages/cognition/src/pper/index.ts`. It must:
   - Accept `PlanServiceOptions` (containing `planBuilder: PlanBuilder`, `llmClient: LLMClient`, `dataProvider: PlanDataProvider`) via constructor injection.
   - Set `isThinking = true` on the agent via `dataProvider.setThinking(agentId, true)` before invoking the LLM.
   - Build the context payload via `planBuilder.build(perceptionResult)`.
   - Call `llmClient.completePlan(payload)` to get a `FormulatePlanResult`.
   - On success: call `dataProvider.storePlan(agentId, result)` to create and store an `AgentPlan`, then call `dataProvider.setThinking(agentId, false)`, and return `PlanResult { success: true, plan }`.
   - On failure (LLM call throws or returns invalid data): call `dataProvider.setThinking(agentId, false)`, leave the agent's `currentPlan` unchanged, and return `PlanResult { success: false, error: message }`. The method must **not** re-throw — it must catch and return a failure result so the PPER orchestrator can retry on the next tick.

7. **No re-planning when plan exists** — `PlanServiceImpl.plan()` must check if the agent already has a non-null `currentPlan` via `dataProvider.getAgentState(agentId)`. If `currentPlan` is not `null`, the method must return `PlanResult { success: true, plan: existingPlan }` without calling the LLM. This prevents redundant LLM calls every tick when the agent already has an active plan. (The PPER orchestrator or Reflect phase is responsible for clearing the plan when re-planning is needed.)

### Engine Layer (`@evol-hive/engine`)

8. **`PlanManagerImpl.createPlan()`** — The `PlanManager` interface (already defined in `packages/engine/src/agents/index.ts`) must be implemented in `packages/engine/src/agents/plans/index.ts`. The `createPlan(agentId, result: FormulatePlanResult)` method must:
   - Generate a unique `id` for the `AgentPlan` (e.g., `plan_${agentId}_${Date.now()}`).
   - Map each `FormulatePlanResult.steps[]` entry to a `PlanStep` with `description` from the result, `targetAffordance` from the result (if present), and `completed: false`.
   - Set `currentStepIndex: 0` and `createdAt` to the current simulation time (obtained from the `AgentManager` or a clock dependency).
   - Store the `AgentPlan` in the agent's state via `AgentManager.updateState(agentId, { currentPlan: plan })`.
   - Return the created `AgentPlan`.

9. **`PlanManagerImpl.advanceStep()`** — Implement `advanceStep(agentId)` to increment `currentStepIndex` on the agent's `currentPlan` and mark the previous step as `completed: true`. If the plan is already complete (no more steps), this is a no-op. This is included because plan progression is tightly coupled with plan creation and may be exercised by integration tests.

10. **`PlanManagerImpl.getCurrentStep()`** — Implement `getCurrentStep(agentId)` to return the `PlanStep` at `currentPlan.steps[currentPlan.currentStepIndex]`, or `null` if no plan exists or the index is out of bounds.

11. **`PlanManagerImpl.isComplete()`** — Implement `isComplete(agentId)` to return `true` if `currentPlan` is `null` or `currentStepIndex >= steps.length`. Returns `false` otherwise.

12. **`PlanManagerImpl.clearPlan()`** — Implement `clearPlan(agentId)` to set `currentPlan` to `null` via `AgentManager.updateState(agentId, { currentPlan: null })`.

13. **`PlanDataProviderImpl` bridge** — A concrete `PlanDataProviderImpl` class must be implemented in `packages/engine/src/agents/plans/index.ts` (or a dedicated file in `packages/engine/src/agents/`). It must implement the `PlanDataProvider` interface (defined in shared, Req 14) using `AgentManager` and `PlanManager`:
    - `getAgentState(agentId)` → delegates to `AgentManager.getState(agentId)`.
    - `storePlan(agentId, result)` → delegates to `PlanManager.createPlan(agentId, result)` and returns the `AgentPlan`.
    - `setThinking(agentId, isThinking)` → delegates to `AgentManager.updateState(agentId, { isThinking })`.

### Shared Layer (`@evol-hive/shared`)

14. **`PlanDataProvider` interface** — A new interface `PlanDataProvider` must be defined in `packages/shared/src/types/cognition.ts` as a bridge between cognition and engine (per ADR-0001, cognition must not import from engine). It must declare:
    ```typescript
    interface PlanDataProvider {
      getAgentState(agentId: string): AgentInternalState | null;
      storePlan(agentId: string, result: FormulatePlanResult): AgentPlan;
      setThinking(agentId: string, isThinking: boolean): void;
    }
    ```
    This follows the `PerceptionDataProvider` pattern from spec 001.

### Cross-Cutting

15. **Structured output conformance** — The LLM response from `completePlan()` must conform to `formulatePlanSchema` as defined in `packages/shared/src/schemas/llm-schemas.ts`. The grammar constraint / `response_format` must be passed to the LLM backend (Ollama `format`, vLLM `guided_json`, llama.cpp `grammar`). If the response cannot be parsed into a valid `FormulatePlanResult` (missing required fields, wrong types), the `PlanServiceImpl` must treat this as a failure (Req 6 error path).

16. **`isThinking` lifecycle** — The `isThinking` flag must be `true` only while the LLM call is in-flight. It must be set to `false` on both success and failure paths. The game loop (§9.1) skips physics updates for agents with `isThinking = true`. Leaving `isThinking = true` on failure would permanently freeze the agent.

17. **No deep state in plan context** — The `PlanBuilder` perception context must not include `SmartObject.state` (e.g., `water_level`). It reuses the same compact object names from the `PerceptionResult.passive.objectsPresent` (which only carry `{ objectId, name, type }` per spec 001).

18. **Plan id uniqueness** — The `AgentPlan.id` generated by `PlanManagerImpl.createPlan()` must be unique per plan creation event. Re-planning (clearing and creating a new plan) must produce a new `id`, not reuse the old one. This supports plan history tracking in future memory specs.

## Acceptance Criteria

- [ ] **AC-1**: `PlanService` interface is defined in `packages/cognition/src/index.ts` with `plan(agentId: string, perceptionResult: PerceptionResult): Promise<PlanResult>`. *(Req 1)*
- [ ] **AC-2**: `PlanResult` is defined in `packages/shared/src/types/cognition.ts` with fields `success: boolean`, `plan?: AgentPlan`, `error?: string`. *(Req 2)*
- [ ] **AC-3**: `PlanBuilder` interface is defined in `packages/cognition/src/index.ts` with `build(perceptionResult: PerceptionResult): LLMContextPayload`. *(Req 3)*
- [ ] **AC-4**: `PlanBuilderImpl.build(perceptionResult)` returns an `LLMContextPayload` whose `responseSchema` is `formulatePlanSchema` (not `llmActionResponseSchema`). *(Req 3, Req 15)*
- [ ] **AC-5**: `PlanBuilderImpl.build(perceptionResult)` returns an `LLMContextPayload` whose `perceptionContext` contains the room name and object names from the `PerceptionResult.passive`, and whose `systemPrompt` instructs the LLM to formulate a plan. *(Req 3, Req 4)*
- [ ] **AC-6**: When `PerceptionResult.passive.systemFeedback` is present, `PlanBuilderImpl.build(perceptionResult)` includes the feedback string in the `perceptionContext`. *(Req 4)*
- [ ] **AC-7**: `PlanBuilderImpl.build(perceptionResult)` sets `availableAffordances` to the `prunedAffordances` from the `PerceptionResult` and `cognitiveTools` to the default cognitive tool catalog. *(Req 3)*
- [ ] **AC-8**: `LLMClient` interface includes `completePlan(payload: LLMContextPayload): Promise<FormulatePlanResult>` in `packages/cognition/src/index.ts`. *(Req 5)*
- [ ] **AC-9**: `PlanServiceImpl` is defined in `packages/cognition/src/pper/plan-service.ts` and exported from `packages/cognition/src/pper/index.ts`. *(Req 6)*
- [ ] **AC-10**: `PlanServiceImpl.plan()` calls `dataProvider.setThinking(agentId, true)` before invoking `llmClient.completePlan()`. *(Req 6)*
- [ ] **AC-11**: `PlanServiceImpl.plan()` calls `planBuilder.build(perceptionResult)` and passes the resulting payload to `llmClient.completePlan()`. *(Req 6)*
- [ ] **AC-12**: When `completePlan()` succeeds, `PlanServiceImpl.plan()` calls `dataProvider.storePlan(agentId, result)`, calls `dataProvider.setThinking(agentId, false)`, and returns `PlanResult { success: true, plan }` where `plan` is the stored `AgentPlan`. *(Req 6)*
- [ ] **AC-13**: When `completePlan()` throws an error, `PlanServiceImpl.plan()` catches the error, calls `dataProvider.setThinking(agentId, false)`, does **not** modify `currentPlan`, and returns `PlanResult { success: false, error: <message> }`. *(Req 6, Req 16)*
- [ ] **AC-14**: When the agent already has a non-null `currentPlan`, `PlanServiceImpl.plan()` returns `PlanResult { success: true, plan: existingPlan }` without calling `llmClient.completePlan()` or `planBuilder.build()`. *(Req 7)*
- [ ] **AC-15**: `PlanManagerImpl.createPlan(agentId, result)` generates an `AgentPlan` with a unique `id`, `currentStepIndex: 0`, `createdAt` set to the current simulation time, and each step mapped to a `PlanStep` with `completed: false`. *(Req 8, Req 18)*
- [ ] **AC-16**: `PlanManagerImpl.createPlan(agentId, result)` stores the `AgentPlan` in the agent's state via `AgentManager.updateState(agentId, { currentPlan: plan })`. *(Req 8)*
- [ ] **AC-17**: `PlanManagerImpl.advanceStep(agentId)` increments `currentStepIndex` by 1 and marks the previous step's `completed` as `true`. If the plan is complete, it is a no-op. *(Req 9)*
- [ ] **AC-18**: `PlanManagerImpl.getCurrentStep(agentId)` returns the `PlanStep` at the current step index, or `null` if no plan exists or the index is out of bounds. *(Req 10)*
- [ ] **AC-19**: `PlanManagerImpl.isComplete(agentId)` returns `true` when `currentPlan` is `null` or `currentStepIndex >= steps.length`. Returns `false` otherwise. *(Req 11)*
- [ ] **AC-20**: `PlanManagerImpl.clearPlan(agentId)` sets `currentPlan` to `null` in the agent's state. *(Req 12)*
- [ ] **AC-21**: `PlanDataProvider` interface is defined in `packages/shared/src/types/cognition.ts` with `getAgentState(agentId: string): AgentInternalState | null`, `storePlan(agentId: string, result: FormulatePlanResult): AgentPlan`, and `setThinking(agentId: string, isThinking: boolean): void`. *(Req 14)*
- [ ] **AC-22**: `PlanDataProviderImpl` implements `PlanDataProvider` using `AgentManager` and `PlanManager`. `getAgentState` delegates to `AgentManager.getState`, `storePlan` delegates to `PlanManager.createPlan`, `setThinking` delegates to `AgentManager.updateState`. *(Req 13)*
- [ ] **AC-23**: When `completePlan()` returns a response that cannot be parsed into a valid `FormulatePlanResult` (missing `description` or `steps`), `PlanServiceImpl.plan()` treats it as a failure and returns `PlanResult { success: false, error: ... }` without calling `storePlan`. *(Req 15)*
- [ ] **AC-24**: After a successful `PlanServiceImpl.plan()` call, `AgentInternalState.isThinking` is `false`. *(Req 16)*
- [ ] **AC-25**: After a failed `PlanServiceImpl.plan()` call, `AgentInternalState.isThinking` is `false` and `AgentInternalState.currentPlan` is unchanged. *(Req 16)*
- [ ] **AC-26**: `PlanBuilderImpl.build(perceptionResult)` perception context does not contain any `SmartObject.state` fields — only object names from `objectsPresent`. *(Req 17)*
- [ ] **AC-27**: Two successive calls to `PlanManagerImpl.createPlan()` for the same agent produce `AgentPlan` objects with different `id` values. *(Req 18)*

## Constraints

- **Package boundaries** (per ADR-0001): `cognition` and `engine` must **not** directly import from each other. All cross-package communication must go through interfaces defined in `@evol-hive/shared`. The engine owns plan storage and agent state; cognition owns LLM invocation and plan formulation orchestration.
- **Structured output compliance**: The `formulatePlanSchema` must be passed to the LLM backend as a grammar constraint. No regex parsing, no string matching — the response must be deterministically parsed via the schema (§7). If the LLM returns malformed data despite the grammar constraint, the Plan phase must treat it as a failure, not attempt to repair it.
- **`isThinking` safety**: The `isThinking` flag must always be reset to `false` — on success, on failure, and on any exception path. Failing to do so permanently freezes the agent in the game loop (§9.1). Use try/finally or equivalent to guarantee cleanup.
- **No `llmActionResponseSchema` in Plan**: The Plan phase uses `formulatePlanSchema` as the response schema. Using `llmActionResponseSchema` is a hard violation — the Plan phase formulates a plan, it does not choose an action. Action selection happens in the Execute phase.
- **Plan phase does not execute**: The Plan phase must not execute affordances, route actions, or modify drives. It only formulates and stores a plan. Physical action execution belongs to the Execute phase.
- **No game loop implementation**: This spec does not implement the game loop, the PPER orchestrator's phase-transition logic, or the async LLM concurrency manager (§9). Those are separate concerns. The `PlanServiceImpl.plan()` method is synchronous from the orchestrator's perspective (it awaits the LLM call).
- **Interface-first pattern**: Follow the existing pattern — define interfaces in `shared` or `cognition`, implement in the appropriate package. Stub files already exist at `packages/cognition/src/pper/index.ts` and `packages/engine/src/agents/plans/index.ts`.
- **Reuse from spec 001**: The `PerceptionResult` type, `PassivePerception` shape, and `LLMContextPayload` interface are already defined (spec 001). This spec adds `PlanResult`, `PlanDataProvider`, `PlanBuilder`, and `PlanService` — it does not redefine existing types.
- **Configurable values**: Any timeout or retry configuration for LLM calls must be config/env-driven (see `.env.example`), not hardcoded constants. The LLM call itself respects `ENGINE_MAX_CONCURRENT_LLM` via the concurrency manager (§9), but the concurrency manager implementation is out of scope for this spec.
- **What NOT to do**:
  - Do not implement the Execute, Reflect, or Perceive phases of the PPER loop (spec 001 covers Perceive; Execute and Reflect are separate specs).
  - Do not implement the PPER orchestrator's phase-transition state machine.
  - Do not implement the game loop, async routing infrastructure, or `LLMConcurrencyManager` (§9).
  - Do not implement cognitive guardrails (§10) — the Plan phase consumes guardrail output (e.g., masked affordances) but does not implement guardrail logic. Guardrails are a separate spec.
  - Do not implement the `query_memory` or `update_internal_state` cognitive tools (§8) — only `formulate_plan` is in scope.
  - Do not implement plan persistence to long-term memory — `AgentPlan` is stored in volatile agent state only. Memory consolidation is a separate spec (§11).
  - Do not implement `LLMClient` backends (Ollama, vLLM, llama.cpp) — only the interface and method signature are in scope. Backend implementations are separate.
