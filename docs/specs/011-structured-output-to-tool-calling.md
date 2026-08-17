# Feature: Replace Structured Output with Tool Calling

## Context
- Architecture: [§7 — Structured Outputs](../architecture/07-structured-outputs.md) (grammar constraints / `response_format` → superseded by tool calling), [§6 — PPER Loop](../architecture/06-pper-loop.md) (System 2 LLM calls), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (intrinsic tools as native tool definitions), [§9 — Engine Routing](../architecture/09-engine-routing.md) (error propagation)
- Related specs: [006 — OpenAI-Compatible LLM Client](006-openai-compatible-llm-client.md) (superseded — `requestChat` now uses `tools`), [009 — LLM JSON Recovery](009-llm-json-recovery.md) (**superseded — mostly deleted**), [010 — LLM Schema-in-Prompt & Field Aliasing](010-llm-schema-in-prompt-and-field-aliasing.md) (**superseded — mostly deleted**), [001 — Perceive Phase](001-perceive-phase.md) (builder changes), [002 — Plan Phase](002-plan-phase.md) (builder changes), [004 — Reflect Phase](004-reflect-phase.md) (builder changes)
- Package: `cognition` (primary — `llm/openai-client.ts`, `pper/*-builder.ts`, `index.ts`), `shared` (schema constants cleanup, `LLMContextPayload` type change)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#40](https://github.com/Redna/evol-hive/issues/40)

## Design Rationale

The current approach uses `response_format: { type: "json_schema" | "json_object" }` to constrain LLM output to a JSON schema. This required three specs (006, 009, 010) and ~500 lines of recovery code because Ollama cloud-backed models (e.g., `kimi-k2.6:cloud`) do not reliably enforce `json_schema` strict mode:

- **Spec 009**: JSON extraction from text, re-prompt recovery, provider-aware `response_format` selection, `enableJsonRecovery`/`useJsonSchema`/`responseFormat` config
- **Spec 010**: Schema-in-prompt hints (`PLAN_SCHEMA_HINT`, `ACTION_RESPONSE_SCHEMA_HINT`, `REFLECT_SCHEMA_HINT`), field name aliasing (`goal`→`description`, `affordance`→`targetAffordance`), `JSON_INSTRUCTION_SUFFIX`, `resolveField()`

**Tool calling solves all of this.** Ollama's native tool calling (`tools` parameter) is a core feature listed in the [OpenAI compatibility docs](https://docs.ollama.com/api/openai-compatibility). When tools are provided, the LLM returns `tool_calls[0].function.arguments` — always valid JSON with exact field names from the tool's parameter schema. No extraction, no aliasing, no re-prompting, no schema hints needed.

Additionally, cognitive tools (`formulate_plan`, `query_memory`, `update_internal_state`) are currently listed as text in the prompt. With tool calling, they become native `tools` definitions — the LLM calls them naturally, eliminating the text description in the prompt.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`ToolDefinition` type** — A new type `ToolDefinition` must be defined and exported from `packages/shared/src/types/cognition.ts` (or `packages/shared/src/schemas/llm-schemas.ts`). It represents the OpenAI tool calling format:
   ```typescript
   interface ToolDefinition {
     type: 'function';
     function: {
       name: string;
       description: string;
       parameters: object; // JSON schema for the tool's arguments
     };
   }
   ```
   This is the standard OpenAI `/v1/chat/completions` tool format. Ollama's OpenAI-compatible endpoint accepts the same structure.

2. **`LLMContextPayload` replaces `responseSchema` and `schemaHint` with `tools`** — The `LLMContextPayload` interface in `packages/cognition/src/index.ts` must be modified:
   - **Remove**: `responseSchema: object` and `schemaHint?: string`
   - **Add**: `tools: ToolDefinition[]` — the tool definitions sent to the LLM via the `tools` parameter
   The `systemPrompt`, `perceptionContext`, `availableAffordances`, and `cognitiveTools` fields remain unchanged. The `cognitiveTools` field is kept for backward compatibility with the `CognitiveToolRegistry` and may be used for constructing user message text (e.g., listing available affordances); it is no longer used to build tool definitions — the builders construct `ToolDefinition[]` directly.

3. **Tool definition constants** — Four new tool definition constants must be exported from `packages/shared/src/schemas/llm-schemas.ts`, one per PPER phase plus memory consolidation:
   - `formulatePlanTool` — `{ type: 'function', function: { name: 'formulate_plan', description: 'Create a plan to satisfy the agent's drives', parameters: formulatePlanSchema } }`
   - `chooseActionTool` — `{ type: 'function', function: { name: 'choose_action', description: 'Choose one action to perform this tick', parameters: llmActionResponseSchema } }`
   - `reflectTool` — `{ type: 'function', function: { name: 'reflect', description: 'Reflect on the last action and update internal state', parameters: reflectSchema } }`
   - `memoryConsolidationTool` — `{ type: 'function', function: { name: 'consolidate_memories', description: 'Consolidate memory nodes into higher-level insights', parameters: memoryConsolidationSchema } }`
   These reuse the existing JSON schema objects (`formulatePlanSchema`, `llmActionResponseSchema`, `reflectSchema`, `memoryConsolidationSchema`) as the `parameters` field. The schemas themselves are not modified.

4. **Remove superseded constants** — The following constants must be **removed** from `packages/shared/src/schemas/llm-schemas.ts`:
   - `JSON_INSTRUCTION_SUFFIX` (spec 009, Req 15)
   - `PLAN_SCHEMA_HINT` (spec 010, Req 2)
   - `ACTION_RESPONSE_SCHEMA_HINT` (spec 010, Req 2)
   - `REFLECT_SCHEMA_HINT` (spec 010, Req 2)
   - `MEMORY_CONSOLIDATION_SCHEMA_HINT` (spec 010, Req 2)
   All imports of these constants throughout the codebase must be removed.

### Cognition Layer — LLM Client (`@evol-hive/cognition`)

5. **`requestChat()` sends `tools` instead of `response_format`** — The private `requestChat()` method in `OpenAICompatibleLLMClient` must accept a `tools: ToolDefinition[]` parameter instead of a `responseSchema: object` parameter. The request body to `/v1/chat/completions` must include:
   ```json
   {
     "model": "<model>",
     "messages": [...],
     "tools": [<tool definitions>],
     "stream": false
   }
   ```
   The `response_format` field must **not** be included in the request body. The `tool_choice` parameter should be set to `"auto"` (the default) to let the LLM choose which tool to call. When a single tool is provided (the common case for each PPER phase), `tool_choice` may be set to `{" type": "function", "function": {"name": "<tool name>"}}` to force the LLM to call that specific tool.

6. **Response parsing extracts `tool_calls[0].function.arguments`** — The `sendRequest()` method (or `requestChat()`) must parse the OpenAI tool call response. The response structure is:
   ```json
   {
     "choices": [{
       "message": {
         "role": "assistant",
         "content": null,
         "tool_calls": [{
           "id": "<call id>",
           "type": "function",
           "function": {
             "name": "<tool name>",
             "arguments": "<JSON string>"
           }
         }]
       }
     }]
   }
   ```
   The method must extract `choices[0].message.tool_calls[0].function.arguments` (a JSON string), `JSON.parse()` it, and return the parsed object. When `tool_calls` is missing or empty, throw `LLMResponseError` with `rawContent` set to the raw response body.

7. **`reasoning_effort` config option** — A new optional field `reasoningEffort` of type `'low' | 'medium' | 'high' | 'none'` must be added to `OpenAICompatibleLLMClientConfig`. When set, the request body must include `"reasoning_effort": "<value>"`. Default: not set (omit from request body — the provider's default applies). This allows callers to reduce latency for simple decisions (e.g., `reasoningEffort: 'low'` for the Execute phase). Ollama passes this through to the underlying model.

8. **Remove superseded config fields** — The following config fields must be **removed** from `OpenAICompatibleLLMClientConfig`:
   - `responseFormat` (spec 009, Req 4)
   - `useJsonSchema` (spec 009, Req 3)
   - `enableJsonRecovery` (spec 009, Req 8)
   The `ResponseFormat` type alias must also be removed. The `retryOnTimeout`, `baseUrl`, `model`, `apiKey`, `timeoutMs`, `maxRetries`, `retryDelayMs`, `embeddingProvider`, and `agentId` fields remain unchanged.

9. **Remove superseded methods and utilities** — The following must be **removed** from `OpenAICompatibleLLMClient` and/or `packages/cognition/src/llm/json-recovery.ts`:
   - `extractJsonFromText()` function and its export
   - `resolveField()` function and its export
   - `buildRePromptMessages()` private method
   - `summarizeSchema()` private method
   - `resolveResponseFormat()` private method
   - `isOllamaBaseUrl()` private method
   - `tryParse()` private method (replaced by tool call argument parsing)
   - `warnRecovery()` private method
   - `warnAliasIfUsed()` private method
   - All field name alias mapping logic in `completeStructured()`, `completePlan()`, and `completeReflect()` — the parsed tool call arguments are guaranteed to use the correct field names from the tool schema
   - The `ResponseFormatEnvelope` internal type
   The `json-recovery.ts` file should be **deleted entirely**. The `llm/index.ts` barrel must stop re-exporting `extractJsonFromText` and `resolveField`.

10. **`completeStructured()` uses `chooseActionTool`** — The `completeStructured(payload)` method must pass `payload.tools` to `requestChat()` instead of wrapping `payload.responseSchema` in `response_format`. The parsed tool call arguments are cast to `LLMActionResponse` with validation that `reasoning` (string) and `action` (string) are present. No alias mapping is performed — the tool schema guarantees correct field names.

11. **`completePlan()` uses `formulatePlanTool`** — The `completePlan(payload)` method must pass `payload.tools` to `requestChat()`. The parsed tool call arguments are cast to `FormulatePlanResult` with validation that `description` (non-empty string) and `steps` (non-empty array) are present. No alias mapping is performed.

12. **`completeReflect()` uses `reflectTool`** — The `completeReflect(payload)` method must pass `payload.tools` to `requestChat()`. The parsed tool call arguments are cast to `ReflectLLMResponse`. No alias mapping is performed. An empty object `{}` is returned when the LLM provides no optional fields (existing behavior).

13. **`completeReflection()` uses `memoryConsolidationTool`** — The `completeReflection(systemPrompt, memoryNodes)` method must construct a `tools` array containing `memoryConsolidationTool` and pass it to `requestChat()`. The `buildReflectionUserMessage()` method must **no longer** append `MEMORY_CONSOLIDATION_SCHEMA_HINT` (the constant is deleted). The user message contains only the memory node list.

14. **`buildUserMessage()` removes schema hint** — The `buildUserMessage()` method must **no longer** append `payload.schemaHint` to the user message (the field is removed from `LLMContextPayload`). The user message contains only the perception context, formatted affordance list, and formatted cognitive tool list.

15. **`LLMResponseError` simplified** — The `LLMResponseError` class must have its `originalRawContent` and `recoveryAttempted` fields **removed** (they were added by spec 009 for JSON recovery, which is no longer needed). The `rawContent` field remains. The `LLMError`, `LLMTimeoutError`, `LLMHTTPError`, and `LLMRateLimitError` classes are unchanged.

16. **`LLMClient` interface unchanged** — The `LLMClient` interface in `packages/cognition/src/index.ts` must not be modified — no methods added, removed, or renamed. The four methods (`completeStructured`, `completeReflection`, `completePlan`, `completeReflect`) keep the same signatures. Only the `LLMContextPayload` type changes (Req 2).

17. **No modification to PPER services** — `PlanServiceImpl`, `ReflectServiceImpl`, `PerceptionServiceImpl`, `ExecuteServiceImpl`, and `PPEROrchestratorImpl` must not be modified. They consume the `LLMClient` interface and catch all exceptions — they work transparently with the tool calling implementation.

### Cognition Layer — Builders (`@evol-hive/cognition`)

18. **`PlanBuilderImpl` sends tool definitions** — The `PlanBuilderImpl.build()` method must:
   - Set `tools: [formulatePlanTool]` in the returned `LLMContextPayload`
   - **Remove** the import and usage of `JSON_INSTRUCTION_SUFFIX` and `PLAN_SCHEMA_HINT`
   - **Remove** the `schemaHint` field from the returned payload
   - The system prompt no longer includes `JSON_INSTRUCTION_SUFFIX`

19. **`PerceptionBuilderImpl` sends tool definitions** — The `PerceptionBuilderImpl.build()` method must:
   - Set `tools: [chooseActionTool]` in the returned `LLMContextPayload` (plus any cognitive tool definitions — see Req 21)
   - **Remove** the import and usage of `JSON_INSTRUCTION_SUFFIX` and `ACTION_RESPONSE_SCHEMA_HINT`
   - **Remove** the `schemaHint` field from the returned payload
   - The system prompt no longer includes `JSON_INSTRUCTION_SUFFIX`

20. **`ReflectBuilderImpl` sends tool definitions** — The `ReflectBuilderImpl.build()` method must:
   - Set `tools: [reflectTool]` in the returned `LLMContextPayload`
   - **Remove** the import and usage of `JSON_INSTRUCTION_SUFFIX` and `REFLECT_SCHEMA_HINT`
   - **Remove** the `schemaHint` field from the returned payload
   - The system prompt no longer includes `JSON_INSTRUCTION_SUFFIX`

21. **Cognitive tools as native tool definitions** — The builders must construct `ToolDefinition[]` that include cognitive tools alongside the primary phase tool where appropriate:
   - **PlanBuilderImpl**: sends `[formulatePlanTool]` only (the Plan phase's purpose is to call `formulate_plan`)
   - **PerceptionBuilderImpl**: sends `[chooseActionTool, ...cognitiveToolDefinitions]` where `cognitiveToolDefinitions` are `ToolDefinition` objects built from the `defaultCognitiveTools` array (excluding `formulate_plan` which is handled by the Plan phase). The LLM can choose to call `choose_action` with a physical affordance, or call `query_memory` / `update_internal_state` directly.
   - **ReflectBuilderImpl**: sends `[reflectTool]` only (the Reflect phase's purpose is to reflect)
   A helper function `cognitiveToolsToToolDefinitions(tools: CognitiveTool[]): ToolDefinition[]` must be exported from `packages/cognition/src/tools/index.ts` (or `packages/shared/src/schemas/llm-schemas.ts`) to convert `CognitiveTool[]` to `ToolDefinition[]`. Each `CognitiveTool`'s `argsSchema` becomes the tool's `parameters`.

### Minimal Scene (`examples/`)

22. **Remove superseded config from minimal scene** — The `examples/minimal-scene.ts` must:
   - **Remove** `responseFormat`, `useJsonSchema`, and `enableJsonRecovery` from the `OpenAICompatibleLLMClient` constructor call
   - **Remove** the `LLM_RESPONSE_FORMAT` env var handling
   - Optionally add `reasoningEffort` from `process.env['LLM_REASONING_EFFORT']` (values: `low`, `medium`, `high`, `none`), passed to the client config when `USE_REAL_LLM=true`
   The `MockLLMClient` must be updated to handle the new `LLMContextPayload` shape (no `responseSchema`/`schemaHint`, has `tools`). The mock should return hardcoded tool call responses matching the expected tool names.

### Cross-Cutting

23. **Remove superseded test files** — The following test files must be **removed** (they test functionality that no longer exists):
   - `packages/cognition/tests/json-recovery.test.ts` (tests `extractJsonFromText` and `resolveField`)
   - `packages/cognition/tests/builder-json-suffix.test.ts` (tests `JSON_INSTRUCTION_SUFFIX` on builder prompts)
   - `packages/cognition/tests/schema-hints-and-aliasing.test.ts` (tests schema hints and field aliasing)
   - `packages/shared/tests/llm-schema-hints.test.ts` (tests schema hint constants)
   The remaining test files (`openai-client.test.ts`, `perception.test.ts`, `plan.test.ts`, `reflect.test.ts`, `pper-orchestrator.test.ts`, `pper-error-recovery.test.ts`) must be **updated** to work with the new `LLMContextPayload` shape and tool call response format.

24. **Update `openai-client.test.ts`** — The existing LLM client tests must be updated to:
   - Mock `fetch` responses with `tool_calls` in the response body instead of `content`
   - Verify that the request body includes `tools` and does not include `response_format`
   - Verify that `tool_calls[0].function.arguments` is parsed correctly
   - Remove tests for JSON recovery, re-prompt, alias mapping, and `response_format` selection
   - Add tests for the new `reasoningEffort` config option
   - Add a test verifying `LLMResponseError` is thrown when `tool_calls` is missing or empty

25. **Update builder tests** — The perception, plan, and reflect builder tests must be updated to:
   - Verify that the returned `LLMContextPayload` has `tools` set to the correct `ToolDefinition[]`
   - Verify that `responseSchema` and `schemaHint` are no longer present
   - Verify that `systemPrompt` does not end with `JSON_INSTRUCTION_SUFFIX`

26. **Update `MockLLMClient`** — The `MockLLMClient` in `examples/minimal-scene.ts` must be updated to:
   - Read `payload.tools` instead of `payload.responseSchema`
   - Return hardcoded `LLMActionResponse`, `FormulatePlanResult`, `ReflectLLMResponse` objects directly (the mock bypasses the HTTP layer, so tool call parsing is not exercised)
   - The mock interface methods remain the same (they implement `LLMClient`)

27. **Architecture doc §7 update note** — The architecture doc `docs/architecture/07-structured-outputs.md` should be updated to reflect that structured outputs are now achieved via tool calling rather than `response_format`. This is a documentation-only change — the core principle (no regex, no string matching, no fragile parsing) remains the same. The tool call mechanism is an even stronger guarantee than `response_format` because the LLM provider validates the tool arguments against the schema before returning them.

28. **Specs 009 and 010 superseded** — This spec formally supersedes spec 009 (LLM JSON Recovery) and spec 010 (LLM Schema-in-Prompt & Field Aliasing). Those specs' acceptance criteria are no longer valid — the code they specified is being deleted. The spec files should remain in `docs/specs/` for historical reference but their status in `INDEX.md` should be updated to "🚫 Superseded by 011".

29. **Package boundaries** (per ADR-0001) — All changes are in:
   - `packages/shared/src/schemas/llm-schemas.ts` (remove constants, add tool definitions)
   - `packages/shared/src/types/cognition.ts` (add `ToolDefinition` type, if placed here)
   - `packages/cognition/src/index.ts` (modify `LLMContextPayload`)
   - `packages/cognition/src/llm/openai-client.ts` (tool calling implementation, remove recovery)
   - `packages/cognition/src/llm/json-recovery.ts` (**deleted**)
   - `packages/cognition/src/llm/index.ts` (remove exports)
   - `packages/cognition/src/pper/plan-builder.ts` (tool definitions)
   - `packages/cognition/src/pper/perception-builder.ts` (tool definitions)
   - `packages/cognition/src/pper/reflect-builder.ts` (tool definitions)
   - `packages/cognition/src/tools/index.ts` (add `cognitiveToolsToToolDefinitions`)
   - `examples/minimal-scene.ts` (config cleanup, MockLLMClient update)
   - `docs/architecture/07-structured-outputs.md` (documentation update)
   - `docs/specs/INDEX.md` (status updates)
   No changes to `packages/engine/` or `packages/memory/`. No new npm dependencies.

30. **What NOT to do**:
   - Do not modify the `LLMClient` interface method signatures — only `LLMContextPayload` changes.
   - Do not modify any PPER service (`PlanServiceImpl`, `ReflectServiceImpl`, `ExecuteServiceImpl`, `PPEROrchestratorImpl`).
   - Do not modify existing JSON schema objects (`llmActionResponseSchema`, `formulatePlanSchema`, `reflectSchema`, `memoryConsolidationSchema`) — they are reused as tool `parameters`.
   - Do not implement streaming support — all requests use `stream: false`.
   - Do not implement tool call execution (the engine does not execute the tool calls — it only parses the arguments as structured data). The LLM "calling" a tool is just a structured output mechanism; the engine interprets the arguments as a plan, action, or reflection.
   - Do not add a tool call loop (where the engine sends tool results back to the LLM for multi-turn tool use). Each PPER phase makes a single LLM request with tools and parses one tool call response.
   - Do not add new npm dependencies.
   - Do not implement provider-specific native APIs — only the OpenAI-compatible `/v1/chat/completions` endpoint is used.

## Acceptance Criteria

- [ ] **AC-1**: `ToolDefinition` type is defined and exported from `@evol-hive/shared` with fields `type: 'function'` and `function: { name, description, parameters }`. *(Req 1)*
- [ ] **AC-2**: `LLMContextPayload` no longer has `responseSchema` or `schemaHint` fields. It has a new required field `tools: ToolDefinition[]`. The `systemPrompt`, `perceptionContext`, `availableAffordances`, and `cognitiveTools` fields remain. *(Req 2)*
- [ ] **AC-3**: `formulatePlanTool` is exported from `@evol-hive/shared` with `function.name === 'formulate_plan'` and `function.parameters === formulatePlanSchema`. *(Req 3)*
- [ ] **AC-4**: `chooseActionTool` is exported from `@evol-hive/shared` with `function.name === 'choose_action'` and `function.parameters === llmActionResponseSchema`. *(Req 3)*
- [ ] **AC-5**: `reflectTool` is exported from `@evol-hive/shared` with `function.name === 'reflect'` and `function.parameters === reflectSchema`. *(Req 3)*
- [ ] **AC-6**: `memoryConsolidationTool` is exported from `@evol-hive/shared` with `function.name === 'consolidate_memories'` and `function.parameters === memoryConsolidationSchema`. *(Req 3)*
- [ ] **AC-7**: `JSON_INSTRUCTION_SUFFIX`, `PLAN_SCHEMA_HINT`, `ACTION_RESPONSE_SCHEMA_HINT`, `REFLECT_SCHEMA_HINT`, and `MEMORY_CONSOLIDATION_SCHEMA_HINT` are no longer exported from `@evol-hive/shared`. Importing them causes a compile error. *(Req 4)*
- [ ] **AC-8**: `requestChat()` sends a request body with `tools` array and does not include `response_format`. A unit test with a `fetch` mock verifies the request body contains `tools` and lacks `response_format`. *(Req 5)*
- [ ] **AC-9**: `requestChat()` parses `choices[0].message.tool_calls[0].function.arguments` (a JSON string) via `JSON.parse()` and returns the parsed object. A unit test with a mock response containing `tool_calls` verifies the parsed arguments are returned. *(Req 6)*
- [ ] **AC-10**: When the response has no `tool_calls` or an empty `tool_calls` array, `requestChat()` throws `LLMResponseError` with `rawContent` set to the raw response body. *(Req 6)*
- [ ] **AC-11**: `OpenAICompatibleLLMClientConfig` includes a new optional field `reasoningEffort?: 'low' | 'medium' | 'high' | 'none'`. When set, the request body includes `"reasoning_effort": "<value>"`. When not set, the field is omitted from the request body. *(Req 7)*
- [ ] **AC-12**: `OpenAICompatibleLLMClientConfig` no longer has `responseFormat`, `useJsonSchema`, or `enableJsonRecovery` fields. The `ResponseFormat` type alias is removed. *(Req 8)*
- [ ] **AC-13**: `packages/cognition/src/llm/json-recovery.ts` is deleted. `extractJsonFromText` and `resolveField` are not exported from `packages/cognition/src/llm/index.ts` or `packages/cognition/src/index.ts`. *(Req 9)*
- [ ] **AC-14**: `OpenAICompatibleLLMClient` no longer has `buildRePromptMessages`, `summarizeSchema`, `resolveResponseFormat`, `isOllamaBaseUrl`, `tryParse`, `warnRecovery`, or `warnAliasIfUsed` methods. No field name alias mapping logic exists in `completeStructured()`, `completePlan()`, or `completeReflect()`. *(Req 9)*
- [ ] **AC-15**: `completeStructured(payload)` passes `payload.tools` to `requestChat()` and parses the tool call arguments into an `LLMActionResponse` with `reasoning` and `action` fields. No alias mapping is performed. *(Req 10)*
- [ ] **AC-16**: `completePlan(payload)` passes `payload.tools` to `requestChat()` and parses the tool call arguments into a `FormulatePlanResult` with `description` and `steps` fields. No alias mapping is performed. *(Req 11)*
- [ ] **AC-17**: `completeReflect(payload)` passes `payload.tools` to `requestChat()` and parses the tool call arguments into a `ReflectLLMResponse`. When the LLM returns no optional fields, the result is `{}`. *(Req 12)*
- [ ] **AC-18**: `completeReflection()` constructs a `tools` array with `memoryConsolidationTool` and passes it to `requestChat()`. The user message does not contain `MEMORY_CONSOLIDATION_SCHEMA_HINT` (it is deleted). *(Req 13)*
- [ ] **AC-19**: `buildUserMessage()` does not append any schema hint to the user message. The user message contains only perception context, affordances, and cognitive tools. *(Req 14)*
- [ ] **AC-20**: `LLMResponseError` no longer has `originalRawContent` or `recoveryAttempted` fields. The `rawContent` field remains. `instanceof` checks for `LLMResponseError` and `LLMError` still work. *(Req 15)*
- [ ] **AC-21**: The `LLMClient` interface in `packages/cognition/src/index.ts` is unchanged — same four methods with the same signatures. *(Req 16)*
- [ ] **AC-22**: No PPER service files are modified (`plan-service.ts`, `reflect-service.ts`, `execute-service.ts`, `orchestrator.ts`). *(Req 17)*
- [ ] **AC-23**: `PlanBuilderImpl.build()` returns a payload with `tools: [formulatePlanTool]`. The system prompt does not contain `JSON_INSTRUCTION_SUFFIX`. The payload does not have `schemaHint` or `responseSchema`. *(Req 18)*
- [ ] **AC-24**: `PerceptionBuilderImpl.build()` returns a payload with `tools` that includes `chooseActionTool` and cognitive tool definitions. The system prompt does not contain `JSON_INSTRUCTION_SUFFIX`. The payload does not have `schemaHint` or `responseSchema`. *(Req 19, Req 21)*
- [ ] **AC-25**: `ReflectBuilderImpl.build()` returns a payload with `tools: [reflectTool]`. The system prompt does not contain `JSON_INSTRUCTION_SUFFIX`. The payload does not have `schemaHint` or `responseSchema`. *(Req 20)*
- [ ] **AC-26**: A helper function `cognitiveToolsToToolDefinitions(tools: CognitiveTool[]): ToolDefinition[]` is exported from `packages/cognition/src/tools/index.ts`. It converts each `CognitiveTool` to a `ToolDefinition` using `argsSchema` as `parameters`. *(Req 21)*
- [ ] **AC-27**: `examples/minimal-scene.ts` does not pass `responseFormat`, `useJsonSchema`, or `enableJsonRecovery` to `OpenAICompatibleLLMClient`. The `LLM_RESPONSE_FORMAT` env var is no longer referenced. *(Req 22)*
- [ ] **AC-28**: `MockLLMClient` in `examples/minimal-scene.ts` works with the new `LLMContextPayload` (reads `payload.tools`, does not reference `payload.responseSchema` or `payload.schemaHint`). The mock returns valid hardcoded responses for all four `LLMClient` methods. *(Req 22, Req 26)*
- [ ] **AC-29**: `packages/cognition/tests/json-recovery.test.ts`, `packages/cognition/tests/builder-json-suffix.test.ts`, `packages/cognition/tests/schema-hints-and-aliasing.test.ts`, and `packages/shared/tests/llm-schema-hints.test.ts` are deleted. *(Req 23)*
- [ ] **AC-30**: `packages/cognition/tests/openai-client.test.ts` is updated to mock `fetch` responses with `tool_calls` in the response body. Tests verify the request body includes `tools` and lacks `response_format`. Tests verify `tool_calls[0].function.arguments` is parsed. Tests for JSON recovery and alias mapping are removed. *(Req 24)*
- [ ] **AC-31**: A unit test verifies that when `reasoningEffort` is set to `'low'`, the request body includes `"reasoning_effort": "low"`. A unit test verifies that when `reasoningEffort` is not set, the request body does not include `reasoning_effort`. *(Req 7, Req 24)*
- [ ] **AC-32**: Builder tests (perception, plan, reflect) verify the returned payload has `tools` set to the correct `ToolDefinition[]` and does not have `responseSchema` or `schemaHint`. *(Req 25)*
- [ ] **AC-33**: All existing PPER service tests (`pper-orchestrator.test.ts`, `pper-error-recovery.test.ts`) pass without modification to the service code. The tests may need mock updates for the new payload shape but the service implementations are unchanged. *(Req 17, Req 23)*
- [ ] **AC-34**: `OpenAICompatibleLLMClient` does not import from `@evol-hive/engine`. No new npm dependencies are added to any `package.json`. *(Req 29)*
- [ ] **AC-35**: `docs/specs/INDEX.md` is updated: spec 011 added with status 📝 Drafted; specs 009 and 010 status updated to 🚫 Superseded by 011. *(Req 28)*
- [ ] **AC-36**: A unit test verifies the end-to-end flow: `PerceptionBuilderImpl.build()` produces a payload with `tools: [chooseActionTool, ...]`, `OpenAICompatibleLLMClient.completeStructured()` sends those tools in the request body, and a mock `fetch` returning `tool_calls` with `choose_action` arguments is parsed into a valid `LLMActionResponse`. *(Req 5, Req 6, Req 10, Req 19)*

## Constraints

- **Package boundaries** (per ADR-0001): Changes are confined to `packages/shared/` (types, schema constants), `packages/cognition/` (LLM client, builders, tools), `examples/` (minimal scene), and `docs/` (architecture, specs index). No changes to `packages/engine/` or `packages/memory/`.
- **No external dependencies**: No new npm packages. The tool calling format is part of the standard OpenAI Chat Completions API — no additional libraries needed. Uses built-in `fetch` and `AbortController` (existing).
- **Non-breaking at the interface level**: The `LLMClient` interface is unchanged. PPER services are unchanged. The `LLMContextPayload` type changes (breaking for code that constructs it, but all such code is in the cognition package and is updated in this spec).
- **Single tool call per request**: Each PPER phase makes one LLM request with tools and parses one tool call response. No multi-turn tool use loop (where the engine sends tool results back to the LLM). The LLM "calling" a tool is a structured output mechanism — the engine interprets the arguments, it does not execute the tool.
- **Schemas reused, not modified**: The existing JSON schema objects (`llmActionResponseSchema`, `formulatePlanSchema`, `reflectSchema`, `memoryConsolidationSchema`) are reused as tool `parameters` without modification. They already define the correct field names and types.
- **Specs 009 and 010 superseded, not retroactively removed**: The spec files remain in `docs/specs/` for historical reference. Their status in `INDEX.md` is updated to "🚫 Superseded by 011". The code they specified (JSON recovery, schema hints, alias mapping) is deleted as part of this spec's implementation.
- **Mock coexistence**: The `MockLLMClient` in `examples/minimal-scene.ts` is updated to work with the new payload shape but remains as the default for mock-based testing. The `OpenAICompatibleLLMClient` is used when `USE_REAL_LLM=true`.
- **What NOT to do**:
  - Do not modify the `LLMClient` interface or PPER services.
  - Do not implement a tool call loop or multi-turn tool use.
  - Do not modify existing JSON schema objects.
  - Do not add streaming support.
  - Do not add new npm dependencies.
  - Do not implement provider-specific APIs — only OpenAI-compatible `/v1/chat/completions`.
  - Do not implement tool execution — the engine parses tool call arguments as structured data, it does not "run" the tools.
