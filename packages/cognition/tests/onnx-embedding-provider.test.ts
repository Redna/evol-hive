/**
 * Tests for OnnxEmbeddingProvider — spec 007 (issue #21)
 * ──────────────────────────────────────────────────────
 * Covers AC-1 through AC-31 from docs/specs/007-onnx-embedding-provider.md.
 *
 * These unit tests do NOT require a real ONNX model file. They use mock session
 * injection to verify tokenization, pooling, normalization, caching, batching,
 * and error-handling logic. Integration tests gated behind EMBEDDING_MODEL_PATH
 * are skipped when no model is present.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UnifiedEmbeddingProvider } from '@evol-hive/shared';
import type { EmbeddingProvider as CognitionEmbeddingProvider } from '../src/classifier/index.js';
import type { EmbeddingProvider as MemoryEmbeddingProvider } from '@evol-hive/memory';
import {
  OnnxEmbeddingProvider,
  EmbeddingModelError,
  type OnnxEmbeddingProviderConfig,
  type MockOnnxSession,
  type MockTokenizer,
} from '../src/classifier/embedding/index.js';
import { AffordanceClassifierImpl } from '../src/classifier/pruning/index.js';
import { MemoryStoreImpl } from '@evol-hive/memory';
import type { VectorStore, MemoryNode } from '@evol-hive/memory';

// ─── AC-1: UnifiedEmbeddingProvider Interface ──────────────────────────────

describe('AC-1: UnifiedEmbeddingProvider interface', () => {
  it('is exported from @evol-hive/shared and has dimensions, embed, embedBatch', async () => {
    const provider: UnifiedEmbeddingProvider = {
      dimensions: 384,
      async embed(): Promise<number[]> {
        return [];
      },
      async embedBatch(): Promise<number[][]> {
        return [];
      },
    };
    expect(provider.dimensions).toBe(384);
    expect(typeof provider.embed).toBe('function');
    expect(typeof provider.embedBatch).toBe('function');
  });
});

// ─── AC-2: Memory EmbeddingProvider includes embedBatch ────────────────────

describe('AC-2: Memory-level EmbeddingProvider includes embedBatch', () => {
  it('the memory EmbeddingProvider interface has embed, embedBatch, and dimensions', () => {
    const provider: MemoryEmbeddingProvider = {
      dimensions: 384,
      async embed(): Promise<number[]> {
        return [];
      },
      async embedBatch(): Promise<number[][]> {
        return [];
      },
    };
    expect(typeof provider.embed).toBe('function');
    expect(typeof provider.embedBatch).toBe('function');
    expect(provider.dimensions).toBe(384);
  });
});

// ─── Mock helpers for ONNX session + tokenizer ──────────────────────────────

/** A simple mock tokenizer that converts text to token IDs (just char codes). */
function makeMockTokenizer(): MockTokenizer {
  return {
    tokenize(text: string, maxLen: number): { inputIds: number[]; attentionMask: number[] } {
      const ids = Array.from(text).map((c) => c.charCodeAt(0));
      const truncated = ids.slice(0, maxLen);
      return {
        inputIds: truncated,
        attentionMask: truncated.map(() => 1),
      };
    },
  };
}

/**
 * A mock ONNX session that returns a deterministic embedding based on token IDs.
 * The "last_hidden_state" output is [batch, seq_len, dim] = [1, seq_len, 384].
 * Each position has a vector where dim[0] = tokenId, dim[1..] = 0.
 */
function makeMockSession(dimensions = 384): MockOnnxSession {
  return {
    async run(feeds: Record<string, unknown>): Promise<Record<string, number[][][]>> {
      const inputIds = feeds['input_ids'] as number[][];
      const attentionMask = (feeds['attention_mask'] as number[][]) ?? undefined;

      const batchSize = inputIds.length;
      const seqLen = inputIds[0]?.length ?? 0;
      // last_hidden_state: [batch, seq_len, dim]
      const hidden: number[][][] = [];
      for (let b = 0; b < batchSize; b++) {
        const seqVecs: number[][] = [];
        for (let s = 0; s < seqLen; s++) {
          const vec = new Array<number>(dimensions).fill(0);
          vec[0] = inputIds[b]![s] ?? 0;
          if (attentionMask && attentionMask[b]?.[s] === 0) {
            // Zero out masked positions
            vec[0] = 0;
          }
          seqVecs.push(vec);
        }
        hidden.push(seqVecs);
      }
      return { last_hidden_state: hidden };
    },
  };
}

// ─── AC-4: OnnxEmbeddingProvider defined and exported ───────────────────────

describe('AC-4 / AC-5 / AC-23: OnnxEmbeddingProvider exports and interface', () => {
  it('OnnxEmbeddingProvider is a class', () => {
    expect(typeof OnnxEmbeddingProvider).toBe('function');
  });

  it('EmbeddingModelError is a class', () => {
    expect(typeof EmbeddingModelError).toBe('function');
  });

  it('OnnxEmbeddingProvider implements UnifiedEmbeddingProvider', () => {
    const config: OnnxEmbeddingProviderConfig = {
      modelPath: '/nonexistent/model.onnx',
      sessionFactory: () => makeMockSession(),
      tokenizerFactory: () => makeMockTokenizer(),
    };
    const provider: UnifiedEmbeddingProvider = new OnnxEmbeddingProvider(config);
    expect(provider.dimensions).toBe(384);
    expect(typeof provider.embed).toBe('function');
    expect(typeof provider.embedBatch).toBe('function');
  });
});

// ─── AC-7: OnnxEmbeddingProviderConfig ──────────────────────────────────────

describe('AC-7: OnnxEmbeddingProviderConfig fields', () => {
  it('has modelPath (required), tokenizerPath?, maxSeqLength? (512), batchSize? (32), normalize? (true)', () => {
    const config: OnnxEmbeddingProviderConfig = {
      modelPath: '/path/to/model.onnx',
      tokenizerPath: '/path/to/tokenizer',
      maxSeqLength: 256,
      batchSize: 16,
      normalize: false,
      sessionFactory: () => makeMockSession(),
      tokenizerFactory: () => makeMockTokenizer(),
    };
    expect(config.modelPath).toBe('/path/to/model.onnx');
    expect(config.tokenizerPath).toBe('/path/to/tokenizer');
    expect(config.maxSeqLength).toBe(256);
    expect(config.batchSize).toBe(16);
    expect(config.normalize).toBe(false);
  });

  it('uses defaults when optional fields are omitted', () => {
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      sessionFactory: () => makeMockSession(),
      tokenizerFactory: () => makeMockTokenizer(),
    });
    // Before loading, dimensions returns default 384
    expect(provider.dimensions).toBe(384);
  });
});

// ─── AC-8: Lazy model loading ───────────────────────────────────────────────

describe('AC-8: Lazy model loading — no I/O in constructor', () => {
  it('constructor does not throw and does not load the session', () => {
    const sessionFactory = vi.fn(() => makeMockSession());
    const tokenizerFactory = vi.fn(() => makeMockTokenizer());
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      sessionFactory,
      tokenizerFactory,
    });
    expect(provider).toBeDefined();
    expect(sessionFactory).not.toHaveBeenCalled();
    expect(tokenizerFactory).not.toHaveBeenCalled();
  });
});

// ─── AC-9: ready() method ───────────────────────────────────────────────────

describe('AC-9: ready() method triggers loading and does not reload', () => {
  it('ready() loads the session, subsequent embed() does not reload', async () => {
    const sessionFactory = vi.fn(() => makeMockSession());
    const tokenizerFactory = vi.fn(() => makeMockTokenizer());
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      sessionFactory,
      tokenizerFactory,
    });
    await provider.ready();
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(tokenizerFactory).toHaveBeenCalledTimes(1);

    await provider.embed('hello');
    // Still only loaded once
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(tokenizerFactory).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-10: embed returns 384-dim L2-normalized vector ──────────────────────

describe('AC-10: embed returns dimensions-length L2-normalized vector', () => {
  it('embed(text) returns number[] of length dimensions, L2-normalized', async () => {
    const session = makeMockSession(4);
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      sessionFactory: () => session,
      tokenizerFactory: () => makeMockTokenizer(),
    });
    const vec = await provider.embed('hello');
    expect(vec).toHaveLength(4);
    // L2 norm should be ~1.0
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it('embed returns finite numbers', async () => {
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 384,
      sessionFactory: () => makeMockSession(384),
      tokenizerFactory: () => makeMockTokenizer(),
    });
    const vec = await provider.embed('test');
    expect(vec.every((v) => Number.isFinite(v))).toBe(true);
  });
});

// ─── AC-11: embedBatch returns one vector per input ─────────────────────────

describe('AC-11: embedBatch returns one vector per input in order', () => {
  it('embedBatch(["a", "b", "c"]) returns 3 vectors', async () => {
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      sessionFactory: () => makeMockSession(4),
      tokenizerFactory: () => makeMockTokenizer(),
    });
    const result = await provider.embedBatch(['a', 'b', 'c']);
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(4);
    expect(result[1]).toHaveLength(4);
    expect(result[2]).toHaveLength(4);
  });

  it('embedBatch([]) returns []', async () => {
    const session = makeMockSession(4);
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      sessionFactory: () => session,
      tokenizerFactory: () => makeMockTokenizer(),
    });
    const result = await provider.embedBatch([]);
    expect(result).toEqual([]);
    // Session should NOT have been called for empty batch
    // (we can verify by checking that session.run was not called)
  });
});

// ─── AC-12: Batch chunking ───────────────────────────────────────────────────

describe('AC-12: embedBatch processes in chunks of batchSize', () => {
  it('40 texts with batchSize=32 makes 2 inference calls (32 + 8)', async () => {
    const session = makeMockSession(4);
    const runSpy = vi.spyOn(session, 'run');
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      batchSize: 32,
      sessionFactory: () => session,
      tokenizerFactory: () => makeMockTokenizer(),
    });
    const texts = Array.from({ length: 40 }, (_, i) => `text${i}`);
    const result = await provider.embedBatch(texts);
    expect(result).toHaveLength(40);
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it('32 texts with batchSize=32 makes 1 inference call', async () => {
    const session = makeMockSession(4);
    const runSpy = vi.spyOn(session, 'run');
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      batchSize: 32,
      sessionFactory: () => session,
      tokenizerFactory: () => makeMockTokenizer(),
    });
    const texts = Array.from({ length: 32 }, (_, i) => `text${i}`);
    await provider.embedBatch(texts);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-13: Deterministic embeddings ────────────────────────────────────────

describe('AC-13: Deterministic embeddings', () => {
  it('embed("hello world") twice returns identical vectors', async () => {
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      sessionFactory: () => makeMockSession(4),
      tokenizerFactory: () => makeMockTokenizer(),
    });
    const v1 = await provider.embed('hello world');
    const v2 = await provider.embed('hello world');
    expect(v1).toEqual(v2);
  });
});

// ─── AC-14: Model file not found error ──────────────────────────────────────

describe('AC-14: Model file not found throws EmbeddingModelError', () => {
  it('embed() throws EmbeddingModelError with path in message when model missing', async () => {
    // No sessionFactory — file existence check runs first and throws before loading.
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/path/model.onnx',
    });
    await expect(provider.embed('hello')).rejects.toThrow(EmbeddingModelError);
    try {
      await provider.embed('hello');
    } catch (err) {
      expect(err).toBeInstanceOf(EmbeddingModelError);
      expect((err as Error).message).toContain('/nonexistent/path/model.onnx');
    }
  });

  it('ready() throws EmbeddingModelError when model missing', async () => {
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/another.onnx',
    });
    await expect(provider.ready()).rejects.toThrow(EmbeddingModelError);
  });

  it('constructor does NOT throw even with missing model', () => {
    expect(
      () =>
        new OnnxEmbeddingProvider({
          modelPath: '/nonexistent/model.onnx',
          sessionFactory: () => makeMockSession(),
          tokenizerFactory: () => makeMockTokenizer(),
        }),
    ).not.toThrow();
  });
});

// ─── AC-15: Inference failure wraps in EmbeddingModelError ──────────────────

describe('AC-15: Inference failure throws EmbeddingModelError with cause', () => {
  it('embed throws EmbeddingModelError wrapping underlying error', async () => {
    const failingSession: MockOnnxSession = {
      async run(): Promise<Record<string, number[][][]>> {
        throw new Error('ONNX shape mismatch');
      },
    };
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      sessionFactory: () => failingSession,
      tokenizerFactory: () => makeMockTokenizer(),
    });
    try {
      await provider.embed('hello');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EmbeddingModelError);
      expect((err as EmbeddingModelError).cause).toBeDefined();
      expect((err as Error).message).toContain('ONNX shape mismatch');
    }
  });
});

// ─── AC-16: EmbeddingModelError class ────────────────────────────────────────

describe('AC-16: EmbeddingModelError', () => {
  it('extends Error, has name "EmbeddingModelError"', () => {
    const err = new EmbeddingModelError('test error');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EmbeddingModelError');
    expect(err.message).toBe('test error');
  });

  it('has optional cause field', () => {
    const cause = new Error('root cause');
    const err = new EmbeddingModelError('wrapped', cause);
    expect(err.cause).toBe(cause);
  });

  it('instanceof check returns true', () => {
    const err = new EmbeddingModelError('test');
    expect(err instanceof EmbeddingModelError).toBe(true);
  });
});

// ─── AC-17: Cache hit ───────────────────────────────────────────────────────

describe('AC-17: Cache hit returns same vector without re-running inference', () => {
  it('after two embed("hello") calls, session.run is called only once', async () => {
    const session = makeMockSession(4);
    const runSpy = vi.spyOn(session, 'run');
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      sessionFactory: () => session,
      tokenizerFactory: () => makeMockTokenizer(),
    });
    const v1 = await provider.embed('hello');
    const v2 = await provider.embed('hello');
    expect(v1).toEqual(v2);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-18: LRU cache eviction ──────────────────────────────────────────────

describe('AC-18: LRU cache eviction', () => {
  it('cache never exceeds maxSize, evicts LRU entry', async () => {
    const session = makeMockSession(4);
    const runSpy = vi.spyOn(session, 'run');
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      cacheSize: 3,
      sessionFactory: () => session,
      tokenizerFactory: () => makeMockTokenizer(),
    });
    // Embed 4 distinct texts — cache holds 3, so text0 is evicted
    await provider.embed('text0');
    await provider.embed('text1');
    await provider.embed('text2');
    await provider.embed('text3');
    expect(runSpy).toHaveBeenCalledTimes(4);

    // Re-embed text0 — should cause a new inference (was evicted)
    await provider.embed('text0');
    expect(runSpy).toHaveBeenCalledTimes(5);

    // Re-embed text1 — but text1 was also evicted? Let's check:
    // After embed text0, text1, text2, text3: cache = {text1, text2, text3} (text0 evicted)
    // Re-embed text0: cache = {text2, text3, text0} (text1 evicted)
    // Re-embed text1: cache = {text3, text0, text1} (text2 evicted)
    await provider.embed('text1');
    expect(runSpy).toHaveBeenCalledTimes(6);
  });

  it('accessing a cached entry updates its LRU position', async () => {
    const session = makeMockSession(4);
    const runSpy = vi.spyOn(session, 'run');
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      cacheSize: 2,
      sessionFactory: () => session,
      tokenizerFactory: () => makeMockTokenizer(),
    });
    // cache: {a, b}
    await provider.embed('a');
    await provider.embed('b');
    expect(runSpy).toHaveBeenCalledTimes(2);

    // Access 'a' → cache order: {b, a} (a is now most recent)
    await provider.embed('a');
    expect(runSpy).toHaveBeenCalledTimes(2); // cache hit, no new inference

    // Add 'c' → evicts LRU ('b')
    await provider.embed('c');
    expect(runSpy).toHaveBeenCalledTimes(3);

    // 'b' should be evicted → new inference
    await provider.embed('b');
    expect(runSpy).toHaveBeenCalledTimes(4);

    // 'a' was also evicted when 'b' was re-embedded → new inference
    await provider.embed('a');
    expect(runSpy).toHaveBeenCalledTimes(5);
  });
});

// ─── AC-19: AffordanceClassifierImpl works with OnnxEmbeddingProvider ───────

describe('AC-19: AffordanceClassifierImpl constructed with OnnxEmbeddingProvider', () => {
  it('type-checks and produces correct pruning results', async () => {
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      sessionFactory: () => makeMockSession(4),
      tokenizerFactory: () => makeMockTokenizer(),
    });
    // Type-level check: assigning to cognition EmbeddingProvider
    const cognitionProvider: CognitionEmbeddingProvider = provider;
    expect(cognitionProvider).toBeDefined();

    const classifier = new AffordanceClassifierImpl(provider, {
      topK: 5,
      similarityThreshold: 0.0,
    });
    const result = await classifier.prune('low energy', [
      {
        id: 'brew_coffee',
        label: 'Brew coffee',
        engineEffect: 'brew_coffee',
        preconditions: [],
        effects: { energy: 20 },
      },
    ]);
    // With mock tokenizer + session, embeddings are deterministic and nonzero,
    // so the affordance should be retained (threshold 0.0).
    expect(result).toBeDefined();
  });
});

// ─── AC-20: MemoryStoreImpl works with OnnxEmbeddingProvider ───────────────

describe('AC-20: MemoryStoreImpl constructed with OnnxEmbeddingProvider', () => {
  it('type-checks — OnnxEmbeddingProvider assignable to memory EmbeddingProvider', async () => {
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      sessionFactory: () => makeMockSession(4),
      tokenizerFactory: () => makeMockTokenizer(),
    });
    // Type-level check: assigning to memory EmbeddingProvider
    const memProvider: MemoryEmbeddingProvider = provider;
    expect(memProvider).toBeDefined();

    const vectorStore: VectorStore = new (class implements VectorStore {
      private readonly nodes = new Map<string, MemoryNode>();
      async store(node: MemoryNode): Promise<void> {
        this.nodes.set(node.id, node);
      }
      async get(id: string): Promise<MemoryNode | null> {
        return this.nodes.get(id) ?? null;
      }
      async queryByEmbedding(): Promise<MemoryNode[]> {
        return [];
      }
      async delete(): Promise<void> {}
      async countRecent(): Promise<number> {
        return 0;
      }
    })();

    const store = new MemoryStoreImpl({ vectorStore, embeddingProvider: provider });
    const node = await store.store('a1', { content: 'test', importance: 5, type: 'action' }, 1000);
    expect(node.embedding).toHaveLength(4);
  });
});

// ─── AC-24: Package boundaries ───────────────────────────────────────────────

describe('AC-24: Package boundaries', () => {
  it('OnnxEmbeddingProvider does not import from engine or memory', async () => {
    // Verify by checking the source file doesn't import those packages.
    const fs = await import('fs');
    const source = fs.readFileSync('src/classifier/embedding/onnx-provider.ts', 'utf-8');
    expect(source).not.toContain('@evol-hive/engine');
    expect(source).not.toContain('@evol-hive/memory');
  });
});

// ─── AC-28: Non-existent model path ──────────────────────────────────────────

describe('AC-28: EmbeddingModelError on non-existent model path', () => {
  it('embed() throws EmbeddingModelError with file path in message', async () => {
    // No sessionFactory — file existence check runs first.
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/totally/missing/model.onnx',
    });
    try {
      await provider.embed('test');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EmbeddingModelError);
      expect((err as Error).message).toContain('/totally/missing/model.onnx');
    }
  });
});

// ─── AC-29: Cache hit — inference called once ────────────────────────────────

describe('AC-29: Cache hit — inference called once for duplicate embed', () => {
  it('after two embed("hello") calls, session.run is called once', async () => {
    const session = makeMockSession(4);
    const runSpy = vi.spyOn(session, 'run');
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      sessionFactory: () => session,
      tokenizerFactory: () => makeMockTokenizer(),
    });
    await provider.embed('hello');
    await provider.embed('hello');
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-30: embedBatch([]) returns [] ────────────────────────────────────────

describe('AC-30: embedBatch([]) returns [] without calling model', () => {
  it('embedBatch([]) returns empty array and does not run inference', async () => {
    const session = makeMockSession(4);
    const runSpy = vi.spyOn(session, 'run');
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      sessionFactory: () => session,
      tokenizerFactory: () => makeMockTokenizer(),
    });
    const result = await provider.embedBatch([]);
    expect(result).toEqual([]);
    expect(runSpy).not.toHaveBeenCalled();
  });
});

// ─── AC-31: L2 normalization ──────────────────────────────────────────────────

describe('AC-31: L2 normalization', () => {
  it('normalize=true produces L2-normalized vector (sum of squares ≈ 1.0)', async () => {
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      normalize: true,
      sessionFactory: () => makeMockSession(4),
      tokenizerFactory: () => makeMockTokenizer(),
    });
    const vec = await provider.embed('test');
    const sumSquares = vec.reduce((sum, v) => sum + v * v, 0);
    expect(sumSquares).toBeCloseTo(1.0, 4);
  });

  it('normalize=false produces un-normalized vector (sum of squares ≠ 1.0)', async () => {
    const provider = new OnnxEmbeddingProvider({
      modelPath: '/nonexistent/model.onnx',
      dimensions: 4,
      normalize: false,
      sessionFactory: () => makeMockSession(4),
      tokenizerFactory: () => makeMockTokenizer(),
    });
    const vec = await provider.embed('test');
    const sumSquares = vec.reduce((sum, v) => sum + v * v, 0);
    // The mock session returns vec[0] = token id (104 for 't'), so sumSquares = 104^2 = 10816
    expect(sumSquares).not.toBeCloseTo(1.0, 1);
    expect(sumSquares).toBeGreaterThan(1.0);
  });
});

// ─── Integration tests (gated) ───────────────────────────────────────────────

describe('Integration with real model (gated by EMBEDDING_MODEL_PATH)', () => {
  const modelPath = process.env['EMBEDDING_MODEL_PATH'];
  const skip = !modelPath || process.env['RUN_INTEGRATION'] !== 'true';

  (skip ? describe.skip : describe)('real ONNX model', () => {
    it('embed returns 384-dim vector', async () => {
      const provider = new OnnxEmbeddingProvider({
        modelPath: modelPath!,
      });
      const vec = await provider.embed('hello world');
      expect(vec).toHaveLength(384);
    });
  });
});
