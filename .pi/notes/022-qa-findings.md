# QA Findings — Spec 022: Scene Authoring (Declarative)

**PR:** [#92](https://github.com/Redna/evol-hive/pull/92)
**Issue:** [#90](https://github.com/Redna/evol-hive/issues/90)
**Branch:** `spec/022-scene-authoring-issue-90`
**Date:** 2026-08-26
**QA Status:** ✅ PASS

## Summary

Spec-only PR introducing `docs/specs/022-scene-authoring-declarative.md` — 19 requirements, 19 acceptance criteria defining declarative scene authoring tools: YAML/JSON scene format, JSON Schema validation, scene loader with auto-registration, plugin system for custom handlers, doorway auto-generation, and CLI commands (create-scene, validate-scene, run-scene).

## Coverage Test Files Added

### `packages/engine/tests/spec-022-coverage.test.ts`
- **46 test cases** total (27 active, 19 `it.todo` scaffolds)
- **8 document structure tests**: file existence, title, requirement count (19), AC count (19), architecture section references (§2, §3, §4), issue reference (#90), package list (shared, engine, CLI), ADR-0001 reference in design-decisions.md
- **3 INDEX.md validation tests**: spec 022 row, issue #90 reference, total spec count (≥23)
- **9 existing scaffolding verification tests**: confirmed presence of `SceneDefinition`, `Room`, `SmartObject`, `Affordance`, `AffordanceCondition`, `AgentProfile`, `loadScene`, `EngineCore`/`createEngineCore`, `AffordanceRegistry`
- **5 backward compatibility tests**: confirmed `coffee-shop.ts`, `minimal-scene.ts`, `morning-routine.ts`, `office-day.ts`, and `scene-helpers.ts` all exist with expected exports
- **2 workspace file tests**: confirmed `workspace.json` and `design-decisions.md` exist with correct content
- **19 AC scaffolds** (AC-1 through AC-19): pending activation when implementation PR lands

## INDEX.md Updates
- Added spec 022 row with status 📝 Drafted, issue #90, PR #92
- Updated architecture coverage for §2, §3, §4 to include spec 022
- Updated total spec count from 22 to 23
- Updated drafted count from 0 to 1

## Acceptance Criteria Mapping

### Verified by Active Tests (3 ACs)
- **AC-17**: All existing tests pass (880 tests, 0 failures) — ✅ Verified
- **AC-18**: All 4 example TS scenes remain unmodified and present — ✅ Verified
- **AC-19**: SceneDefinition interface unchanged (all fields confirmed) — ✅ Verified

### Scaffolded as it.todo (16 ACs, pending implementation)
- AC-1 through AC-16: All scaffolded with descriptive test names matching spec wording
- These will be converted to active tests when the implementation PR lands

## Test Results
```
pnpm test       → 880 passed, 165 todo, 1 skipped (0 failed)
pnpm typecheck  → All 5 packages pass
pnpm lint       → Clean (0 errors)
```

## Notes
- The spec references `affordanceRegistry.hasHandler(effectId)` in AC-9, but the existing `AffordanceRegistry` interface has `getHandler(id)` (returns `null` if not registered). The implementation PR should use `getHandler(id) !== null` or add a `hasHandler` convenience method.
- The design decisions document (`.pi/tasks/feature-022-scene-authoring/design-decisions.md`) contains 10 well-documented decisions covering YAML format choice, no-change constraint, plugin pattern, handler refactoring, doorway auto-generation, CLI package structure, dependencies (js-yaml + ajv), error reporting, env-var pattern, and create-scene wizard scope.
- YAAM search was unavailable (`yaam_search` is not a callable binary in this environment). Notes recorded in `.pi/notes/022-qa-findings.md` following the established pattern.