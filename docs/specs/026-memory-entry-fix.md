# Feature: Memory Entry Fix — Flatten Reflect Schema & Auto-Fallback Memory Generation

## Context
- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md) (Reflect phase — System 2 background, consolidate memories), [§7 — Structured Outputs](../architecture/07-structured-outputs.md) (tool calling, schema enforcement), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (tool definitions), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (MemoryNode, MemoryType, importance scoring)
- Related specs: [004 — Reflect Phase](004-reflect-phase.md) (`ReflectServiceImpl`, `reflectSchema`, `ReflectLLMResponse`, `MemoryEntryInput`), [011 — Structured Output to Tool Calling](011-structured-output-to-tool-calling.md) (tool definitions per PPER phase, `reflectTool`), [003 — Execute Phase](003-execute-phase.md) (`ExecuteResult`), [014 — Memory Consolidation](014-memory-consolidation-decay-retrieval.md) (MemoryNode, retrieval engine)
- Package: `shared`, `cognition`, `engine`
- Issue: [#99](https://github.com/Redna/evol-hive/issues/99)

## Design Rationale

The Reflect phase system prompt instructs the LLM to include a `memoryEntry` nested object in its `reflect` tool call response. In practice, gemma4 (31b) never returns `memoryEntry` — 91 PPER cycles over 60 seconds produced 0 stored memories. The root cause is that the nested object schema (`memoryEntry: { content, importance, type, location }`) is too complex for smaller models when embedded inside a tool definition. Even updating the system prompt from "Use update_internal_state to store a memory" to "Include a memoryEntry" did not help.

Spec 010 proposed schema-in-prompt hints and field alias mapping, but was superseded by spec 011 (tool calling), which removed all recovery machinery. The tool calling approach guarantees valid JSON, but does not solve the fundamental problem: the LLM simply omits the nested `memoryEntry` field rather than returning it with wrong field names.

This spec implements a **two-layer fix**:

1. **Flatten the memory schema** (Issue Solution A) — Replace the nested `memoryEntry` object with top-level fields `memoryContent`, `memoryImportance`, `memoryType`, `memoryLocation` in the `reflectSchema`. Small models handle flat top-level fields far more reliably than nested objects. The nested `memoryEntry` is kept as a backward-compat alias — the `completeReflect()` parser checks both and prefers whichever is present.

2. **Auto-fallback memory generation** (Issue Solution C) — When the LLM returns no memory at all (neither flattened nor nested), the `ReflectServiceImpl` auto-generates a basic memory from the execution result (affordance label, success/failure, location). This ensures the acceptance criterion "at least 1 memory stored per agent per 60s run" is met even when the LLM never returns memory fields.

### Why not Solution B (make memoryEntry required)?
Making `memoryEntry` required would force the LLM to always return a memory, even when the step was skipped or the agent is idle. This would cause tool call validation failures on legitimate no-op ticks, breaking the PPER cycle. The auto-fallback approach achieves the same outcome (always store a memory) without requiring the LLM to comply.

### Why not Solution D (separate store_memory tool)?
A separate `store_memory` cognitive tool would require multi-turn tool call handling — the LLM calls `reflect`, the engine responds, then the LLM calls `store_memory`. The current architecture (spec 011) uses a single request → single tool call pattern. Adding multi-turn handling to the Reflect phase adds significant complexity for a problem solvable with flattening + fallback.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **Extend `ExecuteResult` with affordance metadata** — The `ExecuteResult` interface in `packages/shared/src/types/cognition.ts` must add two optional fields: `affordanceId?: string` (the ID of the affordance that was executed) and `affordanceLabel?: string` (the human-readable label of the affordance). These are populated by the execute service when a physical affordance is executed. When `stepSkipped` is `true`, both are `undefined`. This information is needed by the auto-fallback memory generator (Req 9) to produce meaningful memory content.

2. **Flatten memory fields in `reflectSchema`** — The `reflectSchema` in `packages/shared/src/schemas/llm-schemas.ts` must add top-level fields `memoryContent`, `memoryImportance`, `memoryType`, and `memoryLocation` alongside the existing nested `memoryEntry`. The flattened fields are:
   ```json
   {
     "memoryContent": { "type": "string", "description": "..." },
     "memoryImportance": { "type": "integer", "minimum": 1, "maximum": 10, "description": "..." },
     "memoryType": { "type": "string", "enum": ["observation", "reflection", "action", "interaction"], "description": "..." },
     "memoryLocation": { "type": ["string", "null"], "description": "..." }
   }
   ```
   The nested `memoryEntry` remains in the schema for backward compatibility — larger models may still use it. No top-level fields are required. `additionalProperties: false` is maintained.

3. **Extend `ReflectLLMResponse` with flattened memory fields** — The `ReflectLLMResponse` interface in `packages/shared/src/types/cognition.ts` must add optional fields: `memoryContent?: string`, `memoryImportance?: number`, `memoryType?: MemoryType`, `memoryLocation?: string`. The existing `memoryEntry?: MemoryEntryInput` field is kept for backward compatibility. Both the flattened fields and the nested `memoryEntry` can be present in the response — the reflect service resolves them (see Req 7).

4. **Add `ReflectServiceOptions.autoMemoryFallback`** — The `ReflectServiceOptions` interface in `packages/cognition/src/pper/reflect-service.ts` must add an optional field `autoMemoryFallback?: boolean` (default: `true`). When `true`, the reflect service auto-generates a memory when the LLM returns no memory fields (see Req 9). When `false`, no auto-fallback occurs — the existing behavior (no memory stored) is preserved. This allows tests and operators to disable the fallback if needed.

### Cognition Layer (`@evol-hive/cognition`)

5. **Update `completeReflect()` to parse flattened fields** — The `completeReflect()` method in `packages/cognition/src/llm/openai-client.ts` must check both the flattened top-level fields (`memoryContent`, `memoryImportance`, `memoryType`, `memoryLocation`) and the nested `memoryEntry` object. When `memoryContent` is a non-empty string AND `memoryImportance` is a number AND `memoryType` is a string, construct and populate `result.memoryEntry` from the flattened fields. When the nested `memoryEntry` is present (object with `content`, `importance`, `type`), use it directly. Flattened fields take priority when both are present. The existing `newGoal` and `driveOverrides` parsing is unchanged.

6. **Update `ReflectBuilderImpl` system prompt and context** — The `buildSystemPrompt()` function in `packages/cognition/src/pper/reflect-builder.ts` must update the reflect instruction from "Include a memoryEntry in your reflect response to store a memory for future reference." to "Include memoryContent, memoryImportance, and memoryType in your reflect response to store a memory for future reference. memoryContent is a description of what happened, memoryImportance is 1-10, memoryType is observation/reflection/action/interaction." This uses the flattened field names in the prompt so the LLM knows exactly which top-level fields to populate.

7. **`ReflectServiceImpl` resolves memory from flattened or nested** — The `ReflectServiceImpl.reflect()` method must resolve the memory entry from the `ReflectLLMResponse` as follows:
   - If `llmResponse.memoryEntry` is present (nested object, already parsed by `completeReflect()`), use it.
   - Else if `llmResponse.memoryContent` is present (string), construct a `MemoryEntryInput` from the flattened fields: `{ content: memoryContent, importance: memoryImportance, type: memoryType, location: memoryLocation }`.
   - Else no memory from the LLM.
   The validation logic (Req 15 of spec 004) applies to the resolved `MemoryEntryInput` regardless of source (flattened or nested).

8. **Validation of flattened fields** — The `validateReflectLLMResponse()` function in `reflect-service.ts` must validate the flattened memory fields when the nested `memoryEntry` is absent:
   - If `memoryContent` is present but `memoryImportance` is missing or not an integer 1–10, return an error.
   - If `memoryContent` is present but `memoryType` is missing or not a valid `MemoryType`, return an error.
   - If `memoryImportance` is present but `memoryContent` is missing or empty, return an error.
   - If `memoryType` is present but `memoryContent` is missing or empty, return an error.
   - If neither flattened fields nor nested `memoryEntry` are present, no memory validation occurs (valid — no memory needed).
   When both flattened and nested are present, the nested `memoryEntry` is validated (it takes priority per Req 5).

9. **Auto-fallback memory generation** — When `autoMemoryFallback` is `true` (default) and the LLM returns no memory fields at all (neither flattened nor nested), the `ReflectServiceImpl` must auto-generate a `MemoryEntryInput`:
   - If `executeResult.stepSkipped` is `true` or `executeResult.affordanceLabel` is `undefined`, skip the fallback (nothing physical happened to remember).
   - If `executeResult.success` is `true`: content = `"${affordanceLabel} in ${agentState.location}"`, type = `"action"`, importance = `3`.
   - If `executeResult.success` is `false`: content = `"Failed to ${affordanceLabel} in ${agentState.location}"`, type = `"observation"`, importance = `5`.
   - The `location` field is set to `agentState.location`.
   - The generated entry is passed to `dataProvider.storeMemory()` like any other memory entry.
   - The `memoryStored` flag in `ReflectResult` is `true` if the auto-fallback store succeeds.
   - The `ReflectResult` must include a new optional field `memoryAutoGenerated?: boolean` — `true` when the memory was auto-generated, `false` or `undefined` when the LLM provided the memory. This is for observability and testing.

10. **Add `memoryAutoGenerated` to `ReflectResult`** — The `ReflectResult` interface in `packages/shared/src/types/cognition.ts` must add an optional field `memoryAutoGenerated?: boolean`. When `true`, the memory was auto-generated by the fallback (Req 9), not provided by the LLM. When `false`, the memory was provided by the LLM. When `undefined`, no memory was stored. This flag is purely informational — it does not affect the control flow.

### Engine Layer (`@evol-hive/engine`)

11. **Populate `affordanceId` and `affordanceLabel` in `ExecuteResult`** — The `ExecuteServiceImpl.execute()` method in `packages/cognition/src/pper/execute-service.ts` must populate `affordanceId` and `affordanceLabel` in the returned `ExecuteResult` when a physical affordance is executed:
    - After resolving the affordance (`data Provider.resolveAffordance`), set `affordanceId = step.targetAffordance` and `affordanceLabel = resolved.affordance.label`.
    - On the success path: `return { success: true, result, planComplete, affordanceId: step.targetAffordance, affordanceLabel: resolved.affordance.label }`.
    - On the precondition failure path: `return { success: false, error: ..., planComplete: false, affordanceId: step.targetAffordance, affordanceLabel: resolved.affordance.label }`.
    - On the execution failure path: `return { success: false, error: ..., planComplete: false, affordanceId: step.targetAffordance, affordanceLabel: resolved.affordance.label }`.
    - When `stepSkipped` is `true` (non-physical step or unresolvable affordance): do not populate `affordanceId` or `affordanceLabel` (both remain `undefined`).

### Cross-Cutting

12. **Backward compatibility** — The nested `memoryEntry` in `reflectSchema` is kept and still parsed. Models that successfully return `memoryEntry` (e.g., larger models) continue to work without changes. The flattened fields are an addition, not a replacement. The `completeReflect()` parser prefers flattened fields when both are present (Req 5), but both paths produce the same `result.memoryEntry` output.

13. **No new tool definitions** — This spec does not add a `store_memory` tool (Issue Solution D was rejected). The memory fields remain part of the `reflect` tool's parameter schema. The `reflectTool` definition in `packages/shared/src/schemas/llm-schemas.ts` continues to use `reflectSchema` as its `parameters` — it is updated in place (Req 2).

14. **No `LLMClient` interface change** — The `completeReflect(payload: LLMContextPayload): Promise<ReflectLLMResponse>` method signature is unchanged. The `ReflectLLMResponse` type is extended with new optional fields (Req 3), but the method signature remains the same. The parsing logic changes are internal to `OpenAICompatibleLLMClient`.

15. **Package boundaries** (per ADR-0001) — Changes are confined to:
    - `packages/shared/src/types/cognition.ts` (extend `ExecuteResult`, `ReflectLLMResponse`, `ReflectResult`)
    - `packages/shared/src/schemas/llm-schemas.ts` (flatten fields in `reflectSchema`)
    - `packages/cognition/src/llm/openai-client.ts` (parse flattened fields in `completeReflect`)
    - `packages/cognition/src/pper/reflect-builder.ts` (update system prompt)
    - `packages/cognition/src/pper/reflect-service.ts` (resolve memory, auto-fallback, `autoMemoryFallback` option)
    - `packages/cognition/src/pper/execute-service.ts` (populate `affordanceId`, `affordanceLabel`)
    No changes to `packages/memory/`.

16. **What NOT to do**:
    - Do not make `memoryEntry` or the flattened memory fields required in the schema — optional is correct; the auto-fallback handles the case when the LLM omits them.
    - Do not add a `store_memory` cognitive tool — multi-turn tool call handling is not supported in the Reflect phase (spec 011, Decision 4).
    - Do not remove the nested `memoryEntry` from the schema — it is kept for backward compatibility with larger models.
    - Do not auto-generate memories for skipped steps — there is nothing physical to remember.
    - Do not auto-generate memories with `importance > 5` — the fallback produces basic, low-importance memories; the LLM should provide richer memories with higher importance.
    - Do not modify `dataProvider.storeMemory()` or the `MemoryStore` interface — the auto-fallback produces a standard `MemoryEntryInput`.
    - Do not add new npm dependencies.

## Acceptance Criteria

- [ ] **AC-1**: `ExecuteResult` includes optional fields `affordanceId?: string` and `affordanceLabel?: string` in `packages/shared/src/types/cognition.ts`. *(Req 1)*
- [ ] **AC-2**: `ExecuteServiceImpl.execute()` populates `affordanceId` and `affordanceLabel` when a physical affordance is executed (success, precondition failure, or execution failure paths). When `stepSkipped` is `true`, both are `undefined`. *(Req 1, Req 11)*
- [ ] **AC-3**: `reflectSchema` in `packages/shared/src/schemas/llm-schemas.ts` includes top-level `memoryContent` (string), `memoryImportance` (integer 1–10), `memoryType` (enum), `memoryLocation` (string|null) alongside the existing nested `memoryEntry`. No top-level fields are required. `additionalProperties: false` is maintained. *(Req 2)*
- [ ] **AC-4**: `ReflectLLMResponse` in `packages/shared/src/types/cognition.ts` includes optional fields `memoryContent?: string`, `memoryImportance?: number`, `memoryType?: MemoryType`, `memoryLocation?: string` alongside the existing `memoryEntry?: MemoryEntryInput`. *(Req 3)*
- [ ] **AC-5**: `completeReflect()` in `openai-client.ts` parses flattened fields (`memoryContent`, `memoryImportance`, `memoryType`, `memoryLocation`) and constructs `result.memoryEntry` when all three required flattened fields are present. Flattened fields take priority over nested `memoryEntry` when both are present. *(Req 5)*
- [ ] **AC-6**: `completeReflect()` still parses the nested `memoryEntry` object when flattened fields are absent — backward compatibility with larger models. *(Req 5, Req 12)*
- [ ] **AC-7**: `ReflectBuilderImpl.buildSystemPrompt()` instructs the LLM to "Include memoryContent, memoryImportance, and memoryType in your reflect response" using the flattened field names. *(Req 6)*
- [ ] **AC-8**: `ReflectServiceImpl.reflect()` resolves the memory entry from `llmResponse.memoryEntry` (nested) first, then from flattened fields (`memoryContent` + `memoryImportance` + `memoryType`), then neither. *(Req 7)*
- [ ] **AC-9**: When the LLM returns flattened fields `memoryContent: "Brewed coffee"`, `memoryImportance: 5`, `memoryType: "action"`, the resolved `MemoryEntryInput` has `content: "Brewed coffee"`, `importance: 5`, `type: "action"`. *(Req 7)*
- [ ] **AC-10**: `validateReflectLLMResponse()` validates flattened fields when nested `memoryEntry` is absent: rejects empty `memoryContent`, out-of-range `memoryImportance`, invalid `memoryType`, and mismatched presence (e.g., `memoryImportance` present without `memoryContent`). *(Req 8)*
- [ ] **AC-11**: `ReflectServiceOptions` includes optional `autoMemoryFallback?: boolean` (default `true`). *(Req 4)*
- [ ] **AC-12**: When `autoMemoryFallback` is `true` and the LLM returns no memory fields, and `executeResult.success` is `true` and `executeResult.affordanceLabel` is `"Brew coffee"` and `agentState.location` is `"kitchen"`, the auto-generated `MemoryEntryInput` has `content: "Brew coffee in kitchen"`, `type: "action"`, `importance: 3`, `location: "kitchen"`. *(Req 9)*
- [ ] **AC-13**: When `autoMemoryFallback` is `true` and the LLM returns no memory fields, and `executeResult.success` is `false` and `executeResult.affordanceLabel` is `"Brew coffee"` and `agentState.location` is `"kitchen"`, the auto-generated `MemoryEntryInput` has `content: "Failed to Brew coffee in kitchen"`, `type: "observation"`, `importance: 5`, `location: "kitchen"`. *(Req 9)*
- [ ] **AC-14**: When `autoMemoryFallback` is `true` and `executeResult.stepSkipped` is `true`, no auto-fallback memory is generated. *(Req 9)*
- [ ] **AC-15**: When `autoMemoryFallback` is `false` and the LLM returns no memory fields, no memory is stored — existing behavior is preserved. *(Req 4)*
- [ ] **AC-16**: `ReflectResult` includes optional field `memoryAutoGenerated?: boolean`. When the memory was auto-generated, `memoryAutoGenerated` is `true`. When the LLM provided the memory, `memoryAutoGenerated` is `false`. When no memory was stored, `memoryAutoGenerated` is `undefined`. *(Req 9, Req 10)*
- [ ] **AC-17**: In a 60-second simulation run with gemma4 (or a mock LLM that never returns memory fields), at least 1 memory is stored per agent. *(Issue AC-1, Req 9)*
- [ ] **AC-18**: Auto-generated memories contain meaningful content (non-empty, includes the affordance label and location) — not empty or a generic default string. *(Issue AC-2, Req 9)*
- [ ] **AC-19**: Auto-generated memories are retrievable via `query_memory` cognitive tool — they are stored through the same `dataProvider.storeMemory()` path as LLM-provided memories. *(Issue AC-3, Req 9)*
- [ ] **AC-20**: When the LLM provides flattened fields and the nested `memoryEntry` is absent, `memoryAutoGenerated` is `false` in the `ReflectResult`. *(Req 7, Req 10)*
- [ ] **AC-21**: When the LLM provides the nested `memoryEntry` and flattened fields are absent, `memoryAutoGenerated` is `false` in the `ReflectResult`. *(Req 5, Req 10)*
- [ ] **AC-22**: All existing tests (specs 004, 011) pass without modification — the nested `memoryEntry` path and the `reflectTool` definition still work. New fields are optional. *(Req 12, Req 14, Req 15)*
- [ ] **AC-23**: The `LLMClient` interface method `completeReflect(payload: LLMContextPayload): Promise<ReflectLLMResponse>` signature is unchanged. *(Req 14)*
- [ ] **AC-24**: No files in `packages/memory/` are modified. *(Req 15)*
- [ ] **AC-25**: No new npm dependencies are added. *(Req 16)*

## Constraints

- **Package boundaries** (per ADR-0001): Changes are in `packages/shared/` (type and schema extensions), `packages/cognition/` (parser, builder prompt, service orchestration, execute service), and `packages/engine/` is not modified (the execute service is in cognition). No changes to `packages/memory/`.
- **Backward compatibility**: The nested `memoryEntry` field remains in `reflectSchema` and is still parsed. Models that return `memoryEntry` continue to work. The flattened fields are additions. `ReflectLLMResponse` and `ExecuteResult` extensions are all optional — existing code that constructs these types without the new fields compiles and runs unchanged.
- **Auto-fallback is opt-out**: `autoMemoryFallback` defaults to `true` to fix the bug immediately. Tests can disable it via `autoMemoryFallback: false` to test the LLM-driven path in isolation.
- **Fallback memories are low-importance**: Auto-generated memories use `importance: 3` (success) or `importance: 5` (failure). The LLM should provide higher-importance memories with richer content. The fallback is a safety net, not a replacement for LLM-driven memory.
- **No multi-turn tool calls**: The `reflect` tool remains a single-tool, single-call mechanism. No `store_memory` tool is added.
- **Schema flattening, not removal**: The nested `memoryEntry` is kept in the schema for larger models. Both paths produce the same internal `MemoryEntryInput`.
- **What NOT to do**:
  - Do not make memory fields required in the schema.
  - Do not add a `store_memory` cognitive tool.
  - Do not remove the nested `memoryEntry` from the schema.
  - Do not auto-generate memories for skipped steps.
  - Do not modify `MemoryStore`, `VectorStore`, or `EmbeddingProvider`.
  - Do not add new npm dependencies.
  - Do not modify the `LLMClient` interface signature.
