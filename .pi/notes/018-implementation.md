# YAAM Workspace Note — feature-018-object-interactions

## Task
Implement spec 018 (Object Interactions — Multi-Step Affordances, Object State Changes, Dependencies) for GitHub issue #63.

## What was built (PR #69, branch feature/018-object-interactions)

### Shared layer
- New types in `packages/shared/src/types/affordance.ts`:
  - `AffordanceCondition` — structured declarative condition `{ field, operator, value }` evaluated at perception time
  - `CompoundAction` — multi-step sequence `{ id, label, steps[] }` for LLM context
  - `ObjectDependency` — cross-object affordance dependency `{ affordanceId, requiresObjectId, requiresAffordance, description }`
  - `ObjectStateRule` — declarative state evolution rule `{ field, operation: 'decay'|'approach', rate, target?, interval }`
  - `CrossObjectStateChange` — `{ objectId, statePatch }` for cross-object replenishment
- Optional fields added to existing interfaces (all backward compatible):
  - `Affordance`: `stepGroup?`, `stepOrder?`, `conditions?`
  - `SmartObject`: `stateRules?`, `compoundActions?`, `dependencies?`
  - `AffordanceResult`: `crossObjectStateChanges?`
  - `PerceptionResult`: `compoundActions?`, `objectDependencies?`
- `PerceptionDataProvider` interface extended with 3 new methods: `getAvailableAffordancesInRoom`, `getCompoundActionsInRoom`, `getObjectDependenciesInRoom`

### Engine layer
- `evaluateConditions` — stateless pure function in `packages/engine/src/world/affordances/index.ts` (Req 13)
- `SmartObjectRegistryImpl` — 5 new methods:
  - `getAvailableAffordancesInRoom` — filters affordances by structured `conditions`
  - `getCompoundActionsInRoom` — aggregates compound actions from all objects in a room
  - `getObjectDependenciesInRoom` — aggregates dependencies from all objects in a room
  - `getAll` — returns all registered smart objects
  - `applyStatePatch` — shallow merge state patch (no-op for nonexistent objects)
- `SmartObjectRegistry` interface extended with all 5 new methods
- `PhysicsSystemImpl.executeAffordance` — applies `crossObjectStateChanges` on success only (silent skip for nonexistent targets)
- `ObjectStateSystem` — new engine system in `packages/engine/src/systems/object-state.ts`:
  - Applies declarative `ObjectStateRule`s each tick (decay: subtract rate*delta clamped ≥0; approach: move toward target without overshooting)
  - Throttles by `interval` using `tick.simulationTime`
  - Skips non-numeric fields silently
  - Registered in `assembleGameLoop` as system #3 (after DriveDecaySystem, before PPERScheduler)
- `PerceptionDataProviderImpl` — 3 new delegation methods to `SmartObjectRegistryImpl`

### Cognition layer
- `PerceptionServiceImpl.perceive`:
  - Calls `getAvailableAffordancesInRoom` when available (feature detection via `typeof`), falls back to `getAffordancesInRoom` for backward compat
  - Populates `compoundActions` and `objectDependencies` in `PerceptionResult` (graceful fallback to undefined when methods absent or empty)
- `PlanBuilderImpl.build`:
  - Appends `"Multi-step actions available: ..."` context line when `compoundActions` non-empty
  - Appends `"Object dependencies: ..."` context line when `objectDependencies` non-empty

### Tests (TDD — tests written before implementation)
- `packages/shared/tests/spec-018-object-interaction-types.test.ts` — 17 tests covering AC-1 through AC-10 (shared type definitions)
- `packages/engine/tests/spec-018-object-interactions.test.ts` — 28 tests covering AC-11 through AC-33, AC-42 (evaluateConditions, registry methods, physics cross-object, ObjectStateSystem, perception provider delegation, assembly registration)
- `packages/cognition/tests/spec-018-object-interactions.test.ts` — 11 tests covering AC-34 through AC-39 (perceive available affordances with fallback, compound actions/dependencies in PerceptionResult, PlanBuilderImpl context lines)
- Updated `packages/engine/tests/assembly.test.ts` — system order now includes 'object-state'
- Updated `packages/engine/tests/spec-014-memory-maintenance.test.ts` — memory-maintenance now 5th system (was 4th)

## Key design decisions
1. **`conditions` vs `preconditions` coexistence** — `conditions` (structured, declarative) are evaluated at perception time for affordance availability filtering; `preconditions` (string-based, require registered checkers) remain as execute-time fail-safe. Both systems coexist.
2. **Cross-object changes are data, not code** — Handlers return `crossObjectStateChanges` as data; the engine applies them via `applyStatePatch`. Deterministic, no randomness.
3. **ObjectStateSystem is tick-driven and global** — Operates on all objects each tick, not agent-aware. Uses `tick.time` and `tick.deltaSeconds` (not system clock) for reproducibility.
4. **Shallow merge for applyStatePatch** — `{ ...existingState, ...patch }`. Sufficient for prototype; deep merge is future concern.
5. **Backward compatibility** — All new fields optional, all new methods have feature-detection fallbacks. Existing scenes/handlers unaffected.

## Test results
- `pnpm test` — All pass (shared: 152, engine: 356+97 todo, cognition: 398+26 todo)
- `pnpm typecheck` — Clean (all 4 packages)
- `pnpm lint` — Clean
- `pnpm format:check` — Clean
- `pnpm build` — Succeeds
- Package boundaries verified: no cognition↔engine cross-imports

## PR
- PR #69: https://github.com/Redna/evol-hive/pull/69