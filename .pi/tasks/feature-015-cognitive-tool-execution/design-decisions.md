# Design Decisions — Feature 015: Full Cognitive Tools

## Decision 1: Tool call loop lives in the LLM client, not the PPER services
**Why**: The tool call loop is fundamentally an HTTP-level concern — it involves multiple Chat Completions API requests with growing message arrays. Encapsulating it in `OpenAICompatibleLLMClient.sendRequest` keeps the PPER services unchanged in their call pattern (they still call `completePlan`, `completeReflect`, `completeStructured` and get back the final result). The loop is transparent to callers.

**Alternative considered**: Implement the loop in each PPER service. Rejected — it would duplicate loop logic across 3 services and require them to manage conversation history, tool result messages, and retry logic. The services should remain thin orchestrators.

## Decision 2: CognitiveToolExecutor as a bridge interface in shared
**Why**: The executor needs to call `MemoryInjector.activeRecall` (from `@evol-hive/memory`) for `query_memory` and data provider methods (`updateGoal`, `applyDriveChanges`) for `update_internal_state`. Per ADR-0001, `cognition` can import from `shared` and `memory`, but the data provider implementation lives in `engine`. A bridge interface in `shared` follows the existing pattern (`PlanDataProvider`, `ReflectDataProvider`, etc.) and keeps package boundaries clean.

**Alternative considered**: Put the executor in `engine`. Rejected — the tool call loop is in `cognition` (the LLM client), and importing from `engine` would violate ADR-0001 (`cognition` cannot import from `engine`). The bridge pattern avoids this.

## Decision 3: agentId added to LLMContextPayload (optional field)
**Why**: The `CognitiveToolExecutor` needs to know which agent's memory to query and which agent's state to update. The `OpenAICompatibleLLMClient` is constructed once and shared across agents, so agentId cannot be in the client config. Adding it as an optional field on `LLMContextPayload` is non-breaking — the PPER services set it after the builder creates the payload.

**Alternative considered**: Add `agentId` as a parameter to `LLMClient` methods. Rejected — spec 011 explicitly says "Do not modify the `LLMClient` interface method signatures." Adding an optional field to `LLMContextPayload` doesn't change method signatures.

## Decision 4: Only query_memory and update_internal_state are executed mid-loop
**Why**: `formulate_plan`, `choose_action`, and `reflect` are "primary tools" — their arguments ARE the phase result. The loop terminates when a primary tool is called. `query_memory` and `update_internal_state` are "cognitive tools" — they are executed mid-loop, their results are sent back to the LLM, and the loop continues. This distinction is clean and matches the architecture (§8: cognitive tools are internal affordances the agent uses before acting).

**Alternative considered**: Execute `formulate_plan` mid-loop in the Perception/Execute phase. Rejected — `formulate_plan` returns a plan that needs to be stored and executed by the Execute service. Handling this mid-loop would require the executor to access `PlanDataProvider.storePlan`, coupling it to the Plan phase. The Plan phase already handles plan formulation; the Execute phase should follow the existing plan.

## Decision 5: Max 3 iterations, configurable
**Why**: The LLM should be able to call `query_memory` and `update_internal_state` a reasonable number of times before calling the primary tool. 3 iterations is enough for: query_memory → (maybe update_internal_state) → formulate_plan. A configurable max prevents infinite loops while allowing flexibility.

**Alternative considered**: No limit. Rejected — an LLM stuck in a loop would consume tokens indefinitely. The max iteration is a safety valve.

## Decision 6: Cognitive tool execution errors are sent back to the LLM as tool results
**Why**: If `query_memory` fails (e.g., no memory subsystem wired), sending an error message as the tool result lets the LLM adjust its approach (e.g., proceed without memories). This is more resilient than propagating the error, which would fail the entire PPER cycle. If the LLM keeps failing, the max iteration limit catches it.

**Alternative considered**: Propagate errors to the PPER service. Rejected — a memory query failure shouldn't abort the entire Plan phase. The LLM can plan without memories.

## Decision 7: Backward compatible — no executor means no loop
**Why**: If `cognitiveToolExecutor` is not set in the client config (or `agentId` is not in the payload), the client falls back to the current behavior: single request, single tool call, return parsed arguments. This ensures existing tests and minimal scenes work without changes.

## Decision 8: Tool definitions for cognitive tools use dedicated constants
**Why**: `queryMemoryTool` and `updateInternalStateTool` are defined as dedicated `ToolDefinition` constants in `packages/shared/src/schemas/llm-schemas.ts`, matching the pattern of `formulatePlanTool`, `chooseActionTool`, etc. This is cleaner than using `cognitiveToolsToToolDefinitions` for these two tools, because the dedicated constants can reference the updated `queryMemorySchema` (with `topK`) and `updateInternalStateSchema` directly.

## Decision 9: query_memory argsSchema updated to include topK
**Why**: The issue specifies `query_memory` parameters as `{ query: string, topK: number }`. The current `queryMemorySchema` only has `query`. Adding `topK` (optional, default 5) lets the LLM control how many memories to retrieve. The `CognitiveToolExecutor.executeQueryMemory` uses `topK` from the arguments.

## Decision 10: Plan and Reflect builders include cognitive tools alongside primary tools
**Why**: The issue requires all three cognitive tools to be available as tool definitions. The Plan builder currently sends only `[formulatePlanTool]`; it should also send `[queryMemoryTool, updateInternalStateTool]` so the LLM can query memories and adjust state before planning. The Reflect builder currently sends only `[reflectTool]`; it should also send `[queryMemoryTool, updateInternalStateTool]`. The Perception builder already sends cognitive tools alongside `chooseActionTool` (excluding `formulate_plan`).

## Decision 11: tool_choice is 'auto' when cognitive tools are present
**Why**: When multiple tools are sent (primary + cognitive), `tool_choice` must be `'auto'` so the LLM can choose which tool to call. The current behavior of forcing a single tool (`tool_choice: { type: 'function', function: { name: ... } }`) only applies when there's exactly one tool. With cognitive tools added, the Plan and Reflect phases will have 3 tools, so `tool_choice` is `'auto'`.
