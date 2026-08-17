# Feature: LLM JSON Response Recovery & Provider-Aware Structured Output

## Context
- Architecture: [§7 — Structured Outputs](../architecture/07-structured-outputs.md) (grammar constraints / `response_format`), [§6 — PPER Loop](../architecture/06-pper-loop.md) (System 2 LLM calls), [§9 — Engine Routing](../architecture/09-engine-routing.md) (error propagation)
- Related specs: [006 — OpenAI-Compatible LLM Client](006-openai-compatible-llm-client.md) (the `requestChat` method and `response_format` construction being modified), [002 — Plan Phase](002-plan-phase.md) (`PlanBuilder` system prompt and `formulatePlanSchema`), [008 — PPER Error Recovery](008-pper-error-recovery.md) (retry/backoff, `retryOnTimeout`), [004 — Reflect Phase](004-reflect-phase.md) (`reflectSchema`, `ReflectBuilder` system prompt)
- Package: `cognition` (primary — `llm/openai-client.ts`), `shared` (schema prompt suffix constants)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#34](https://github.com/Redna/evol-hive/issues/34)

## Design Rationale

The `OpenAICompatibleLLMClient.requestChat()` (spec 006) sends `response_format: { type: "json_schema", json_schema: { ... } }` and immediately `JSON.parse()`s the response content. This works with OpenAI's hosted API and with some local models on Ollama. However, **Ollama does not properly enforce `json_schema` for cloud-backed models** (e.g., `kimi-k2.6:cloud`). The LLM returns plain text wrapped in XML-like tags:

```
<formulate_plan>
Goal: Restore energy...
Steps:
1. [observe] ...
</formulate_plan>
```

`JSON.parse()` throws, `LLMResponseError` propagates through `completePlan()` → `PlanService.plan()` → `PPEROrchestrator.runCycle()`, and the cycle aborts before Execute or Reflect. The agent's energy drains to 0 and no action is ever executed.

This spec introduces a **multi-layered recovery strategy**:

1. **JSON extraction** — When `JSON.parse(content)` fails, attempt to extract a JSON object from the text using a regex-based extractor before giving up.
2. **Re-prompt with explicit instructions** — If extraction fails, send a second request to the LLM with a stronger system prompt ("Respond ONLY in valid JSON matching this schema") and a simpler `response_format: { type: "json_object" }` envelope (no schema), which Ollama enforces more reliably.
3. **Provider-aware format fallback** — When the `baseUrl` matches an Ollama instance (`localhost:11434`), prefer `response_format: { type: "json_object" }` (Ollama-native `"format": "json"`) instead of `json_schema`. This is configurable via a new `useJsonSchema` config flag (default: `true`; Ollama auto-detection sets it to `false` when the host matches).
4. **System prompt strengthening** — Append an explicit JSON instruction suffix to the system prompt in the `PlanBuilder`, `PerceptionBuilder`, and `ReflectBuilder` so the LLM is reminded to respond in JSON even if the backend doesn't enforce the schema.

The recovery is **non-breaking**: the `LLMClient` interface and PPER services are not modified. All changes are internal to `OpenAICompatibleLLMClient` and the builder classes.

## Requirements

### Cognition Layer (`@evol-hive/cognition`)

1. **JSON extraction from text responses** — When `JSON.parse(content)` fails inside `requestChat()`, the method must attempt to extract a JSON object from the raw content string before throwing `LLMResponseError`. The extraction logic must:
   - Search for the first `{` and the last `}` in the content string and attempt `JSON.parse()` on that substring.
   - If that fails, search for the first `[` and last `]` (array case) and attempt `JSON.parse()`.
   - If both fail, fall through to the re-prompt recovery (Req 2).
   If extraction succeeds, the extracted JSON object is returned as if `JSON.parse()` had succeeded normally. No error is thrown in this case.

2. **Re-prompt recovery on JSON parse failure** — When both direct `JSON.parse()` and JSON extraction (Req 1) fail, `requestChat()` must send a **single follow-up request** to the LLM with:
   - The same `messages` array, but with an additional user message appended: `"Your previous response was not valid JSON. Respond ONLY with a valid JSON object matching this structure: <schema summary>. Do not include any prose, markdown, or code fences."`
   - `response_format` set to `{ type: "json_object" }` (no `json_schema` envelope) — this is the simpler OpenAI format that Ollama enforces reliably.
   - The same timeout, authorization, and retry (429) logic as the original request.
   If the follow-up response parses successfully (either directly or via extraction per Req 1), return the parsed object. If it also fails, throw `LLMResponseError` with `rawContent` set to the follow-up response's raw content. The re-prompt is attempted at most **once** per original request (no recursive re-prompting).

3. **Provider-aware `response_format` selection** — A new optional config field `useJsonSchema` (default: `true`) must be added to `OpenAICompatibleLLMClientConfig`. When `true`, the `request_format` envelope is `{ type: "json_schema", json_schema: { name: "response", schema: <schema>, strict: true } }` (existing behavior, Req 4 of spec 006). When `false`, the `response_format` envelope is `{ type: "json_object" }` (no schema, no `strict`). Additionally, when the `baseUrl` hostname matches `localhost:11434` or `127.0.0.1:11434` and `useJsonSchema` is not explicitly set by the caller, the client must auto-detect Ollama and default `useJsonSchema` to `false`. Explicit `useJsonSchema: true` overrides auto-detection.

4. **`responseFormat` field on config** — A new optional config field `responseFormat` of type `'json_schema' | 'json_object' | 'auto'` (default: `'auto'`) must be added to `OpenAICompatibleLLMClientConfig`. This is the preferred configuration mechanism:
   - `'json_schema'` — always use `{ type: "json_schema", json_schema: { ... } }` (original behavior).
   - `'json_object'` — always use `{ type: "json_object" }`.
   - `'auto'` — use `json_schema` for non-Ollama providers, `json_object` for Ollama (auto-detected from `baseUrl`).
   The `useJsonSchema` boolean field (Req 3) is kept for backward compatibility. If both are set, `responseFormat` takes precedence. If only `useJsonSchema` is set, it maps to `'json_schema'` (true) or `'json_object'` (false). If neither is set, `'auto'` is used.

5. **Schema summary for re-prompt** — The `requestChat()` method must generate a human-readable summary of the response schema for the re-prompt message (Req 2). The summary must include the top-level property names, their types, and whether they are required. For nested objects, only the first level of properties is summarized. This summary is generated from the JSON schema object's `properties` and `required` fields. No external library is used — a simple recursive summary function is implemented inline.

6. **`LLMResponseError` enrichment** — When `LLMResponseError` is thrown after all recovery attempts fail, the error must include:
   - `rawContent`: the raw content from the **final** (re-prompt) response.
   - `originalRawContent`: the raw content from the **first** response that triggered recovery (new optional field on `LLMResponseError`).
   - `recoveryAttempted`: `true` (new optional boolean field on `LLMResponseError`).
   This allows callers and loggers to see both the original failed response and the recovery attempt.

7. **`LLMResponseError` new optional fields** — The `LLMResponseError` class must be extended with two new optional fields:
   ```typescript
   class LLMResponseError extends LLMError {
     readonly rawContent?: string;
     readonly originalRawContent?: string;   // NEW
     readonly recoveryAttempted?: boolean;    // NEW
   }
   ```
   These fields are optional and backward-compatible — existing code that checks `err instanceof LLMResponseError` and reads `rawContent` continues to work.

8. **Recovery opt-out** — A new optional config field `enableJsonRecovery` (default: `true`) must be added to `OpenAICompatibleLLMClientConfig`. When `false`, the JSON extraction (Req 1) and re-prompt (Req 2) are skipped — the original behavior (throw `LLMResponseError` immediately on parse failure) is preserved. This is useful for providers that reliably enforce `json_schema` (e.g., OpenAI hosted) where recovery adds unnecessary latency.

9. **No modification to `LLMClient` interface** — The `LLMClient` interface in `packages/cognition/src/index.ts` must not be modified. All recovery logic is internal to `requestChat()` and transparent to callers.

10. **No modification to PPER services** — `PlanServiceImpl`, `ReflectServiceImpl`, `PerceptionServiceImpl`, `ExecuteServiceImpl`, and `PPEROrchestratorImpl` must not be modified. They already catch all exceptions and return `{ success: false }` results. The recovery happens inside `requestChat()` before any error reaches the services.

### Builder System Prompt Strengthening (Cognition Layer)

11. **JSON instruction suffix on `PlanBuilderImpl`** — The `PlanBuilderImpl.build()` method must append the following suffix to the system prompt: `"\n\nIMPORTANT: Respond ONLY with a valid JSON object. Do not include any prose, markdown formatting, code fences, or XML tags. The JSON must match the provided schema exactly."` This ensures the LLM is explicitly instructed to produce JSON even if the backend does not enforce the schema.

12. **JSON instruction suffix on `PerceptionBuilder` (spec 001)** — The `PerceptionBuilder` (or equivalent builder that constructs the `LLMContextPayload` for the Perceive/Execute phase) must append the same JSON instruction suffix as Req 11 to its system prompt.

13. **JSON instruction suffix on `ReflectBuilder` (spec 004)** — The `ReflectBuilder.build()` method must append the same JSON instruction suffix as Req 11 to its system prompt.

14. **Shared JSON instruction constant** — A new exported constant `JSON_INSTRUCTION_SUFFIX` must be defined in `packages/shared/src/schemas/llm-schemas.ts` (or a new `packages/shared/src/constants/prompts.ts`). All three builders (Req 11, 12, 13) reference this constant instead of duplicating the string. This ensures consistency and future updates in one place.

### Shared Layer (`@evol-hive/shared`)

15. **`JSON_INSTRUCTION_SUFFIX` constant** — A new string constant `JSON_INSTRUCTION_SUFFIX` must be exported from `packages/shared/src/schemas/llm-schemas.ts` with the value: `"IMPORTANT: Respond ONLY with a valid JSON object. Do not include any prose, markdown formatting, code fences, or XML tags. The JSON must match the provided schema exactly."` This is the single source of truth for the JSON instruction appended to builder system prompts.

### Minimal Scene (`examples/`)

16. **Minimal scene config passthrough** — The `examples/minimal-scene.ts` must pass `responseFormat: 'auto'` and `enableJsonRecovery: true` (the defaults) to the `OpenAICompatibleLLMClient` constructor when `USE_REAL_LLM=true`. This is a no-op if the defaults are unchanged, but makes the configuration explicit and discoverable. The `LLM_RESPONSE_FORMAT` env var may optionally override the `responseFormat` config (values: `json_schema`, `json_object`, `auto`).

### Cross-Cutting

17. **Recovery is non-blocking to PPER cycle** — The total time for recovery (extraction + one re-prompt) must not exceed `timeoutMs * 2` (one timeout for the original request, one for the re-prompt). If the original request succeeds, no recovery overhead is incurred. If the original request fails JSON parsing, one additional LLM round-trip is added. This is acceptable because the alternative is a cycle abort with zero actions executed.

18. **Logging / observability** — When JSON recovery is triggered (extraction succeeds or re-prompt is attempted), the `requestChat()` method must log a warning via `console.warn` with: the original raw content (truncated to 500 chars), whether extraction succeeded, and whether re-prompt was attempted. This is a lightweight observability measure — a full logging framework is out of scope.

19. **Testability** — The JSON extraction logic must be testable in isolation. A new exported function `extractJsonFromText(content: string): { json: Record<string, unknown> } | null` must be exported from `packages/cognition/src/llm/openai-client.ts` (or a utility file `packages/cognition/src/llm/json-recovery.ts`). Unit tests must cover: valid JSON embedded in prose, JSON with surrounding XML tags, JSON array in text, no JSON present (returns null), and multiple JSON objects (extracts the first).

20. **Package boundaries** (per ADR-0001) — All changes are in `packages/cognition/src/llm/` (recovery logic, config fields, error class extension), `packages/cognition/src/pper/` (builder system prompt suffixes), and `packages/shared/src/schemas/` (new constant). No changes to `packages/engine/`. No new npm dependencies.

21. **No external dependencies** — The JSON extraction uses a simple string search (`indexOf('{')`, `lastIndexOf('}')`) and `JSON.parse()`. No regex library, no JSON repair library (e.g., `jsonrepair`, `dirty-json`). The extraction is intentionally simple — if it fails, the re-prompt path handles recovery.

22. **What NOT to do**:
   - Do not modify the `LLMClient` interface — recovery is internal to `OpenAICompatibleLLMClient`.
   - Do not modify any PPER service (`PlanServiceImpl`, `ReflectServiceImpl`, etc.).
   - Do not implement provider-specific native APIs (Ollama `/api/chat` with `"format": "json"`) — only the OpenAI-compatible API is used. The `json_object` format is still sent via the OpenAI-compatible `/v1/chat/completions` endpoint.
   - Do not implement recursive re-prompting — at most one re-prompt per original request.
   - Do not implement a JSON repair library or fuzzy JSON parsing — the extraction is simple substring-based.
   - Do not add streaming support.
   - Do not add new npm dependencies.
   - Do not modify the existing JSON schema objects (`llmActionResponseSchema`, `formulatePlanSchema`, `reflectSchema`, `memoryConsolidationSchema`).

## Acceptance Criteria

- [ ] **AC-1**: When `JSON.parse(content)` fails, `requestChat()` attempts to extract a JSON object by finding the first `{` and last `}` in the content and parsing that substring. If successful, the extracted object is returned. *(Req 1)*
- [ ] **AC-2**: When JSON extraction from `{...}` fails, `requestChat()` attempts to extract a JSON array by finding the first `[` and last `]` and parsing that substring. If successful, the extracted value is returned. *(Req 1)*
- [ ] **AC-3**: When both direct parse and extraction fail, `requestChat()` sends a single follow-up request with an additional user message containing a JSON instruction and the schema summary, using `response_format: { type: "json_object" }`. If the follow-up parses successfully, the result is returned. *(Req 2, Req 5)*
- [ ] **AC-4**: When the follow-up re-prompt also fails to produce valid JSON, `requestChat()` throws `LLMResponseError` with `rawContent` set to the re-prompt response, `originalRawContent` set to the first response's raw content, and `recoveryAttempted: true`. *(Req 2, Req 6)*
- [ ] **AC-5**: At most one re-prompt is attempted per original request — no recursive re-prompting. *(Req 2)*
- [ ] **AC-6**: `OpenAICompatibleLLMClientConfig` includes a new optional field `responseFormat` of type `'json_schema' | 'json_object' | 'auto'` with default `'auto'`. *(Req 4)*
- [ ] **AC-7**: When `responseFormat` is `'json_schema'`, the request body uses `{ type: "json_schema", json_schema: { name: "response", schema: <schema>, strict: true } }`. When `responseFormat` is `'json_object'`, the request body uses `{ type: "json_object" }`. *(Req 3, Req 4)*
- [ ] **AC-8**: When `responseFormat` is `'auto'` and `baseUrl` matches `localhost:11434` or `127.0.0.1:11434`, the client uses `{ type: "json_object" }`. When `responseFormat` is `'auto'` and `baseUrl` does not match Ollama, the client uses `{ type: "json_schema", ... }`. *(Req 3, Req 4)*
- [ ] **AC-9**: Explicit `responseFormat: 'json_schema'` overrides Ollama auto-detection — the client uses `json_schema` even when `baseUrl` is `localhost:11434`. *(Req 3, Req 4)*
- [ ] **AC-10**: The `useJsonSchema` boolean field (Req 3) remains functional for backward compatibility. `useJsonSchema: true` maps to `json_schema`, `useJsonSchema: false` maps to `json_object`. When both `responseFormat` and `useJsonSchema` are set, `responseFormat` takes precedence. *(Req 3, Req 4)*
- [ ] **AC-11**: `OpenAICompatibleLLMClientConfig` includes a new optional field `enableJsonRecovery` (default `true`). When `false`, JSON extraction and re-prompt are skipped — `LLMResponseError` is thrown immediately on parse failure (original spec 006 behavior). *(Req 8)*
- [ ] **AC-12**: The schema summary for the re-prompt message includes top-level property names, their types, and required fields from the JSON schema's `properties` and `required` keys. *(Req 5)*
- [ ] **AC-13**: `LLMResponseError` has new optional fields `originalRawContent?: string` and `recoveryAttempted?: boolean`. Existing code reading `rawContent` continues to work. `instanceof LLMResponseError` and `instanceof LLMError` checks are unaffected. *(Req 6, Req 7)*
- [ ] **AC-14**: A new exported function `extractJsonFromText(content: string): { json: Record<string, unknown> } | null` is available from `packages/cognition/src/llm/openai-client.ts`. It returns the extracted JSON object or `null` when no valid JSON is found. *(Req 19)*
- [ ] **AC-15**: `JSON_INSTRUCTION_SUFFIX` constant is exported from `packages/shared/src/schemas/llm-schemas.ts` with the exact value: `"IMPORTANT: Respond ONLY with a valid JSON object. Do not include any prose, markdown formatting, code fences, or XML tags. The JSON must match the provided schema exactly."` *(Req 14, Req 15)*
- [ ] **AC-16**: `PlanBuilderImpl.build()` appends `JSON_INSTRUCTION_SUFFIX` to the system prompt. *(Req 11)*
- [ ] **AC-17**: `PerceptionBuilder` (or equivalent) appends `JSON_INSTRUCTION_SUFFIX` to the system prompt. *(Req 12)*
- [ ] **AC-18**: `ReflectBuilder.build()` appends `JSON_INSTRUCTION_SUFFIX` to the system prompt. *(Req 13)*
- [ ] **AC-19**: When `USE_REAL_LLM=true`, `examples/minimal-scene.ts` passes `responseFormat: 'auto'` and `enableJsonRecovery: true` to `OpenAICompatibleLLMClient`. The `LLM_RESPONSE_FORMAT` env var, if set, overrides `responseFormat`. *(Req 16)*
- [ ] **AC-20**: When JSON recovery is triggered, `console.warn` is called with the truncated original raw content (≤500 chars), whether extraction succeeded, and whether re-prompt was attempted. *(Req 18)*
- [ ] **AC-21**: When `enableJsonRecovery` is `true` and the LLM returns a response with embedded JSON (e.g., `<formulate_plan>{...}</formulate_plan>`), `requestChat()` successfully extracts and returns the JSON without throwing. *(Req 1)*
- [ ] **AC-22**: When `enableJsonRecovery` is `true` and the LLM returns plain text with no JSON, `requestChat()` sends a re-prompt. If the re-prompt returns valid JSON, the result is returned without error. *(Req 2)*
- [ ] **AC-23**: The `LLMClient` interface in `packages/cognition/src/index.ts` is unchanged — no methods added or removed. *(Req 9)*
- [ ] **AC-24**: No PPER service files (`plan-service.ts`, `reflect-service.ts`, `execute-service.ts`, `perception-builder.ts`, `plan-builder.ts`, `reflect-builder.ts`, `orchestrator.ts`) are modified except for the builder system prompt suffix addition in `plan-builder.ts`, `reflect-builder.ts`, and the perception builder. *(Req 10)*
- [ ] **AC-25**: `OpenAICompatibleLLMClient` does not import from `@evol-hive/engine`. No new npm dependencies are added. *(Req 20, Req 21)*
- [ ] **AC-26**: A unit test verifies that `extractJsonFromText` returns a valid object when JSON is embedded in XML-like tags (e.g., `<formulate_plan>{"reasoning": "...", "action": "brew_coffee"}</formulate_plan>`). *(Req 19)*
- [ ] **AC-27**: A unit test verifies that `extractJsonFromText` returns `null` when no JSON object is present in the text. *(Req 19)*
- [ ] **AC-28**: A unit test verifies that `requestChat()` with `enableJsonRecovery: true` and a mock `fetch` that returns plain text on the first call and valid JSON on the second call (re-prompt) returns the parsed JSON without throwing. *(Req 2)*
- [ ] **AC-29**: A unit test verifies that `requestChat()` with `enableJsonRecovery: true` and a mock `fetch` that returns plain text on both calls throws `LLMResponseError` with `recoveryAttempted: true` and `originalRawContent` set. *(Req 2, Req 6)*
- [ ] **AC-30**: A unit test verifies that `requestChat()` with `enableJsonRecovery: false` and a mock `fetch` that returns plain text throws `LLMResponseError` immediately without a second `fetch` call. *(Req 8)*
- [ ] **AC-31**: A unit test verifies that when `responseFormat` is `'json_object'`, the request body's `response_format` is `{ type: "json_object" }` (no `json_schema` envelope). *(Req 3, Req 4)*
- [ ] **AC-32**: A unit test verifies that when `responseFormat` is `'auto'` and `baseUrl` is `http://localhost:11434/v1`, the request body's `response_format` is `{ type: "json_object" }`. *(Req 3, Req 4)*
- [ ] **AC-33**: A unit test verifies that when `responseFormat` is `'auto'` and `baseUrl` is `https://api.openai.com/v1`, the request body's `response_format` is `{ type: "json_schema", json_schema: { ... } }`. *(Req 3, Req 4)*
- [ ] **AC-34**: A unit test verifies that `PlanBuilderImpl.build()` system prompt ends with the `JSON_INSTRUCTION_SUFFIX` string. *(Req 11, Req 15)*
- [ ] **AC-35**: A unit test verifies that `ReflectBuilder.build()` system prompt ends with the `JSON_INSTRUCTION_SUFFIX` string. *(Req 13, Req 15)*
- [ ] **AC-36**: The existing spec 006 acceptance criteria remain passing — no regression in the base `OpenAICompatibleLLMClient` behavior when recovery is disabled and `responseFormat` is `json_schema`. *(Req 8, Req 22)*

## Constraints

- **Package boundaries** (per ADR-0001): Changes are confined to `packages/cognition/src/llm/` (recovery logic, config, error class), `packages/cognition/src/pper/` (builder prompt suffixes), and `packages/shared/src/schemas/` (new constant). No changes to `packages/engine/` or `packages/memory/`.
- **No external dependencies**: JSON extraction uses `String.indexOf`/`lastIndexOf` and `JSON.parse()` only. No `jsonrepair`, `dirty-json`, or regex library. The re-prompt uses the existing `fetch` infrastructure.
- **Non-breaking**: The `LLMClient` interface, PPER service interfaces, and all existing error class names are unchanged. New config fields are optional with backward-compatible defaults. Existing tests (spec 006, spec 008) must pass without modification.
- **Recovery budget**: At most one re-prompt per original request. Total worst-case latency is `2 * timeoutMs` (original + re-prompt). No recursive or multi-round recovery.
- **Provider-agnostic**: The `json_object` format is sent via the OpenAI-compatible `/v1/chat/completions` endpoint — not Ollama's native `/api/chat` with `"format": "json"`. The client remains provider-agnostic. Auto-detection is a convenience default, not a provider switch.
- **Observability without framework**: Recovery warnings use `console.warn`. A structured logging framework is out of scope. The warning includes enough context (truncated raw content, recovery path taken) for debugging.
- **What NOT to do**:
  - Do not modify the `LLMClient` interface or PPER services.
  - Do not implement Ollama native API (`/api/chat`) — only the OpenAI-compatible endpoint.
  - Do not implement recursive re-prompting or multi-round JSON repair.
  - Do not add a JSON repair library or fuzzy JSON parser.
  - Do not modify existing JSON schema objects.
  - Do not add streaming support.
  - Do not add new npm dependencies.
  - Do not implement a full logging/telemetry framework.
