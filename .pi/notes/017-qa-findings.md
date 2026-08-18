# QA Findings — Spec 017: Persistence (Save/Load Game State)

**PR:** [#64](https://github.com/Redna/evol-hive/pull/64)
**Issue:** [#61](https://github.com/Redna/evol-hive/issues/61)
**Branch:** `spec/017-persistence-save-load`
**Date:** 2025-01-22
**QA Status:** ✅ PASS

## Summary

Spec-only PR introducing `docs/specs/017-persistence-save-load-game-state.md` — 29 requirements, 55 acceptance criteria defining the persistence/save-load feature for the evol-hive engine.

## Coverage Test Files Added

### `packages/engine/tests/spec-017-coverage.test.ts`
- **71 test cases** total (16 active, 55 `it.todo` scaffolds)
- **8 document structure tests**: file existence, title, requirement count (29), AC count (55), architecture section references (§2, §3, §6, §11), issue reference (#61), package list, no cognition dependency
- **3 INDEX.md validation tests**: spec 017 row, architecture coverage, total spec count (18)
- **5 existing scaffolding verification tests**: confirmed presence of `AgentProfile`, `AgentInternalState`, `AgentDrives`, `AgentPlan`, `Room`, `SmartObject`, `MemoryNode`, `VectorStore` interface, `InMemoryVectorStore` class
- **55 AC scaffolds** (AC-1 through AC-55): pending activation when implementation PR lands

## Other Changes

- **`docs/specs/INDEX.md`**: Added spec 017 row, updated architecture coverage for §2/§3/§6/§11, updated total specs 17→18, drafted 2→3
- **`packages/cognition/tests/spec-016-coverage.test.ts`**: Updated hardcoded INDEX.md total specs assertion from 17→18

## Test Results

| Command | Result |
|---------|--------|
| `pnpm test` | ✅ All pass (900+ tests across 4 packages) |
| `pnpm typecheck` | ✅ All pass |
| `pnpm lint` | ✅ All pass |

## AC Coverage Map

| AC Range | Layer | Count | Status |
|----------|-------|-------|--------|
| AC-1 – AC-8 | Shared (types) | 8 | Scaffolded |
| AC-9 – AC-12 | Memory (VectorStore) | 4 | Scaffolded |
| AC-13 – AC-22 | Engine (EnginePersistenceImpl) | 10 | Scaffolded |
| AC-23 – AC-24 | Engine (string/file I/O) | 2 | Scaffolded |
| AC-25 – AC-28 | Engine (subsystem methods) | 4 | Scaffolded |
| AC-29 – AC-33 | Engine (AutoSaveSystem) | 5 | Scaffolded |
| AC-34 – AC-37 | Engine (assembly) | 4 | Scaffolded |
| AC-38 – AC-45 | Round-trip preservation | 8 | Scaffolded |
| AC-46 – AC-47 | Edge cases | 2 | Scaffolded |
| AC-48 – AC-49 | Package boundaries | 2 | Scaffolded |
| AC-50 – AC-54 | Serialization & errors | 5 | Scaffolded |
| AC-55 | Integration | 1 | Scaffolded |

## Key Design Decisions Noted

1. Full snapshot (not incremental) — simpler, sufficient for prototype scale
2. Embeddings preserved as-is (not re-embedded) — prevents retrieval inconsistency
3. `isThinking` cleared on load — lost LLM calls cannot be resumed
4. AffordanceHandler functions not serialized — re-registered at startup
5. Save format versioned from day one (`SAVE_FORMAT_VERSION = 1`)
6. Auto-save is fire-and-forget — never blocks the game loop
7. `load()` is destructive — clears all existing state before restoring

## Notes for Implementation PR

- The 55 `it.todo()` scaffolds in `spec-017-coverage.test.ts` must be converted to active `it()` tests with real assertions
- Integration tests should be split across packages (shared types, memory VectorStore, engine EnginePersistenceImpl)
- AC-55 (full simulation round-trip) should be an E2E integration test
- Package boundary tests (AC-48, AC-49) can be implemented as static import analysis