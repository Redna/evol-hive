# Feature: Real ONNX Embedding Provider

## Context
- Architecture: [§5 — Fast-Path Classifier](../architecture/05-fast-path-classifier.md) (System 0, embedding model, cosine similarity pruning, `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` config), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (§11.1 dual-track injection — embeddings for associative memory, §11.2 weighted retrieval — `relevance` via cosine similarity)
- Related specs: [001 — Perceive Phase](001-perceive-phase.md) (`AffordanceClassifierImpl`, `EmbeddingProvider` interface in cognition), [004 — Reflect Phase](004-reflect-phase.md) (`MemoryStoreImpl`, `EmbeddingProvider` interface in memory), [005 — Game Loop Integration](005-game-loop-integration.md) (`MockEmbeddingProvider` in minimal scene), [006 — Real OpenAI-Compatible LLM Client](006-openai-compatible-llm-client.md) (optional `embeddingProvider` in `OpenAICompatibleLLMClient`)
- Package: `cognition` (primary — concrete `OnnxEmbeddingProvider` in `classifier/embedding/`), `memory` (consumer — `MemoryStoreImpl` uses `EmbeddingProvider`), `shared` (unified `EmbeddingProvider` interface if needed), `examples` (minimal scene wiring)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md) (package boundaries: `cognition/classifier/embedding/` is the designated embedding directory; System 0 is a cognition sub-module)
- Issue: [#21](https://github.com/Redna/evol-hive/issues/21)

## Design Rationale

The architecture document (§5) lists three candidate embedding backends: Model2Vec, ONNX Runtime, and Ollama embeddings. This spec implements **ONNX Runtime** as the first real provider because:

1. **No external service required** — unlike Ollama embeddings, the ONNX model runs in-process via `onnxruntime-node`. This aligns with the "self-contained, no infrastructure" philosophy of the minimal scene.
2. **Sub-100ms inference** — `gte-small` (a 384-dimensional, ~130M parameter model) runs in under 50ms on commodity hardware via ONNX Runtime, meeting the §5 "blazing-fast" requirement for System 0 affordance pruning (called every Perceive tick).
3. **Shared interface** — the existing codebase defines **two separate `EmbeddingProvider` interfaces**: one in `packages/cognition/src/classifier/index.ts` (with `embed`, `embedBatch`, `dimensions`) and one in `packages/memory/src/index.ts` (with `embed`, `dimensions`). The `OnnxEmbeddingProvider` must satisfy **both** interfaces so it can be used for both affordance pruning (System 0) and semantic memory search (MemoryStore).

The `gte-small` model produces 384-dimensional dense vectors, which matches the `dimensions = 384` already used by `MockEmbeddingProvider` in `examples/minimal-scene.ts`.

## Requirements

### Unified Embedding Provider

1. **`UnifiedEmbeddingProvider` interface** — A new interface must be defined in `packages/shared/src/types/embedding.ts` and exported from `packages/shared/src/index.ts`:
   ```typescript
   export interface UnifiedEmbeddingProvider {
     /** Embedding dimensionality (e.g. 384 for gte-small). */
     readonly dimensions: number;
     /** Generate an embedding vector for a single text input. */
     embed(text: string): Promise<number[]>;
     /** Batch embed multiple strings. Returns one vector per input, in order. */
     embedBatch(texts: string[]): Promise<number[][]>;
   }
   ```
   This is the canonical embedding interface. The cognition-level `EmbeddingProvider` (in `packages/cognition/src/classifier/index.ts`) and the memory-level `EmbeddingProvider` (in `packages/memory/src/index.ts`) are structurally compatible with this interface (cognition already has all three members; memory has `embed` and `dimensions` but not `embedBatch`). The `OnnxEmbeddingProvider` implements `UnifiedEmbeddingProvider`, which structurally satisfies both package-level interfaces.

2. **Add `embedBatch` to memory-level `EmbeddingProvider`** — The memory package's `EmbeddingProvider` interface (`packages/memory/src/index.ts`) must be extended to include `embedBatch(texts: string[]): Promise<number[][]>`. This aligns it with the cognition-level interface and the new `UnifiedEmbeddingProvider`. Existing implementations (`MockEmbeddingProvider` in `examples/minimal-scene.ts`, `FakeEmbeddingProvider` in tests) must be updated to include `embedBatch` (the `MockEmbeddingProvider` already has it; test fakes must add a trivial implementation).

### ONNX Embedding Provider (`@evol-hive/cognition`)

3. **`OnnxEmbeddingProvider` class** — A concrete `OnnxEmbeddingProvider` class must be implemented in `packages/cognition/src/classifier/embedding/onnx-provider.ts` and exported from `packages/cognition/src/classifier/embedding/index.ts` (and re-exported from `packages/cognition/src/classifier/index.ts` and `packages/cognition/src/index.ts`). It must implement the `UnifiedEmbeddingProvider` interface (and by structural compatibility, both the cognition-level and memory-level `EmbeddingProvider` interfaces).

4. **`OnnxEmbeddingProviderConfig` interface** — A new interface must be defined in `packages/cognition/src/classifier/embedding/onnx-provider.ts`:
   ```typescript
   export interface OnnxEmbeddingProviderConfig {
     /** Path to the ONNX model file (.onnx). */
     modelPath: string;
     /** Path to the tokenizer directory (containing tokenizer.json / vocab.txt). */
     tokenizerPath?: string;
     /** Maximum sequence length for tokenization (default: 512). */
     maxSeqLength?: number;
     /** Batch size for batch inference (default: 32). */
     batchSize?: number;
     /** Whether to normalize embeddings to unit length (default: true). */
     normalize?: boolean;
   }
   ```

5. **Model loading** — The `OnnxEmbeddingProvider` constructor must accept an `OnnxEmbeddingProviderConfig`. Model loading must be **lazy** — the ONNX inference session and tokenizer are loaded on the first call to `embed()` or `embedBatch()`, not in the constructor. This allows the provider to be constructed synchronously (matching the existing `MockEmbeddingProvider` pattern) and defers file I/O until actually needed. A `ready()` method must be provided to explicitly trigger loading (for pre-warming). Subsequent calls reuse the loaded session. If loading fails, an `EmbeddingModelError` must be thrown.

6. **Tokenization** — The provider must tokenize input text using a HuggingFace-compatible tokenizer (e.g., `@xenova/transformers` or a lightweight tokenizer library). The tokenizer is loaded from `tokenizerPath` (if provided) or inferred from the model directory. Tokenization must respect `maxSeqLength` (truncating longer sequences). The tokenized input (input_ids, attention_mask) is fed to the ONNX inference session.

7. **Inference** — The provider must run the ONNX model via `onnxruntime-node` (the Node.js binding for ONNX Runtime). The model's last hidden state is mean-pooled (averaged across the sequence dimension, weighted by the attention mask) to produce a single dense vector per input. When `normalize` is `true` (default), the vector is L2-normalized to unit length. This produces 384-dimensional vectors for `gte-small`.

8. **Batch embedding** — The `embedBatch(texts)` method must process inputs in batches of `batchSize` (default 32). Each batch is tokenized and run through the ONNX session as a single forward pass with batch dimension. Results are concatenated in order. An empty input array returns `[]`.

9. **Embedding dimensionality** — The `dimensions` property must return the model's output dimensionality (e.g., 384 for `gte-small`). This is determined after model loading (from the model's output shape or config). Before loading, it returns the configured/expected value (default 384). After loading, it returns the actual model output dimension.

10. **Error handling — model file not found** — If the ONNX model file at `modelPath` does not exist or cannot be read, an `EmbeddingModelError` must be thrown with a message indicating the file path. This error must be thrown on the first `embed()` / `embedBatch()` / `ready()` call (lazy loading), not in the constructor.

11. **Error handling — inference failure** — If the ONNX inference session fails to run (e.g., corrupted model, shape mismatch), an `EmbeddingModelError` must be thrown with the underlying error message. The provider must not silently return zero vectors.

12. **Error type** — A custom error class `EmbeddingModelError` must be defined and exported from `packages/cognition/src/classifier/embedding/onnx-provider.ts`:
    ```typescript
    export class EmbeddingModelError extends Error {
      readonly cause?: unknown;
      constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'EmbeddingModelError';
        this.cause = cause;
      }
    }
    ```

13. **Embedding cache** — The provider must include an in-memory LRU cache mapping text strings to their embedding vectors. Repeated calls to `embed()` with the same text return the cached vector without re-running inference. The cache has a configurable maximum size (default 1000 entries). When the cache is full, the least recently accessed entry is evicted. This is critical for System 0 affordance pruning, where the same affordance labels are embedded every Perceive tick.

### Wiring into AffordanceClassifier (System 0)

14. **`AffordanceClassifierImpl` works with `OnnxEmbeddingProvider`** — The existing `AffordanceClassifierImpl` in `packages/cognition/src/classifier/pruning/index.ts` already accepts an `EmbeddingProvider` in its constructor. The `OnnxEmbeddingProvider` must be compatible — it must satisfy the cognition-level `EmbeddingProvider` interface (which requires `embed`, `embedBatch`, `dimensions`). No changes to `AffordanceClassifierImpl` are needed. A test must verify that constructing an `AffordanceClassifierImpl` with an `OnnxEmbeddingProvider` type-checks and produces correct pruning results when the model is available.

### Wiring into MemoryStore (Memory)

15. **`MemoryStoreImpl` works with `OnnxEmbeddingProvider`** — The existing `MemoryStoreImpl` in `packages/memory/src/store/index.ts` already accepts an `EmbeddingProvider` in its constructor. The `OnnxEmbeddingProvider` must be compatible — it must satisfy the memory-level `EmbeddingProvider` interface (which after Req 2 requires `embed`, `embedBatch`, `dimensions`). No changes to `MemoryStoreImpl` are needed. A test must verify that constructing a `MemoryStoreImpl` with an `OnnxEmbeddingProvider` type-checks.

### Minimal Scene Integration (`examples/`)

16. **Real embedding option in minimal scene** — The `examples/minimal-scene.ts` must be updated to support running with a real ONNX embedding model when an environment variable `USE_REAL_EMBEDDINGS=true` is set. When `USE_REAL_EMBEDDINGS` is not set, the existing `MockEmbeddingProvider` is used (no behavior change). When `USE_REAL_EMBEDDINGS=true`, the scene constructs an `OnnxEmbeddingProvider` with:
    - `modelPath` from `process.env['EMBEDDING_MODEL_PATH']` (required when `USE_REAL_EMBEDDINGS=true`)
    - `tokenizerPath` from `process.env['EMBEDDING_TOKENIZER_PATH']` (optional — inferred from model directory if not set)
    - Default `maxSeqLength`, `batchSize`, `normalize` settings.
    The `OnnxEmbeddingProvider` must be used for both the `MemoryStore` (memory-level `EmbeddingProvider`) and the `AffordanceClassifier` (cognition-level `EmbeddingProvider`), replacing the `MockEmbeddingProvider` and the mock classifier respectively.

17. **Real classifier in minimal scene** — When `USE_REAL_EMBEDDINGS=true`, the `makeMockClassifier()` function must be replaced with a real `AffordanceClassifierImpl` constructed from the `OnnxEmbeddingProvider` and `defaultClassifierConfig()`. The classifier config is read from environment variables (`CLASSIFIER_TOP_K`, `CLASSIFIER_SIMILARITY_THRESHOLD`) with existing defaults.

### Export Structure

18. **Export from embedding barrel** — `packages/cognition/src/classifier/embedding/index.ts` must export `OnnxEmbeddingProvider`, `OnnxEmbeddingProviderConfig`, and `EmbeddingModelError`. The existing cognition barrel (`packages/cognition/src/classifier/index.ts` and `packages/cognition/src/index.ts`) must re-export these.

### Cross-Cutting

19. **Package boundaries** (per ADR-0001) — The `OnnxEmbeddingProvider` lives in `packages/cognition/src/classifier/embedding/`. It imports from `@evol-hive/shared` (for `UnifiedEmbeddingProvider`) and from `onnxruntime-node` (external dependency) and a tokenizer library (external dependency). It must not import from `@evol-hive/engine` or `@evol-hive/memory`.

20. **New npm dependencies** — The following dependencies are added to `packages/cognition/package.json`:
    - `onnxruntime-node` — Node.js binding for ONNX Runtime (model inference)
    - `@xenova/transformers` (or equivalent lightweight tokenizer) — for HuggingFace-compatible tokenization
    
    These are the first external runtime dependencies in the `cognition` package. They are justified because ONNX inference and tokenization cannot reasonably be reimplemented from scratch. The dependencies are scoped to the `cognition` package only.

21. **Model file management** — The ONNX model file (`gte-small.onnx`) and tokenizer files are **not** committed to the repository (they are too large for git). A `scripts/download-embedding-model.sh` (or `.ts`) script must be provided that downloads the model and tokenizer from HuggingFace Hub to a configurable directory (default `models/gte-small/`). The `EMBEDDING_MODEL_PATH` environment variable points to the downloaded file. The `.gitignore` must exclude the `models/` directory.

22. **Testability** — The `OnnxEmbeddingProvider` must be designed for unit testing without a real ONNX model file:
    - Tests must be able to inject a mock ONNX session (via constructor injection or a factory function) to verify tokenization, pooling, normalization, and caching logic.
    - Tests that require a real model file must be skipped when the model is not present (gated behind `EMBEDDING_MODEL_PATH` env check or a `RUN_INTEGRATION=true` flag).
    - The error handling tests (model not found, inference failure) must not require a real model.

23. **What NOT to do**:
    - Do not modify the `AffordanceClassifierImpl` or `MemoryStoreImpl` — they already consume the `EmbeddingProvider` interface. The `OnnxEmbeddingProvider` is a drop-in replacement.
    - Do not implement other embedding backends (Ollama embeddings, Model2Vec) — only ONNX Runtime is in scope. The embedding directory structure should accommodate future providers, but only `OnnxEmbeddingProvider` is implemented here.
    - Do not implement the retrieval engine (`RetrievalEngine`) or the associative memory injector (`MemoryInjector`) — those are separate specs. This spec only provides the embedding provider that those components will consume.
    - Do not modify the PPER services or orchestrator — they do not directly use `EmbeddingProvider`.
    - Do not remove or break the `MockEmbeddingProvider` — it remains for mock-based testing and the default minimal scene.
    - Do not implement GPU inference — CPU inference via `onnxruntime-node` is sufficient for the §5 "blazing-fast" requirement.
    - Do not implement model quantization or optimization — use the standard ONNX model as-is. Quantization is a future optimization.

## Acceptance Criteria

- [ ] **AC-1**: `UnifiedEmbeddingProvider` interface is defined in `packages/shared/src/types/embedding.ts` and exported from `packages/shared/src/index.ts`. It has `readonly dimensions: number`, `embed(text: string): Promise<number[]>`, and `embedBatch(texts: string[]): Promise<number[][]>`. *(Req 1)*
- [ ] **AC-2**: The memory-level `EmbeddingProvider` interface in `packages/memory/src/index.ts` includes `embedBatch(texts: string[]): Promise<number[][]>` in addition to `embed` and `dimensions`. *(Req 2)*
- [ ] **AC-3**: All existing `FakeEmbeddingProvider` implementations in `packages/memory/tests/memory-store.test.ts` and `packages/engine/tests/reflect-integration.test.ts` are updated to include `embedBatch` (trivial or mock implementation). Tests pass after the update. *(Req 2)*
- [ ] **AC-4**: `OnnxEmbeddingProvider` class is defined in `packages/cognition/src/classifier/embedding/onnx-provider.ts` and exported from `packages/cognition/src/classifier/embedding/index.ts`, `packages/cognition/src/classifier/index.ts`, and `packages/cognition/src/index.ts`. *(Req 3, Req 18)*
- [ ] **AC-5**: `OnnxEmbeddingProvider` implements `UnifiedEmbeddingProvider` — it has `dimensions`, `embed()`, and `embedBatch()` methods. TypeScript compilation confirms the interface is satisfied. *(Req 3, Req 1)*
- [ ] **AC-6**: `OnnxEmbeddingProvider` structurally satisfies the cognition-level `EmbeddingProvider` interface (in `packages/cognition/src/classifier/index.ts`) and the memory-level `EmbeddingProvider` interface (in `packages/memory/src/index.ts`). A value of type `OnnxEmbeddingProvider` can be assigned to both interface types without error. *(Req 3, Req 1, Req 2)*
- [ ] **AC-7**: `OnnxEmbeddingProviderConfig` is defined with fields `modelPath` (required), `tokenizerPath?`, `maxSeqLength?` (default 512), `batchSize?` (default 32), and `normalize?` (default true). *(Req 4)*
- [ ] **AC-8**: The ONNX inference session and tokenizer are not loaded in the constructor. They are loaded lazily on the first call to `embed()`, `embedBatch()`, or `ready()`. Constructing an `OnnxEmbeddingProvider` does not perform file I/O. *(Req 5)*
- [ ] **AC-9**: A `ready()` method is provided that triggers model loading and returns a `Promise<void>`. Calling `ready()` followed by `embed()` does not reload the model. *(Req 5)*
- [ ] **AC-10**: `embed(text)` returns a `number[]` of length `dimensions` (384 for `gte-small`). The vector is L2-normalized (sum of squares ≈ 1.0) when `normalize` is `true`. *(Req 7, Req 9)*
- [ ] **AC-11**: `embedBatch(texts)` returns `number[][]` with one vector per input, in the same order as the input array. An empty input array returns `[]`. *(Req 8)*
- [ ] **AC-12**: `embedBatch` processes inputs in chunks of `batchSize` (default 32). If 40 texts are passed with `batchSize=32`, two inference calls are made (32 + 8). *(Req 8)*
- [ ] **AC-13**: `embed("hello world")` and `embed("hello world")` (same input twice) return identical vectors (deterministic). *(Req 7)*
- [ ] **AC-14**: If the model file at `modelPath` does not exist, calling `embed()` (or `ready()`) throws an `EmbeddingModelError` with a message containing the file path. The error is not thrown in the constructor. *(Req 10)*
- [ ] **AC-15**: If the ONNX inference session throws during execution, `embed()` throws an `EmbeddingModelError` with the underlying error in the `cause` field. No zero vectors are returned on inference failure. *(Req 11)*
- [ ] **AC-16**: `EmbeddingModelError` is defined and exported from `packages/cognition/src/classifier/embedding/onnx-provider.ts`. It extends `Error`, has `name: 'EmbeddingModelError'`, and has an optional `cause` field. `err instanceof EmbeddingModelError` returns `true`. *(Req 12)*
- [ ] **AC-17**: A second call to `embed()` with the same text as a previous call returns the cached vector without re-running inference. After two calls to `embed("hello")`, the ONNX session's run method is called only once. *(Req 13)*
- [ ] **AC-18**: When the cache reaches its maximum size (default 1000), adding a new entry evicts the least recently used entry. The cache size never exceeds the configured maximum. *(Req 13)*
- [ ] **AC-19**: `AffordanceClassifierImpl` can be constructed with an `OnnxEmbeddingProvider` as its `EmbeddingProvider` parameter. TypeScript compilation confirms type compatibility. *(Req 14)*
- [ ] **AC-20**: `MemoryStoreImpl` can be constructed with an `OnnxEmbeddingProvider` as its `EmbeddingProvider` parameter. TypeScript compilation confirms type compatibility. *(Req 15)*
- [ ] **AC-21**: When `USE_REAL_EMBEDDINGS=true` and `EMBEDDING_MODEL_PATH` is set, `examples/minimal-scene.ts` constructs an `OnnxEmbeddingProvider` and uses it for both the `MemoryStore` and the `AffordanceClassifier`. *(Req 16, Req 17)*
- [ ] **AC-22**: When `USE_REAL_EMBEDDINGS` is not set, `examples/minimal-scene.ts` uses `MockEmbeddingProvider` and `makeMockClassifier()` exactly as before — no behavioral change. *(Req 16, Req 17)*
- [ ] **AC-23**: `packages/cognition/src/classifier/embedding/index.ts` exports `OnnxEmbeddingProvider`, `OnnxEmbeddingProviderConfig`, and `EmbeddingModelError`. `packages/cognition/src/index.ts` re-exports them. *(Req 18)*
- [ ] **AC-24**: `OnnxEmbeddingProvider` does not import from `@evol-hive/engine` or `@evol-hive/memory`. It imports from `@evol-hive/shared` and external packages only. *(Req 19)*
- [ ] **AC-25**: `onnxruntime-node` and a tokenizer library are added to `packages/cognition/package.json` `dependencies`. No other packages' dependencies change. *(Req 20)*
- [ ] **AC-26**: A `scripts/download-embedding-model.sh` (or `.ts`) script exists and downloads the `gte-small` ONNX model and tokenizer to `models/gte-small/` by default. The `models/` directory is in `.gitignore`. *(Req 21)*
- [ ] **AC-27**: Unit tests for `OnnxEmbeddingProvider` exist in `packages/cognition/tests/` and do not require a real ONNX model file for the core logic tests (mock session injection). Tests requiring a real model are gated and skipped when the model is absent. *(Req 22)*
- [ ] **AC-28**: A unit test verifies that `EmbeddingModelError` is thrown when `modelPath` points to a non-existent file. *(Req 10, Req 22)*
- [ ] **AC-29**: A unit test verifies the embedding cache: after two `embed("hello")` calls, the underlying inference is called only once. *(Req 13, Req 22)*
- [ ] **AC-30**: A unit test verifies that `embedBatch([])` returns `[]` without calling the model. *(Req 8, Req 22)*
- [ ] **AC-31**: A unit test verifies that L2 normalization is applied when `normalize: true` (sum of squares ≈ 1.0) and not applied when `normalize: false`. *(Req 7, Req 22)*

## Constraints

- **Package boundaries** (per ADR-0001): The `OnnxEmbeddingProvider` lives in `packages/cognition/src/classifier/embedding/`. It imports from `@evol-hive/shared` and external packages (`onnxruntime-node`, tokenizer library). It must not import from `@evol-hive/engine` or `@evol-hive/memory`. The ADR-0001 package layout designates `cognition/classifier/embedding/` as the embedding directory.
- **New external dependencies**: `onnxruntime-node` (ONNX Runtime Node.js binding) and a tokenizer library (`@xenova/transformers` or equivalent) are added to `packages/cognition/package.json`. These are the first external runtime dependencies in the cognition package. They are justified because ONNX inference and HuggingFace tokenization cannot reasonably be reimplemented. Dependencies are scoped to cognition only.
- **Lazy loading**: The ONNX session and tokenizer must be loaded lazily (on first use), not in the constructor. This allows the provider to be constructed synchronously and defers file I/O. A `ready()` method enables pre-warming.
- **Drop-in replacement**: The `OnnxEmbeddingProvider` must be a drop-in replacement for `MockEmbeddingProvider` in both the `MemoryStore` and `AffordanceClassifier`. No changes to `MemoryStoreImpl` or `AffordanceClassifierImpl` are needed.
- **Mock coexistence**: The `MockEmbeddingProvider` in `examples/minimal-scene.ts` must remain. It is used by existing tests and the default mock-based scene run. The `OnnxEmbeddingProvider` is an alternative, enabled via `USE_REAL_EMBEDDINGS=true`.
- **Model files not committed**: ONNX model and tokenizer files are downloaded by a script, not stored in git. The `models/` directory is `.gitignore`d.
- **CPU-only inference**: Use `onnxruntime-node` CPU execution provider. GPU inference is a future enhancement. The `gte-small` model (~130M parameters) runs in <50ms on CPU, meeting the §5 "blazing-fast" requirement.
- **Interface-first pattern**: Follow the existing pattern — `EmbeddingProvider` interfaces are already defined in cognition and memory. A unified `UnifiedEmbeddingProvider` is added to `shared` to bridge them. The `OnnxEmbeddingProvider` implements it.
- **What NOT to do**:
  - Do not modify `AffordanceClassifierImpl`, `MemoryStoreImpl`, or any PPER service.
  - Do not implement Ollama embeddings or Model2Vec — only ONNX Runtime is in scope.
  - Do not implement the `RetrievalEngine` or `MemoryInjector` — separate specs.
  - Do not remove or break `MockEmbeddingProvider`.
  - Do not implement GPU inference or model quantization.
  - Do not commit model files to git.
