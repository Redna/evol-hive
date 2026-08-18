# QA Findings — Spec 018: Object Interactions

**PR:** [#65](https://github.com/Redna/evol-hive/pull/65)
**Issue:** [#63](https://github.com/Redna/evol-hive/issues/63)
**Branch:** `spec/018-object-interactions`
**Date:** 2025-01-23
**QA Status:** ✅ PASS

## Summary

Spec-only PR introducing `docs/specs/018-object-interactions.md` — 32 requirements, 42 acceptance criteria defining object interactions: multi-step affordances, object state evolution, dependencies, conditional affordances, and cross-object replenishment.

## Coverage Test Files Added

### `packages/engine/tests/spec-018-coverage.test.ts`
- **60 test cases** total (18 active, 42 `it.todo` scaffolds)
- **8 document structure tests**: file existence, title, requirement count (32), AC count (42), architecture section references (§4, §5, §6, §9), issue reference (#63), package list (shared, engine, cognition), ADR-0001 reference
- **3 INDEX.md validation tests**: spec 018 row, architecture coverage for §4/§5, total spec count (19)
- **7 existing scaffolding verification tests**: confirmed presence of `Affordance`, `SmartObject`, `AffordanceResult`, `PerceptionResult`, `PerceptionDataProvider`, `SmartObjectRegistry` interface + `SmartObjectRegistryImpl`, `PhysicsSystemImpl`, `EngineSystem`, `GameTick`, `DriveDecaySystem`, `PerceptionServiceImpl`, `PlanBuilderImpl`
- **42 AC scaffolds** (AC-1 through AC-42): pending activation when implementation PR lands

## Other Changes

- **`docs/specs/INDEX.md`**: Added spec 018 row, updated architecture coverage for §4/§5, updated total specs 18→19, drafted 3→4
- **`packages/engine/tests/spec-017-coverage.test.ts`**: Fixed hardcoded INDEX.md total specs assertion (18 → `greaterThanOrEqual(18)`) since spec 018 bumps count to 19
- **`packages/cognition/tests/spec-016-coverage.test.ts`**: Fixed same hardcoded INDEX.md count assertion (18 → `greaterThanOrEqual(16)`)

## Test Results

| Command | Result |
|---------|--------|
| `pnpm test` | ✅ All pass (shared: 62, memory: 81, cognition: 387+1 skipped+26 todo, engine: 323+97 todo) |
| `pnpm typecheck` | ✅ Clean (all 4 packages) |
| `pnpm lint` | ✅ Clean (no errors) |

## AC Coverage Breakdown

| AC Range | Layer | Description |
|----------|-------|-------------|
| AC-1 – AC-10 | Shared | New types (AffordanceCondition, CompoundAction, ObjectDependency, ObjectStateRule, CrossObjectStateChange) + interface extensions (Affordance, SmartObject, AffordanceResult, PerceptionResult, PerceptionDataProvider) |
| AC-11 – AC-13 | Engine | `evaluateConditions` static helper — numeric, boolean, missing field cases |
| AC-14 – AC-20 | Engine | SmartObjectRegistryImpl — getAvailableAffordancesInRoom, getCompoundActionsInRoom, getObjectDependenciesInRoom, applyStatePatch (shallow merge + no-op for missing) |
| AC-21 – AC-23 | Engine | PhysicsSystemImpl — cross-object state changes on success, silent skip for missing target, no application on failure |
| AC-24 – AC-29 | Engine | ObjectStateSystem — decay, approach, clamping, throttling, non-numeric skip |
| AC-30 | Engine | SmartObjectRegistryImpl.getAll() |
| AC-31 – AC-33 | Engine | PerceptionDataProviderImpl — delegation to registry |
| AC-34 – AC-37 | Cognition | PerceptionServiceImpl — available affordances with backward compat fallback, compound actions & dependencies in PerceptionResult |
| AC-38 – AC-39 | Cognition | PlanBuilderImpl — compound actions & dependencies in LLM context lines |
| AC-40 – AC-42 | Cross-cutting | Backward compat (spec 013 scenes), package boundaries (no cross-imports), ObjectStateSystem registration |

## Actions Taken

1. ✅ Created spec-018 coverage test file with 18 active + 42 scaffold tests
2. ✅ Fixed pre-existing INDEX.md count assertions in spec-016 and spec-017 coverage tests
3. ✅ All tests pass (`pnpm test`)
4. ✅ Typecheck clean (`pnpm typecheck`)
5. ✅ Lint clean (`pnpm lint`)
6. ✅ QA report posted as PR comment
7. ✅ Label "Status: In Review/QA" added to issue #63 and PR #65