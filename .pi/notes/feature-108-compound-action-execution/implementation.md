# YAAM Workspace Note — feature-108-compound-action-execution

## Task
Implement spec 028 (Compound Action Execution — Execute Compound Actions Planned by the LLM) for GitHub issue #108.

## What was built (PR #114, branch feature/108-compound-action-execution)

TDD followed: tests written first in `packages/engine/tests/` and `packages/cognition/tests/`, confirmed failing for the right reasons (`resolveCompoundAction is not a function`; compound targets were skipped with "affordance not found"), then implemented until green.

### Shared layer (`packages/shared/src/types/cognition.ts`)
- Optional `resolveCompoundAction?(roomId, compoundActionId): { objectId, compoundAction } | null` added to `ExecuteDataProvider` (Req 1). Optional keeps custom providers source- and behavior-compatible; the service guards with `?.`/`typeof` (same pattern as `getCompoundActionsInRoom`).

### Engine layer (`packages/engine/src/agents/execute/index.ts`)
- `ExecuteDataProviderImpl.resolveCompoundAction` (Req 2): linear scan over `smartRegistry.getByRoom(roomId)` matching `object.compoundActions` entries by ID; returns first `{ objectId, compoundAction }`, `null` when no match. `resolveAffordance` untouched (Decision 3 — separate method, plain fast path preserved).

### Cognition layer (`packages/cognition/src/pper/execute-service.ts`)
- Compound fallback in `ExecuteServiceImpl.execute` (Req 3): after `resolveAffordance` returns null for `step.targetAffordance`, attempt `dataProvider.resolveCompoundAction?.(...)`; non-null → `executeCompoundAction`; null/absent method → pre-change skip behavior byte-identical.
- `executeCompoundAction` (Req 4–7): iterates `compoundAction.steps` in order through the existing single-affordance path — `resolveAffordance(roomId, subStep.affordanceId)` → `checkPreconditions` → `executeAffordance`.
  - Full success (Req 5): merged drive changes (numeric sum) applied once via `applyDriveChanges`, plan advances exactly once, aggregated `AffordanceResult { success: true, driveChanges: merged }`, `planComplete` reflects post-advance state, no system feedback, no `setThinking`.
  - Precondition-failure abort (Req 6 / AC-4): abort immediately — remaining sub-steps not attempted, NO drive changes applied, plan step NOT advanced, feedback `Compound action '<id>' aborted at step <i>/<n> ('<affordanceId>'): preconditions not met: <failed>.`, `{ success: false, planComplete: false }`, `isThinking` reset false.
  - Execution-failure abort (Req 7 / AC-5): same abort semantics with the sub-step's `failureReason`; sub-step exceptions propagate to the existing top-level try/catch (isThinking invariant holds).
  - Nested compounds (Req 4/7 / AC-8): sub-step that resolves only as a compound action aborts with `nested compound actions are not supported` in the message; detection = `resolveAffordance` null + `resolveCompoundAction` non-null for the sub-step ID; no recursion.

### Constraints honored
- Physics untouched (single-affordance); Execute phase stays LLM-free (§6); bridge pattern per ADR-0001; guardrail plan validation (spec 016 Req 11) runs before compound resolution unchanged; abort message format exactly matches spec AC-4 template.

### Tests (29 total, all passing)
- `packages/engine/tests/spec-028-compound-action-execution.test.ts` (9 tests) — AC-1 on the coffee-shop scene (`brew_coffee_sequence` → `coffee-1`, 3 steps; unknown ID → null; room scoping; first-match; plain path unchanged).
- `packages/cognition/tests/spec-028-compound-action-execution.test.ts` (20 tests) — AC-2 order+single-advance, AC-3 merged drives {energy: 25, comfort: 5} applied once, AC-4/AC-5 abort semantics + exact feedback format + isThinking reset + no partial drive application, AC-6 skip fallback, AC-7 missing-method compat (delete the optional method), AC-8 nested no-recursion (resolveCompoundActionCalls asserted 2, never deeper).

### Verification
- `pnpm test` all packages green (shared 19, visualizer 2, memory 11, cognition 27, engine 41, examples 4, cli 1 test files)
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` all green
- PR: https://github.com/Redna/evol-hive/pull/114 (spec status updated to 🔍 In Review)

### Gotchas for future work
- `executeAffordance` is called with `step.targetAffordance` (the plan's ID), not `resolved.affordance.id` — pre-existing single-path contract, kept for the plain-wins-over-compound case.
- The failed sub-step's `executeAffordance` call IS recorded before an abort — assert "sub-steps attempted" not "sub-steps executed successfully" when testing aborts.
- Visualizer dist artifact needed building for examples e2e tests (`pnpm --filter @evol-hive/visualizer build`) — pre-existing build-order quirk, unrelated to this feature.