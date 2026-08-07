# Feature: Execute Phase of the PPER Loop

## Context
- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md) (Execute section), [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (affordances, preconditions, engine effects, `AffordanceResult`), [§9 — Engine Routing](../architecture/09-engine-routing.md) (§9.1 `is_thinking`, §9.2 Action Feedback Loop), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (`AgentPlan`, `PlanStep`, `AgentInternalState`), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (plan validation interaction)
- Related specs: [001 — Perceive Phase](001-perceive-phase.md) (produces `PerceptionResult`, defines `PerceptionDataProvider` with `getSystemFeedback`), [002 — Plan Phase](002-plan-phase.md) (produces `AgentPlan` with `PlanStep.targetAffordance`, defines `PlanManager.advanceStep` / `getCurrentStep` / `isComplete`)
- Package: `shared`, `engine`, `cognition`
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#8](https://github.com/Redna/evol-hive/issues/8)

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`ExecuteResult` type** — A new interface `ExecuteResult` must be defined in `packages/shared/src/types/cognition.ts` representing the outcome of the Execute phase: `{ success: boolean; affordanceResult?: AffordanceResult; error?: string; planComplete: boolean }`. On success, `affordanceResult` contains the `AffordanceResult` from the engine (if an affordance was executed). On failure, `error` contains the failure reason. `planComplete` is `true` when all plan steps have been executed.

2. **`ResolvedAffordance` type** — A new interface `ResolvedAffordance` must be defined in `packages/shared/src/types/cognition.ts` representing an affordance resolved to a specific smart object: `{ affordance: Affordance; objectId: string }`. This is returned by the data provider when resolving which object in a room offers a given affordance.

3. **`ExecuteDataProvider` interface** — A new interface `ExecuteDataProvider` must be defined in `packages/shared/src/types/cognition.ts` as a bridge between cognition and engine (per ADR-0001, cognition must not import from engine). It must declare:
   ```typescript
   interface ExecuteDataProvider {
     getAgentState(agentId: string): AgentInternalState | null;
     getCurrentPlanStep(agentId: string): PlanStep | null;
     resolveAffordance(affordanceId: string, roomId: string): ResolvedAffordance | null;
     checkPreconditions(affordanceId: string, objectId: string): { satisfied: boolean; failed: string[] };
     executeAffordance(objectId: string, affordanceId: string, agentId: string): Promise<AffordanceResult>;
     advancePlanStep(agentId: string): void;
     isPlanComplete(agentId: string): boolean;
     setThinking(agentId: string, isThinking: boolean): void;
     setSystemFeedback(agentId: string, feedback: string): void;
   }
   ```
   This follows the `PlanDataProvider` and `PerceptionDataProvider` patterns from specs 001 and 002.

### Cognition Layer (`@evol-hive/cognition`)

4. **`ExecuteService` interface** — A new interface `ExecuteService` must be defined in `packages/cognition/src/index.ts` with a method `execute(agentId: string): Promise<ExecuteResult>`. This is the entry point for the Execute phase, invoked by the PPER orchestrator after the Plan phase completes (or when the agent has an active plan).

5. **`ExecuteServiceImpl` — orchestration** — A concrete `ExecuteServiceImpl` class must be implemented in `packages/cognition/src/pper/execute-service.ts`, exported from `packages/cognition/src/pper/index.ts`. It must accept `ExecuteServiceOptions` (containing `dataProvider: ExecuteDataProvider`) via constructor injection. The `execute(agentId)` method must:
   - Retrieve the agent state via `dataProvider.getAgentState(agentId)`. If the agent does not exist, return `ExecuteResult { success: false, error: 'Agent not found', planComplete: false }`.
   - If `currentPlan` is `null`, return `ExecuteResult { success: false, error: 'No active plan', planComplete: false }`. The agent must plan before executing.
   - Retrieve the current plan step via `dataProvider.getCurrentPlanStep(agentId)`. If the step is `null` (plan complete or index out of bounds), return `ExecuteResult { success: true, planComplete: true }`.
   - If the current step has no `targetAffordance` (non-physical step), advance the plan via `dataProvider.advancePlanStep(agentId)`, check completion via `dataProvider.isPlanComplete(agentId)`, and return `ExecuteResult { success: true, planComplete: <result> }`. No affordance is executed.
   - Resolve the affordance via `dataProvider.resolveAffordance(step.targetAffordance, state.location)`. If not found in the agent's current room, call `dataProvider.setSystemFeedback(agentId, feedback)` with a descriptive message, call `dataProvider.setThinking(agentId, false)`, and return `ExecuteResult { success: false, error: ..., planComplete: false }`. The plan step is **not** advanced.
   - Check preconditions via `dataProvider.checkPreconditions(step.targetAffordance, resolved.objectId)`. If not satisfied, call `dataProvider.setSystemFeedback(agentId, feedback)` with the failed precondition names, call `dataProvider.setThinking(agentId, false)`, and return `ExecuteResult { success: false, error: ..., planComplete: false }`. The plan step is **not** advanced.
   - Execute the affordance via `dataProvider.executeAffordance(resolved.objectId, step.targetAffordance, agentId)`. If the `AffordanceResult.success` is `false`, call `dataProvider.setSystemFeedback(agentId, feedback)` with the failure reason, call `dataProvider.setThinking(agentId, false)`, and return `ExecuteResult { success: false, affordanceResult: result, error: result.failureReason, planComplete: false }`. The plan step is **not** advanced.
   - On success: advance the plan via `dataProvider.advancePlanStep(agentId)`, check completion via `dataProvider.isPlanComplete(agentId)`, and return `ExecuteResult { success: true, affordanceResult: result, planComplete: <result> }`.
   - The method must catch any unexpected exceptions, call `dataProvider.setThinking(agentId, false)`, and return `ExecuteResult { success: false, error: <message>, planComplete: false }`. It must **not** re-throw.

6. **System feedback message format** — The `ExecuteServiceImpl` must construct human-readable system feedback messages for injection into the next perception tick (per §9.2):
   - Affordance not found: `"You planned to use {targetAffordance} but it's not available in this room."`
   - Preconditions failed: `"You tried to {affordance.label} but: {failed preconditions joined by ', '}."`
   - Execution failed: `"You tried to {affordance.label} but {result.failureReason}."`

### Engine Layer (`@evol-hive/engine`)

7. **`PreconditionChecker` type** — A new type `PreconditionChecker` must be defined in `packages/engine/src/world/affordances/index.ts`: `(objectId: string, objectState: Record<string, unknown>) => boolean`. This represents a named precondition check function (e.g., `has_water` → checks `objectState.water_level > 0`).

8. **`AffordanceRegistry` interface extension** — The existing `AffordanceRegistry` interface in `packages/engine/src/world/index.ts` must be extended with a new method: `registerPreconditionChecker(name: string, checker: PreconditionChecker): void`. This allows the engine to register named precondition checkers (e.g., `"has_water"`, `"has_beans"`) that are resolved by the `preconditions` string array on `Affordance`.

9. **`AffordanceRegistryImpl` implementation** — A concrete `AffordanceRegistryImpl` class must be implemented in `packages/engine/src/world/affordances/index.ts`, exported from the world module. It must:
   - Store registered `AffordanceHandler` instances in a `Map<string, AffordanceHandler>`.
   - Store registered `PreconditionChecker` instances in a `Map<string, PreconditionChecker>`.
   - Accept a `SmartObjectRegistry` via constructor injection (to look up objects and their affordances when checking preconditions).
   - `registerHandler(affordanceId, handler)` — store the handler.
   - `registerPreconditionChecker(name, checker)` — store the checker.
   - `getHandler(affordanceId)` — return the stored handler, or `null`.
   - `checkPreconditions(affordanceId, objectId)` — look up the `SmartObject` via the registry, find the affordance with matching `id` on that object, iterate `affordance.preconditions`, and for each precondition string, look up and invoke the registered `PreconditionChecker`. If a precondition has no registered checker, treat it as **failed** (fail-safe). Return `{ satisfied: boolean, failed: string[] }` where `failed` lists the names of unsatisfied or unregistered preconditions.

10. **`PhysicsSystemImpl` implementation** — A concrete `PhysicsSystemImpl` class must be implemented in `packages/engine/src/physics/index.ts`, exported from the engine module. It must implement the existing `PhysicsSystem` interface. It must:
    - Accept `PhysicsSystemOptions` (containing `registry: SmartObjectRegistry`, `affordanceRegistry: AffordanceRegistry`, `driveSystem: DriveSystem`) via constructor injection.
    - `executeAffordance(objectId, affordanceId, agentId)` — look up the handler via `affordanceRegistry.getHandler(affordanceId)`. If no handler is registered, return `AffordanceResult { success: false, failureReason: 'No handler registered for affordance: {affordanceId}' }`. Get the `SmartObject` via `registry.get(objectId)`. If the object doesn't exist, return `AffordanceResult { success: false, failureReason: 'Object not found: {objectId}' }`. Call the handler with `(objectId, agentId, object.state)`. If the returned `AffordanceResult.success` is `true`: update the object state via `registry.updateState(objectId, result.newState)` when `newState` is present, and apply drive changes via `driveSystem.applyChanges(agentId, result.driveChanges)` when `driveChanges` is present. Return the `AffordanceResult`.
    - The `update(tick: GameTick)` method is a no-op (the physics system is event-driven, not tick-driven, for affordance execution).

11. **`SystemFeedbackStore`** — A new class `SystemFeedbackStore` must be implemented in `packages/engine/src/agents/state/index.ts` (or a dedicated file in `packages/engine/src/agents/`). It provides a per-agent string store for system feedback from failed actions (per §9.2):
    - `set(agentId: string, feedback: string): void` — store feedback for the agent (overwrites any previous feedback).
    - `get(agentId: string): string | undefined` — retrieve and **clear** the stored feedback (one-shot consumption). After `get`, the feedback is removed so it is only delivered once.
    - `clear(agentId: string): void` — explicitly clear feedback for an agent.

12. **`ExecuteDataProviderImpl` bridge** — A concrete `ExecuteDataProviderImpl` class must be implemented in `packages/engine/src/agents/` (e.g., `packages/engine/src/agents/execute-provider.ts`), exported from the agents module. It must implement the `ExecuteDataProvider` interface (defined in shared, Req 3) using `AgentManager`, `PlanManager`, `SmartObjectRegistry`, `AffordanceRegistry`, `PhysicsSystem`, and `SystemFeedbackStore`:
    - `getAgentState(agentId)` → delegates to `AgentManager.getState(agentId)`.
    - `getCurrentPlanStep(agentId)` → delegates to `PlanManager.getCurrentStep(agentId)`.
    - `resolveAffordance(affordanceId, roomId)` → iterates `SmartObjectRegistry.getByRoom(roomId)`, finds the object whose `affordances` array contains an `Affordance` with `id === affordanceId`, and returns `{ affordance, objectId: object.id }`. Returns `null` if not found.
    - `checkPreconditions(affordanceId, objectId)` → delegates to `AffordanceRegistry.checkPreconditions(affordanceId, objectId)`.
    - `executeAffordance(objectId, affordanceId, agentId)` → delegates to `PhysicsSystem.executeAffordance(objectId, affordanceId, agentId)`.
    - `advancePlanStep(agentId)` → delegates to `PlanManager.advanceStep(agentId)`.
    - `isPlanComplete(agentId)` → delegates to `PlanManager.isComplete(agentId)`.
    - `setThinking(agentId, isThinking)` → delegates to `AgentManager.updateState(agentId, { isThinking })`.
    - `setSystemFeedback(agentId, feedback)` → delegates to `SystemFeedbackStore.set(agentId, feedback)`.

### Cross-Cutting

13. **`isThinking` lifecycle during Execute** — The Execute phase must **not** set `isThinking = true` (it is deterministic — no LLM call). On failure, the `ExecuteServiceImpl` must call `dataProvider.setThinking(agentId, false)` to ensure the agent is not stuck in a thinking state from a prior phase. On success, `isThinking` is not modified (it should already be `false` from the Plan phase's cleanup). On unexpected exceptions, `isThinking` must be reset to `false`.

14. **Plan step advancement on success only** — The plan step index must only be advanced when execution succeeds (or when a non-physical step with no `targetAffordance` is encountered). On failure (affordance not found, preconditions unsatisfied, or execution error), the step is **not** advanced — the same step will be retried on the next tick.

15. **System feedback injection** — When execution fails, the `ExecuteServiceImpl` must call `dataProvider.setSystemFeedback(agentId, feedback)` to inject a human-readable feedback message. This message is consumed by the `PerceptionDataProvider.getSystemFeedback(agentId)` method (spec 001) on the next perception tick, making the LLM aware of why the action failed (per §9.2 Action Feedback Loop). This prevents infinite retry loops — the agent will perceive the feedback and can adjust its plan.

16. **Affordance resolution scope** — Affordance resolution is scoped to the agent's **current room** (`AgentInternalState.location`). If the affordance exists on an object in a different room, it is not resolved. This enforces spatial consistency — the agent must be in the same room as the object to interact with it.

17. **Precondition fail-safe** — If a precondition string in `Affordance.preconditions` has no registered `PreconditionChecker`, the `AffordanceRegistryImpl.checkPreconditions` method must treat it as **failed** (fail-safe). This prevents silent execution of unvalidated actions. The unregistered precondition name must be included in the `failed` array.

18. **Non-physical step auto-completion** — When a `PlanStep` has no `targetAffordance` (i.e., `targetAffordance` is `undefined`), the Execute phase must treat it as a non-physical step: advance the plan step index without executing any affordance, and return `ExecuteResult { success: true, planComplete: <result> }`. No system feedback is generated for non-physical steps.

19. **`ExecuteResult` re-export** — `ExecuteResult`, `ResolvedAffordance`, and `ExecuteDataProvider` must be re-exported from `packages/shared/src/index.ts` so they are available via `@evol-hive/shared`.

## Acceptance Criteria

- [ ] **AC-1**: `ExecuteResult` is defined in `packages/shared/src/types/cognition.ts` with fields `success: boolean`, `affordanceResult?: AffordanceResult`, `error?: string`, and `planComplete: boolean`. *(Req 1)*
- [ ] **AC-2**: `ResolvedAffordance` is defined in `packages/shared/src/types/cognition.ts` with fields `affordance: Affordance` and `objectId: string`. *(Req 2)*
- [ ] **AC-3**: `ExecuteDataProvider` is defined in `packages/shared/src/types/cognition.ts` with all nine methods: `getAgentState`, `getCurrentPlanStep`, `resolveAffordance`, `checkPreconditions`, `executeAffordance`, `advancePlanStep`, `isPlanComplete`, `setThinking`, and `setSystemFeedback`. *(Req 3)*
- [ ] **AC-4**: `ExecuteService` interface is defined in `packages/cognition/src/index.ts` with `execute(agentId: string): Promise<ExecuteResult>`. *(Req 4)*
- [ ] **AC-5**: `ExecuteServiceImpl` is defined in `packages/cognition/src/pper/execute-service.ts` and exported from `packages/cognition/src/pper/index.ts`. *(Req 5)*
- [ ] **AC-6**: When the agent does not exist, `ExecuteServiceImpl.execute(agentId)` returns `ExecuteResult { success: false, error: 'Agent not found', planComplete: false }`. *(Req 5)*
- [ ] **AC-7**: When the agent has no `currentPlan` (null), `ExecuteServiceImpl.execute(agentId)` returns `ExecuteResult { success: false, error: 'No active plan', planComplete: false }`. *(Req 5)*
- [ ] **AC-8**: When `getCurrentPlanStep` returns `null` (plan is complete), `ExecuteServiceImpl.execute(agentId)` returns `ExecuteResult { success: true, planComplete: true }`. *(Req 5)*
- [ ] **AC-9**: When the current plan step has no `targetAffordance`, `ExecuteServiceImpl.execute(agentId)` calls `advancePlanStep` and returns `ExecuteResult { success: true, planComplete: <isPlanComplete result> }` without calling `resolveAffordance`, `checkPreconditions`, or `executeAffordance`. *(Req 5, Req 18)*
- [ ] **AC-10**: When `resolveAffordance` returns `null` (affordance not in room), `ExecuteServiceImpl.execute(agentId)` calls `setSystemFeedback` with a message containing the affordance ID, calls `setThinking(agentId, false)`, and returns `ExecuteResult { success: false, error: ..., planComplete: false }`. The plan step is not advanced. *(Req 5, Req 15, Req 16)*
- [ ] **AC-11**: When preconditions are not satisfied, `ExecuteServiceImpl.execute(agentId)` calls `setSystemFeedback` with a message containing the affordance label and failed precondition names, calls `setThinking(agentId, false)`, and returns `ExecuteResult { success: false, error: ..., planComplete: false }`. The plan step is not advanced. *(Req 5, Req 15)*
- [ ] **AC-12**: When `executeAffordance` returns `AffordanceResult { success: false, ... }`, `ExecuteServiceImpl.execute(agentId)` calls `setSystemFeedback` with the failure reason, calls `setThinking(agentId, false)`, and returns `ExecuteResult { success: false, affordanceResult: result, error: result.failureReason, planComplete: false }`. The plan step is not advanced. *(Req 5, Req 14, Req 15)*
- [ ] **AC-13**: When `executeAffordance` returns `AffordanceResult { success: true, ... }`, `ExecuteServiceImpl.execute(agentId)` calls `advancePlanStep`, checks `isPlanComplete`, and returns `ExecuteResult { success: true, affordanceResult: result, planComplete: <result> }`. *(Req 5, Req 14)*
- [ ] **AC-14**: When `ExecuteServiceImpl.execute(agentId)` throws an unexpected exception, the method catches it, calls `setThinking(agentId, false)`, and returns `ExecuteResult { success: false, error: <message>, planComplete: false }` without re-throwing. *(Req 5, Req 13)*
- [ ] **AC-15**: `ExecuteServiceImpl` never calls `setThinking(agentId, true)` — the Execute phase is deterministic and does not use the LLM. *(Req 13)*
- [ ] **AC-16**: `PreconditionChecker` type is defined in `packages/engine/src/world/affordances/index.ts`. *(Req 7)*
- [ ] **AC-17**: `AffordanceRegistry` interface includes `registerPreconditionChecker(name: string, checker: PreconditionChecker): void` in `packages/engine/src/world/index.ts`. *(Req 8)*
- [ ] **AC-18**: `AffordanceRegistryImpl` is implemented in `packages/engine/src/world/affordances/index.ts` and accepts `SmartObjectRegistry` via constructor injection. *(Req 9)*
- [ ] **AC-19**: `AffordanceRegistryImpl.checkPreconditions(affordanceId, objectId)` returns `{ satisfied: true, failed: [] }` when all preconditions pass. *(Req 9)*
- [ ] **AC-20**: `AffordanceRegistryImpl.checkPreconditions(affordanceId, objectId)` returns `{ satisfied: false, failed: ['has_water'] }` when the `has_water` precondition fails. *(Req 9)*
- [ ] **AC-21**: `AffordanceRegistryImpl.checkPreconditions(affordanceId, objectId)` treats a precondition with no registered checker as failed and includes its name in the `failed` array. *(Req 9, Req 17)*
- [ ] **AC-22**: `PhysicsSystemImpl` is implemented in `packages/engine/src/physics/index.ts` and accepts `PhysicsSystemOptions` (containing `SmartObjectRegistry`, `AffordanceRegistry`, `DriveSystem`) via constructor injection. *(Req 10)*
- [ ] **AC-23**: `PhysicsSystemImpl.executeAffordance(objectId, affordanceId, agentId)` returns `AffordanceResult { success: false, failureReason: 'No handler registered...' }` when no handler is registered for the affordance. *(Req 10)*
- [ ] **AC-24**: `PhysicsSystemImpl.executeAffordance(objectId, affordanceId, agentId)` returns `AffordanceResult { success: false, failureReason: 'Object not found...' }` when the object does not exist. *(Req 10)*
- [ ] **AC-25**: `PhysicsSystemImpl.executeAffordance` calls the handler with `(objectId, agentId, object.state)` and returns the handler's `AffordanceResult`. *(Req 10)*
- [ ] **AC-26**: When the handler returns `AffordanceResult { success: true, newState: {...} }`, `PhysicsSystemImpl.executeAffordance` calls `registry.updateState(objectId, newState)`. *(Req 10)*
- [ ] **AC-27**: When the handler returns `AffordanceResult { success: true, driveChanges: { energy: +20 } }`, `PhysicsSystemImpl.executeAffordance` calls `driveSystem.applyChanges(agentId, { energy: +20 })`. *(Req 10)*
- [ ] **AC-28**: `SystemFeedbackStore` is implemented with `set(agentId, feedback)`, `get(agentId)` (which retrieves and clears), and `clear(agentId)`. *(Req 11)*
- [ ] **AC-29**: `SystemFeedbackStore.get(agentId)` returns the stored feedback and then clears it — a second call returns `undefined`. *(Req 11)*
- [ ] **AC-30**: `ExecuteDataProviderImpl` is implemented and implements all nine methods of `ExecuteDataProvider`. `getAgentState` delegates to `AgentManager.getState`, `getCurrentPlanStep` delegates to `PlanManager.getCurrentStep`, `advancePlanStep` delegates to `PlanManager.advanceStep`, `isPlanComplete` delegates to `PlanManager.isComplete`, `setThinking` delegates to `AgentManager.updateState`. *(Req 12)*
- [ ] **AC-31**: `ExecuteDataProviderImpl.resolveAffordance(affordanceId, roomId)` returns `{ affordance, objectId }` when an object in the room offers the affordance, and `null` otherwise. *(Req 12, Req 16)*
- [ ] **AC-32**: `ExecuteDataProviderImpl.executeAffordance(objectId, affordanceId, agentId)` delegates to `PhysicsSystem.executeAffordance(objectId, affordanceId, agentId)`. *(Req 12)*
- [ ] **AC-33**: `ExecuteDataProviderImpl.setSystemFeedback(agentId, feedback)` delegates to `SystemFeedbackStore.set(agentId, feedback)`. *(Req 12)*
- [ ] **AC-34**: `ExecuteResult`, `ResolvedAffordance`, and `ExecuteDataProvider` are re-exported from `packages/shared/src/index.ts`. *(Req 19)*
- [ ] **AC-35**: After a successful `ExecuteServiceImpl.execute(agentId)` call, `AgentInternalState.isThinking` is `false` (not modified by Execute, already `false` from Plan phase). *(Req 13)*
- [ ] **AC-36**: After a failed `ExecuteServiceImpl.execute(agentId)` call, `AgentInternalState.isThinking` is `false` and the plan step index is unchanged. *(Req 13, Req 14)*

## Constraints

- **Package boundaries** (per ADR-0001): `cognition` and `engine` must **not** directly import from each other. All cross-package communication must go through interfaces defined in `@evol-hive/shared`. The engine owns affordance execution, physics, and system feedback storage; cognition owns Execute phase orchestration.
- **No LLM call in Execute**: The Execute phase is deterministic (Engine — System 0). It must **not** invoke `LLMClient.completeStructured()`, `completePlan()`, or `completeReflection()`. The LLM is only called in the Plan and Reflect phases. Calling the LLM during Execute is a hard violation.
- **`isThinking` safety**: The Execute phase must never set `isThinking = true`. On failure, it must ensure `isThinking = false` so the agent can retry on the next tick. Leaving `isThinking = true` would permanently freeze the agent in the game loop (§9.1).
- **Step advancement on success only**: The plan step index must only be advanced on successful execution (or for non-physical steps). Advancing on failure would skip a step that was never executed, causing the agent to miss actions.
- **System feedback is one-shot**: `SystemFeedbackStore.get()` must clear the feedback after retrieval so it is only delivered once to the next perception tick. This prevents stale feedback from being re-delivered on subsequent ticks.
- **Precondition fail-safe**: Unregistered precondition names must be treated as **failed**, not silently passed. This prevents execution of actions with unvalidated safety checks.
- **Spatial consistency**: Affordance resolution is scoped to the agent's current room. The agent must be co-located with the smart object to interact with it.
- **Interface-first pattern**: Follow the existing pattern — define interfaces in `shared` or `cognition`, implement in the appropriate package. Stub files already exist at `packages/engine/src/physics/index.ts` and `packages/engine/src/world/affordances/index.ts`.
- **Reuse from spec 002**: The `PlanManager.advanceStep()`, `getCurrentStep()`, and `isComplete()` methods are already implemented (spec 002). This spec reuses them via `ExecuteDataProvider` — it does not reimplement plan management.
- **Reuse from spec 001**: The `PerceptionDataProvider.getSystemFeedback(agentId)` method (spec 001) consumes system feedback set by the Execute phase. The `SystemFeedbackStore` is the shared storage mechanism. When `PerceptionDataProviderImpl` is implemented, it must use the same `SystemFeedbackStore` instance as `ExecuteDataProviderImpl`.
- **`AffordanceRegistry` interface change**: This spec adds `registerPreconditionChecker(name, checker)` to the existing `AffordanceRegistry` interface (defined in `packages/engine/src/world/index.ts`). This is an additive change — existing methods are unchanged.
- **Configurable values**: No hardcoded constants for timeouts or thresholds. The Execute phase is deterministic and synchronous from the orchestrator's perspective.
- **What NOT to do**:
  - Do not implement the Reflect or Perceive phases of the PPER loop (spec 001 covers Perceive; Reflect is a separate spec).
  - Do not implement the PPER orchestrator's phase-transition state machine.
  - Do not implement the game loop, async routing infrastructure, or `LLMConcurrencyManager` (§9).
  - Do not implement the `ActionRouter` — action routing of LLM responses (§9) is a separate concern from plan-step execution.
  - Do not implement cognitive guardrails (§10) — the Execute phase consumes guardrail output (e.g., plan validation) but does not implement guardrail logic.
  - Do not implement `LLMClient` backends (Ollama, vLLM, llama.cpp) — the Execute phase doesn't use the LLM.
  - Do not implement plan persistence to long-term memory — `AgentPlan` is stored in volatile agent state only. Memory consolidation is a separate spec (§11).
  - Do not implement the `observe(target)` active perception mechanism (§6.2) — that is a separate spec.
  - Do not reimplement `PlanManager` methods — reuse the existing implementations from spec 002.
  - Do not modify `AgentPlan`, `PlanStep`, or `AgentInternalState` types — they are already defined and used by specs 001 and 002.
