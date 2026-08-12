# Feature: Real OpenAI-Compatible LLM Client

## Context
- Architecture: [§7 — Structured Outputs](../architecture/07-structured-outputs.md) (grammar constraints / `response_format`), [§6 — PPER Loop](../architecture/06-pper-loop.md) (System 2 LLM calls), [§9 — Engine Routing](../architecture/09-engine-routing.md) (`isThinking`, async LLM), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (§11.3 background reflection/consolidation), [§5 — Fast-Path Classifier](../architecture/05-fast-path-classifier.md) (embedding provider pattern)
- Related specs: [001 — Perceive Phase](001-perceive-phase.md) (`LLMContextPayload`, `PerceptionBuilder`), [002 — Plan Phase](002-plan-phase.md) (`completePlan`, `formulatePlanSchema`), [003 — Execute Phase](003-execute-phase.md) (Execute produces `ExecuteResult`), [004 — Reflect Phase](004-reflect-phase.md) (`completeReflect`, `reflectSchema`), [005 — Game Loop Integration](005-game-loop-integration.md) (minimal scene, `MockLLMClient`)
- Package: `cognition` (primary — new `llm/` module), `shared` (new schema constant), `examples` (minimal scene wiring option)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md) (package boundaries: `cognition/llm/` is the designated LLM client directory)
- Issue: [#20](https://github.com/Redna/evol-hive/issues/20)

## Design Rationale

The OpenAI Chat Completions API (`/v1/chat/completions`) is the de facto standard for LLM inference servers. It is supported by virtually every local and hosted provider:

- **Ollama** — OpenAI-compatible mode at `http://localhost:11434/v1/`
- **vLLM** — native OpenAI-compatible server
- **llama.cpp** — `llama-server` exposes the OpenAI API
- **LM Studio, Together AI, Groq, Anyscale, etc.** — all OpenAI-compatible

A single `OpenAICompatibleLLMClient` implementation works across all providers with zero code changes — just config (base URL, model name, optional API key). Structured output uses the standard OpenAI `response_format` with `type: "json_schema"`.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`memoryConsolidationSchema` constant** — A new JSON schema constant `memoryConsolidationSchema` must be defined in `packages/shared/src/schemas/llm-schemas.ts` for the LLM's raw response during background memory consolidation (§11.3). This schema is used by the `completeReflection` method. It must enforce the shape:
   ```json
   {
     "type": "object",
     "properties": {
       "consolidatedMemories": {
         "type": "array",
         "items": {
           "type": "object",
           "properties": {
             "content": { "type": "string" },
             "importance": { "type": "integer", "minimum": 1, "maximum": 10 },
             "type": { "type": "string", "enum": ["observation", "reflection", "action", "interaction"] }
           },
           "required": ["content", "importance", "type"],
           "additionalProperties": false
         }
       },
       "consolidatedNodeIds": {
         "type": "array",
         "items": { "type": "string" }
       }
     },
     "additionalProperties": false
   }
   ```
   This follows the same grammar-constraint pattern as `llmActionResponseSchema`, `formulatePlanSchema`, and `reflectSchema` (§7). The LLM returns higher-level consolidated memory descriptions and the IDs of the low-level nodes that were consolidated (to be deprioritized).

### Cognition Layer (`@evol-hive/cognition`)

2. **`OpenAICompatibleLLMClient` class** — A concrete `OpenAICompatibleLLMClient` class must be implemented in `packages/cognition/src/llm/openai-client.ts` and exported from `packages/cognition/src/llm/index.ts` (and re-exported from `packages/cognition/src/index.ts`). It must implement the full `LLMClient` interface from `packages/cognition/src/index.ts`:
   ```typescript
   interface LLMClient {
     completeStructured(payload: LLMContextPayload): Promise<LLMActionResponse>;
     completeReflection(systemPrompt: string, memoryNodes: MemorySnippet[]): Promise<ReflectionResult>;
     completePlan(payload: LLMContextPayload): Promise<FormulatePlanResult>;
     completeReflect(payload: LLMContextPayload): Promise<ReflectLLMResponse>;
   }
   ```
   This replaces the `MockLLMClient` (which remains in `examples/minimal-scene.ts` for mock-based testing).

3. **`OpenAICompatibleLLMClientConfig` interface** — A new interface `OpenAICompatibleLLMClientConfig` must be defined in `packages/cognition/src/llm/openai-client.ts`:
   ```typescript
   interface OpenAICompatibleLLMClientConfig {
     /** OpenAI-compatible API base URL (default: http://localhost:11434/v1). */
     baseUrl: string;
     /** Model name to use for chat completions (e.g. "llama3.1", "gpt-4o"). */
     model: string;
     /** Optional API key for hosted providers. Local providers (Ollama, llama.cpp) ignore this. */
     apiKey?: string;
     /** Request timeout in milliseconds (default: 30000). */
     timeoutMs?: number;
     /** Max retry attempts on HTTP 429 rate limit (default: 3). */
     maxRetries?: number;
     /** Base delay between retries in milliseconds (default: 1000, exponential backoff). */
     retryDelayMs?: number;
     /** Optional embedding provider for constructing MemoryNode objects in completeReflection. */
     embeddingProvider?: EmbeddingProvider;
     /** Optional agent ID for the ReflectionResult returned by completeReflection. */
     agentId?: string;
   }
   ```
   The `EmbeddingProvider` is the one defined in `packages/cognition/src/classifier/embedding/index.ts` (the cognition-level embedding interface). It is optional — if not provided, `completeReflection` returns `newMemories` with empty `embedding` arrays (callers must fill embeddings later).

4. **OpenAI `/v1/chat/completions` request format** — The `OpenAICompatibleLLMClient` must call the OpenAI-compatible REST API at `${baseUrl}/v1/chat/completions` via `fetch`. The request body must be:
   ```json
   {
     "model": "<model name>",
     "messages": [
       { "role": "system", "content": "<systemPrompt>" },
       { "role": "user", "content": "<user message content>" }
     ],
     "response_format": {
       "type": "json_schema",
       "json_schema": {
         "name": "response",
         "schema": <JSON schema object>,
         "strict": true
       }
     },
     "stream": false
   }
   ```
   The `response_format.json_schema.schema` field is the JSON schema from the `LLMContextPayload.responseSchema` field (§7). This uses the standard OpenAI structured output format to constrain the model's output to the schema. The `stream` parameter must be `false` (non-streaming mode). The response is a JSON object: `{ choices: [{ message: { role: "assistant", content: "<JSON string>" } }] }`.

5. **Authorization header** — When `apiKey` is configured (non-empty string), the `OpenAICompatibleLLMClient` must include an `Authorization: Bearer <apiKey>` header in every request. When `apiKey` is not set or is empty, no authorization header is sent (local providers like Ollama and llama.cpp do not require it).

6. **User message construction** — The `OpenAICompatibleLLMClient` must construct the user message content from the `LLMContextPayload` fields. The user message must include:
   - The `perceptionContext` string verbatim.
   - A formatted list of `availableAffordances` (each affordance rendered as `id: <id>, label: <label>`), prefixed with "Available actions:".
   - A formatted list of `cognitiveTools` (each tool rendered as `name: <name>, description: <description>`), prefixed with "Cognitive tools:".
   When `availableAffordances` or `cognitiveTools` is empty, the corresponding section is omitted.

7. **`completeStructured` implementation** — The `completeStructured(payload)` method must:
   - Call the OpenAI-compatible API with `payload.responseSchema` wrapped in the standard `response_format` structure (Req 4).
   - Parse the `choices[0].message.content` field (a JSON string) into an `LLMActionResponse` object.
   - Validate that the parsed object has `reasoning` (string) and `action` (string) fields. If validation fails, throw an `LLMResponseError` (Req 13).
   - Return the validated `LLMActionResponse`.

8. **`completePlan` implementation** — The `completePlan(payload)` method must:
   - Call the OpenAI-compatible API with `payload.responseSchema` wrapped in the standard `response_format` structure (which will be `formulatePlanSchema`).
   - Parse the `choices[0].message.content` into a `FormulatePlanResult` object.
   - Validate that the parsed object has `description` (non-empty string) and `steps` (non-empty array). If validation fails, throw an `LLMResponseError`.
   - Return the validated `FormulatePlanResult`.

9. **`completeReflect` implementation** — The `completeReflect(payload)` method must:
   - Call the OpenAI-compatible API with `payload.responseSchema` wrapped in the standard `response_format` structure (which will be `reflectSchema`).
   - Parse the `choices[0].message.content` into a `ReflectLLMResponse` object.
   - No top-level fields are required (the LLM may return `{}`). If the parsed object is empty or all-optional, return it as-is.
   - Return the `ReflectLLMResponse`.

10. **`completeReflection` implementation** — The `completeReflection(systemPrompt, memoryNodes)` method must:
    - Construct a user message listing the memory snippets (each rendered as `id: <id>, content: <content>, importance: <importance>`).
    - Call the OpenAI-compatible API with the `memoryConsolidationSchema` (Req 1) wrapped in the standard `response_format` structure and a system prompt instructing the LLM to consolidate the memory nodes into higher-level insights.
    - Parse the `choices[0].message.content` into the consolidation result.
    - For each item in `consolidatedMemories`, construct a `MemoryNode` with: a generated `id` (e.g. `mem_consolidated_<timestamp>_<counter>`), `agentId` from the config (or empty string if not set), `content` from the LLM output, `embedding` from `embeddingProvider.embed(content)` (or empty array `[]` if no embedding provider is configured), `timestamp` from `Date.now()`, `importance` from the LLM output, and `type` from the LLM output.
    - Return a `ReflectionResult` with `agentId`, `newMemories` (the constructed `MemoryNode[]`), and `consolidatedNodeIds` (from the LLM output).
    - If no `embeddingProvider` is configured, the `MemoryNode.embedding` field is `[]`. Callers are responsible for filling embeddings before storing to a `VectorStore`.

11. **Timeout handling** — The `OpenAICompatibleLLMClient` must enforce a configurable timeout on every HTTP request using `AbortController`. If the request does not complete within `timeoutMs` (default 30000ms), the `fetch` must be aborted and an `LLMTimeoutError` must be thrown. The `AbortController` must be created per request (not shared). The `signal` must be passed to the `fetch` call. On timeout, any in-flight request is cancelled.

12. **Rate limit (HTTP 429) handling** — When the API returns HTTP 429 (Too Many Requests), the `OpenAICompatibleLLMClient` must retry the request up to `maxRetries` times (default 3) with exponential backoff: delay = `retryDelayMs * 2^attempt` (e.g., 1000ms, 2000ms, 4000ms). If all retries are exhausted, an `LLMRateLimitError` must be thrown. The retry logic must apply to all four `LLMClient` methods. Other non-2xx HTTP status codes (4xx except 429, 5xx) must throw an `LLMHTTPError` with the status code and response body.

13. **Invalid JSON handling** — When the API response `choices[0].message.content` cannot be parsed as valid JSON (e.g., the model returned prose despite the schema constraint), the `OpenAICompatibleLLMClient` must throw an `LLMResponseError` with a message indicating the parse failure and including the raw content for debugging. This error must be distinguishable from `LLMTimeoutError` and `LLMHTTPError` via `instanceof` checks.

14. **Error type hierarchy** — The `OpenAICompatibleLLMClient` must define and export custom error classes from `packages/cognition/src/llm/openai-client.ts`:
    ```typescript
    class LLMError extends Error { ... }
    class LLMTimeoutError extends LLMError { ... }
    class LLMHTTPError extends LLMError {
      readonly statusCode: number;
      readonly responseBody: string;
      ...
    }
    class LLMRateLimitError extends LLMHTTPError { ... }
    class LLMResponseError extends LLMError {
      readonly rawContent?: string;
      ...
    }
    ```
    All extend a common `LLMError` base class. `LLMRateLimitError` extends `LLMHTTPError` (with `statusCode: 429`). This allows callers to catch `LLMError` broadly or specific subtypes precisely. The PPER services (`PlanServiceImpl`, `ReflectServiceImpl`, `ExecuteServiceImpl`) already catch all exceptions via `try/catch` and return failure results, so the error types are for logging and debugging.

15. **Low-level request method** — A private method `requestChat(messages, responseSchema)` (or similar) must be shared by all four `LLMClient` methods. This method handles the HTTP request, authorization header, timeout, retries, JSON parsing, and error handling. It constructs the `response_format` wrapper from the schema, sends the request, and returns the parsed JSON object (`Record<string, unknown>`) from `choices[0].message.content`. Each public method then casts/validates this object to the appropriate typed interface.

16. **Export structure** — The `packages/cognition/src/llm/` directory must have an `index.ts` barrel file exporting:
    - `OpenAICompatibleLLMClient`
    - `OpenAICompatibleLLMClientConfig`
    - `LLMError`, `LLMTimeoutError`, `LLMHTTPError`, `LLMRateLimitError`, `LLMResponseError`
    The `packages/cognition/src/index.ts` barrel must re-export everything from `./llm/index.js`. This follows the existing pattern where `index.ts` re-exports sub-module barrels (`./pper/`, `./tools/`, `./guardrails/`, `./schemas/`, `./classifier/`).

17. **No modification to `LLMClient` interface** — The existing `LLMClient` interface in `packages/cognition/src/index.ts` must not be modified. The `OpenAICompatibleLLMClient` implements it as-is. No new methods are added to the interface.

18. **No modification to PPER services** — The existing `PlanServiceImpl`, `ReflectServiceImpl`, `PerceptionServiceImpl`, `ExecuteServiceImpl`, and `PPEROrchestratorImpl` must not be modified. They already consume the `LLMClient` interface and catch all exceptions — they work with `OpenAICompatibleLLMClient` transparently.

### Minimal Scene (`examples/`)

19. **Real LLM option in minimal scene** — The `examples/minimal-scene.ts` must be updated to support running with a real LLM when an environment variable `USE_REAL_LLM=true` (or similar) is set. When `USE_REAL_LLM` is not set, the existing `MockLLMClient` is used (no behavior change). When `USE_REAL_LLM=true`, the scene constructs an `OpenAICompatibleLLMClient` with:
    - `baseUrl` from `process.env['LLM_BASE_URL'] ?? 'http://localhost:11434/v1'`
    - `model` from `process.env['LLM_MODEL'] ?? 'llama3.1'`
    - `apiKey` from `process.env['LLM_API_KEY']` (optional — only set if the env var is present)
    - Default timeout and retry settings.
    The `MockLLMClient` class must remain in the file (it is used by tests and the default mock-based run). The conditional wiring must be in the `buildMinimalEngine()` function (or a new `buildMinimalEngineWithLLM(llmClient)` variant).

20. **Extended simulation time for real LLM** — When `USE_REAL_LLM=true`, the `main()` function's `setTimeout` wait must be extended from 200ms to a configurable duration (e.g., `process.env['SCENE_DURATION_MS'] ?? '5000'`) to allow for LLM latency. The mock path retains the 200ms wait. This is because a real LLM may take 1–5 seconds per request.

### Cross-Cutting

21. **Package boundaries** (per ADR-0001) — The `OpenAICompatibleLLMClient` lives in `packages/cognition/src/llm/`. It imports from `@evol-hive/shared` (for `LLMActionResponse`, `FormulatePlanResult`, `ReflectLLMResponse`, `ReflectionResult`, `MemoryNode`, `MemorySnippet`, `MemoryType`, and the schema constants). It uses the cognition-level `EmbeddingProvider` from `../classifier/embedding/index.js` for the optional embedding generation in `completeReflection`. It must not import from `@evol-hive/engine`, `@evol-hive/memory` (implementations), or any external HTTP library — it uses the built-in `fetch` API (available in Node 18+). No new npm dependencies are added.

22. **No external dependencies** — The `OpenAICompatibleLLMClient` must use the built-in `fetch` API (global in Node 18+ and Bun). No `axios`, `node-fetch`, or other HTTP client library may be added as a dependency. The `AbortController` is also a built-in global. This keeps the dependency footprint minimal and aligns with the lean monorepo philosophy (ADR-0001).

23. **Structured output via standard OpenAI `response_format`** — The OpenAI-compatible `/v1/chat/completions` endpoint supports structured output via the `response_format` parameter with `type: "json_schema"`. When `response_format` is set to `{ type: "json_schema", json_schema: { name: "response", schema: <schema>, strict: true } }`, the provider constrains the model's output to that schema (§7). The `OpenAICompatibleLLMClient` wraps the `LLMContextPayload.responseSchema` in this standard structure. The schemas are already defined as plain JSON schema objects (`llmActionResponseSchema`, `formulatePlanSchema`, `reflectSchema`) — no transformation of the schema itself is needed, only wrapping in the `response_format` envelope. The `memoryConsolidationSchema` (Req 1) follows the same pattern.

24. **Graceful degradation** — All error types (`LLMTimeoutError`, `LLMHTTPError`, `LLMRateLimitError`, `LLMResponseError`) are thrown to the caller. The PPER services already have `try/catch` blocks that catch any error and return a `success: false` result with the error message. The agent's `isThinking` flag is reset to `false` in the `finally` block of each service. No special error handling is needed in the PPER services for the new error types — the existing `catch (err)` blocks handle them generically.

25. **Testability** — The `OpenAICompatibleLLMClient` must be designed for unit testing without a real LLM server. Tests should be able to:
    - Inject a custom `baseUrl` pointing to a test server (or `MockServer`/`msw` mock).
    - Inject short timeouts to test timeout behavior.
    - Assert error types via `instanceof`.
    - Assert that the correct `response_format` schema is sent in the request body.
    The unit tests must not require a running LLM instance. Integration tests (if any) that require a real LLM instance must be skipped when `LLM_BASE_URL` is not reachable (or gated behind a `LLM_INTEGRATION=true` env flag).

26. **Provider compatibility** — The `OpenAICompatibleLLMClient` is designed to work with any OpenAI-compatible inference server. The default `baseUrl` of `http://localhost:11434/v1` targets a local Ollama instance in OpenAI-compatibility mode. Users can point to vLLM (`http://localhost:8000/v1`), llama.cpp (`http://localhost:8080/v1`), or hosted providers (e.g., `https://api.openai.com/v1`, `https://api.groq.com/openai/v1`) by changing the config. The `apiKey` field enables authentication for hosted providers.

27. **What NOT to do**:
    - Do not modify the `LLMClient` interface — it is already defined and used by the PPER services.
    - Do not modify the existing PPER services (`PlanServiceImpl`, `ReflectServiceImpl`, `PerceptionServiceImpl`, `ExecuteServiceImpl`, `PPEROrchestratorImpl`).
    - Do not implement provider-specific backends (Ollama native API, vLLM native API, llama.cpp native API) — only the OpenAI-compatible API is in scope. The `llm/` directory structure should accommodate future provider-specific clients if needed, but only `OpenAICompatibleLLMClient` is implemented here.
    - Do not implement the background reflection/consolidation loop (§11.3) orchestration — only the `completeReflection` method on the LLM client is in scope. The loop that calls it (threshold detection, scheduling) is a separate spec.
    - Do not implement an embedding model — the `EmbeddingProvider` is injected. A real embedding model (e.g., Ollama embeddings API) is a separate concern from the LLM chat client.
    - Do not add streaming support — all requests use `stream: false`. Streaming is a future enhancement.
    - Do not add prompt templating or system prompt management — the system prompt comes from the `LLMContextPayload.systemPrompt` field, which is already constructed by the `PerceptionBuilder`, `PlanBuilder`, and `ReflectBuilder`.
    - Do not implement rate limiting on the client side (the `LLMConcurrencyManager` from §9 is a separate concern). The retry logic here is only for handling HTTP 429 responses.
    - Do not add new npm dependencies.

## Acceptance Criteria

- [ ] **AC-1**: `memoryConsolidationSchema` is defined in `packages/shared/src/schemas/llm-schemas.ts` as a JSON schema object with `consolidatedMemories` (array of `{ content, importance, type }` objects) and `consolidatedNodeIds` (array of strings). `additionalProperties: false` at all levels. *(Req 1)*
- [ ] **AC-2**: `OpenAICompatibleLLMClient` class is defined in `packages/cognition/src/llm/openai-client.ts` and exported from `packages/cognition/src/llm/index.ts` and re-exported from `packages/cognition/src/index.ts`. *(Req 2, Req 16)*
- [ ] **AC-3**: `OpenAICompatibleLLMClient` implements all four methods of the `LLMClient` interface: `completeStructured`, `completeReflection`, `completePlan`, and `completeReflect`. TypeScript compilation confirms the interface is satisfied (no missing methods). *(Req 2)*
- [ ] **AC-4**: `OpenAICompatibleLLMClientConfig` is defined in `packages/cognition/src/llm/openai-client.ts` with fields `baseUrl`, `model`, `apiKey?`, `timeoutMs?`, `maxRetries?`, `retryDelayMs?`, `embeddingProvider?`, and `agentId?`. *(Req 3)*
- [ ] **AC-5**: When `OpenAICompatibleLLMClient` is constructed with `{ baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' }` (no optional fields), the defaults are `timeoutMs=30000`, `maxRetries=3`, `retryDelayMs=1000`, `apiKey=undefined`. *(Req 3)*
- [ ] **AC-6**: `OpenAICompatibleLLMClient.completeStructured(payload)` sends a POST request to `http://localhost:11434/v1/chat/completions` with a body containing `model`, `messages` (system + user), `response_format` (set to `{ type: "json_schema", json_schema: { name: "response", schema: payload.responseSchema, strict: true } }`), and `stream: false`. *(Req 4, Req 7)*
- [ ] **AC-7**: `OpenAICompatibleLLMClient.completeStructured(payload)` parses the `choices[0].message.content` field from the response into an `LLMActionResponse` with `reasoning` and `action` fields. *(Req 7)*
- [ ] **AC-8**: `OpenAICompatibleLLMClient.completePlan(payload)` parses the `choices[0].message.content` field into a `FormulatePlanResult` with `description` and `steps` fields. *(Req 8)*
- [ ] **AC-9**: `OpenAICompatibleLLMClient.completeReflect(payload)` parses the `choices[0].message.content` field into a `ReflectLLMResponse`. When the LLM returns an empty object `{}`, the method returns `{}` (no fields set). *(Req 9)*
- [ ] **AC-10**: `OpenAICompatibleLLMClient.completeReflection(systemPrompt, memoryNodes)` sends a request with `memoryConsolidationSchema` wrapped in the `response_format` structure and constructs `MemoryNode` objects for each consolidated memory returned by the LLM. *(Req 10)*
- [ ] **AC-11**: When `embeddingProvider` is configured, `completeReflection` generates embeddings for new memories via `embeddingProvider.embed(content)`. When `embeddingProvider` is not configured, `MemoryNode.embedding` is `[]`. *(Req 10)*
- [ ] **AC-12**: When `apiKey` is configured, every request includes an `Authorization: Bearer <apiKey>` header. When `apiKey` is not set, no authorization header is sent. *(Req 5)*
- [ ] **AC-13**: When a request exceeds `timeoutMs`, an `LLMTimeoutError` is thrown. The error message includes the timeout duration and the request URL. *(Req 11)*
- [ ] **AC-14**: When the API returns HTTP 429, the `OpenAICompatibleLLMClient` retries up to `maxRetries` times with exponential backoff (`retryDelayMs * 2^attempt`). After exhausting retries, an `LLMRateLimitError` is thrown. *(Req 12)*
- [ ] **AC-15**: When the API returns a non-429 error status (e.g., 404, 500), an `LLMHTTPError` is thrown with `statusCode` and `responseBody` fields. *(Req 12)*
- [ ] **AC-16**: When `choices[0].message.content` cannot be parsed as valid JSON, an `LLMResponseError` is thrown with a `rawContent` field containing the unparsed string. *(Req 13)*
- [ ] **AC-17**: `LLMError` is a base class. `LLMTimeoutError`, `LLMHTTPError`, `LLMRateLimitError`, and `LLMResponseError` all extend `LLMError`. `LLMRateLimitError` extends `LLMHTTPError`. `instanceof` checks work: `err instanceof LLMError` is `true` for all subtypes. *(Req 14)*
- [ ] **AC-18**: All five error classes (`LLMError`, `LLMTimeoutError`, `LLMHTTPError`, `LLMRateLimitError`, `LLMResponseError`) are exported from `packages/cognition/src/llm/openai-client.ts` and re-exported from `packages/cognition/src/index.ts`. *(Req 14, Req 16)*
- [ ] **AC-19**: A single private method handles the HTTP request, authorization header, timeout, retry, `response_format` construction, and JSON parsing for all four `LLMClient` methods. No duplicated fetch logic across methods. *(Req 15)*
- [ ] **AC-20**: The user message content includes the `perceptionContext` string, formatted affordance list, and formatted cognitive tool list. When `availableAffordances` is empty, the affordance section is omitted. When `cognitiveTools` is empty, the tools section is omitted. *(Req 6)*
- [ ] **AC-21**: `packages/cognition/src/llm/index.ts` exports `OpenAICompatibleLLMClient`, `OpenAICompatibleLLMClientConfig`, and all error classes. `packages/cognition/src/index.ts` re-exports from `./llm/index.js`. *(Req 16)*
- [ ] **AC-22**: The `LLMClient` interface in `packages/cognition/src/index.ts` is unchanged — no methods added or removed. *(Req 17)*
- [ ] **AC-23**: No existing PPER service files (`plan-service.ts`, `reflect-service.ts`, `execute-service.ts`, `perception-builder.ts`, `plan-builder.ts`, `reflect-builder.ts`, `orchestrator.ts`) are modified. *(Req 18)*
- [ ] **AC-24**: When `USE_REAL_LLM=true` and `LLM_MODEL=llama3.1` are set, `examples/minimal-scene.ts` constructs an `OpenAICompatibleLLMClient` instead of `MockLLMClient` and passes it to `createPPEROrchestrator`. *(Req 19)*
- [ ] **AC-25**: When `USE_REAL_LLM` is not set, `examples/minimal-scene.ts` uses `MockLLMClient` exactly as before — no behavioral change. *(Req 19)*
- [ ] **AC-26**: When `USE_REAL_LLM=true`, the simulation wait duration is configurable via `SCENE_DURATION_MS` (default 5000ms). When `USE_REAL_LLM` is not set, the wait remains 200ms. *(Req 20)*
- [ ] **AC-27**: `OpenAICompatibleLLMClient` does not import from `@evol-hive/engine` or `@evol-hive/memory`. It imports from `@evol-hive/shared` and `../classifier/embedding/index.js` only. *(Req 21)*
- [ ] **AC-28**: No new npm dependencies are added to `packages/cognition/package.json`. The implementation uses only the built-in `fetch` and `AbortController`. *(Req 22)*
- [ ] **AC-29**: The `response_format` in the request body is set to `{ type: "json_schema", json_schema: { name: "response", schema: <schema>, strict: true } }` where `<schema>` is the `payload.responseSchema` object. *(Req 23)*
- [ ] **AC-30**: Unit tests for `OpenAICompatibleLLMClient` exist in `packages/cognition/tests/openai-client.test.ts` (or similar). Tests mock the `fetch` API and do not require a running LLM instance. *(Req 25)*
- [ ] **AC-31**: A unit test verifies that when `fetch` returns a 429 status, the client retries `maxRetries` times before throwing `LLMRateLimitError`. *(Req 12, Req 25)*
- [ ] **AC-32**: A unit test verifies that when `fetch` is aborted (timeout), `LLMTimeoutError` is thrown. *(Req 11, Req 25)*
- [ ] **AC-33**: A unit test verifies that when `choices[0].message.content` is not valid JSON, `LLMResponseError` is thrown with `rawContent` set to the raw string. *(Req 13, Req 25)*
- [ ] **AC-34**: A unit test verifies that `completeStructured` sends the `llmActionResponseSchema` wrapped in `response_format` and correctly parses a valid response. *(Req 7, Req 25)*
- [ ] **AC-35**: A unit test verifies that `completePlan` sends the `formulatePlanSchema` wrapped in `response_format` and correctly parses a valid response. *(Req 8, Req 25)*
- [ ] **AC-36**: A unit test verifies that `completeReflect` sends the `reflectSchema` wrapped in `response_format` and correctly parses a valid response including the empty-object case. *(Req 9, Req 25)*

## Constraints

- **Package boundaries** (per ADR-0001): The `OpenAICompatibleLLMClient` lives in `packages/cognition/src/llm/`. It imports from `@evol-hive/shared` and `../classifier/embedding/index.js` only. It must not import from `@evol-hive/engine` or `@evol-hive/memory` implementations. The ADR-0001 package layout explicitly designates `cognition/llm/` as the LLM client directory.
- **No external dependencies**: Use the built-in `fetch` and `AbortController` globals. No HTTP client library (`axios`, `node-fetch`, `got`) may be added. This keeps the dependency footprint minimal and works in both Node 18+ and Bun runtimes.
- **Structured output via standard OpenAI `response_format`**: The OpenAI-compatible `/v1/chat/completions` endpoint accepts `response_format: { type: "json_schema", json_schema: { name: "response", schema: <schema>, strict: true } }` to constrain output. The schemas (`llmActionResponseSchema`, `formulatePlanSchema`, `reflectSchema`, `memoryConsolidationSchema`) are already plain JSON schema objects — they are wrapped in the `response_format` envelope with no transformation of the schema itself (§7).
- **Non-streaming mode**: All requests use `stream: false`. The response is a single JSON object, not a stream of chunks. Streaming is a future enhancement.
- **Error propagation**: All errors are thrown to the caller. The PPER services already catch all exceptions in `try/catch` blocks and return `success: false` results with the error message. The `isThinking` flag is always reset in the `finally` block. No special handling is needed in the services for the new error types.
- **Retry only on 429**: Only HTTP 429 (Too Many Requests) triggers retries. Other HTTP errors (4xx, 5xx) are thrown immediately as `LLMHTTPError`. Timeouts are thrown immediately as `LLMTimeoutError` (no retry on timeout). Invalid JSON is thrown immediately as `LLMResponseError` (no retry — the model failed to follow the schema, retrying is unlikely to help).
- **Interface-first pattern**: Follow the existing pattern — the `LLMClient` interface is already defined in `packages/cognition/src/index.ts`. The `OpenAICompatibleLLMClient` implements it without modifying it. New types (`OpenAICompatibleLLMClientConfig`, error classes) are defined alongside the implementation class.
- **Mock coexistence**: The `MockLLMClient` in `examples/minimal-scene.ts` must remain. It is used by the existing tests and the default mock-based scene run. The `OpenAICompatibleLLMClient` is an alternative implementation, not a replacement.
- **Provider-agnostic**: The client uses the standard OpenAI Chat Completions API (`/v1/chat/completions`) with `response_format` for structured output. This works with any OpenAI-compatible server (Ollama, vLLM, llama.cpp, LM Studio, hosted providers). No provider-specific API endpoints or parameters are used.
- **What NOT to do**:
  - Do not modify the `LLMClient` interface or any PPER service.
  - Do not implement provider-specific native APIs (Ollama `/api/chat`, vLLM guided_json, llama.cpp GBNF) — only the OpenAI-compatible API.
  - Do not implement the background reflection/consolidation loop orchestration.
  - Do not implement an embedding model — inject `EmbeddingProvider`.
  - Do not add streaming support.
  - Do not add prompt templating or system prompt management.
  - Do not implement client-side rate limiting (`LLMConcurrencyManager` is separate).
  - Do not add new npm dependencies.
