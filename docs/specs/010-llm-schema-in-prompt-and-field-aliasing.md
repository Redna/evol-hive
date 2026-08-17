# Feature: LLM Schema-in-Prompt & Field Name Aliasing

## Context
- Architecture: [§7 — Structured Outputs](../architecture/07-structured-outputs.md) (grammar constraints / `response_format`), [§6 — PPER Loop](../architecture/06-pper-loop.md) (System 2 LLM calls), [§9 — Engine Routing](../architecture/09-engine-routing.md) (error propagation)
- Related specs: [009 — LLM JSON Response Recovery](009-llm-json-recovery.md) (JSON extraction, re-prompt, `JSON_INSTRUCTION_SUFFIX`, `response_format` selection), [006 — OpenAI-Compatible LLM Client](006-openai-compatible-llm-client.md) (`requestChat`, `completeStructured`, `completePlan`, `completeReflect`, `completeReflection`), [002 — Plan Phase](002-plan-phase.md) (`PlanBuilderImpl`, `formulatePlanSchema`), [004 — Reflect Phase](004-reflect-phase.md) (`ReflectBuilderImpl`, `reflectSchema`), [001 — Perceive Phase](001-perceive-phase.md) (`PerceptionBuilderImpl`, `llmActionResponseSchema`)
- Package: `cognition` (primary — `llm/openai-client.ts`, `pper/*-builder.ts`), `shared` (schema hint constants, `LLMContextPayload` extension)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#37](https://github.com/Redna/evol-hive/issues/37)

## Design Rationale

Spec 009 added `JSON_INSTRUCTION_SUFFIX` to builder system prompts: *"IMPORTANT: Respond ONLY with a valid JSON object … The JSON must match the provided schema exactly."* This tells the LLM **to** match a schema, but never shows the LLM **what** the schema is. The schema is only passed via `response_format: { type: "json_schema", … }`, which Ollama cloud-backed models (e.g., `kimi-k2.6:cloud`) silently ignore. With `response_format: { type: "json_object" }` (the Ollama fallback from spec 009), the LLM produces valid JSON but invents its own field names based on the natural-language system prompt:

- `goal` instead of `description` (plan)
- `affordance` instead of `targetAffordance` (plan step)
- `tool` wrapper field instead of `action` (structured)
- `reason` instead of `reasoning` (structured)

The `completePlan()` parser checks `parsed["description"]` and `parsed["steps"][i]["targetAffordance"]` — both missing → `LLMResponseError` → PPER cycle aborts → energy drains to 0.

This spec introduces a **two-layer fix**:

1. **Schema-in-prompt** — Append an explicit JSON template string (with exact field names and placeholder values) to the **user message**. The LLM now sees the exact JSON structure it must produce, regardless of whether the backend enforces `json_schema` or `json_object`. This is distinct from `JSON_INSTRUCTION_SUFFIX` (which is a general "respond in JSON" reminder in the system prompt) — the schema hint is a concrete field-by-field template in the user message.

2. **Field name alias mapping** — As a defense-in-depth fallback, the `completePlan()`, `completeStructured()`, and `completeReflect()` parsers accept known alternative field names and map them to the canonical names before validation. This handles LLMs that use semantically equivalent but syntactically different field names even when the schema hint is present.

Both layers are **non-breaking**: the `LLMClient` interface is unchanged, PPER services are unmodified, the new `schemaHint` field on `LLMContextPayload` is optional, and existing tests pass without modification.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`schemaHint` field on `LLMContextPayload`** — A new optional field `schemaHint?: string` must be added to the `LLMContextPayload` interface in `packages/cognition/src/index.ts`. When provided, the `OpenAICompatibleLLMClient` appends it to the user message (Req 6). When omitted (undefined), no schema hint is appended — existing behavior is preserved. The field is optional to maintain backward compatibility with any code that constructs `LLMContextPayload` without it.

2. **Schema hint constants** — Four new string constants must be exported from `packages/shared/src/schemas/llm-schemas.ts`, one per LLM-facing schema. Each constant is a human-readable JSON template showing the exact field names and placeholder values the LLM must use:
   - `PLAN_SCHEMA_HINT` — for `formulatePlanSchema`: `'Respond with JSON in this exact format: {"description": "<plan description>", "steps": [{"description": "<step description>", "targetAffordance": "<affordance id or null>"}]}'`
   - `ACTION_RESPONSE_SCHEMA_HINT` — for `llmActionResponseSchema`: `'Respond with JSON in this exact format: {"reasoning": "<your reasoning>", "action": "<affordance id or cognitive tool name>", "actionArgs": {}, "observeTarget": "<object id or null>", "updatedGoal": "<new goal or null>"}'`
   - `REFLECT_SCHEMA_HINT` — for `reflectSchema`: `'Respond with JSON in this exact format: {"newGoal": "<new goal or null>", "driveOverrides": {"<driveName>": <value>}, "memoryEntry": {"content": "<description>", "importance": 1, "type": "observation", "location": "<room or null>"}}'`
   - `MEMORY_CONSOLIDATION_SCHEMA_HINT` — for `memoryConsolidationSchema`: `'Respond with JSON in this exact format: {"consolidatedMemories": [{"content": "<description>", "importance": 1, "type": "observation"}], "consolidatedNodeIds": ["<nodeId>"]}'`
   These constants are the single source of truth for the schema templates shown to the LLM. They are maintained alongside the JSON schema definitions they correspond to.

### Cognition Layer — Builders (`@evol-hive/cognition`)

3. **`PlanBuilderImpl` populates `schemaHint`** — The `PlanBuilderImpl.build()` method must set `schemaHint: PLAN_SCHEMA_HINT` in the returned `LLMContextPayload`. This ensures the LLM sees the exact `{"description": …, "steps": [{"description": …, "targetAffordance": …}]}` structure in the user message.

4. **`PerceptionBuilderImpl` populates `schemaHint`** — The `PerceptionBuilderImpl.build()` method must set `schemaHint: ACTION_RESPONSE_SCHEMA_HINT` in the returned `LLMContextPayload`. This ensures the LLM sees the exact `{"reasoning": …, "action": …, …}` structure in the user message.

5. **`ReflectBuilderImpl` populates `schemaHint`** — The `ReflectBuilderImpl.build()` method must set `schemaHint: REFLECT_SCHEMA_HINT` in the returned `LLMContextPayload`. This ensures the LLM sees the exact `{"newGoal": …, "driveOverrides": …, "memoryEntry": …}` structure in the user message.

### Cognition Layer — LLM Client (`@evol-hive/cognition`)

6. **`buildUserMessage()` appends `schemaHint`** — The `OpenAICompatibleLLMClient.buildUserMessage()` method must append `payload.schemaHint` to the user message text when `schemaHint` is a non-empty string. The schema hint is appended as a separate paragraph (double-newline separated) after the existing content (perception context, affordances, cognitive tools). When `schemaHint` is undefined or empty, the user message is unchanged — existing behavior is preserved.

7. **`buildReflectionUserMessage()` appends `MEMORY_CONSOLIDATION_SCHEMA_HINT`** — The `OpenAICompatibleLLMClient.buildReflectionUserMessage()` method must append `MEMORY_CONSOLIDATION_SCHEMA_HINT` to the user message text. This applies to the `completeReflection()` method, which does not use `LLMContextPayload` and therefore cannot receive `schemaHint` through the payload. The hint is appended as a separate paragraph after the memory node list.

8. **Alias mapping in `completePlan()`** — Before validating the parsed response, `completePlan()` must apply field name alias mapping:
   - **Top-level**: If `parsed["description"]` is missing (undefined or not a string), check `parsed["goal"]`. If `parsed["goal"]` is a non-empty string, use it as `description`. If neither is present, the existing validation error is thrown.
   - **Step-level**: For each step object, if `obj["targetAffordance"]` is missing (undefined), check `obj["affordance"]`. If `obj["affordance"]` is a string, use it as `targetAffordance`. If `obj["affordance"]` is null, treat it as `targetAffordance: undefined` (no affordance for this step — this is valid per `formulatePlanSchema`).
   - Extra fields the LLM adds (e.g., `tool`, `order`, `goal`) are silently ignored — they do not cause errors and are not mapped.

9. **Alias mapping in `completeStructured()`** — Before validating the parsed response, `completeStructured()` must apply field name alias mapping:
   - If `parsed["reasoning"]` is missing, check `parsed["reason"]`. If it is a string, use it as `reasoning`.
   - If `parsed["action"]` is missing, check `parsed["tool"]`. If it is a string, use it as `action`.
   - If `parsed["actionArgs"]` is missing, check `parsed["args"]` or `parsed["arguments"]`. If it is an object, use it as `actionArgs`.
   - If `parsed["observeTarget"]` is missing, check `parsed["observe_target"]`. If it is a string, use it as `observeTarget`.
   - If `parsed["updatedGoal"]` is missing, check `parsed["updated_goal"]` or `parsed["goal"]`. If it is a string, use it as `updatedGoal`.
   - If after alias mapping both `reasoning` and `action` are still missing, the existing validation error is thrown.

10. **Alias mapping in `completeReflect()`** — Before extracting fields, `completeReflect()` must apply field name alias mapping:
    - If `parsed["newGoal"]` is missing, check `parsed["goal"]` or `parsed["new_goal"]`. If it is a string, use it as `newGoal`.
    - If `parsed["driveOverrides"]` is missing, check `parsed["drives"]` or `parsed["drive_overrides"]`. If it is an object, use it as `driveOverrides`.
    - If `parsed["memoryEntry"]` is missing, check `parsed["memory"]` or `parsed["memory_entry"]`. If it is an object, use it as `memoryEntry`.
    - Extra fields are silently ignored.

11. **Shared alias resolution utility** — A new exported function `resolveField(parsed: Record<string, unknown>, canonical: string, aliases: string[]): { value: unknown; usedAlias: string | null }` must be implemented in `packages/cognition/src/llm/json-recovery.ts` (alongside `extractJsonFromText`). The function:
    - Returns `{ value: parsed[canonical], usedAlias: null }` when the canonical field is present (not undefined).
    - Iterates `aliases` in order; returns `{ value: parsed[alias], usedAlias: alias }` for the first alias that is present (not undefined).
    - Returns `{ value: undefined, usedAlias: null }` when neither canonical nor any alias is present.
    This utility is used by `completePlan()`, `completeStructured()`, and `completeReflect()` to avoid duplicating alias-checking logic. It is exported for unit testing.

12. **Logging when alias mapping is triggered** — When `resolveField()` returns a non-null `usedAlias`, the calling method must log a `console.warn` with: the method name, the canonical field name, the alias that was used, and the truncated value (≤200 chars). This is a lightweight observability measure consistent with spec 009's recovery logging (Req 18 of spec 009). The warning format is: `[field-alias] completePlan: canonical="description", usedAlias="goal", value="Restore energy…"`.

13. **No modification to `LLMClient` interface** — The `LLMClient` interface in `packages/cognition/src/index.ts` must not be modified — no methods added, removed, or renamed. The `schemaHint` field is added to `LLMContextPayload` (a data structure), not to the `LLMClient` interface.

14. **No modification to PPER services** — `PlanServiceImpl`, `ReflectServiceImpl`, `PerceptionServiceImpl`, `ExecuteServiceImpl`, and `PPEROrchestratorImpl` must not be modified. The alias mapping and schema hint are internal to `OpenAICompatibleLLMClient` and the builder classes. The services call `llmClient.completePlan()` etc. as before and receive the same typed results.

### Cross-Cutting

15. **Non-breaking** — All changes are backward-compatible:
    - `schemaHint` is optional on `LLMContextPayload` — existing code that constructs payloads without it continues to work (no schema hint appended).
    - Alias mapping only activates when canonical fields are missing — when the LLM returns correct field names, no mapping occurs and behavior is identical to before.
    - `resolveField()` is a new export — no existing exports are changed or removed.
    - All existing tests (specs 001–009) pass without modification.

16. **Package boundaries** (per ADR-0001) — All changes are in:
    - `packages/shared/src/schemas/llm-schemas.ts` (four new constants)
    - `packages/cognition/src/index.ts` (add `schemaHint?` to `LLMContextPayload`)
    - `packages/cognition/src/llm/openai-client.ts` (append `schemaHint` to user message, alias mapping in three `complete*` methods, `buildReflectionUserMessage` schema hint)
    - `packages/cognition/src/llm/json-recovery.ts` (new `resolveField` function)
    - `packages/cognition/src/pper/plan-builder.ts` (set `schemaHint`)
    - `packages/cognition/src/pper/perception-builder.ts` (set `schemaHint`)
    - `packages/cognition/src/pper/reflect-builder.ts` (set `schemaHint`)
    No changes to `packages/engine/` or `packages/memory/`. No new npm dependencies.

17. **Testability** — The `resolveField()` function must be unit-testable in isolation. Tests must cover: canonical present (returns canonical, no alias), canonical missing + alias present (returns alias), canonical missing + no alias (returns undefined), canonical present + alias present (returns canonical — canonical takes priority), multiple aliases (first matching alias wins).

18. **Schema hint placement** — The schema hint is appended to the **user message**, not the system prompt. The system prompt already contains `JSON_INSTRUCTION_SUFFIX` (a general "respond in JSON" reminder). The user message schema hint is a concrete field-by-field template that appears immediately before the LLM generates its response, maximizing the probability that the LLM uses the correct field names. The two are complementary, not redundant: the system prompt says "respond in JSON matching the schema"; the user message shows "here is the exact JSON format."

19. **What NOT to do**:
    - Do not modify the `LLMClient` interface — the `schemaHint` field is on `LLMContextPayload`, not on the interface methods.
    - Do not modify any PPER service (`PlanServiceImpl`, `ReflectServiceImpl`, etc.).
    - Do not modify existing JSON schema objects (`llmActionResponseSchema`, `formulatePlanSchema`, `reflectSchema`, `memoryConsolidationSchema`) — the schema hint constants are separate strings, not schema modifications.
    - Do not modify `JSON_INSTRUCTION_SUFFIX` — it remains in the system prompt as-is.
    - Do not implement a generic schema-to-template generator — the schema hint constants are hand-written strings for clarity and maintainability.
    - Do not add alias mapping to `completeReflection()` — the issue specifies `completeStructured`, `completePlan`, and `completeReflect`. Memory consolidation responses are simpler and less prone to field name drift.
    - Do not implement fuzzy field name matching (e.g., Levenshtein distance) — only explicitly known aliases are mapped.
    - Do not add new npm dependencies.
    - Do not add streaming support.
    - Do not modify the `response_format` selection logic from spec 009 — the schema hint is in the prompt text, not in the `response_format` parameter.

## Acceptance Criteria

- [ ] **AC-1**: `LLMContextPayload` includes a new optional field `schemaHint?: string`. When omitted, `buildUserMessage()` produces the same user message as before (no schema hint paragraph). *(Req 1, Req 6, Req 15)*
- [ ] **AC-2**: `PLAN_SCHEMA_HINT` is exported from `@evol-hive/shared` with the value: `'Respond with JSON in this exact format: {"description": "<plan description>", "steps": [{"description": "<step description>", "targetAffordance": "<affordance id or null>"}]}'`. *(Req 2)*
- [ ] **AC-3**: `ACTION_RESPONSE_SCHEMA_HINT` is exported from `@evol-hive/shared` with the value: `'Respond with JSON in this exact format: {"reasoning": "<your reasoning>", "action": "<affordance id or cognitive tool name>", "actionArgs": {}, "observeTarget": "<object id or null>", "updatedGoal": "<new goal or null>"}'`. *(Req 2)*
- [ ] **AC-4**: `REFLECT_SCHEMA_HINT` is exported from `@evol-hive/shared` with the value: `'Respond with JSON in this exact format: {"newGoal": "<new goal or null>", "driveOverrides": {"<driveName>": <value>}, "memoryEntry": {"content": "<description>", "importance": 1, "type": "observation", "location": "<room or null>"}}'`. *(Req 2)*
- [ ] **AC-5**: `MEMORY_CONSOLIDATION_SCHEMA_HINT` is exported from `@evol-hive/shared` with the value: `'Respond with JSON in this exact format: {"consolidatedMemories": [{"content": "<description>", "importance": 1, "type": "observation"}], "consolidatedNodeIds": ["<nodeId>"]}'`. *(Req 2)*
- [ ] **AC-6**: `PlanBuilderImpl.build()` returns a payload with `schemaHint` set to `PLAN_SCHEMA_HINT`. *(Req 3)*
- [ ] **AC-7**: `PerceptionBuilderImpl.build()` returns a payload with `schemaHint` set to `ACTION_RESPONSE_SCHEMA_HINT`. *(Req 4)*
- [ ] **AC-8**: `ReflectBuilderImpl.build()` returns a payload with `schemaHint` set to `REFLECT_SCHEMA_HINT`. *(Req 5)*
- [ ] **AC-9**: When `payload.schemaHint` is a non-empty string, `buildUserMessage()` appends it as a separate paragraph (preceded by `\n\n`) after the perception context, affordances, and cognitive tools. A unit test with a mock payload containing `schemaHint: "Respond with JSON in this exact format: {...}"` verifies the user message contains the schema hint string. *(Req 6)*
- [ ] **AC-10**: When `payload.schemaHint` is undefined, `buildUserMessage()` does not append any schema hint paragraph. The user message is identical to the pre-change behavior. *(Req 1, Req 6, Req 15)*
- [ ] **AC-11**: `buildReflectionUserMessage()` appends `MEMORY_CONSOLIDATION_SCHEMA_HINT` as a separate paragraph after the memory node list. A unit test verifies the user message contains the memory consolidation schema hint string. *(Req 7)*
- [ ] **AC-12**: `completePlan()` accepts a response with `goal` instead of `description` and maps it correctly. A unit test with mock LLM response `{"goal": "Restore energy", "steps": [{"description": "Brew coffee", "affordance": "brew_coffee"}]}` returns a `FormulatePlanResult` with `description: "Restore energy"` and `steps[0].targetAffordance: "brew_coffee"`. *(Req 8)*
- [ ] **AC-13**: `completePlan()` accepts a response with `affordance: null` in a step and maps it to `targetAffordance: undefined` (no affordance for that step — valid per schema). *(Req 8)*
- [ ] **AC-14**: `completePlan()` throws `LLMResponseError` when both `description` and `goal` are missing, or when `steps` is missing/empty. The alias mapping does not mask genuinely invalid responses. *(Req 8)*
- [ ] **AC-15**: `completeStructured()` accepts a response with `reason` instead of `reasoning` and `tool` instead of `action`, mapping them correctly. A unit test with mock LLM response `{"reason": "I need coffee", "tool": "brew_coffee"}` returns an `LLMActionResponse` with `reasoning: "I need coffee"` and `action: "brew_coffee"`. *(Req 9)*
- [ ] **AC-16**: `completeStructured()` accepts a response with `args` or `arguments` instead of `actionArgs`, `observe_target` instead of `observeTarget`, and `updated_goal` or `goal` instead of `updatedGoal`. *(Req 9)*
- [ ] **AC-17**: `completeStructured()` throws `LLMResponseError` when both `reasoning` and `reason` are missing, or when both `action` and `tool` are missing. *(Req 9)*
- [ ] **AC-18**: `completeReflect()` accepts a response with `goal` instead of `newGoal`, `drives` instead of `driveOverrides`, and `memory` instead of `memoryEntry`, mapping them correctly. A unit test with mock LLM response `{"goal": "Survive", "drives": {"energy": 50}, "memory": {"content": "Brewed coffee", "importance": 5, "type": "action"}}` returns a `ReflectLLMResponse` with `newGoal: "Survive"`, `driveOverrides: {energy: 50}`, and `memoryEntry.content: "Brewed coffee"`. *(Req 10)*
- [ ] **AC-19**: `completeReflect()` throws no error when all fields are missing — it returns an empty `ReflectLLMResponse` `{}` (existing behavior, since all reflect fields are optional). Alias mapping does not change this behavior. *(Req 10)*
- [ ] **AC-20**: A new exported function `resolveField(parsed: Record<string, unknown>, canonical: string, aliases: string[]): { value: unknown; usedAlias: string | null }` is available from `packages/cognition/src/llm/json-recovery.ts`. *(Req 11)*
- [ ] **AC-21**: A unit test verifies `resolveField` returns the canonical value when the canonical field is present, even if aliases are also present (canonical takes priority). *(Req 11, Req 17)*
- [ ] **AC-22**: A unit test verifies `resolveField` returns the first matching alias value when the canonical field is missing and at least one alias is present. *(Req 11, Req 17)*
- [ ] **AC-23**: A unit test verifies `resolveField` returns `{ value: undefined, usedAlias: null }` when neither canonical nor any alias is present. *(Req 11, Req 17)*
- [ ] **AC-24**: When alias mapping is triggered (an alias is used instead of the canonical field), `console.warn` is called with the method name, canonical field name, alias name, and truncated value (≤200 chars). *(Req 12)*
- [ ] **AC-25**: When the LLM returns correct canonical field names, no `console.warn` for field aliases is emitted. Alias mapping is transparent when not needed. *(Req 12, Req 15)*
- [ ] **AC-26**: The `LLMClient` interface in `packages/cognition/src/index.ts` is unchanged — no methods added, removed, or renamed. *(Req 13)*
- [ ] **AC-27**: No PPER service files (`plan-service.ts`, `reflect-service.ts`, `execute-service.ts`, `orchestrator.ts`) are modified. *(Req 14)*
- [ ] **AC-28**: `OpenAICompatibleLLMClient` does not import from `@evol-hive/engine`. No new npm dependencies are added. *(Req 16)*
- [ ] **AC-29**: All existing tests (specs 001–009) pass without modification. The `schemaHint` field is optional and alias mapping only activates when canonical fields are missing. *(Req 15)*
- [ ] **AC-30**: A unit test verifies that `completePlan()` with a mock LLM response using canonical field names (`{"description": "...", "steps": [{"description": "...", "targetAffordance": "..."}]}`) returns the correct result without triggering any alias mapping. *(Req 8, Req 15)*
- [ ] **AC-31**: A unit test verifies that the user message sent to the LLM (captured from `fetch` mock) contains the `PLAN_SCHEMA_HINT` string when `completePlan()` is called with a `PlanBuilderImpl`-built payload. *(Req 3, Req 6)*
- [ ] **AC-32**: A unit test verifies that the user message sent to the LLM (captured from `fetch` mock) contains the `ACTION_RESPONSE_SCHEMA_HINT` string when `completeStructured()` is called with a `PerceptionBuilderImpl`-built payload. *(Req 4, Req 6)*
- [ ] **AC-33**: A unit test verifies that the user message sent to the LLM (captured from `fetch` mock) contains the `REFLECT_SCHEMA_HINT` string when `completeReflect()` is called with a `ReflectBuilderImpl`-built payload. *(Req 5, Req 6)*
- [ ] **AC-34**: A unit test verifies that the user message sent to the LLM (captured from `fetch` mock) contains the `MEMORY_CONSOLIDATION_SCHEMA_HINT` string when `completeReflection()` is called. *(Req 7)*
- [ ] **AC-35**: A unit test verifies that extra fields in the LLM response (e.g., `tool`, `order`, `goal` at the top level of a plan response) are silently ignored and do not cause errors. *(Req 8)*
- [ ] **AC-36**: A unit test verifies the end-to-end reproduction from issue #37: `completePlan()` receives `{"tool": "formulate_plan", "goal": "restore energy", "steps": [{"order": 1, "description": "Observe the coffee machine...", "affordance": "observe"}, {"order": 2, "description": "Brew coffee...", "affordance": "brew_coffee"}]}` and returns a valid `FormulatePlanResult` with `description: "restore energy"`, two steps, and `steps[0].targetAffordance: "observe"`, `steps[1].targetAffordance: "brew_coffee"`. No `LLMResponseError` is thrown. *(Req 8)*

## Constraints

- **Package boundaries** (per ADR-0001): Changes are confined to `packages/cognition/src/llm/` (alias mapping, schema hint appending, `resolveField` utility), `packages/cognition/src/pper/` (builder `schemaHint` population), `packages/cognition/src/index.ts` (`LLMContextPayload` extension), and `packages/shared/src/schemas/llm-schemas.ts` (four new constants). No changes to `packages/engine/` or `packages/memory/`.
- **No external dependencies**: No new npm packages. The `resolveField` utility is pure TypeScript with no imports. Schema hint constants are plain strings.
- **Non-breaking**: The `LLMClient` interface, PPER service interfaces, `LLMContextPayload` existing fields, and all existing error class names are unchanged. `schemaHint` is optional. Alias mapping only activates when canonical fields are missing. Existing tests (specs 001–009) pass without modification.
- **Alias mapping is explicit, not fuzzy**: Only known aliases are mapped (e.g., `goal`→`description`, `affordance`→`targetAffordance`, `reason`→`reasoning`, `tool`→`action`). No Levenshtein distance, no fuzzy matching, no heuristic field name inference.
- **Schema hints are hand-written**: The four `*_SCHEMA_HINT` constants are hand-written strings, not auto-generated from JSON schema objects. This ensures clarity, readability, and exact control over what the LLM sees.
- **What NOT to do**:
  - Do not modify the `LLMClient` interface or PPER services.
  - Do not modify existing JSON schema objects or `JSON_INSTRUCTION_SUFFIX`.
  - Do not implement a generic schema-to-template generator.
  - Do not add alias mapping to `completeReflection()`.
  - Do not implement fuzzy field name matching.
  - Do not add new npm dependencies.
  - Do not add streaming support.
  - Do not modify the `response_format` selection logic from spec 009.
