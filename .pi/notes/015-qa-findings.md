# QA Findings — Spec 015 (Full Cognitive Tools, PR #58)

## QA Date
2025-01-18

## PR
- **Number:** #58
- **Title:** feat: full cognitive tools — query_memory & update_internal_state as real tool calls
- **Branch:** `feature/015-full-cognitive-tools`
- **Issue:** #55
- **Spec:** `docs/specs/015-full-cognitive-tools.md` (42 acceptance criteria)

## Critical Finding — Merge Regression

The merge commit `ec648bc` ("resolve conflicts with main, include spec 016")
introduced regressions by overwriting spec 015 changes when resolving
conflicts in favor of spec 016 versions. **5 acceptance criteria were broken:**

| AC | File | Lost Change | Impact |
|----|------|-------------|--------|
| AC-29 | `plan-builder.ts` | `queryMemoryTool` + `updateInternalStateTool` removed from tools array | Plan phase no longer sends cognitive tools to LLM |
| AC-32 | `plan-service.ts` | `payload.agentId = agentId` removed | Tool call loop never activates in Plan phase |
| AC-35 | `minimal-scene.ts` | `CognitiveToolExecutorImpl` wiring, env var, data provider all removed | Example scene cannot use cognitive tools |
| AC-39 | `docs/specs/INDEX.md` | `#58` PR reference removed, status reverted to 📝 Drafted | INDEX.md out of sync with PR status |
| AC-40 | `spec-015-tool-call-loop.test.ts` | E2E test depends on AC-29 (PlanBuilderImpl tools) | Test fails because builder produces wrong tools |

### Root Cause
Spec 016 (PR #59, cognitive guardrails) modified the same files
(`plan-builder.ts`, `perception-builder.ts`, `plan-service.ts`, `minimal-scene.ts`,
`INDEX.md`). When the merge resolved conflicts, it kept the spec 016 versions
and silently dropped the spec 015 additions.

### Fix Applied
Commit `261aa9e` restores all lost spec 015 changes while preserving spec 016
additions:
- `plan-builder.ts`: Added `queryMemoryTool` and `updateInternalStateTool` to
  imports and tools array (alongside existing `GUARDRAIL_FORCING_DIRECTIVE`)
- `plan-service.ts`: Added `payload.agentId = agentId` after
  `planBuilder.build(perceptionResult, builderOptions)`
- `minimal-scene.ts`: Added `CognitiveToolExecutorImpl` import, `MemoryInjector`
  type, `CognitiveToolDataProvider` type, and full wiring block with
  `LLM_MAX_TOOL_CALL_ITERATIONS` env support
- `docs/specs/INDEX.md`: Updated spec 015 row to 🔍 In Review with `#58` PR
  reference; updated summary counts

## Test Coverage

### Spec 015 Test Files
| Test File | Package | ACs Covered | Tests |
|-----------|---------|-------------|-------|
| `spec-015-cognitive-tool-types.test.ts` | shared | AC-1..AC-8 | 14 |
| `spec-015-cognitive-tool-executor.test.ts` | cognition | AC-10..AC-16, AC-36, AC-42 | 15 |
| `spec-015-builders-services.test.ts` | cognition | AC-9, AC-29..AC-33 | 10 |
| `spec-015-tool-call-loop.test.ts` | cognition | AC-5, AC-17..AC-28, AC-37, AC-40..AC-42 | 21 |
| `spec-015-coverage.test.ts` | cognition | AC-19, AC-34, AC-35, AC-38, AC-39 | 18 |
| `spec-011-coverage.test.ts` (updated) | cognition | Workspace dep check | 1 modified |

### AC-to-Test Mapping (all 42 ACs covered)
- **AC-1**: CognitiveToolExecutor interface — `spec-015-cognitive-tool-types` (2 tests)
- **AC-2**: CognitiveToolDataProvider interface — `spec-015-cognitive-tool-types` (2 tests)
- **AC-3**: QueryMemoryToolResult type — `spec-015-cognitive-tool-types` (2 tests)
- **AC-4**: UpdateStateToolResult type — `spec-015-cognitive-tool-types` (1 test)
- **AC-5**: LLMContextPayload.agentId — `spec-015-tool-call-loop` (1 test)
- **AC-6**: queryMemorySchema with topK — `spec-015-cognitive-tool-types` (3 tests)
- **AC-7**: queryMemoryTool constant — `spec-015-cognitive-tool-types` (2 tests)
- **AC-8**: updateInternalStateTool constant — `spec-015-cognitive-tool-types` (2 tests)
- **AC-9**: defaultCognitiveTools argsSchema — `spec-015-builders-services` (2 tests)
- **AC-10**: CognitiveToolExecutorImpl export — `spec-015-cognitive-tool-executor` (2 tests)
- **AC-11**: executeQueryMemory with memoryInjector — `spec-015-cognitive-tool-executor` (1 test)
- **AC-12**: executeQueryMemory without memoryInjector — `spec-015-cognitive-tool-executor` (2 tests)
- **AC-13**: executeQueryMemory error catching — `spec-015-cognitive-tool-executor` (1 test)
- **AC-14**: executeUpdateInternalState with newGoal — `spec-015-cognitive-tool-executor` (1 test)
- **AC-15**: executeUpdateInternalState with driveOverrides — `spec-015-cognitive-tool-executor` (1 test + 3 edge cases)
- **AC-16**: executeUpdateInternalState without stateDataProvider — `spec-015-cognitive-tool-executor` (2 tests)
- **AC-17**: Config fields — `spec-015-tool-call-loop` (1 test)
- **AC-18**: ChatMessage type — `spec-015-tool-call-loop` (1 test)
- **AC-19**: COGNITIVE_TOOL_NAMES constant — `spec-015-coverage` (2 tests)
- **AC-20**: query_memory mid-loop execution — `spec-015-tool-call-loop` (2 tests)
- **AC-21**: update_internal_state mid-loop — `spec-015-tool-call-loop` (1 test)
- **AC-22**: Terminal tool after cognitive tool — `spec-015-tool-call-loop` (1 test)
- **AC-23**: Max iterations exceeded — `spec-015-tool-call-loop` (3 tests)
- **AC-24**: No executor → single request — `spec-015-tool-call-loop` (1 test)
- **AC-25**: No agentId → single request — `spec-015-tool-call-loop` (1 test)
- **AC-26**: tool_choice auto vs forced — `spec-015-tool-call-loop` (2 tests)
- **AC-27**: requestChat passes agentId — `spec-015-tool-call-loop` (2 tests)
- **AC-28**: Executor throws → error result — `spec-015-tool-call-loop` (1 test)
- **AC-29**: PlanBuilderImpl tools — `spec-015-builders-services` (2 tests)
- **AC-30**: PerceptionBuilderImpl tools — `spec-015-builders-services` (2 tests)
- **AC-31**: ReflectBuilderImpl tools — `spec-015-builders-services` (2 tests)
- **AC-32**: PlanServiceImpl sets agentId — `spec-015-builders-services` (1 test)
- **AC-33**: ReflectServiceImpl sets agentId — `spec-015-builders-services` (1 test)
- **AC-34**: MockLLMClient compatibility — `spec-015-coverage` (2 tests)
- **AC-35**: Minimal scene wiring — `spec-015-coverage` (6 tests)
- **AC-36**: CognitiveToolExecutorImpl imports — `spec-015-cognitive-tool-executor` (1 test)
- **AC-37**: OpenAICompatibleLLMClient imports — `spec-015-tool-call-loop` (1 test)
- **AC-38**: No engine/memory changes — `spec-015-coverage` (4 tests)
- **AC-39**: INDEX.md spec 015 entry — `spec-015-coverage` (4 tests)
- **AC-40**: End-to-end PlanBuilder → client loop — `spec-015-tool-call-loop` (1 test)
- **AC-41**: Direct terminal tool — `spec-015-tool-call-loop` (1 test)
- **AC-42**: topK passed through, default 5 — `spec-015-cognitive-tool-executor` (1 test) + `spec-015-tool-call-loop` (1 test)

### Test Results (after fix)
- **shared**: 12 files, 129 tests — all pass
- **memory**: 9 files, 73 tests (24 todo) — all pass
- **cognition**: 21 files, 408 tests (1 skipped, 26 todo) — all pass
- **engine**: 27 files, 289 tests — all pass
- **Total**: 69 files, 899 tests — all pass
- **typecheck**: clean
- **lint**: clean

## Missing Tests
No missing tests identified. All 42 acceptance criteria have dedicated test
coverage across 5 spec-015 test files (78 spec-015-specific tests).

## Recommendation
✅ **Approved for merge** — after the merge regression fix (commit `261aa9e`).
Recommend squashing the fix commit into the PR to avoid the regression in
merge history.