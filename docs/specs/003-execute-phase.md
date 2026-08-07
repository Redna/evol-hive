# Feature: Execute Phase of the PPER Loop

## Context
- Architecture: [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (execution flow, preconditions, engineEffect), [§6 — PPER Loop](../architecture/06-pper-loop.md) (Execute section), [§9 — Engine Routing](../architecture/09-engine-routing.md) (§9.1 is_thinking, §9.2 Action Feedback Loop), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (AgentPlan, PlanStep, AgentInternalState), [§2 — System Overview](../architecture/02-system-overview.md) (package boundaries)
- Related specs: [001 — Perceive Phase](001-perceive-phase.md) (produces `PerceptionResult` and `PerceptionDataProvider`), [002 — Plan Phase](002-plan-phase.md) (produces `AgentPlan`, `PlanResult`, `PlanDataProvider`)
- Package: `shared`, `engine`, `cognition`
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monrope-structure.md)
- Issue: [#8](https://github.com/Redna/evol-hive/issues/8)

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`ExecuteResult` type** — A new interface `ExecuteResult` must be defined in `packages/shared/src/types/cognition.ts` representing the outcome of the Execute phase: `{ success: boolean; result?: AffordanceResult; error?: string; planComplete: boolean; stepSkipped?: boolean }`. On success with a physical affordance, `result` contains the raw `AffordanceResult`. On failure, `error` contains the failure reason and `result` is `undefined`. `planComplete` indicates whether the plan has no remaining steps after this execution. `stepSkipped` is `true` when the current step had no `targetAffordance` and was advanced without physical execution.

2. **`ExecutionOutcome` type** — A new interface `ExecutionOutcome` must be defined in `packages/shared/src/types/cognition.ts` representing the intermediate result of resolving and attempting an affordance: `{ resolved: boolean; objectId?: string; preconditionsMet: boolean; failedPreconditions?: string[]; result?: AffordanceResult }`. `resolved` is `false` when no smart object in the agent's room exposes the requested affordance. `preconditionsMet` is `false` when one or more precondition checks failed (with `failedPreconditions` listing the failed precondition names). `result` is present only when the affordance was executed (preconditions passed).

3. **`ExecuteDataProvider` interface** — A new bridge interface `ExecuteDataProvider` must be defined in `packages/shared/src/types/cognition.ts` (per ADR-0001, cognition must not import from engine). It must declare:
   ```typescript
   interface ExecuteDataProvider {
     getAgentState(agentId: string): AgentInternalState | null;
     getCurrentStep(agentId: string): PlanStep | null;
     isPlanComplete(agentId: string): boolean;
     resolveAffordance(roomId: string, affordanceId: string): { objectId: string; affordance: Affordance } | null;
     checkPreconditions(affordanceId: string, objectId: string): { satisfied: boolean; failed: string[] };
     executeAffordance(objectId: string, affordanceId: string, agentId: string): Promise<AffordanceResult>;
     advanceStep(agentId: string): void;
     applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void;
     setSystemFeedback(agentId: string, feedback: string): void;
     setThinking(agentId: string, isThinking: boolean): void;
   }
   ```
   This follows the `PlanDataProvider` and `PerceptionDataProvider` bridge pattern from specs 001 and 002. Some methods overlap with `PlanDataProvider` (e.g., `getAgentState`, `setThinking`) — the same engine class may implement multiple provider interfaces.

### Engine Layer (`@evol-hive/engine`)

4. **`AffordanceRegistryImpl` — handler registration** — The `AffordanceRegistry` interface (already defined in `packages/engine/src/world/index.ts`) must be implemented in `packages/engine/src/world/affordances/index.ts`. The `registerHandler(affordanceId, handler)` method stores handlers in an internal map. The `getHandler(affordanceId)` method retrieves a registered handler or returns `null` if none is registered for that affordance ID.

5. **`PreconditionChecker` type and registration** — A new type `PreconditionChecker` must be defined as `(objectState: Record<string, unknown>) => boolean` in `packages/engine/src/world/affordances/index.ts`. The `AffordanceRegistryImpl` must support registration of precondition checkers via a `registerPreconditionChecker(name: string, checker: PreconditionChecker): void` method. Precondition checkers are keyed by their name string (e.g., `"has_water"`) and evaluate against the smart object's `state` field.

6. **`AffordanceRegistryImpl.checkPreconditions()`** — The `checkPreconditions(affordanceId, objectId)` method must:
   - Look up the `SmartObject` by `objectId` via `SmartObjectRegistry.get(objectId)`.
   - Find the `Affordance` on that object whose `id` matches `affordanceId`.
   - For each string in `affordance.preconditions`, invoke the corresponding registered `PreconditionChecker` with the object's `state`.
   - If any precondition checker returns `false` (or is not registered), add it to the `failed` array.
   - Return `{ satisfied: boolean; failed: string[] }` where `satisfied` is `true` only if all preconditions pass.

7. **`PhysicsSystemImpl` — executeAffordance** — The `PhysicsSystem` interface (already defined in `packages/engine/src/index.ts`) must be implemented in `packages/engine/src/physics/index.ts`. The `executeAffordance(objectId, affordanceId, agentId)` method must:
   - Look up the `SmartObject` via `SmartObjectRegistry.get(objectId)`.
   - If the object does not exist, return `AffordanceResult { success: false, failureReason: "Object not found" }`.
   - Find the `Affordance` on the object whose `id` matches `affordanceId`.
   - If the affordance does not exist on the object, return `AffordanceResult { success: false, failureReason: "Affordance not available on this object" }`.
   - Check preconditions via `AffordanceRegistryImpl.checkPreconditions(affordanceId, objectId)`. If not satisfied, return `AffordanceResult { success: false, failureReason: "Preconditions not met: <failed list>" }`.
   - Invoke the registered `AffordanceHandler` for `affordanceId` via `AffordanceRegistryImpl.getHandler(affordanceId)`. If no handler is registered, return `AffordanceResult { success: false, failureReason: "No handler registered for affordance: <affordanceId>" }`.
   - On handler success: update the object's state via `SmartObjectRegistry.updateState(objectId, result.newState)` if `newState` is provided, and return the `AffordanceResult` from the handler.
   - On handler failure: return the `AffordanceResult` from the handler (with `success: false` and `failureReason`).

8. **System feedback store** — The engine must maintain a per-agent system feedback store (e.g., `Map<agentId, string>`) accessible via `setSystemFeedback(agentId, feedback: string): void` and `getSystemFeedback(agentId: string): string | undefined`. The `getSystemFeedback` method is already declared on the existing `PerceptionDataProvider` interface (spec 001). The store must be shared between the `ExecuteDataProviderImpl` (which writes feedback on failure) and the `PerceptionDataProviderImpl` (which reads feedback during the next Perceive tick). Feedback is overwritten on each failure; it is not accumulated. The feedback store should also expose a `clearSystemFeedback(agentId: string): void` method to be called after feedback has been consumed by the Perceive phase (prevents stale feedback on subsequent ticks).

9. **`ExecuteDataProviderImpl` bridge** — A concrete `ExecuteDataProviderImpl` class must be implemented in `packages/engine/src/agents/index.ts` (or a dedicated file in `packages/engine/src/agents/`). It must implement the `ExecuteDataProvider` interface (defined in shared, Req 3) using `AgentManager`, `PlanManager`, `DriveSystem`, `SmartObjectRegistry`, `AffordanceRegistry`, `PhysicsSystem`, and the system feedback store:
   - `getAgentState(agentId)` → delegates to `AgentManager.getState(agentId)`.
   - `getCurrentStep(agentId)` → delegates to `PlanManager.getCurrentStep(agentId)`.
   - `isPlanComplete(agentId)` → delegates to `PlanManager.isComplete(agentId)`.
   - `resolveAffordance(roomId, affordanceId)` → iterates `SmartObjectRegistry.getByRoom(roomId)`, finds the object whose `affordances` array contains an `Affordance` with matching `id`, and returns `{ objectId, affordance }`. Returns `null` if no object in the room exposes that affordance.
   - `checkPreconditions(affordanceId, objectId)` → delegates to `AffordanceRegistry.checkPreconditions(affordanceId, objectId)`.
   - `executeAffordance(objectId, affordanceId, agentId)` → delegates to `PhysicsSystem.executeAffordance(objectId, affordanceId, agentId)`.
   - `advanceStep(agentId)` → delegates to `PlanManager.advanceStep(agentId)`.
   - `applyDriveChanges(agentId, changes)` → delegates to `DriveSystem.applyChanges(agentId, changes)`.
   - `setSystemFeedback(agentId, feedback)` → stores feedback in the system feedback store.
   - `setThinking(agentId, isThinking)` → delegates to `AgentManager.updateState(agentId, { isThinking })`.

### Cognition Layer (`@evol-hive/cognition`)

10. **`ExecuteService` interface** — A new interface `ExecuteService` must be defined in `packages/cognition/src/index.ts` with a method `execute(agentId: string): Promise<ExecuteResult>`. This is the entry point for the Execute phase, invoked by the PPER orchestrator after the Plan phase completes successfully.

11. **`ExecuteServiceImpl` — orchestration** — A concrete `ExecuteServiceImpl` class must be implemented in `packages/cognition/src/pper/execute-service.ts`, exported from `packages/cognition/src/pper/index.ts`. It must accept `ExecuteServiceOptions` (containing `dataProvider: ExecuteDataProvider`) via constructor injection. The `execute(agentId)` method must perform the following orchestration:
    - Retrieve the agent's state via `dataProvider.getAgentState(agentId)`. If the agent does not exist, return `ExecuteResult { success: false, error: "Agent not found", planComplete: true }`.
    - If `currentPlan` is `null`, return `ExecuteResult { success: false, error: "No active plan", planComplete: true }`.
    - If `dataProvider.isPlanComplete(agentId)` is `true`, return `ExecuteResult { success: true, planComplete: true }` without executing anything.
    - Get the current step via `dataProvider.getCurrentStep(agentId)`. If `null`, return `ExecuteResult { success: false, error: "No current step in plan", planComplete: true }`.

12. **Handle steps without `targetAffordance`** — If the current `PlanStep.targetAffordance` is `undefined`, the `ExecuteServiceImpl` must call `dataProvider.advanceStep(agentId)` and return `ExecuteResult { success: true, planComplete: <result of isPlanComplete after advance>, stepSkipped: true }`. This handles non-physical steps (e.g., "move to room") that do not map to a specific affordance. No precondition check, execution, or drive changes are performed for skipped steps.

13. **Resolve affordance to object** — When the current step has a `targetAffordance`, the `ExecuteServiceImpl` must call `dataProvider.resolveAffordance(agentState.location, step.targetAffordance)`. If `null` is returned (no object in the room exposes this affordance), the `ExecuteServiceImpl` must:
    - Set system feedback via `dataProvider.setSystemFeedback(agentId, "Cannot find object with affordance '<affordanceId>' in room '<roomId>'.")`.
    - Set `isThinking` to `false` via `dataProvider.setThinking(agentId, false)`.
    - Return `ExecuteResult { success: false, error: "Affordance '<affordanceId>' not found in room '<roomId>'" , planComplete: false }`.

14. **Check preconditions** — After resolving the affordance, the `ExecuteServiceImpl` must call `dataProvider.checkPreconditions(step.targetAffordance, resolved.objectId)`. If `satisfied` is `false`, the `ExecuteServiceImpl` must:
    - Set system feedback via `dataProvider.setSystemFeedback(agentId, "Preconditions not met for '<affordanceId>': <failed list joined by ', '>.")`.
    - Set `isThinking` to `false` via `dataProvider.setThinking(agentId, false)`.
    - Return `ExecuteResult { success: false, error: "Preconditions not met: <failed list>" , planComplete: false }`.

15. **Execute affordance** — If preconditions are satisfied, the `ExecuteServiceImpl` must call `dataProvider.executeAffordance(resolved.objectId, step.targetAffordance, agentId)` and await the `AffordanceResult`. If the result's `success` is `false`, the `ExecuteServiceImpl` must:
    - Set system feedback via `dataProvider.setSystemFeedback(agentId, result.failureReason ?? "Affordance execution failed.")`.
    - Set `isThinking` to `false` via `dataProvider.setThinking(agentId, false)`.
    - Return `ExecuteResult { success: false, error: result.failureReason ?? "Affordance execution failed", planComplete: false }`.

16. **Apply drive changes on success** — When the affordance execution succeeds (`result.success === true`), the `ExecuteServiceImpl` must call `dataProvider.applyDriveChanges(agentId, result.driveChanges)` if `result.driveChanges` is present and non-empty. If `result.driveChanges` is `undefined` or empty, no drive changes are applied (the affordance may have no drive impact).

17. **Advance plan step on success** — After successful execution and drive change application, the `ExecuteServiceImpl` must call `dataProvider.advanceStep(agentId)` to mark the current step as completed and increment `currentStepIndex`.

18. **Report plan completion** — After advancing the step, the `ExecuteServiceImpl` must call `dataProvider.isPlanComplete(agentId)` and include the result as `planComplete` in the returned `ExecuteResult { success: true, result, planComplete }`.

19. **`isThinking` safety on failure** — On every failure path (affordance not found, preconditions failed, execution failed, or any thrown exception), the `ExecuteServiceImpl` must call `dataProvider.setThinking(agentId, false)` to ensure the agent is not permanently frozen in the game loop (§9.1). This must be done before returning the failure `ExecuteResult`. On success, `isThinking` is not modified by the Execute phase (it should already be `false` from the Plan phase's `finally` block).

20. **Exception handling** — The `execute(agentId)` method must catch any exception thrown by the data provider calls and return `ExecuteResult { success: false, error: <exception message>, planComplete: false }`. It must **not** re-throw. Before returning, it must call `dataProvider.setThinking(agentId, false)` to guarantee the agent is not frozen. This follows the same pattern as `PlanServiceImpl` (spec 002, Req 6).

### Cross-Cutting

21. **No LLM in Execute** — The Execute phase is deterministic (System 1 / engine). It must **not** invoke the heavy LLM (`LLMClient.completeStructured()`, `LLMClient.completePlan()`, or `LLMClient.completeReflection()`). The Execute phase runs affordance physics, not cognitive reasoning. (§6 PPER overview: Execute = Engine deterministic.)

22. **Package boundaries** (per ADR-0001) — `cognition` and `engine` must **not** directly import from each other. All cross-package communication must go through interfaces defined in `@evol-hive/shared`. The engine owns affordance execution, precondition checking, object state, drives, and plan progression; cognition owns the Execute phase orchestration (reading plan, calling the bridge, handling results). The `ExecuteDataProviderImpl` lives in the engine package; the `ExecuteServiceImpl` lives in the cognition package.

23. **Deterministic execution** — Affordance execution must be deterministic. Given the same game world state and agent state, executing the same affordance must produce the same `AffordanceResult`. The `AffordanceHandler` functions are the single source of physics logic — no random number generation, no LLM calls, no external I/O inside handlers. This is critical for reproducible simulations.

24. **System feedback integration with Perceive** — The system feedback set by the Execute phase (on failure) must be readable by the `PerceptionDataProvider.getSystemFeedback(agentId)` method during the next Perceive tick. This closes the §9.2 Action Feedback Loop: failed execution → system feedback → next perception → agent adjusts plan. The feedback store must be the same instance shared between `ExecuteDataProviderImpl` and `PerceptionDataProviderImpl`.

25. **No plan modification during Execute** — The Execute phase must not create new plans, clear plans, or modify plan descriptions. It may only advance the step index (via `PlanManager.advanceStep`) and mark steps as completed. Re-planning (clearing the plan) is the responsibility of the Reflect phase or the PPER orchestrator.

26. **Drive change safety** — Drive changes from `AffordanceResult.driveChanges` must be applied via `DriveSystem.applyChanges`, which clamps values to 0–100 (per existing `DriveSystemImpl`). The Execute phase must not apply drive changes directly to `AgentInternalState.drives`.

## Acceptance Criteria

- [ ] **AC-1**: `ExecuteResult` is defined in `packages/shared/src/types/cognition.ts` with fields `success: boolean`, `result?: AffordanceResult`, `error?: string`, `planComplete: boolean`, and `stepSkipped?: boolean`. *(Req 1)*
- [ ] **AC-2**: `ExecutionOutcome` is defined in `packages/shared/src/types/cognition.ts` with fields `resolved: boolean`, `objectId?: string`, `preconditionsMet: boolean`, `failedPreconditions?: string[]`, and `result?: AffordanceResult`. *(Req 2)*
- [ ] **AC-3**: `ExecuteDataProvider` interface is defined in `packages/shared/src/types/cognition.ts` with all 10 methods listed in Req 3. *(Req 3)*
- [ ] **AC-4**: `AffordanceRegistryImpl.registerHandler(affordanceId, handler)` stores the handler, and `getHandler(affordanceId)` retrieves it. `getHandler` returns `null` for an unregistered affordance ID. *(Req 4)*
- [ ] **AC-5**: `PreconditionChecker` type is defined as `(objectState: Record<string, unknown>) => boolean`. `AffordanceRegistryImpl.registerPreconditionChecker(name, checker)` stores the checker. *(Req 5)*
- [ ] **AC-6**: Given a `SmartObject` with state `{ water_level: 0 }` and an `Affordance` with `preconditions: ["has_water"]`, and a registered checker `"has_water"` that returns `state.water_level > 0`, `checkPreconditions(affordanceId, objectId)` returns `{ satisfied: false, failed: ["has_water"] }`. *(Req 6)*
- [ ] **AC-7**: Given the same setup but with `water_level: 5`, `checkPreconditions(affordanceId, objectId)` returns `{ satisfied: true, failed: [] }`. *(Req 6)*
- [ ] **AC-8**: `checkPreconditions(affordanceId, objectId)` returns `{ satisfied: false, failed: ["<preconditionName>"] }` when a precondition name has no registered checker. *(Req 6)*
- [ ] **AC-9**: `PhysicsSystemImpl.executeAffordance(objectId, affordanceId, agentId)` returns `AffordanceResult { success: false, failureReason: "Object not found" }` when the object ID does not exist in the registry. *(Req 7)*
- [ ] **AC-10**: `PhysicsSystemImpl.executeAffordance(objectId, affordanceId, agentId)` returns `AffordanceResult { success: false, failureReason: "Affordance not available on this object" }` when the object exists but does not have the requested affordance. *(Req 7)*
- [ ] **AC-11**: `PhysicsSystemImpl.executeAffordance(objectId, affordanceId, agentId)` returns `AffordanceResult { success: false, failureReason: "No handler registered for affordance: <affordanceId>" }` when preconditions pass but no handler is registered. *(Req 7)*
- [ ] **AC-12**: `PhysicsSystemImpl.executeAffordance(objectId, affordanceId, agentId)` returns `{ success: false, failureReason: "Preconditions not met: has_water" }` when preconditions are not satisfied. *(Req 7)*
- [ ] **AC-13**: When the handler returns `AffordanceResult { success: true, newState: { water_level: 0 }, driveChanges: { energy: +20 } }`, `PhysicsSystemImpl.executeAffordance` updates the object state via `SmartObjectRegistry.updateState` and returns the handler's result. *(Req 7)*
- [ ] **AC-14**: `setSystemFeedback(agentId, feedback)` stores the feedback, and `getSystemFeedback(agentId)` retrieves it. Calling `setSystemFeedback` again overwrites the previous feedback (no accumulation). *(Req 8)*
- [ ] **AC-15**: `clearSystemFeedback(agentId)` removes any stored feedback for the agent; `getSystemFeedback(agentId)` returns `undefined` after clearing. *(Req 8)*
- [ ] **AC-16**: `ExecuteDataProviderImpl.resolveAffordance(roomId, affordanceId)` returns `{ objectId, affordance }` for the first object in the room whose `affordances` array contains an `Affordance` with matching `id`. Returns `null` if no object in the room has that affordance. *(Req 9)*
- [ ] **AC-17**: `ExecuteDataProviderImpl.applyDriveChanges(agentId, changes)` delegates to `DriveSystem.applyChanges(agentId, changes)`, which clamps drive values to 0–100. *(Req 9, Req 26)*
- [ ] **AC-18**: `ExecuteDataProviderImpl.advanceStep(agentId)` delegates to `PlanManager.advanceStep(agentId)`, incrementing `currentStepIndex` and marking the previous step as `completed`. *(Req 9)*
- [ ] **AC-19**: `ExecuteService` interface is defined in `packages/cognition/src/index.ts` with `execute(agentId: string): Promise<ExecuteResult>`. *(Req 10)*
- [ ] **AC-20**: `ExecuteServiceImpl` is defined in `packages/cognition/src/pper/execute-service.ts` and exported from `packages/cognition/src/pper/index.ts`. *(Req 11)*
- [ ] **AC-21**: When `currentPlan` is `null`, `ExecuteServiceImpl.execute(agentId)` returns `ExecuteResult { success: false, error: "No active plan", planComplete: true }` without calling `resolveAffordance`, `checkPreconditions`, or `executeAffordance`. *(Req 11)*
- [ ] **AC-22**: When `isPlanComplete(agentId)` is `true`, `ExecuteServiceImpl.execute(agentId)` returns `ExecuteResult { success: true, planComplete: true }` without executing any affordance. *(Req 11)*
- [ ] **AC-23**: When the current step's `targetAffordance` is `undefined`, `ExecuteServiceImpl.execute(agentId)` calls `advanceStep(agentId)` and returns `ExecuteResult { success: true, planComplete: <isPlanComplete after advance>, stepSkipped: true }`. No precondition check, execution, or drive changes are performed. *(Req 12)*
- [ ] **AC-24**: When `resolveAffordance` returns `null` (affordance not found in room), `ExecuteServiceImpl.execute(agentId)` calls `setSystemFeedback` with a message containing the affordance ID and room ID, calls `setThinking(agentId, false)`, and returns `ExecuteResult { success: false, error: ..., planComplete: false }`. *(Req 13, Req 19)*
- [ ] **AC-25**: When `checkPreconditions` returns `{ satisfied: false, failed: ["has_water"] }`, `ExecuteServiceImpl.execute(agentId)` calls `setSystemFeedback` with a message listing the failed preconditions, calls `setThinking(agentId, false)`, and returns `ExecuteResult { success: false, error: "Preconditions not met: has_water", planComplete: false }`. *(Req 14, Req 19)*
- [ ] **AC-26**: When `executeAffordance` returns `AffordanceResult { success: false, failureReason: "Machine broken" }`, `ExecuteServiceImpl.execute(agentId)` calls `setSystemFeedback` with the failure reason, calls `setThinking(agentId, false)`, and returns `ExecuteResult { success: false, error: "Machine broken", planComplete: false }`. *(Req 15, Req 19)*
- [ ] **AC-27**: When `executeAffordance` returns `AffordanceResult { success: true, driveChanges: { energy: +20 } }`, `ExecuteServiceImpl.execute(agentId)` calls `applyDriveChanges(agentId, { energy: +20 })`, calls `advanceStep(agentId)`, and returns `ExecuteResult { success: true, result: <the AffordanceResult>, planComplete: <isPlanComplete after advance> }`. *(Req 16, Req 17, Req 18)*
- [ ] **AC-28**: When `executeAffordance` returns `AffordanceResult { success: true }` (no `driveChanges`), `ExecuteServiceImpl.execute(agentId)` does **not** call `applyDriveChanges`, calls `advanceStep(agentId)`, and returns `ExecuteResult { success: true, result, planComplete: <isPlanComplete after advance> }`. *(Req 16)*
- [ ] **AC-29**: When a data provider call throws an exception, `ExecuteServiceImpl.execute(agentId)` catches the error, calls `setThinking(agentId, false)`, and returns `ExecuteResult { success: false, error: <message>, planComplete: false }` without re-throwing. *(Req 20)*
- [ ] **AC-30**: After any failure path (AC-24, AC-25, AC-26, AC-29), `AgentInternalState.isThinking` is `false`. *(Req 19, Req 20)*
- [ ] **AC-31**: No method in `ExecuteServiceImpl` calls `LLMClient.completeStructured()`, `LLMClient.completePlan()`, or `LLMClient.completeReflection()`. *(Req 21)*
- [ ] **AC-32**: `ExecuteServiceImpl` imports from `@evol-hive/shared` only (not from `@evol-hive/engine`). `ExecuteDataProviderImpl` imports from `@evol-hive/engine` and `@evol-hive/shared` (not from `@evol-hive/cognition`). *(Req 22)*
- [ ] **AC-33**: The system feedback set by `ExecuteDataProviderImpl.setSystemFeedback(agentId, feedback)` is readable by `PerceptionDataProvider.getSystemFeedback(agentId)` when both providers share the same feedback store instance. *(Req 24)*
- [ ] **AC-34**: `ExecuteServiceImpl.execute(agentId)` does not call `PlanManager.clearPlan`, `PlanManager.createPlan`, or modify `AgentPlan.description`. It only advances the step index via `advanceStep`. *(Req 25)*
- [ ] **AC-35**: Given an `AgentPlan` with 2 steps where step 0 has `targetAffordance: "brew_coffee"` and step 1 has no `targetAffordance`, calling `execute(agentId)` twice (first succeeds, second is skipped) results in `planComplete: true` on the second call. *(Req 12, Req 17, Req 18)*
- [ ] **AC-36**: Given the same SmartObject state and agent state, calling `PhysicsSystemImpl.executeAffordance(objectId, affordanceId, agentId)` twice produces identical `AffordanceResult` objects (same `success`, `failureReason`, `newState`, `driveChanges`). *(Req 23)*

## Constraints

- **Package boundaries** (per ADR-0001): `cognition` and `engine` must **not** directly import from each other. All cross-package communication must go through interfaces defined in `@evol-hive/shared`. The engine owns affordance execution, precondition checking, object state management, drives, and plan progression; cognition owns the Execute phase orchestration. The `ExecuteDataProvider` bridge (defined in `shared`) is the only communication channel.
- **No LLM in Execute**: The Execute phase is deterministic (Engine). Calling any `LLMClient` method during Execute is a hard violation. The LLM is only called in the Plan phase (for plan formulation) and the Reflect phase (for memory consolidation).
- **`isThinking` safety**: The `isThinking` flag must be set to `false` on every failure path (affordance not found, preconditions failed, execution failed, exception). Leaving `isThinking = true` permanently freezes the agent in the game loop (§9.1). On the success path, `isThinking` is not modified by the Execute phase — it should already be `false` from the Plan phase's cleanup. Use the safety pattern from `PlanServiceImpl` (try/catch with guaranteed `setThinking(false)` before returning on error paths).
- **Deterministic execution**: `AffordanceHandler` functions must be pure deterministic functions of `(objectId, agentId, objectState)`. No random number generation, no LLM calls, no network I/O, no `Date.now()` inside handlers. The same input must always produce the same `AffordanceResult`. This is critical for reproducible simulations and testing.
- **System feedback is transient**: System feedback is a one-shot message — it is overwritten on the next failure and cleared after being consumed by the Perceive phase. It must not accumulate or persist across multiple ticks. The feedback store must be shared between `ExecuteDataProviderImpl` (writer) and `PerceptionDataProviderImpl` (reader), typically as a constructor-injected dependency.
- **No plan modification**: The Execute phase must not create, clear, or modify plans beyond advancing the step index. Re-planning is the Reflect phase's responsibility. Modifying `AgentPlan.description`, `steps`, or clearing `currentPlan` during Execute is a hard violation.
- **Drive clamping**: Drive changes must be applied via `DriveSystem.applyChanges`, which clamps to 0–100. Directly modifying `AgentInternalState.drives` without clamping is a violation. This prevents overflow/underflow in drive values.
- **Interface-first pattern**: Follow the existing pattern — define interfaces in `shared` or `cognition`, implement in the appropriate package. The `ExecuteDataProvider` interface goes in `shared`; the `ExecuteService` interface goes in `cognition`; `ExecuteDataProviderImpl` goes in `engine`; `ExecuteServiceImpl` goes in `cognition`.
- **Reuse from specs 001 and 002**: The `AgentPlan`, `PlanStep`, `AgentInternalState`, `Affordance`, `AffordanceResult`, `SmartObject`, `SmartObjectRegistry`, `PlanManager`, `DriveSystem`, `PerceptionDataProvider`, and `PlanDataProvider` types/interfaces are already defined. This spec adds `ExecuteResult`, `ExecutionOutcome`, `ExecuteDataProvider`, `ExecuteService`, and their implementations — it does not redefine existing types.
- **Precondition checker registration**: Precondition checkers must be registered at engine initialization time (e.g., during world setup), not dynamically during execution. The `AffordanceRegistryImpl` must not lazy-register checkers or infer them from affordance definitions. If a precondition name has no registered checker, it is treated as failed (fail-safe).
- **What NOT to do**:
  - Do not implement the Reflect phase of the PPER loop — that is a separate spec.
  - Do not implement the PPER orchestrator's phase-transition state machine.
  - Do not implement the game loop, async routing infrastructure, or `LLMConcurrencyManager` (§9).
  - Do not implement the `observe(target)` active perception mechanism (§6.2) — that is a separate spec.
  - Do not implement cognitive guardrails (§10) — the Execute phase consumes the plan as-is.
  - Do not implement `LLMClient` backends (Ollama, vLLM, llama.cpp) — the Execute phase doesn't use the LLM at all.
  - Do not implement memory retrieval or consolidation (§11) — that is the Reflect phase's scope.
  - Do not add `ExecuteResult` or `ExecuteDataProvider` to `packages/engine/` — they belong in `shared` since both engine and cognition need to reference them.
