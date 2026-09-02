# Implementation Notes — Spec 025 (Memory Entry Flatten & Auto-Fallback, Issue #99)

## Date: 2025-09-02

## What was implemented

### Shared layer (`@evol-hive/shared`)

- **`packages/shared/src/schemas/llm-schemas.ts`** —
  - **R1.1**: Replaced the nested `memoryEntry` property in `reflectSchema` with four top-level properties: `memoryContent` (string), `memoryImportance` (integer 1–10), `memoryType` (string enum: observation|reflection|action|interaction), `memoryLocation` (string, optional).
  - **R1.2**: Added `"memoryContent"` to the `required` array. `memoryImportance`, `memoryType`, `memoryLocation` remain optional.
  - **R1.3**: Removed the nested `memoryEntry` property from `reflectSchema` entirely (the schema is what the LLM sees).

- **`packages/shared/src/types/cognition.ts`** —
  - **R2.1**: Updated `ReflectLLMResponse` interface to add `memoryContent?: string`, `memoryImportance?: number`, `memoryType?: MemoryType`, `memoryLocation?: string`.
  - **R2.2**: Retained the legacy `memoryEntry?: MemoryEntryInput` field for backward compatibility (marked `@deprecated`).

### Cognition layer (`@evol-hive/cognition`)

- **`packages/cognition/src/llm/openai-client.ts`** —
  - **R3.1**: `completeReflect` now parses the flattened top-level fields (`memoryContent`, `memoryImportance`, `memoryType`, `memoryLocation`) from the LLM tool-call arguments and populates them on `ReflectLLMResponse`.
  - **R3.2**: When the LLM returns the legacy `memoryEntry` nested object, `completeReflect` extracts `content`, `importance`, `type`, and `location` from it and populates the flattened fields. Flattened fields take precedence over legacy `memoryEntry` when both are present.
  - **R3.3**: Defaults: `memoryImportance` defaults to `5` when missing/invalid (not an integer 1–10); `memoryType` defaults to `"observation"` when missing/invalid (not in enum); `memoryLocation` is `undefined` when missing.

- **`packages/cognition/src/pper/reflect-service.ts`** —
  - **R4.2**: When `memoryContent` is present and non-empty, `ReflectServiceImpl` constructs a `MemoryEntryInput` from the flattened fields (using defaults for missing optional fields) and calls `dataProvider.storeMemory`.
  - **R4.3**: When legacy `memoryEntry` is present but flattened fields are absent, uses `memoryEntry` (backward compatibility).
  - **R4.4**: Atomicity guarantee preserved — invalid legacy `memoryEntry` content causes the entire reflect result to fail with no partial updates.
  - **R5.1–R5.5**: Auto-fallback memory generation — when the LLM omits all memory fields, auto-generates a `MemoryEntryInput` from the execution result and agent state. Content: `"Idle tick — no action taken. Goal: {currentGoal}"` (stepSkipped), `"Action succeeded: {currentGoal}"` + drive changes (success), `"Action failed: {error}. Goal: {currentGoal}"` (failure). Importance: 3. Type: `"action"` (success) or `"observation"` (failure/stepSkipped). Location: agent's location.

- **`packages/cognition/src/pper/reflect-builder.ts`** —
  - **R6.1**: Updated `buildSystemPrompt` to reference flattened field names: "Include memoryContent in your reflect response to store a memory for future reference. Set memoryImportance (1-10), memoryType (observation|reflection|action|interaction), and optionally memoryLocation."

### Tests

- **`packages/shared/tests/spec-025-memory-entry-flatten-and-fallback.test.ts`** (new) — Tests for reflectSchema flattening (AC-4, AC-5) and ReflectLLMResponse type (AC-6).
- **`packages/cognition/tests/spec-025-memory-entry-flatten-and-fallback.test.ts`** (new) — Tests for completeReflect parsing (AC-7, AC-8, AC-9), ReflectServiceImpl with flattened fields (AC-10, AC-11, AC-12), auto-fallback (AC-13, AC-14, AC-15, AC-16), and system prompt (AC-17).
- **`packages/shared/tests/reflect-types.test.ts`** (updated) — Updated schema tests to check flattened fields instead of nested `memoryEntry`.
- **`packages/cognition/tests/reflect.test.ts`** (updated) — Updated AC-18 to use flattened fields, AC-19 and null/undefined response tests to expect auto-fallback, AC-26 to use flattened fields.

## Key design decisions

1. **Flattened fields take precedence over legacy `memoryEntry`** — In both `completeReflect` and `ReflectServiceImpl`, flattened fields are checked first. The legacy `memoryEntry` is a fallback for backward compatibility.
2. **Empty `memoryContent` triggers auto-fallback** — An empty or whitespace-only `memoryContent` is treated as "no memory provided", which triggers the auto-fallback. This is NOT a validation error (unlike empty `memoryEntry.content` which IS a validation error per the atomicity guarantee).
3. **Auto-fallback is the last resort** — It only triggers when both `memoryContent` is absent/empty AND `memoryEntry` is absent. When either is present and valid, the auto-fallback is suppressed.
4. **No new cognitive tools** — Solution D (separate `store_memory` tool) was rejected per the spec. The flatten + fallback approach is simpler and sufficient.

## Verification

- `pnpm test` — all 254 shared + 556 cognition + 570 engine + 91 memory + 79 examples + 16 visualizer + 4 CLI tests pass
- `pnpm typecheck` — passes
- `pnpm lint` — passes
- `pnpm format:check` — passes
- `pnpm build` — builds successfully