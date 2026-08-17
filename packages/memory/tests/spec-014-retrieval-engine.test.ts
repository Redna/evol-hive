/**
 * Spec 014 — RetrievalEngineImpl (memory layer)
 * ──────────────────────────────────────────────
 * Covers AC-18 through AC-25, AC-53, AC-54, AC-59.
 */
import { describe, it, expect, vi } from 'vitest';
import type { MemoryNode, RetrievalWeights } from '@evol-hive/shared';
import { defaultRetrievalWeights } from '@evol-hive/shared';
import { RetrievalEngineImpl } from '../src/retrieval/retrieval-engine.js';
import type { VectorStore, EmbeddingProvider } from '../src/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkNode(id: string, embedding: number[], opts: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id,
    agentId: 'a1',
    content: `c-${id}`,
    embedding,
    timestamp: 0,
    importance: 5,
    type: 'observation',
    ...opts,
  };
}

/** A fully-featured fake VectorStore that records update calls. */
class FakeVectorStore implements VectorStore {
  private readonly nodes = new Map<string, MemoryNode>();
  updateCalls: { id: string; changes: Partial<MemoryNode> }[] = [];

  async store(n: MemoryNode): Promise<void> {
    this.nodes.set(n.id, { ...n });
  }
  async get(id: string): Promise<MemoryNode | null> {
    return this.nodes.get(id) ?? null;
  }
  async queryByEmbedding(_emb: number[], topK: number): Promise<MemoryNode[]> {
    return [...this.nodes.values()].slice(0, topK);
  }
  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.nodes.delete(id);
  }
  async countRecent(): Promise<number> {
    return 0;
  }
  async update(id: string, changes: Partial<MemoryNode>): Promise<void> {
    this.updateCalls.push({ id, changes });
    const existing = this.nodes.get(id);
    if (existing) {
      this.nodes.set(id, { ...existing, ...changes });
    }
  }
  async queryByAgent(agentId: string): Promise<MemoryNode[]> {
    return [...this.nodes.values()].filter((n) => n.agentId === agentId);
  }
  /** Test helper to seed nodes directly. */
  seed(n: MemoryNode): void {
    this.nodes.set(n.id, { ...n });
  }
}

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 3;
  embed = vi.fn(async (_text: string): Promise<number[]> => [1, 0, 0]);
  embedBatch = vi.fn(async (texts: string[]): Promise<number[][]> => texts.map(() => [1, 0, 0]));
}

// ─── AC-18: exported & constructable ─────────────────────────────────────────

describe('AC-18: RetrievalEngineImpl exported', () => {
  it('is importable from the retrieval module', () => {
    const store = new FakeVectorStore();
    const emb = new FakeEmbeddingProvider();
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: emb,
      clock: () => 100,
    });
    expect(engine).toBeDefined();
    expect(typeof engine.score).toBe('function');
    expect(typeof engine.retrieve).toBe('function');
  });
});

// ─── AC-19: constructor weights default ──────────────────────────────────────

describe('AC-19: default weights when omitted', () => {
  it('uses defaultRetrievalWeights when no weights provided', () => {
    const store = new FakeVectorStore();
    const emb = new FakeEmbeddingProvider();
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: emb,
      clock: () => 0,
    });
    // Indirect verification: score a node and check composite equals the
    // default-weighted sum. With simTime=timestamp=0, recency=1,
    // importance=base (no decay), relevance=cosine.
    const n = mkNode('n1', [1, 0, 0], { importance: 4 });
    const scores = engine.score([n], [1, 0, 0], 0);
    expect(scores[0]?.recency).toBeCloseTo(1, 6);
    expect(scores[0]?.importance).toBeCloseTo(4, 6);
    expect(scores[0]?.relevance).toBeCloseTo(1, 6);
    // composite = 1*1 + 4*1 + 1*1 = 6 (default weights all 1.0)
    expect(scores[0]?.composite).toBeCloseTo(6, 6);
  });
});

// ─── AC-20: recency formula ──────────────────────────────────────────────────

describe('AC-20: recency = e^(-recencyDecayRate * (simTime - timestamp))', () => {
  it('decays exponentially with time since creation', () => {
    const store = new FakeVectorStore();
    const emb = new FakeEmbeddingProvider();
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: emb,
      clock: () => 0,
    });
    const n = mkNode('n1', [1, 0, 0], { timestamp: 0 });
    // simTime = 100, recencyDecayRate = 0.01 → e^(-1) ≈ 0.367879
    const scores = engine.score([n], [1, 0, 0], 100);
    expect(scores[0]?.recency).toBeCloseTo(Math.exp(-0.01 * 100), 6);
  });
});

// ─── AC-21: effective importance formula ─────────────────────────────────────

describe('AC-21: effective importance with decay based on lastAccessed', () => {
  it('decays importance based on time since lastAccessed', () => {
    const store = new FakeVectorStore();
    const emb = new FakeEmbeddingProvider();
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: emb,
      clock: () => 0,
    });
    const n = mkNode('n1', [1, 0, 0], { timestamp: 0, importance: 10, lastAccessed: 50 });
    // simTime=100, lastAccessed=50, importanceDecayRate = 0.01*0.1 = 0.001
    // importance = 10 * e^(-0.001 * 50) = 10 * e^(-0.05) ≈ 9.5123
    const scores = engine.score([n], [1, 0, 0], 100);
    expect(scores[0]?.importance).toBeCloseTo(10 * Math.exp(-0.001 * 50), 5);
  });

  it('falls back to timestamp when lastAccessed is undefined (AC-53)', () => {
    const store = new FakeVectorStore();
    const emb = new FakeEmbeddingProvider();
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: emb,
      clock: () => 0,
    });
    const n = mkNode('n1', [1, 0, 0], { timestamp: 0, importance: 10 });
    // lastAccessed undefined → treated as timestamp=0
    // simTime=100 → importance = 10 * e^(-0.001 * 100) = 10 * e^(-0.1) ≈ 9.048
    const scores = engine.score([n], [1, 0, 0], 100);
    expect(scores[0]?.importance).toBeCloseTo(10 * Math.exp(-0.001 * 100), 5);
  });
});

// ─── AC-22: relevance = cosine similarity, zero-magnitude → 0 ───────────────

describe('AC-22: relevance is cosine similarity', () => {
  it('computes cosine similarity for non-zero vectors', () => {
    const store = new FakeVectorStore();
    const emb = new FakeEmbeddingProvider();
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: emb,
      clock: () => 0,
    });
    const n = mkNode('n1', [1, 1, 0]); // query [1,0,0] → cos = 1/√2 ≈ 0.7071
    const scores = engine.score([n], [1, 0, 0], 0);
    expect(scores[0]?.relevance).toBeCloseTo(1 / Math.sqrt(2), 6);
  });

  it('returns 0 relevance for zero-magnitude node embedding', () => {
    const store = new FakeVectorStore();
    const emb = new FakeEmbeddingProvider();
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: emb,
      clock: () => 0,
    });
    const n = mkNode('n1', [0, 0, 0]);
    const scores = engine.score([n], [1, 0, 0], 0);
    expect(scores[0]?.relevance).toBe(0);
  });

  it('returns 0 relevance for zero-magnitude query embedding', () => {
    const store = new FakeVectorStore();
    const emb = new FakeEmbeddingProvider();
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: emb,
      clock: () => 0,
    });
    const n = mkNode('n1', [1, 0, 0]);
    const scores = engine.score([n], [0, 0, 0], 0);
    expect(scores[0]?.relevance).toBe(0);
  });
});

// ─── AC-23: composite formula ────────────────────────────────────────────────

describe('AC-23: composite = weighted sum', () => {
  it('computes composite from recency, importance, relevance with weights', () => {
    const store = new FakeVectorStore();
    const emb = new FakeEmbeddingProvider();
    const weights: RetrievalWeights = {
      recencyWeight: 2,
      importanceWeight: 3,
      relevanceWeight: 0.5,
      recencyDecayRate: 0.01,
    };
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: emb,
      weights,
      clock: () => 0,
    });
    const n = mkNode('n1', [1, 0, 0], { timestamp: 0, importance: 6 });
    const scores = engine.score([n], [1, 0, 0], 50);
    const expected =
      scores[0]!.recency * 2 + scores[0]!.importance * 3 + scores[0]!.relevance * 0.5;
    expect(scores[0]?.composite).toBeCloseTo(expected, 6);
  });
});

// ─── AC-59: weights parameter override ───────────────────────────────────────

describe('AC-59: score weights parameter overrides constructor defaults', () => {
  it('uses the passed weights instead of constructor weights', () => {
    const store = new FakeVectorStore();
    const emb = new FakeEmbeddingProvider();
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: emb,
      weights: defaultRetrievalWeights, // all weights 1.0
      clock: () => 0,
    });
    const override: RetrievalWeights = {
      recencyWeight: 0,
      importanceWeight: 0,
      relevanceWeight: 10,
      recencyDecayRate: 0.01,
    };
    const n = mkNode('n1', [1, 0, 0], { timestamp: 0, importance: 5 });
    const scores = engine.score([n], [1, 0, 0], 0, override);
    // composite = relevance*10 only (others zeroed)
    expect(scores[0]?.composite).toBeCloseTo(10, 6);
  });
});

// ─── AC-24: retrieve pipeline ────────────────────────────────────────────────

describe('AC-24: retrieve embeds, fetches, filters by agentId, scores, sorts, top-K', () => {
  it('returns top-K scored results filtered by agentId', async () => {
    const store = new FakeVectorStore();
    const emb = new FakeEmbeddingProvider();
    // embedding provider returns [1,0,0] for any query.
    emb.embed.mockResolvedValue([1, 0, 0]);
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: emb,
      clock: () => 100,
    });

    // All nodes share the same relevance (embedding [1,0,0]); differentiate by
    // importance so sorting is deterministic.
    store.seed(mkNode('low', [1, 0, 0], { importance: 2, timestamp: 100 }));
    store.seed(mkNode('high', [1, 0, 0], { importance: 9, timestamp: 100 }));
    store.seed(mkNode('other', [1, 0, 0], { importance: 9, timestamp: 100, agentId: 'a2' }));

    const results = await engine.retrieve('query', 'a1', 2);
    expect(results).toHaveLength(2);
    // 'high' should rank above 'low' due to higher importance.
    expect(results[0]?.node.id).toBe('high');
    expect(results[1]?.node.id).toBe('low');
    // The 'other' agent node is filtered out.
    expect(results.find((r) => r.node.id === 'other')).toBeUndefined();
  });
});

// ─── AC-25: retrieve updates lastAccessed ────────────────────────────────────

describe('AC-25: retrieve updates lastAccessed on returned nodes', () => {
  it('calls vectorStore.update(id, { lastAccessed: currentSimTime }) for each result', async () => {
    const store = new FakeVectorStore();
    const emb = new FakeEmbeddingProvider();
    emb.embed.mockResolvedValue([1, 0, 0]);
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: emb,
      clock: () => 777,
    });
    store.seed(mkNode('m1', [1, 0, 0], { timestamp: 0 }));
    store.seed(mkNode('m2', [1, 0, 0], { timestamp: 0 }));

    await engine.retrieve('q', 'a1', 2);

    expect(store.updateCalls).toHaveLength(2);
    for (const call of store.updateCalls) {
      expect(call.changes.lastAccessed).toBe(777);
    }
    const ids = store.updateCalls.map((c) => c.id).sort();
    expect(ids).toEqual(['m1', 'm2']);
  });
});

// ─── AC-54: empty result when no memories ────────────────────────────────────

describe('AC-54: retrieve with no memories returns empty array', () => {
  it('returns [] without error', async () => {
    const store = new FakeVectorStore();
    const emb = new FakeEmbeddingProvider();
    emb.embed.mockResolvedValue([1, 0, 0]);
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: emb,
      clock: () => 0,
    });
    const results = await engine.retrieve('q', 'lonely', 5);
    expect(results).toEqual([]);
  });
});
