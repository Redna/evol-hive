# Design Decisions — Spec 028 (Compound Action Execution, Issue #108)

Workspace: `feature-108-compound-action-execution`
Spec: `docs/specs/028-compound-action-execution.md`
Issue: #108 (labels at drafting time: bug, Status: Needs Architecture)

## Decision 1: Execute-Service Expansion (Option A from Issue), Not Physics Expansion
**Context:** The issue proposes executing compound steps in the Execute service (`packages/cognition/src/pper/execute-service.ts`) or, alternatively, resolving in the engine bridge and expanding steps in the physics layer.

**Decision:** Option A — the Execute service detects compound targets and expands them, using an optional new `resolveCompoundAction` bridge method for resolution.

**Rationale:** Drive-change aggregation, per-step system feedback, and plan advancement are cognition-layer responsibilities (spec 003). Expanding in physics would couple the physics layer to plan/feedback state and break the `ExecuteDataProvider` abstraction. Physics stays deterministic and single-affordance; the Execute phase stays LLM-free (§6).

**Alternative considered:** Physics-layer expansion. Rejected per above.

## Decision 2: Optional `resolveCompoundAction` on `ExecuteDataProvider`
**Context:** `ExecuteServiceImpl` (cognition) cannot see `SmartObject.compoundActions` — that data lives behind the engine bridge. `PerceptionDataProvider` already has `getCompoundActionsInRoom`, but the Execute provider is a separate interface.

**Decision:** Add an *optional* method `resolveCompoundAction?(roomId, compoundActionId): { objectId, compoundAction } | null` to `ExecuteDataProvider` in `shared`, implemented by `ExecuteDataProviderImpl` in `engine`.

**Rationale:** Crosses the cognition/engine boundary, so it belongs on the bridge interface (ADR-0001). Optional keeps custom providers source- and behavior-compatible; the service guards with a `typeof` check (same pattern as `getCompoundActionsInRoom` in the PPER perception service).

## Decision 3: Do Not Touch `resolveAffordance()`
**Context:** An alternative is to make `resolveAffordance("kitchen", "brew_coffee_sequence")` return the compound action directly.

**Decision:** `resolveAffordance()` is unchanged; compound resolution is a separate method and a fallback in the service (attempted only when plain resolution returns `null`).

**Rationale:** Changing `resolveAffordance`'s return contract (it returns an `Affordance`, and compound actions are not affordances) would break the plain-affordance fast path and every existing caller/test. A separate method keeps both paths type-safe. The issue's AC-1 is satisfied either way ("or the Execute service handles it").

## Decision 4: One Plan Step = One Atomic Compound Execution
**Context:** Should a compound action advance the plan step per sub-step, or once for the whole compound?

**Decision:** All sub-steps execute within a single Execute-phase call for the plan step; the plan advances exactly once after full success.

**Rationale:** The LLM planned one step ("brew_coffee_sequence"); advancing per sub-step would desynchronize the plan from what the LLM emitted. Atomicity also gives clean abort semantics: on failure the same step stays current and is retryable next tick.

## Decision 5: All-or-Nothing Drive Changes; World State Persists on Abort
**Context:** If sub-step 1 succeeds and sub-step 2 fails preconditions, what happens to step 1's drive changes and world-state effects?

**Decision:** Drive changes are aggregated and applied only on full compound success (numeric sum). On abort, no drive changes are applied. World-state changes from already-executed sub-steps persist (physics handlers are side-effecting); the feedback message names the failed sub-step so the LLM can replan.

**Rationale:** All-or-nothing drive changes are simpler to test and reason about (AC-3 asserts an exact sum), and avoid partially rewarding an agent for a failed sequence. Reverting world state is not feasible without transactional physics — out of scope; the persisted state (e.g., water added) is semantically consistent with "the steps that ran, ran".

## Decision 6: Abort Semantics Mirror Single-Affordance Failures
**Context:** What should an aborted compound return?

**Decision:** `ExecuteResult { success: false, planComplete: false }`, `isThinking` set to `false`, system feedback `Compound action '<id>' aborted at step <i>/<n> ('<affordanceId>'): <reason>.`, plan step not advanced.

**Rationale:** Identical to the existing precondition-failure and execution-failure paths in `ExecuteServiceImpl`, so the Reflect/retry loop behaves uniformly. Exceptions keep flowing to the existing top-level `try/catch`, which already guarantees the `isThinking` invariant.

## Decision 7: No Nested Compound Actions
**Context:** A compound step's `affordanceId` could itself reference another compound action.

**Decision:** Unsupported. A sub-step that resolves only as a compound action is treated as an execution failure (aborts with clear feedback, no recursion).

**Rationale:** Recursion adds no demonstrated value (no scene uses it), risks infinite loops, and complicates the aggregate result. Can be layered on later without breaking this contract.
