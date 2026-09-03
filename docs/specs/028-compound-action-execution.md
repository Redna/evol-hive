# Feature: Compound Action Execution — Execute Compound Actions Planned by the LLM

## Context
- Architecture: [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (SmartObject, CompoundAction, affordances, preconditions), [§6 — PPER Loop](../architecture/06-pper-loop.md) (Execute phase is deterministic, System 1; failure paths must unfreeze `isThinking`), [§9 — Engine Routing](../architecture/09-engine-routing.md) (bridge pattern, system feedback loop)
- Related specs: [018 — Object Interactions](018-object-interactions.md) (CompoundAction type, `compoundActions` on SmartObject, `getCompoundActionsInRoom`, Req 25 — plan-builder advertisement), [003 — Execute Phase](003-execute-phase.md) (ExecuteService, ExecuteDataProvider, AffordanceResult, precondition checking), [016 — Cognitive Guardrails](016-cognitive-guardrails.md) (plan validation before execution)
- Package: `shared` (interface extension), `engine` (bridge implementation), `cognition` (ExecuteService expansion)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#108](https://github.com/Redna/evol-hive/issues/108)

## Problem

Compound actions (spec 018, Req 25) are advertised in the Plan-phase context ("Multi-step actions available: Brew a cup of coffee (3 steps)") but there is no execution path. `resolveAffordance()` in the Execute bridge (`packages/engine/src/agents/execute/index.ts`) only searches `object.affordances`; compound actions live in `object.compoundActions` and are never consulted. When the LLM targets a compound action ID in a plan step, the Execute service cannot resolve it and skips the step with "affordance not found in room". The compound-action feature is advertised dead code.

## Design Rationale

Two approaches were considered (both named in the issue):

1. **Execute-service expansion (chosen)** — Add an optional compound-resolution method to the `ExecuteDataProvider` bridge; when the Execute service fails to resolve a step target as a plain affordance, it attempts compound resolution and, on success, runs the compound's steps sequentially through the *existing* single-affordance path (resolve → check preconditions → execute → aggregate).
2. **Engine-bridge/physics expansion (rejected)** — Resolve compound actions inside `resolveAffordance()` and expand steps in the physics layer. Rejected because drive-change aggregation, per-step system feedback, and plan advancement are cognition-layer responsibilities (spec 003); pushing them into physics would couple the physics layer to plan/feedback state and break the `ExecuteDataProvider` abstraction. Physics stays deterministic and single-affordance.

The compound resolution capability crosses the cognition/engine boundary, so it must be declared on the `ExecuteDataProvider` interface in `shared` (per ADR-0001), implemented by the engine bridge, and consumed by `ExecuteServiceImpl`. The method is **optional** on the interface so custom providers remain backward compatible.

All changes are backward compatible: existing providers without the new method keep the current behavior (unresolvable step targets are skipped with feedback), and all new fields/methods are additive.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`resolveCompoundAction` on `ExecuteDataProvider`** — Add an *optional* method to the `ExecuteDataProvider` interface in `packages/shared/src/types/cognition.ts`: `resolveCompoundAction?(roomId: string, compoundActionId: string): { objectId: string; compoundAction: CompoundAction } | null`. It resolves a compound action ID to the smart object in the given room that defines it. Returns `null` if no object in the room defines a compound action with that ID. Optional so that existing custom `ExecuteDataProvider` implementations compile and behave unchanged.

### Engine Layer (`@evol-hive/engine`)

2. **`ExecuteDataProviderImpl.resolveCompoundAction`** — Implement the method in `packages/engine/src/agents/execute/index.ts`. It iterates the room's objects (via `SmartObjectRegistry.getByRoom`) and returns the first `{ objectId, compoundAction }` where `object.compoundActions` contains an entry whose `id` matches `compoundActionId`. Returns `null` when no match is found. Plain-affordance resolution via the existing `resolveAffordance` is unchanged.

### Cognition Layer (`@evol-hive/cognition`)

3. **Compound fallback in `ExecuteServiceImpl.execute`** — In `packages/cognition/src/pper/execute-service.ts`, after the existing `resolveAffordance` call returns `null` for a step target, the service must attempt compound resolution: if `dataProvider.resolveCompoundAction` is defined and returns a non-null result for `step.targetAffordance`, the step is a compound action and is executed per Req 4–7. If compound resolution also fails (or the method is not implemented), the existing skip behavior is preserved unchanged (advance step, system feedback "affordance not found in room", `stepSkipped: true`, `success: true`).

4. **Sequential step execution** — A compound step is executed by iterating `compoundAction.steps` in order. For each sub-step, the service uses the existing single-affordance path: `resolveAffordance(roomId, step.affordanceId)` (on the compound's owning object — the sub-steps resolve on the object that declares the compound action), `checkPreconditions`, then `executeAffordance`. Sub-steps must map to plain affordances; nested compound actions are not supported (a sub-step ID that only resolves as a compound action is treated as an execution failure, see Req 7).

5. **Aggregated success result** — When all sub-steps succeed, the service applies the *merged* drive changes (numeric sum of each sub-step's `AffordanceResult.driveChanges`) via `applyDriveChanges` once, advances the plan step exactly once, and returns `ExecuteResult` with `success: true`, an aggregated `AffordanceResult` (`success: true`, merged `driveChanges`), and `planComplete` reflecting the post-advance plan state. No system feedback is set on full success (parity with single-affordance success).

6. **Precondition-failure abort** — If any sub-step fails its precondition check, the compound action aborts immediately: remaining sub-steps are not attempted, drive changes are **not** applied (world-state changes from already-executed sub-steps persist, since physics is side-effecting), the plan step is **not** advanced (the compound step remains current and retryable), and the service sets system feedback naming the compound action and the failed sub-step, e.g. `Compound action 'brew_coffee_sequence' aborted at step 2/3 ('brew_coffee'): preconditions not met: has_water.`. It returns `ExecuteResult` with `success: false`, `error` containing the same reason, `planComplete: false`, and `isThinking` set to `false` (§9.1 failure-path guarantee).

7. **Execution-failure abort** — If a sub-step's `executeAffordance` returns `success: false` (or throws), the compound action aborts with the same semantics as Req 6, using the sub-step's `failureReason` in the feedback message. Exceptions from any sub-step are caught by the existing top-level `try/catch`, which already guarantees `isThinking === false` and returns `success: false`.

8. **Guardrail compatibility** — Plan validation (spec 016, Req 11) runs before compound resolution on `step.targetAffordance` (the compound ID), unchanged. No guardrail changes are required: a compound ID planned by the LLM appears in the plan, so validation passes.

## Acceptance Criteria

- [ ] **AC-1**: `ExecuteDataProviderImpl.resolveCompoundAction("kitchen", "brew_coffee_sequence")` on the coffee-shop scene returns `{ objectId, compoundAction }` with `compoundAction.steps.length === 3`; it returns `null` for an unknown ID. *(Req 2)*
- [ ] **AC-2**: A plan whose current step targets a compound action ID executes all sub-steps in order — each sub-step's engineEffect fires exactly once, in `steps` order — and the plan advances exactly one step for the whole compound. *(Req 3, 4, 5)*
- [ ] **AC-3**: On full compound success, `ExecuteResult.success === true`, the returned `AffordanceResult.driveChanges` equals the numeric sum of the sub-steps' drive changes, those merged drive changes are applied via `applyDriveChanges`, no system feedback is set, and `planComplete` reflects the post-advance state. *(Req 5)*
- [ ] **AC-4**: When sub-step 2 of 3 fails preconditions, sub-step 1 has executed, sub-step 3 has not, the plan step is not advanced, system feedback matches `Compound action '<id>' aborted at step 2/3 ('<affordanceId>'): preconditions not met: <failed>.`, and `ExecuteResult` is `{ success: false, planComplete: false }` with `isThinking` reset to `false`. *(Req 6)*
- [ ] **AC-5**: When a sub-step's execution fails (handler returns `success: false`), the compound aborts with the same semantics as AC-4 and the feedback message contains the sub-step's `failureReason`. *(Req 7)*
- [ ] **AC-6**: A step target that resolves as neither a plain affordance nor a compound action is skipped with the existing feedback and `stepSkipped: true` — behavior identical to pre-change. *(Req 3)*
- [ ] **AC-7**: An `ExecuteDataProvider` without `resolveCompoundAction` produces identical behavior to pre-change for both resolvable affordances and unresolvable targets (backward compatibility). *(Req 1, 3)*
- [ ] **AC-8**: A sub-step ID that is itself only a compound action (nested compound) aborts the compound with a clear failure message and does not recurse. *(Req 4, 7)*
- [ ] **AC-9**: Unit tests exist covering: compound happy path (AC-2, AC-3), precondition-failure abort (AC-4), execution-failure abort (AC-5), skip fallback (AC-6), and missing-provider-method backward compatibility (AC-7), in `packages/cognition/tests/` and `packages/engine/tests/`. *(Req 2–7)*

## Constraints
- Package boundaries: only `shared` (optional interface method), `engine` (bridge implementation), and `cognition` (ExecuteService) may be modified. The physics layer (`packages/engine/src/physics/index.ts`) must **not** be modified — it stays single-affordance. `memory` is untouched.
- The Execute phase must remain LLM-free (§6): compound expansion is deterministic engine/service logic.
- Follow the bridge pattern (ADR-0001): cognition depends only on `ExecuteDataProvider`, never on engine classes.
- Performance: compound resolution is a linear scan over room objects (same complexity as the existing `resolveAffordance`); sub-step execution reuses existing methods with no new allocations per tick beyond the aggregate result. No hot-path changes.
- Failure-path parity: every failure path must set `isThinking = false` (§9.1) and must never re-throw (top-level `try/catch` in `ExecuteServiceImpl` is retained).
- What NOT to do: do not resolve compound actions inside `resolveAffordance()` (it would change the return contract and break the plain-affordance fast path); do not apply drive changes incrementally during a compound run (aggregate once on success, per Req 5/6); do not support nested compound actions.
