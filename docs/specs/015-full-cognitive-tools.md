# Feature: Full Cognitive Tools — query_memory and update_internal_state as Real Tool Calls (§8)

## Context
- Architecture: [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (intrinsic tools as native tool definitions, query_memory active recall, update_internal_state self-regulation), [§6 — PPER Loop](../architecture/06-pper-loop.md) (System 2 LLM calls within phases), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (Track 2 active recall, weighted retrieval)
- Related specs: [011 — Structured Output to Tool Calling](011-structured-output-to-tool-calling.md) (tool calling infrastructure, `ToolDefinition`, `LLMContextPayload.tools`), [014 — Memory Consolidation](014-memory-consolidation-decay-retrieval.md) (`MemoryInjector.activeRecall`, `RetrievalEngineImpl`, weighted retrieval scoring), [004 — Reflect Phase](004-reflect-phase.md) (`ReflectDataProvider.updateGoal`, `applyDriveChanges`), [002 — Plan Phase](002-plan-phase.md) (`PlanBuilderImpl`, `PlanServiceImpl`)
- Package: `shared` (new bridge interfaces, tool definition constants, schema updates), `cognition` (tool call loop, `CognitiveToolExecutorImpl`, builder updates, service updates), `memory` (no changes — existing `MemoryInjector.activeRecall` reused), `engine` (no changes — existing data provider methods reused)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#55](https://github.com/Redna/evol-hive/issues/55)

## Design Rationale

Spec 011 introduced tool calling — the LLM returns `tool_calls[0].function.arguments` which the engine parses as structured data. However, spec 011 explicitly stated "Do not implement tool execution" and "Do not add a tool call loop." The LLM "calling" a tool was just a structured output mechanism; the engine interpreted the arguments without executing the tool.

This spec takes the next step: **cognitive tools are now actually executed.** When the LLM calls `query_memory`, the engine embeds the query, searches the memory store via weighted retrieval (spec 014's `MemoryInjector.activeRecall`), and returns the top-K memory snippets as a tool result. When the LLM calls `update_internal_state`, the engine updates the agent's goal and drives via the data provider and returns a confirmation. The LLM receives these results and can then call the primary tool (`formulate_plan`, `choose_action`, or `reflect`) with the memory/state context in its conversation history.

This requires a **multi-turn tool call loop** within each LLM phase: send tools → LLM calls a cognitive tool → engine executes it → send result back → LLM calls the next tool (or the primary tool) → loop terminates. The loop has a max iteration count (default 3) to prevent infinite loops.

The key insight is that `query_memory` and `update_internal_state` are **mid-loop tools** — their results are fed back to the LLM. `formulate_plan`, `choose_action`, and `reflect` are **terminal tools** — their arguments are the phase result, and the loop terminates when they are called.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`CognitiveToolExecutor` interface** — A new bridge interface must be defined in `packages/shared/src/types/cognition.ts` that the cognition layer calls to execute cognitive tools mid-loop. The engine (or application entry point) provides a concrete implementation:
   ```typescript
   interface CognitiveToolExecutor {
     /** Execute query_memory: embed the query, search the memory store, return top-K snippets. */
     executeQueryMemory(agentId: string, query: string, topK: number): Promise<QueryMemoryToolResult>;
     /** Execute update_internal_state: update goal and/or drives, return confirmation. */
     executeUpdateInternalState(
       agentId: string,
       newGoal?: string,
       driveOverrides?: Partial<Record<string, number>>,
     ): Promise<UpdateStateToolResult>;
   }
   ```
   This interface is defined in `shared` because both `cognition` (consumer — the LLM client calls it) and the application entry point (provider — wires the implementation) need to reference it. Per ADR-0001, `cognition` can import from `shared`.

2. **`CognitiveToolDataProvider` interface** — A new bridge interface must be defined in `packages/shared/src/types/cognition.ts` for the state update operations needed by `update_internal_state`:
   ```typescript
   interface CognitiveToolDataProvider {
     /** Update the agent's current goal. */
     updateGoal(agentId: string, goal: string): void;
     /** Apply drive changes (clamped to 0–100 by the DriveSystem). */
     applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void;
   }
   ```
   This is a focused subset of `ReflectDataProvider` (which already has both methods). The engine can implement this interface on the same object that implements `ReflectDataProvider`, or a separate adapter. This interface exists so `CognitiveToolExecutorImpl` (in cognition) does not need to depend on `ReflectDataProvider` (which carries memory storage and plan clearing methods unrelated to cognitive tool execution).

3. **`QueryMemoryToolResult` type** — A new type must be defined in `packages/shared/src/types/cognition.ts` for the result of `query_memory` execution:
   ```typescript
   interface QueryMemoryToolResult {
     memories: MemorySnippet[];
   }
   ```
   This reuses the existing `QueryMemoryResult` interface name pattern. The `memories` field contains `MemorySnippet[]` from `MemoryInjector.activeRecall`. If no memories are found, `memories` is an empty array. If no memory subsystem is wired, `memories` is an empty array (not an error).

4. **`UpdateStateToolResult` type** — A new type must be defined in `packages/shared/src/types/cognition.ts` for the confirmation result of `update_internal_state`:
   ```typescript
   interface UpdateStateToolResult {
     success: boolean;
     goalUpdated: boolean;
     drivesUpdated: boolean;
     message: string;
   }
   ```
   The `success` field is `true` when the update was applied (even partially). `goalUpdated` is `true` only if `newGoal` was provided and applied. `drivesUpdated` is `true` only if `driveOverrides` was provided and applied. `message` is a human-readable confirmation (e.g., `"Goal updated to: find coffee. Drives updated: energy=45."`) that is sent back to the LLM as the tool result content.

5. **`LLMContextPayload.agentId` field** — The `LLMContextPayload` interface in `packages/cognition/src/index.ts` must be extended with a new optional field `agentId?: string`. The PPER services set this field after the builder creates the payload. The `OpenAICompatibleLLMClient` reads it to pass `agentId` to the `CognitiveToolExecutor` during the tool call loop. When `agentId` is absent (e.g., in tests), the tool call loop is not activated — the client falls back to single-request behavior. This is a non-breaking, additive change.

6. **`queryMemorySchema` updated with `topK`** — The existing `queryMemorySchema` in `packages/shared/src/schemas/llm-schemas.ts` must be extended to include an optional `topK` property:
   ```typescript
   export const queryMemorySchema = {
     type: 'object',
     properties: {
       query: { type: 'string', description: 'The search query for active recall.' },
       topK: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum number of memories to retrieve (default: 5).' },
     },
     required: ['query'],
     additionalProperties: false,
   } as const;
   ```
   The `topK` field is optional (not in `required`). When the LLM omits it, the `CognitiveToolExecutor` defaults to `topK = 5`.

7. **`queryMemoryTool` and `updateInternalStateTool` constants** — Two new tool definition constants must be exported from `packages/shared/src/schemas/llm-schemas.ts`:
   - `queryMemoryTool` — `{ type: 'function', function: { name: 'query_memory', description: 'Actively recall relevant memories for the current situation.', parameters: queryMemorySchema } }`
   - `updateInternalStateTool` — `{ type: 'function', function: { name: 'update_internal_state', description: 'Update the agent goal or drive overrides.', parameters: updateInternalStateSchema } }`
   These follow the same pattern as `formulatePlanTool`, `chooseActionTool`, `reflectTool`, and `memoryConsolidationTool`. They reuse the existing `queryMemorySchema` (updated in Req 6) and `updateInternalStateSchema` (already defined, no changes needed).

8. **Update `defaultCognitiveTools` argsSchema for `query_memory`** — The `defaultCognitiveTools` array in `packages/cognition/src/tools/index.ts` must update the `query_memory` entry's `argsSchema` to match the updated `queryMemorySchema` (include `topK`). The `argsSchema` must include `topK: { type: 'integer', minimum: 1, maximum: 20, description: '...' }` in `properties`. This keeps the `CognitiveTool` metadata in sync with the `ToolDefinition` constant.

### Cognition Layer — Cognitive Tool Executor (`@evol-hive/cognition`)

9. **`CognitiveToolExecutorImpl` concrete implementation** — A concrete `CognitiveToolExecutorImpl` class must be implemented in `packages/cognition/src/tools/cognitive-tool-executor.ts`, exported from `packages/cognition/src/tools/index.ts` and `packages/cognition/src/index.ts`. It accepts `CognitiveToolExecutorOptions` via constructor injection:
   ```typescript
   interface CognitiveToolExecutorOptions {
     memoryInjector?: MemoryInjector;
     stateDataProvider?: CognitiveToolDataProvider;
   }
   ```
   Both dependencies are optional — if `memoryInjector` is not provided, `executeQueryMemory` returns `{ memories: [] }`. If `stateDataProvider` is not provided, `executeUpdateInternalState` returns `{ success: false, goalUpdated: false, drivesUpdated: false, message: 'State update not available.' }`.

10. **`executeQueryMemory` method** — The `executeQueryMemory(agentId, query, topK)` method must:
    - If `memoryInjector` is not set, return `{ memories: [] }` immediately (no error).
    - Call `memoryInjector.activeRecall(agentId, query, topK)` → `MemorySnippet[]`.
    - Return `{ memories: snippets }`.
    - If `activeRecall` throws, catch the error and return `{ memories: [] }` (log the error but do not propagate — a memory query failure should not abort the LLM interaction).

11. **`executeUpdateInternalState` method** — The `executeUpdateInternalState(agentId, newGoal?, driveOverrides?)` method must:
    - If `stateDataProvider` is not set, return `{ success: false, goalUpdated: false, drivesUpdated: false, message: 'State update not available.' }`.
    - If `newGoal` is provided (non-empty string), call `stateDataProvider.updateGoal(agentId, newGoal)`. Set `goalUpdated = true`.
    - If `driveOverrides` is provided (non-empty object), call `stateDataProvider.applyDriveChanges(agentId, driveOverrides)`. Set `drivesUpdated = true`. Drive values are clamped to 0–100 by the data provider's `applyDriveChanges` implementation (existing behavior).
    - Construct a human-readable `message` summarizing what was updated (e.g., `"Goal updated to: X."` and/or `"Drives updated: key=value, ..."`.
    - Return `{ success: true, goalUpdated, drivesUpdated, message }`.
    - If either `updateGoal` or `applyDriveChanges` throws, catch the error and return `{ success: false, goalUpdated, drivesUpdated, message: 'State update failed: <error message>.' }` (partial success is reported — if goal was updated but drives failed, `goalUpdated` is `true` and `drivesUpdated` is `false`).

### Cognition Layer — LLM Client Tool Call Loop (`@evol-hive/cognition`)

12. **`OpenAICompatibleLLMClientConfig` new fields** — The `OpenAICompatibleLLMClientConfig` interface must be extended with two new optional fields:
    - `cognitiveToolExecutor?: CognitiveToolExecutor` — when set, the client uses it to execute cognitive tools mid-loop. When absent, the client falls back to single-request behavior (no loop).
    - `maxToolCallIterations?: number` — maximum number of tool call iterations in the loop (default: 3). Must be ≥ 1. If set to 0 or negative, defaults to 3.
    Both fields are optional — existing constructors without them work unchanged.

13. **Extended `ChatMessage` type** — The internal `ChatMessage` type in `openai-client.ts` must be extended to support assistant messages with tool calls and tool result messages:
    ```typescript
    type ChatMessage =
      | { role: 'system' | 'user'; content: string }
      | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
      | { role: 'tool'; content: string; tool_call_id: string };
    ```
    The existing `buildPayloadMessages` and `buildReflectionUserMessage` methods continue to produce `system` and `user` messages only. The new message types are only constructed internally by the tool call loop.

14. **`COGNITIVE_TOOL_NAMES` constant** — A private constant `COGNITIVE_TOOL_NAMES` must be defined in `openai-client.ts` as `new Set<string>(['query_memory', 'update_internal_state'])`. This is the set of tool names that are executed mid-loop via the `CognitiveToolExecutor`. When the LLM calls a tool whose name is in this set, the client executes it and continues the loop. When the LLM calls a tool NOT in this set, the loop terminates and the tool's arguments are returned as the result.

15. **Tool call loop in `sendRequest`** — The `sendRequest` method must be modified to implement the multi-turn tool call loop when `cognitiveToolExecutor` is set and `agentId` is available. The loop logic:
    1. Send the initial request with `messages` and `tools` (same as current behavior).
    2. Parse the response: extract `choices[0].message.tool_calls[0]` (including `id`, `function.name`, `function.arguments`).
    3. If the called tool's name is NOT in `COGNITIVE_TOOL_NAMES`, this is a terminal tool — parse `function.arguments` and return the parsed object (same as current behavior).
    4. If the called tool's name IS in `COGNITIVE_TOOL_NAMES`:
       a. Parse `function.arguments` as JSON.
       b. Execute the tool via `cognitiveToolExecutor`:
          - `query_memory`: call `executeQueryMemory(agentId, args.query, args.topK ?? 5)`.
          - `update_internal_state`: call `executeUpdateInternalState(agentId, args.newGoal, args.driveOverrides)`.
       c. Construct a tool result message: `{ role: 'tool', content: JSON.stringify(result), tool_call_id: toolCallId }`.
       d. Append the assistant message (with `tool_calls`) and the tool result message to the `messages` array.
       e. Increment the iteration counter. If `iterationCount >= maxToolCallIterations`, throw `LLMError` with message `"Tool call loop exceeded max iterations (N). Last tool: <toolName>."`.
       f. Send another request with the updated `messages` and the same `tools`.
       g. Go to step 2.
    5. If `cognitiveToolExecutor` is NOT set or `agentId` is NOT available, skip the loop — behave exactly as the current implementation (single request, parse `tool_calls[0].function.arguments`, return).
    The `tool_choice` parameter must be set to `'auto'` when `tools.length > 1` (multiple tools including cognitive tools). When `tools.length === 1`, `tool_choice` forces the single tool (existing behavior, no cognitive tools present).

16. **`requestChat` passes `agentId`** — The private `requestChat` method must accept an optional `agentId?: string` parameter and pass it to `sendRequest`. The public methods (`completeStructured`, `completePlan`, `completeReflect`) extract `agentId` from `payload.agentId` and pass it to `requestChat`. The `completeReflection` method does not pass `agentId` (memory consolidation does not use cognitive tools).

17. **Cognitive tool execution error handling** — When the `CognitiveToolExecutor` throws during tool execution (step 4b above), the error must be caught and a tool result message with the error text must be constructed: `{ role: 'tool', content: JSON.stringify({ error: '<message>' }), tool_call_id: toolCallId }`. This error result is sent back to the LLM so it can adjust its approach. The loop continues — the LLM may call a different tool or the primary tool on the next iteration. The `CognitiveToolExecutorImpl` methods (Req 10, Req 11) already catch errors internally and return error results, so this is a secondary safety net.

### Cognition Layer — Builder Updates (`@evol-hive/cognition`)

18. **`PlanBuilderImpl` includes cognitive tools** — The `PlanBuilderImpl.build()` method must include `queryMemoryTool` and `updateInternalStateTool` alongside `formulatePlanTool` in the `tools` array:
    ```typescript
    tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool]
    ```
    This enables the LLM to call `query_memory` to recall relevant memories before formulating a plan, and `update_internal_state` to adjust its goal before planning. The `cognitiveTools` field in the payload remains `defaultCognitiveTools` (all three, for prompt text). The system prompt is unchanged — it still instructs the LLM to use `formulate_plan`. The LLM discovers `query_memory` and `update_internal_state` via the tool definitions.

19. **`PerceptionBuilderImpl` includes all cognitive tools** — The `PerceptionBuilderImpl.build()` method already includes cognitive tools (excluding `formulate_plan`) alongside `chooseActionTool`. This must be updated to use the dedicated `queryMemoryTool` and `updateInternalStateTool` constants instead of `cognitiveToolsToToolDefinitions`:
    ```typescript
    tools: [chooseActionTool, queryMemoryTool, updateInternalStateTool]
    ```
    The `cognitiveTools` field remains `defaultCognitiveTools` (for prompt text). The existing filtering logic (`defaultCognitiveTools.filter(t => t.name !== 'formulate_plan')`) is replaced with explicit constant references. This does not change the set of tools sent — it changes how they're constructed (dedicated constants vs. converted from `CognitiveTool[]`).

20. **`ReflectBuilderImpl` includes cognitive tools** — The `ReflectBuilderImpl.build()` method must include `queryMemoryTool` and `updateInternalStateTool` alongside `reflectTool` in the `tools` array:
    ```typescript
    tools: [reflectTool, queryMemoryTool, updateInternalStateTool]
    ```
    This enables the LLM to call `query_memory` to recall relevant memories before reflecting, and `update_internal_state` to adjust state mid-reflection. The `cognitiveTools` field in the payload remains the filtered `update_internal_state`-only list (for prompt text). The system prompt is unchanged.

### Cognition Layer — PPER Service Updates (`@evol-hive/cognition`)

21. **`PlanServiceImpl` sets `agentId` on payload** — The `PlanServiceImpl.plan()` method must set `payload.agentId = agentId` after the builder creates the payload and before calling `llmClient.completePlan(payload)`. This is a one-line addition:
    ```typescript
    const payload = planBuilder.build(perceptionResult);
    payload.agentId = agentId;
    const result = await llmClient.completePlan(payload);
    ```
    No other changes to `PlanServiceImpl` — the tool call loop is transparent to the service.

22. **`ReflectServiceImpl` sets `agentId` on payload** — The `ReflectServiceImpl.reflect()` method must set `payload.agentId = agentId` after the builder creates the payload and before calling `llmClient.completeReflect(payload)`:
    ```typescript
    const payload = reflectBuilder.build(agentId, agentState, executeResult, profile);
    payload.agentId = agentId;
    const response = await llmClient.completeReflect(payload);
    ```
    No other changes to `ReflectServiceImpl`.

### Engine Layer — No Changes Required

23. **Engine data providers already implement required methods** — The engine's existing `ReflectDataProvider` implementation already has `updateGoal(agentId, goal)` and `applyDriveChanges(agentId, changes)`. The application entry point can pass the same object (or a subset adapter) as the `CognitiveToolDataProvider` to `CognitiveToolExecutorImpl`. No new engine code is needed. The `MemoryInjectorImpl` (spec 014) already implements `activeRecall(agentId, query, topK)` and is wired at the application entry point.

### Application Entry Point / Assembly

24. **Wiring the `CognitiveToolExecutor`** — The application entry point (e.g., `examples/minimal-scene.ts` or the engine assembly function) must construct `CognitiveToolExecutorImpl` with the wired `MemoryInjector` and `CognitiveToolDataProvider`, and pass it to `OpenAICompatibleLLMClient` via the `cognitiveToolExecutor` config field. When memory subsystems are not wired (e.g., minimal test setups), `CognitiveToolExecutorImpl` is constructed with no dependencies (or not constructed at all), and the client falls back to single-request behavior. The wiring is optional — the system works without cognitive tool execution.

### Minimal Scene (`examples/`)

25. **`MockLLMClient` updated for tool call loop** — The `MockLLMClient` in `examples/minimal-scene.ts` must be updated to handle the `agentId` field on `LLMContextPayload`. Since the mock bypasses the HTTP layer, it does not implement the tool call loop — it returns hardcoded responses directly. The mock should read `payload.agentId` if needed for logging but does not need to execute cognitive tools. The `MockLLMClient` interface methods remain the same (they implement `LLMClient`).

26. **Minimal scene wiring (when `USE_REAL_LLM=true`)** — When `USE_REAL_LLM=true`, the minimal scene must construct `CognitiveToolExecutorImpl` (if memory subsystems are wired) and pass it to the `OpenAICompatibleLLMClient` config. If memory subsystems are not wired in the minimal scene, the `cognitiveToolExecutor` config field is omitted — the client uses single-request behavior. The `maxToolCallIterations` config field may be set from `process.env['LLM_MAX_TOOL_CALL_ITERATIONS']` (optional, defaults to 3).

### Cross-Cutting

27. **Package boundaries** (per ADR-0001) — All changes are in:
    - `packages/shared/src/types/cognition.ts` (new interfaces: `CognitiveToolExecutor`, `CognitiveToolDataProvider`, `QueryMemoryToolResult`, `UpdateStateToolResult`; `LLMContextPayload.agentId` is in cognition's `index.ts`)
    - `packages/shared/src/schemas/llm-schemas.ts` (updated `queryMemorySchema`, new `queryMemoryTool` and `updateInternalStateTool` constants)
    - `packages/cognition/src/index.ts` (`LLMContextPayload.agentId` field)
    - `packages/cognition/src/tools/cognitive-tool-executor.ts` (new file — `CognitiveToolExecutorImpl`)
    - `packages/cognition/src/tools/index.ts` (export `CognitiveToolExecutorImpl`, update `defaultCognitiveTools` argsSchema)
    - `packages/cognition/src/llm/openai-client.ts` (tool call loop, new config fields, extended `ChatMessage`)
    - `packages/cognition/src/pper/plan-builder.ts` (include cognitive tools)
    - `packages/cognition/src/pper/perception-builder.ts` (use dedicated tool constants)
    - `packages/cognition/src/pper/reflect-builder.ts` (include cognitive tools)
    - `packages/cognition/src/pper/plan-service.ts` (set `agentId` on payload)
    - `packages/cognition/src/pper/reflect-service.ts` (set `agentId` on payload)
    - `examples/minimal-scene.ts` (MockLLMClient update, optional wiring)
    - `docs/specs/INDEX.md` (spec 015 added)
    No changes to `packages/engine/` or `packages/memory/`. No new npm dependencies.

28. **What NOT to do**:
    - Do not modify the `LLMClient` interface method signatures — only `LLMContextPayload` gains an optional `agentId` field.
    - Do not execute `formulate_plan`, `choose_action`, or `reflect` mid-loop — these are terminal tools. Their arguments are the phase result.
    - Do not add `formulate_plan` to the Perception/Execute phase's tool list — planning is the Plan phase's responsibility.
    - Do not modify `packages/engine/` or `packages/memory/` — existing interfaces are reused.
    - Do not modify `completeReflection` (memory consolidation) — it does not use cognitive tools.
    - Do not implement streaming support — all requests use `stream: false`.
    - Do not add new npm dependencies.
    - Do not modify existing JSON schema objects (`formulatePlanSchema`, `llmActionResponseSchema`, `reflectSchema`, `memoryConsolidationSchema`) — only `queryMemorySchema` is updated (add `topK`).
    - Do not implement cognitive guardrails (§10) — guardrails are a separate concern.
    - Do not remove the `cognitiveTools` field from `LLMContextPayload` — it is still used for prompt text construction in `buildUserMessage`.

## Acceptance Criteria

- [ ] **AC-1**: `CognitiveToolExecutor` interface is defined in `packages/shared/src/types/cognition.ts` with `executeQueryMemory(agentId: string, query: string, topK: number): Promise<QueryMemoryToolResult>` and `executeUpdateInternalState(agentId: string, newGoal?: string, driveOverrides?: Partial<Record<string, number>>): Promise<UpdateStateToolResult>`. *(Req 1)*
- [ ] **AC-2**: `CognitiveToolDataProvider` interface is defined in `packages/shared/src/types/cognition.ts` with `updateGoal(agentId: string, goal: string): void` and `applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void`. *(Req 2)*
- [ ] **AC-3**: `QueryMemoryToolResult` is defined in `packages/shared/src/types/cognition.ts` with `memories: MemorySnippet[]`. *(Req 3)*
- [ ] **AC-4**: `UpdateStateToolResult` is defined in `packages/shared/src/types/cognition.ts` with `success: boolean`, `goalUpdated: boolean`, `drivesUpdated: boolean`, `message: string`. *(Req 4)*
- [ ] **AC-5**: `LLMContextPayload` includes an optional `agentId?: string` field. Existing payloads without `agentId` compile and work without changes. *(Req 5)*
- [ ] **AC-6**: `queryMemorySchema` in `packages/shared/src/schemas/llm-schemas.ts` includes an optional `topK` property of type `integer` with `minimum: 1`, `maximum: 20`. The `required` array still contains only `['query']`. *(Req 6)*
- [ ] **AC-7**: `queryMemoryTool` is exported from `@evol-hive/shared` with `function.name === 'query_memory'` and `function.parameters === queryMemorySchema` (the updated schema). *(Req 7)*
- [ ] **AC-8**: `updateInternalStateTool` is exported from `@evol-hive/shared` with `function.name === 'update_internal_state'` and `function.parameters === updateInternalStateSchema`. *(Req 7)*
- [ ] **AC-9**: The `query_memory` entry in `defaultCognitiveTools` has an `argsSchema` that includes `topK` in `properties` (matching `queryMemorySchema`). *(Req 8)*
- [ ] **AC-10**: `CognitiveToolExecutorImpl` is defined in `packages/cognition/src/tools/cognitive-tool-executor.ts` and exported from `packages/cognition/src/index.ts`. It accepts `{ memoryInjector?, stateDataProvider? }` via constructor. *(Req 9)*
- [ ] **AC-11**: `CognitiveToolExecutorImpl.executeQueryMemory` with `memoryInjector` set calls `memoryInjector.activeRecall(agentId, query, topK)` and returns `{ memories: snippets }`. *(Req 10)*
- [ ] **AC-12**: `CognitiveToolExecutorImpl.executeQueryMemory` without `memoryInjector` returns `{ memories: [] }` (no error thrown). *(Req 10)*
- [ ] **AC-13**: `CognitiveToolExecutorImpl.executeQueryMemory` catches errors from `activeRecall` and returns `{ memories: [] }` (does not propagate). *(Req 10)*
- [ ] **AC-14**: `CognitiveToolExecutorImpl.executeUpdateInternalState` with `stateDataProvider` set, `newGoal` provided, calls `stateDataProvider.updateGoal(agentId, newGoal)` and returns `{ success: true, goalUpdated: true, drivesUpdated: false, message: '...' }`. *(Req 11)*
- [ ] **AC-15**: `CognitiveToolExecutorImpl.executeUpdateInternalState` with `stateDataProvider` set, `driveOverrides` provided, calls `stateDataProvider.applyDriveChanges(agentId, driveOverrides)` and returns `{ success: true, goalUpdated: false, drivesUpdated: true, message: '...' }`. *(Req 11)*
- [ ] **AC-16**: `CognitiveToolExecutorImpl.executeUpdateInternalState` without `stateDataProvider` returns `{ success: false, goalUpdated: false, drivesUpdated: false, message: 'State update not available.' }`. *(Req 11)*
- [ ] **AC-17**: `OpenAICompatibleLLMClientConfig` includes optional `cognitiveToolExecutor?: CognitiveToolExecutor` and `maxToolCallIterations?: number` fields. Existing constructors without these fields work unchanged. *(Req 12)*
- [ ] **AC-18**: The internal `ChatMessage` type in `openai-client.ts` supports `role: 'assistant'` with `tool_calls` and `role: 'tool'` with `content` and `tool_call_id`. *(Req 13)*
- [ ] **AC-19**: `COGNITIVE_TOOL_NAMES` constant is defined as `new Set(['query_memory', 'update_internal_state'])` in `openai-client.ts`. *(Req 14)*
- [ ] **AC-20**: When `cognitiveToolExecutor` is set and `agentId` is available, and the LLM calls `query_memory`, the client executes it via `cognitiveToolExecutor.executeQueryMemory`, constructs a tool result message, appends it to the messages, and sends another request. A unit test with mock `fetch` verifies the second request includes the tool result message. *(Req 15)*
- [ ] **AC-21**: When `cognitiveToolExecutor` is set and `agentId` is available, and the LLM calls `update_internal_state`, the client executes it via `cognitiveToolExecutor.executeUpdateInternalState`, constructs a tool result message, and sends another request. *(Req 15)*
- [ ] **AC-22**: When the LLM calls a terminal tool (e.g., `formulate_plan`) after a cognitive tool call, the loop terminates and the terminal tool's arguments are returned as the parsed result. A unit test verifies a two-turn flow: LLM calls `query_memory` → engine executes → LLM calls `formulate_plan` → result is the `formulate_plan` arguments. *(Req 15)*
- [ ] **AC-23**: When the tool call loop exceeds `maxToolCallIterations` (default 3) without a terminal tool call, the client throws `LLMError` with a message containing `"max iterations"`. *(Req 15)*
- [ ] **AC-24**: When `cognitiveToolExecutor` is NOT set in the client config, the client behaves as before — single request, parse `tool_calls[0].function.arguments`, return. No loop is attempted. *(Req 15)*
- [ ] **AC-25**: When `agentId` is NOT set on the payload, the client behaves as before — single request, no loop. *(Req 15)*
- [ ] **AC-26**: `tool_choice` is set to `'auto'` when `tools.length > 1`. `tool_choice` forces the single tool when `tools.length === 1`. *(Req 15)*
- [ ] **AC-27**: `requestChat` accepts an optional `agentId?: string` parameter and passes it to `sendRequest`. The public methods (`completeStructured`, `completePlan`, `completeReflect`) pass `payload.agentId` to `requestChat`. *(Req 16)*
- [ ] **AC-28**: When the `CognitiveToolExecutor` throws during tool execution, the error is caught and a tool result with `{ error: '<message>' }` is sent back to the LLM. The loop continues. *(Req 17)*
- [ ] **AC-29**: `PlanBuilderImpl.build()` returns a payload with `tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool]`. *(Req 18)*
- [ ] **AC-30**: `PerceptionBuilderImpl.build()` returns a payload with `tools: [chooseActionTool, queryMemoryTool, updateInternalStateTool]`. *(Req 19)*
- [ ] **AC-31**: `ReflectBuilderImpl.build()` returns a payload with `tools: [reflectTool, queryMemoryTool, updateInternalStateTool]`. *(Req 20)*
- [ ] **AC-32**: `PlanServiceImpl.plan()` sets `payload.agentId = agentId` before calling `llmClient.completePlan(payload)`. A unit test verifies the payload passed to `completePlan` has `agentId` set. *(Req 21)*
- [ ] **AC-33**: `ReflectServiceImpl.reflect()` sets `payload.agentId = agentId` before calling `llmClient.completeReflect(payload)`. A unit test verifies the payload passed to `completeReflect` has `agentId` set. *(Req 22)*
- [ ] **AC-34**: `MockLLMClient` in `examples/minimal-scene.ts` accepts `LLMContextPayload` with `agentId` field without error. The mock does not implement the tool call loop. *(Req 25)*
- [ ] **AC-35**: When `USE_REAL_LLM=true` and memory subsystems are wired, the minimal scene constructs `CognitiveToolExecutorImpl` and passes it to `OpenAICompatibleLLMClient`. When memory subsystems are not wired, `cognitiveToolExecutor` is omitted. *(Req 24, Req 26)*
- [ ] **AC-36**: `CognitiveToolExecutorImpl` imports from `@evol-hive/shared` (for `CognitiveToolExecutor`, `CognitiveToolDataProvider`, `QueryMemoryToolResult`, `UpdateStateToolResult`) and `@evol-hive/memory` (for `MemoryInjector`). It does NOT import from `@evol-hive/engine`. *(Req 27)*
- [ ] **AC-37**: `OpenAICompatibleLLMClient` imports `CognitiveToolExecutor` from `@evol-hive/shared` (type only). It does NOT import from `@evol-hive/memory` or `@evol-hive/engine`. *(Req 27)*
- [ ] **AC-38**: No files in `packages/engine/` or `packages/memory/` are modified. *(Req 27)*
- [ ] **AC-39**: `docs/specs/INDEX.md` is updated with spec 015 added with status 📝 Drafted. *(Req 27)*
- [ ] **AC-40**: A unit test verifies the end-to-end tool call loop: (1) `PlanBuilderImpl.build()` produces a payload with `[formulatePlanTool, queryMemoryTool, updateInternalStateTool]`, (2) `payload.agentId` is set, (3) `OpenAICompatibleLLMClient.completePlan()` sends the first request, (4) mock `fetch` returns `query_memory` tool call, (5) client executes via mock `CognitiveToolExecutor`, (6) client sends second request with tool result, (7) mock `fetch` returns `formulate_plan` tool call, (8) client parses and returns the `FormulatePlanResult`. *(Req 15, Req 18, Req 21)*
- [ ] **AC-41**: A unit test verifies that when the LLM directly calls the terminal tool (no cognitive tool calls), the result is identical to the pre-loop behavior — single request, single response, same parsed arguments. *(Req 15, Req 24)*
- [ ] **AC-42**: A unit test verifies `CognitiveToolExecutorImpl.executeQueryMemory` with `topK` from the LLM's tool call arguments passes `topK` to `memoryInjector.activeRecall`. When `topK` is omitted from the arguments, `5` is used as the default. *(Req 10, Req 15)*

## Constraints

- **Package boundaries** (per ADR-0001): `CognitiveToolExecutorImpl` is in `cognition` and imports from `shared` (bridge interfaces, types) and `memory` (`MemoryInjector` type). The `OpenAICompatibleLLMClient` imports `CognitiveToolExecutor` from `shared` (type only). No `cognition` imports from `engine`. No changes to `engine` or `memory` packages. The wiring of `CognitiveToolExecutorImpl` → `OpenAICompatibleLLMClient` happens at the application entry point.
- **Backward compatible**: If `cognitiveToolExecutor` is not set in the client config, or `agentId` is not on the payload, the client falls back to single-request behavior. Existing tests, minimal scenes, and mock clients work without changes. The `LLMClient` interface is unchanged (method signatures preserved). The `LLMContextPayload` gains an optional field (non-breaking).
- **Terminal vs. cognitive tools**: `query_memory` and `update_internal_state` are cognitive tools executed mid-loop. `formulate_plan`, `choose_action`, `reflect`, and `consolidate_memories` are terminal tools that end the loop. The `COGNITIVE_TOOL_NAMES` constant (Req 14) defines this distinction. Adding a new cognitive tool in the future requires adding its name to this set and implementing it in `CognitiveToolExecutorImpl`.
- **Max iterations safety**: The tool call loop has a max iteration count (default 3, configurable). This prevents infinite loops if the LLM keeps calling cognitive tools without progressing to a terminal tool. The limit counts cognitive tool executions, not HTTP requests — a single cognitive tool call is one iteration.
- **No LLM call in cognitive tool execution**: `query_memory` execution uses `MemoryInjector.activeRecall` which is pure embedding-based retrieval (no LLM call, per spec 014, Req 25). `update_internal_state` execution uses data provider methods (synchronous, no LLM call). The only LLM calls are the chat completion requests in the tool call loop itself.
- **Error resilience**: Cognitive tool execution errors are caught and sent back to the LLM as tool results (Req 17). This lets the LLM adjust its approach (e.g., proceed without memories if the memory system is unavailable). The PPER cycle is not aborted due to a cognitive tool failure. If the LLM cannot recover, the max iteration limit terminates the loop with an `LLMError`.
- **What NOT to do**:
    - Do not modify the `LLMClient` interface method signatures.
    - Do not execute `formulate_plan`, `choose_action`, or `reflect` mid-loop.
    - Do not add `formulate_plan` to the Perception/Execute phase's tool list.
    - Do not modify `packages/engine/` or `packages/memory/`.
    - Do not modify `completeReflection` (memory consolidation).
    - Do not implement streaming support.
    - Do not add new npm dependencies.
    - Do not modify existing JSON schema objects except `queryMemorySchema` (add `topK`).
    - Do not implement cognitive guardrails (§10).
    - Do not remove the `cognitiveTools` field from `LLMContextPayload`.
