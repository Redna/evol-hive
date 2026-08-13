/**
 * OnnxEmbeddingProvider — Real ONNX Embedding Provider (spec 007)
 * ──────────────────────────────────────────────────────────────
 * Section 5: A concrete `EmbeddingProvider` backed by an ONNX Runtime inference
 * session. Designed as a drop-in replacement for `MockEmbeddingProvider` in both
 * the `AffordanceClassifier` (cognition) and the `MemoryStore` (memory).
 *
 * Key design decisions:
 * - **Lazy loading**: The ONNX session and tokenizer are loaded on the first call
 *   to `embed()`, `embedBatch()`, or `ready()`, not in the constructor. This allows
 *   synchronous construction and defers file I/O until needed.
 * - **Testability**: The session and tokenizer can be injected via factory
 *   functions (`sessionFactory`, `tokenizerFactory`) in the config. This allows
 *   unit tests to verify tokenization, pooling, normalization, and caching without
 *   a real ONNX model file. In production, the factories load the real model.
 * - **LRU cache**: Repeated calls to `embed()` with the same text return the cached
 *   vector without re-running inference. This is critical for System 0 affordance
 *   pruning, where the same affordance labels are embedded every Perceive tick.
 */

import type { UnifiedEmbeddingProvider } from '@evol-hive/shared';

// ── Error class (Req 12) ──────────────────────────────────────────────────────

/** Custom error class for embedding model failures (load, inference, etc.). */
export class EmbeddingModelError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'EmbeddingModelError';
    if (cause !== undefined) {
      // Use defineProperty to reliably set cause (Error's built-in cause may be non-writable).
      Object.defineProperty(this, 'cause', {
        value: cause,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  }
}

// ── Config (Req 4) ───────────────────────────────────────────────────────────

/** Configuration for {@link OnnxEmbeddingProvider}. */
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
  /** Embedding dimensionality, returned by `dimensions` before model loading (default: 384). */
  dimensions?: number;
  /** Maximum LRU cache entries (default: 1000). */
  cacheSize?: number;

  // ── Testability hooks (Req 22) ──────────────────────────────────────────────

  /**
   * Factory function for creating an ONNX inference session. In production, this
   * loads the real model via `onnxruntime-node`. In tests, a mock session can be
   * injected here. If not provided, the default factory uses `onnxruntime-node`.
   */
  sessionFactory?: () => OnnxSession;
  /**
   * Factory function for creating a tokenizer. In production, this loads a
   * HuggingFace-compatible tokenizer. In tests, a mock tokenizer can be injected.
   * If not provided, the default factory uses `@xenova/transformers`.
   */
  tokenizerFactory?: () => Tokenizer;
}

// ── Internal abstractions for mock injection ──────────────────────────────────

/** Abstraction over the ONNX inference session (for mock injection). */
export interface OnnxSession {
  /** Run inference with the given input feeds. Returns named output tensors. */
  run(feeds: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Abstraction over the tokenizer (for mock injection). */
export interface Tokenizer {
  /** Tokenize text into input IDs and attention mask, respecting maxSeqLength. */
  tokenize(text: string, maxSeqLength: number): { inputIds: number[]; attentionMask: number[] };
}

/** Mock ONNX session type (exposed for test convenience). */
export type MockOnnxSession = OnnxSession;

/** Mock tokenizer type (exposed for test convenience). */
export type MockTokenizer = Tokenizer;

// ── LRU Cache ─────────────────────────────────────────────────────────────────

/** Simple LRU cache with a maximum size. */
class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    // Move to end (most recently used).
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      // Delete first so re-insert moves to end.
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict least recently used (first entry).
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }
}

// ── OnnxEmbeddingProvider ─────────────────────────────────────────────────────

/** Concrete `EmbeddingProvider` backed by an ONNX Runtime inference session. */
export class OnnxEmbeddingProvider implements UnifiedEmbeddingProvider {
  // ── Config (resolved with defaults) ───────────────────────────────────────
  private readonly modelPath: string;
  private readonly tokenizerPath: string | undefined;
  private readonly maxSeqLength: number;
  private readonly batchSize: number;
  private readonly doNormalize: boolean;
  private readonly expectedDimensions: number;
  private readonly cacheSize: number;
  private readonly sessionFactory: (() => OnnxSession) | undefined;
  private readonly tokenizerFactory: (() => Tokenizer) | undefined;

  // ── Lazy-loaded state ──────────────────────────────────────────────────────
  private session: OnnxSession | null = null;
  private tokenizer: Tokenizer | null = null;
  private loadedDimensions: number | null = null;
  private loadPromise: Promise<void> | null = null;

  // ── LRU cache ──────────────────────────────────────────────────────────────
  private readonly cache: LruCache<string, number[]>;

  constructor(config: OnnxEmbeddingProviderConfig) {
    this.modelPath = config.modelPath;
    this.tokenizerPath = config.tokenizerPath;
    this.maxSeqLength = config.maxSeqLength ?? 512;
    this.batchSize = config.batchSize ?? 32;
    this.doNormalize = config.normalize ?? true;
    this.expectedDimensions = config.dimensions ?? 384;
    this.cacheSize = config.cacheSize ?? 1000;
    this.sessionFactory = config.sessionFactory;
    this.tokenizerFactory = config.tokenizerFactory;
    this.cache = new LruCache<string, number[]>(this.cacheSize);
  }

  // ── dimensions (Req 9) ──────────────────────────────────────────────────────

  get dimensions(): number {
    return this.loadedDimensions ?? this.expectedDimensions;
  }

  // ── ready() (Req 5) ────────────────────────────────────────────────────────

  /** Pre-warm the model by loading the session and tokenizer. Subsequent calls reuse the loaded session. */
  async ready(): Promise<void> {
    await this.ensureLoaded();
  }

  // ── embed() (Req 7, Req 13) ──────────────────────────────────────────────────

  async embed(text: string): Promise<number[]> {
    // Check cache first.
    const cached = this.cache.get(text);
    if (cached !== undefined) return cached;

    // Ensure model is loaded, then run inference.
    await this.ensureLoaded();
    const vectors = await this.runInference([text]);

    const vec = vectors[0]!;
    this.cache.set(text, vec);
    return vec;
  }

  // ── embedBatch() (Req 8) ─────────────────────────────────────────────────────

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Empty input returns [] without calling the model.
    if (texts.length === 0) return [];

    // Collect cached and uncached indices.
    const results: number[][] = new Array(texts.length);
    const uncachedTexts: string[] = [];
    const uncachedIndices: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      const cached = this.cache.get(text);
      if (cached !== undefined) {
        results[i] = cached;
      } else {
        uncachedTexts.push(text);
        uncachedIndices.push(i);
      }
    }

    // If everything was cached, return early.
    if (uncachedTexts.length === 0) return results;

    // Ensure model is loaded, then process uncached texts in batches.
    await this.ensureLoaded();

    // Process in chunks of batchSize (Req 8).
    for (let offset = 0; offset < uncachedTexts.length; offset += this.batchSize) {
      const chunk = uncachedTexts.slice(offset, offset + this.batchSize);
      const chunkVectors = await this.runInference(chunk);

      for (let j = 0; j < chunk.length; j++) {
        const originalIndex = uncachedIndices[offset + j]!;
        const text = chunk[j]!;
        const vec = chunkVectors[j]!;
        results[originalIndex] = vec;
        this.cache.set(text, vec);
      }
    }

    return results;
  }

  // ── Internal: lazy loading ──────────────────────────────────────────────────

  /** Ensure the ONNX session and tokenizer are loaded. Idempotent. */
  private async ensureLoaded(): Promise<void> {
    if (this.session !== null && this.tokenizer !== null) return;

    // Use a shared promise to avoid race conditions on concurrent calls.
    if (this.loadPromise !== null) {
      await this.loadPromise;
      return;
    }

    this.loadPromise = this.loadModel().finally(() => {
      this.loadPromise = null;
    });
    await this.loadPromise;
  }

  /** Load the ONNX session and tokenizer. Throws EmbeddingModelError on failure. */
  private async loadModel(): Promise<void> {
    // Check model file exists (Req 10) — only when using real (non-mock) factories.
    // When sessionFactory is provided (test mode), skip the file check.
    if (!this.sessionFactory) {
      try {
        await import('fs').then((fs) => {
          if (!fs.existsSync(this.modelPath)) {
            throw new EmbeddingModelError(`ONNX model file not found at: ${this.modelPath}`);
          }
        });
      } catch (err) {
        if (err instanceof EmbeddingModelError) throw err;
        throw new EmbeddingModelError(`Failed to check model file at: ${this.modelPath}`, err);
      }
    }

    // Load session.
    try {
      if (this.sessionFactory) {
        this.session = this.sessionFactory();
      } else {
        this.session = await this.loadRealSession();
      }
    } catch (err) {
      if (err instanceof EmbeddingModelError) throw err;
      throw new EmbeddingModelError(`Failed to load ONNX session from: ${this.modelPath}`, err);
    }

    // Load tokenizer.
    try {
      if (this.tokenizerFactory) {
        this.tokenizer = this.tokenizerFactory();
      } else {
        this.tokenizer = await this.loadRealTokenizer();
      }
    } catch (err) {
      if (err instanceof EmbeddingModelError) throw err;
      throw new EmbeddingModelError('Failed to load tokenizer', err);
    }
  }

  /** Load the real ONNX session via `onnxruntime-node`. */
  private async loadRealSession(): Promise<OnnxSession> {
    const ort = await import('onnxruntime-node');
    const session = await ort.InferenceSession.create(this.modelPath);
    return {
      async run(feeds: Record<string, unknown>): Promise<Record<string, unknown>> {
        // Convert plain arrays to ONNX tensors.
        const ortFeeds: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(feeds)) {
          if (Array.isArray(value)) {
            ortFeeds[key] = new ort.Tensor('int64', value, [value.length]);
          } else {
            ortFeeds[key] = value;
          }
        }
        const results = await session.run(ortFeeds as never);
        return results as Record<string, unknown>;
      },
    };
  }

  /** Load a real HuggingFace-compatible tokenizer via `@xenova/transformers`. */
  private async loadRealTokenizer(): Promise<Tokenizer> {
    const { AutoTokenizer } = await import('@xenova/transformers');
    const tokenizerPath = this.tokenizerPath ?? this.modelPath.replace(/\/[^/]+$/, '');
    const tokenizer = await AutoTokenizer.from_pretrained(tokenizerPath);
    return {
      tokenize(
        text: string,
        maxSeqLength: number,
      ): { inputIds: number[]; attentionMask: number[] } {
        const encoded = tokenizer(text, { truncation: true, max_length: maxSeqLength });
        const inputIds = Array.from(encoded.input_ids.data as number[]);
        const attentionMask = Array.from(encoded.attention_mask.data as number[]);
        return { inputIds, attentionMask };
      },
    };
  }

  // ── Internal: inference ─────────────────────────────────────────────────────

  /** Tokenize and run inference for a batch of texts. Returns normalized/pooled vectors. */
  private async runInference(texts: string[]): Promise<number[][]> {
    if (this.session === null || this.tokenizer === null) {
      throw new EmbeddingModelError('Model not loaded');
    }

    // Tokenize each text (Req 6).
    const tokenized = texts.map((text) => this.tokenizer!.tokenize(text, this.maxSeqLength));

    // Pad to max sequence length in the batch.
    const maxLen = Math.max(...tokenized.map((t) => t.inputIds.length));
    const batchInputIds: number[][] = [];
    const batchAttentionMask: number[][] = [];

    for (const t of tokenized) {
      const paddedIds = [...t.inputIds];
      const paddedMask = [...t.attentionMask];
      while (paddedIds.length < maxLen) {
        paddedIds.push(0);
        paddedMask.push(0);
      }
      batchInputIds.push(paddedIds);
      batchAttentionMask.push(paddedMask);
    }

    // Run inference (Req 7, Req 11).
    let outputs: Record<string, unknown>;
    try {
      outputs = await this.session.run({
        input_ids: batchInputIds,
        attention_mask: batchAttentionMask,
      });
    } catch (err) {
      throw new EmbeddingModelError(`ONNX inference failed: ${(err as Error).message}`, err);
    }

    // Extract last_hidden_state and mean-pool (Req 7).
    const hiddenState = outputs['last_hidden_state'] as number[][][];
    if (!hiddenState) {
      throw new EmbeddingModelError('ONNX output does not contain "last_hidden_state"');
    }

    // hiddenState shape: [batch, seq_len, dim]
    const dim = hiddenState[0]?.[0]?.length ?? this.expectedDimensions;
    this.loadedDimensions = dim;

    const vectors: number[][] = [];
    for (let b = 0; b < texts.length; b++) {
      const vec = this.meanPool(hiddenState[b]!, batchAttentionMask[b]!);
      if (this.doNormalize) {
        this.l2Normalize(vec);
      }
      vectors.push(vec);
    }

    return vectors;
  }

  /** Mean-pool the token vectors across the sequence dimension, weighted by attention mask. */
  private meanPool(tokenVectors: number[][], attentionMask: number[]): number[] {
    const dim = tokenVectors[0]?.length ?? this.expectedDimensions;
    const sumVec = new Array<number>(dim).fill(0);
    let weightSum = 0;

    for (let s = 0; s < tokenVectors.length; s++) {
      const mask = attentionMask[s] ?? 0;
      weightSum += mask;
      const vec = tokenVectors[s]!;
      for (let d = 0; d < dim; d++) {
        sumVec[d] = (sumVec[d] ?? 0) + vec[d]! * mask;
      }
    }

    if (weightSum > 0) {
      for (let d = 0; d < dim; d++) {
        sumVec[d] = sumVec[d]! / weightSum;
      }
    }

    return sumVec;
  }

  /** L2-normalize a vector in place. */
  private l2Normalize(vec: number[]): void {
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] = vec[i]! / norm;
      }
    }
  }
}
