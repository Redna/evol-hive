# Feature: Memory Entry — Flatten Schema & Auto-Fallback

## Context
- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md), [§11 — Memory Architecture](../architecture/11-memory-architecture.md)
- Related specs: [004 — Reflect Phase](004-reflect-phase.md), [011 — Structured Output to Tool Calling](011-structured-output-to-tool-calling.md), [015 — Full Cognitive Tools](015-full-cognitive-tools.md)
- Package: `shared`, `cognition`
- Issue: [#99](https://github.com/Redna/evol-hive/issues/99)

## Problem

The reflect tool definition (`reflectSchema` in `packages/shared/src/schemas/llm-schemas.ts`) nests the memory entry as an optional `memoryEntry` object containing `content`, `importance`, `type`, and `location`. Small models (gemma4 31b) do not reliably populate this nested object — 91 PPER cycles produced 0 stored memories. The `ReflectServiceImpl` checks `llmResponse.memoryEntry !== undefined`, which is always `undefined`.

## Design Decisions

1. **Flatten the memory schema (Solution A from issue).** Replace the nested `memoryEntry` object in `reflectSchema` with four top-level fields: `memoryContent` (string), `memoryImportance` (integer 1–10), `memoryType` (enum), `memoryLocation` (optional string). Small models handle flat schemas better than nested objects.

2. **Make `memoryContent` required in the reflect tool schema (Solution B from issue).** The `required` array in the JSON schema now includes `"memoryContent"`. This is a strong hint to the LLM. It is not enforced at the parsing layer (the OpenAI-compatible client does not validate `required`), but it significantly increases the probability that the LLM returns the field.

3. **Auto-fallback memory generation (Solution C from issue).** When the LLM response does not contain `memoryContent` (or it is empty), `ReflectServiceImpl` auto-generates a memory entry from the execution result and agent state. This guarantees at least one memory per reflect cycle, satisfying AC-1. The auto-generated memory uses:
   - **Content**: `"Action {succeeded|failed}: {currentGoal}"` (or `"Idle tick — no action taken"` when `stepSkipped` is true). Drive changes are appended when present (e.g., `"energy +20, hunger -5"`).
   - **Importance**: `3` (low — auto-generated, not LLM-curated).
   - **Type**: `"action"` when execution succeeded, `"observation"` otherwise.
   - **Location**: the agent's `location` from `AgentInternalState`, or `undefined`.

4. **Backward-compatible `ReflectLLMResponse` type.** The `ReflectLLMResponse` interface is updated to accept the flattened fields (`memoryContent`, `memoryImportance`, `memoryType`, `memoryLocation`) in addition to the legacy `memoryEntry` for a transitional period. The `completeReflect` method in `OpenAICompatibleLLMClient` parses the flattened fields and constructs a `MemoryEntryInput` internally. The legacy `memoryEntry` field is deprecated but still accepted if the LLM returns it.

5. **No separate `store_memory` tool (Solution D rejected).** Adding a separate cognitive tool for the reflect phase increases the tool-call loop complexity and latency. The flatten + fallback approach is simpler and sufficient.

## Requirements

### R1: Flatten reflect tool schema — `shared`
- **R1.1**: The `reflectSchema` in `packages/shared/src/schemas/llm-schemas.ts` must replace the nested `memoryEntry` property with four top-level properties: `memoryContent` (string), `memoryImportance` (integer 1–10), `memoryType` (string enum: `observation|reflection|action|interaction`), `memoryLocation` (string, optional).
- **R1.2**: The `required` array of `reflectSchema` must include `"memoryContent"` (alongside any existing required fields). `memoryImportance`, `memoryType`, and `memoryLocation` remain optional in the schema.
- **R1.3**: The legacy `memoryEntry` nested property must be removed from `reflectSchema` (not retained as deprecated — the schema is what the LLM sees).

### R2: Update `ReflectLLMResponse` type — `shared`
- **R2.1**: The `ReflectLLMResponse` interface in `packages/shared/src/types/cognition.ts` must replace the `memoryEntry?: MemoryEntryInput` field with `memoryContent?: string`, `memoryImportance?: number`, `memoryType?: MemoryType`, `memoryLocation?: string`.
- **R2.2**: For backward compatibility during the transition, the interface must also accept an optional legacy `memoryEntry?: MemoryEntryInput` field. When both flattened fields and `memoryEntry` are present, the flattened fields take precedence.

### R3: Update `completeReflect` parsing — `cognition`
- **R3.1**: The `completeReflect` method in `OpenAICompatibleLLMClient` must parse the flattened top-level fields (`memoryContent`, `memoryImportance`, `memoryType`, `memoryLocation`) from the LLM tool-call arguments and populate the corresponding fields on `ReflectLLMResponse`.
- **R3.2**: When the LLM returns the legacy `memoryEntry` nested object (some models may still do), `completeReflect` must extract `content`, `importance`, `type`, and `location` from it and populate the flattened fields on `ReflectLLMResponse`. Flattened fields take precedence over the legacy `memoryEntry` when both are present.
- **R3.3**: When `memoryImportance` is missing or invalid (not an integer 1–10), it must default to `5`. When `memoryType` is missing or invalid (not in the enum), it must default to `"observation"`. When `memoryLocation` is missing, it must be `undefined`.

### R4: Update `ReflectServiceImpl` validation and application — `cognition`
- **R4.1**: The `validateReflectLLMResponse` function must validate the flattened `memoryContent` field (if present and non-empty, it must be a non-empty string). The legacy `memoryEntry` validation path must also be retained for backward compatibility.
- **R4.2**: When `memoryContent` is present and non-empty, `ReflectServiceImpl` must construct a `MemoryEntryInput` from the flattened fields (using defaults for missing `memoryImportance`/`memoryType`/`memoryLocation` as in R3.3) and call `dataProvider.storeMemory`.
- **R4.3**: When the legacy `memoryEntry` is present but flattened fields are absent, `ReflectServiceImpl` must use `memoryEntry` (backward compatibility).
- **R4.4**: The atomicity guarantee (Req 15 from spec 004) is preserved: if the memory content is invalid, no partial updates (drives, goal) are applied.

### R5: Auto-fallback memory generation — `cognition`
- **R5.1**: When the LLM response has no `memoryContent` (or it is empty/whitespace-only) AND no legacy `memoryEntry`, `ReflectServiceImpl` must auto-generate a `MemoryEntryInput` from the execution result and agent state.
- **R5.2**: The auto-generated content must follow this format:
  - When `executeResult.stepSkipped` is true: `"Idle tick — no action taken. Goal: {agentState.currentGoal}"`.
  - When `executeResult.success` is true: `"Action succeeded: {agentState.currentGoal}"` plus drive changes if present (e.g., `", drives: energy +20, hunger -5"`).
  - When `executeResult.success` is false: `"Action failed: {executeResult.error ?? 'unknown'}. Goal: {agentState.currentGoal}"`.
- **R5.3**: The auto-generated `importance` must be `3`. The `type` must be `"action"` when `executeResult.success` is true, `"observation"` otherwise. The `location` must be `agentState.location` when available, `undefined` otherwise.
- **R5.4**: The auto-fallback memory must be stored via `dataProvider.storeMemory` just like an LLM-provided memory. `ReflectResult.memoryStored` must be `true`.
- **R5.5**: The auto-fallback must not trigger when the LLM provided a valid memory (either flattened or legacy). It is a last resort.

### R6: Update reflect system prompt — `cognition`
- **R6.1**: The `buildSystemPrompt` function in `ReflectBuilderImpl` must update the memory instruction to reference the flattened field names: "Include memoryContent in your reflect response to store a memory for future reference. Set memoryImportance (1-10), memoryType (observation|reflection|action|interaction), and optionally memoryLocation."

### R7: Update tests — `cognition`, `shared`
- **R7.1**: Existing reflect tests that mock `memoryEntry` on `ReflectLLMResponse` must be updated to use the flattened fields (`memoryContent`, `memoryImportance`, `memoryType`).
- **R7.2**: New tests must verify: (a) flattened fields are parsed correctly, (b) legacy `memoryEntry` is still accepted, (c) auto-fallback generates a memory when LLM omits all memory fields, (d) auto-fallback content is meaningful (non-empty, contains goal or error info), (e) auto-fallback does not trigger when LLM provides memory.

## Acceptance Criteria

- [ ] **AC-1**: A 60-second simulation run with gemma4 stores at least 1 memory per agent (maps to R5.1, R5.4).
- [ ] **AC-2**: Every stored memory (LLM-provided or auto-fallback) has non-empty `content` (maps to R4.1, R5.2).
- [ ] **AC-3**: Stored memories are retrievable via the `query_memory` cognitive tool (maps to R4.2, R5.4 — memories go through `dataProvider.storeMemory` which generates embeddings and creates `MemoryNode`s).
- [ ] **AC-4**: The `reflectSchema` in `llm-schemas.ts` has `memoryContent`, `memoryImportance`, `memoryType`, `memoryLocation` as top-level properties and does NOT have a nested `memoryEntry` property (maps to R1.1, R1.3).
- [ ] **AC-5**: The `reflectSchema` `required` array includes `"memoryContent"` (maps to R1.2).
- [ ] **AC-6**: The `ReflectLLMResponse` interface has `memoryContent`, `memoryImportance`, `memoryType`, `memoryLocation` fields (maps to R2.1).
- [ ] **AC-7**: `completeReflect` parses flattened fields and populates `ReflectLLMResponse` correctly (maps to R3.1).
- [ ] **AC-8**: `completeReflect` still accepts the legacy `memoryEntry` nested object and translates it to flattened fields (maps to R3.2).
- [ ] **AC-9**: When `memoryImportance` is missing, it defaults to `5`; when `memoryType` is missing, it defaults to `"observation"` (maps to R3.3).
- [ ] **AC-10**: `ReflectServiceImpl` stores a memory when `memoryContent` is non-empty (maps to R4.2).
- [ ] **AC-11**: `ReflectServiceImpl` stores a memory from the legacy `memoryEntry` when flattened fields are absent (maps to R4.3).
- [ ] **AC-12**: Invalid memory content (empty string) causes the entire reflect result to fail with no partial updates (maps to R4.4).
- [ ] **AC-13**: When LLM omits all memory fields, `ReflectServiceImpl` auto-generates a memory and `ReflectResult.memoryStored` is `true` (maps to R5.1, R5.4).
- [ ] **AC-14**: Auto-generated memory content is non-empty and contains either the agent's current goal or the execution error (maps to R5.2).
- [ ] **AC-15**: Auto-generated memory has `importance: 3` and `type: "action"` (success) or `"observation"` (failure) (maps to R5.3).
- [ ] **AC-16**: Auto-fallback does not trigger when the LLM provides a valid memory (maps to R5.5).
- [ ] **AC-17**: The reflect system prompt references `memoryContent`, `memoryImportance`, `memoryType` by name (maps to R6.1).
- [ ] **AC-18**: All existing reflect tests pass after updating to the new flattened schema (maps to R7.1).
- [ ] **AC-19**: New tests cover flattened parsing, legacy compatibility, auto-fallback generation, and auto-fallback suppression (maps to R7.2).

## Constraints
- **Package boundaries**: Schema changes are in `packages/shared`. Parsing logic and reflect service changes are in `packages/cognition`. No changes to `engine` or `memory` packages.
- **Backward compatibility**: The legacy `memoryEntry` field must still be accepted by `completeReflect` and `ReflectServiceImpl` to avoid breaking any model that still returns the nested object.
- **No new cognitive tools**: This spec does not add a `store_memory` cognitive tool (Solution D from the issue is rejected).
- **No new data provider methods**: The auto-fallback uses only existing `ReflectDataProvider` methods (`getAgentState`, `storeMemory`). No new bridge interface methods.
- **Performance**: The auto-fallback adds negligible overhead (string concatenation, no LLM call, no I/O beyond the existing `storeMemory`).
- **Pattern**: Follow the existing tool-calling pattern (spec 011) — the schema is the tool `parameters`, not a prompt hint.
- **What NOT to do**: Do not make `memoryImportance` or `memoryType` required in the schema — only `memoryContent` is required. Forcing all four fields increases the chance the small model produces a malformed response. Defaults (R3.3) handle missing optional fields.
