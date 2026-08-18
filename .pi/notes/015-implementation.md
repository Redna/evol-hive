# Implementation Notes — Feature 015: Full Cognitive Tool Execution (Issue #55)

## Summary
Implemented spec 015 — `query_memory` and `update_internal_state` are now **executed** mid-loop
during the LLM tool call loop, instead of being parsed as structured output only. A multi-turn
tool call loop was added to `OpenAICompatibleLLMClient` that runs when a `CognitiveToolExecutor`
is wired and `agentId` is present on the payload.

## Files changed

### shared (`@evol-hive/shared`)
- `src/types/cognition.ts` — Added `CognitiveToolExecutor`, `CognitiveToolDataProvider`,
  `QueryMemoryToolResult`, `UpdateStateToolResult` interfaces.
- `src/schemas/llm-schemas.ts` — Extended `queryMemorySchema` with optional `topK`
  (integer, 1–20). Added `queryMemoryTool` and `updateInternalStateTool` `ToolDefinition`
  constants.

### cognition (`@evol-hive/cognition`)
- `src/index.ts` — Added optional `agentId?: string` to `LLMContextPayload` (non-breaking).
- `src/tools/cognitive-tool-executor.ts` (NEW) — `CognitiveToolExecutorImpl` concrete
  implementation. Error-resilient: `executeQueryMemory` returns `{ memories: [] }` when no
  injector or on `activeRecall` failure; `executeUpdateInternalState` reports partial success.
- `src/tools/index.ts` — Exported `CognitiveToolExecutorImpl`; updated `defaultCognitiveTools`
  `query_memory` `argsSchema` to include `topK`.
- `src/llm/openai-client.ts` — Added `cognitiveToolExecutor?` and `maxToolCallIterations?`
  config fields. Extended internal `ChatMessage` type (assistant `tool_calls` + `tool` result
  messages). Added `COGNITIVE_TOOL_NAMES` constant. Refactored `sendRequest` to return raw
  tool-call details (`toolCallId`, `toolName`, `argsStr`); `requestChat` now accepts `agentId?`
  and runs the multi-turn loop. Public methods pass `payload.agentId`. The loop: terminal tool
  → parse & return; cognitive tool → execute via executor → append assistant + tool result
  messages → increment counter → `>= max` throws `LLMError("…max iterations…")`. Executor
  errors are caught and sent back as `{ error }` tool results (loop continues).
- `src/pper/plan-builder.ts` — `tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool]`.
- `src/pper/perception-builder.ts` — Non-masked path uses
  `[chooseActionTool, queryMemoryTool, updateInternalStateTool]` (dedicated constants).
- `src/pper/reflect-builder.ts` — `tools: [reflectTool, queryMemoryTool, updateInternalStateTool]`
  (renamed local `updateInternalStateTool` var to `updateStateToolList` to avoid collision with
  the imported constant).
- `src/pper/plan-service.ts` — Sets `payload.agentId = agentId` before `completePlan`.
- `src/pper/reflect-service.ts` — Sets `payload.agentId = agentId` before `completeReflect`.
- `package.json` — Added `@evol-hive/memory` workspace dependency (required by
  `CognitiveToolExecutorImpl` for the `MemoryInjector` type; per spec 015 AC-36).

### examples
- `examples/minimal-scene.ts` — Imports `CognitiveToolExecutorImpl`; when `USE_REAL_LLM=true`,
  wires it with `core.bridges.reflect` as the state data provider and passes
  `cognitiveToolExecutor` + optional `LLM_MAX_TOOL_CALL_ITERATIONS` to the client. `MockLLMClient`
  unchanged (accepts the new optional `agentId` field via the payload type — AC-34).

### tests
- `packages/shared/tests/spec-015-cognitive-tool-types.test.ts` (NEW) — AC-1 to AC-8.
- `packages/cognition/tests/spec-015-cognitive-tools.test.ts` (NEW) — AC-5, AC-9 to AC-42
  (executor, tool call loop, builders, service agentId wiring, package boundaries, end-to-end).
- `packages/cognition/tests/spec-011-coverage.test.ts` — Updated the package-boundaries test to
  allow `@evol-hive/memory` as a cognition workspace dependency (spec 015 supersedes the
  spec 011 "shared-only" constraint for this dependency).

### docs
- `docs/specs/INDEX.md` — Spec 015 status → 🔍 In Review; updated counts and §8 coverage line.

## Key decisions / deviations
- **Loop iteration semantics**: Per spec Req 15 step 4e, the counter is incremented *after*
  execution and the check is `iterationCount >= max`. With default 3, this allows 3 cognitive
  executions and throws on the 3rd (3 HTTP requests for an all-cognitive loop). Matches the spec
  literally.
- **No engine/memory changes** (AC-38 verified via git diff — empty for both packages).
- `OpenAICompatibleLLMClient` imports `CognitiveToolExecutor` from `shared` only (AC-37); it
  does not import from `@evol-hive/memory` or `@evol-hive/engine`.

## Verification
- `pnpm test` — all packages pass (shared 135, cognition 387+1 skipped, engine 289, memory).
- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm format:check` — clean.
- `pnpm build` — all packages build.

## Branch / PR
- Branch: `feature/015-full-cognitive-tools`
- Spec: `docs/specs/015-full-cognitive-tools.md`
- Issue: #55