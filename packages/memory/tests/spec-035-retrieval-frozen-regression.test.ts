/**
 * Spec 035 — retrieval-formula freeze regression (spec 035, AC-7 partial)
 * ─────────────────────────────────────────────────────────────────────────
 * Spec 035's constraint "Retrieval is frozen" and AC-7 require that
 * `RetrievalEngineImpl`'s spec-014 scoring formula, decay rates, and
 * `defaultRetrievalWeights` remain byte-identical in behavior when the
 * trainable importance head lands: composite importance improves the *input
 * quality* (value stored in `MemoryNode.importance` at write time), never the
 * scoring formula.
 *
 * This file pins the contract with independently hand-computed golden values
 * for fixed inputs (derived from the documented formulas, not from the
 * implementation), so any accidental change to scoring is caught even though
 * the composite-importance feature itself is not yet implemented.
 *
 * Documented formulas (§11.2 / spec 014 Req 10):
 *   recency    = e^(-recencyDecayRate * (simTime - timestamp))
 *   importance = node.importance * e^(-recencyDecayRate*0.1 * (simTime - (lastAccessed ?? timestamp)))
 *   relevance  = cosineSimilarity(query, node.embedding)   (0 for zero-magnitude)
 *   composite  = recency*recencyWeight + importance*importanceWeight + relevance*relevanceWeight
 */
import { describe, it, expect } from 'vitest';
import type { MemoryNode, RetrievalWeights } from '@evol-hive/shared';
import { defaultRetrievalWeights } from '@evol-hive/shared';
import { RetrievalEngineImpl } from '../src/retrieval/retrieval-engine.js';
import type { VectorStore, EmbeddingProvider, SimulationClock } from '../src/index.js';

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

class FakeVectorStore implements VectorStore {
  private readonly nodes: MemoryNode[];
  constructor(nodes: MemoryNode[]) {
    this.nodes = nodes;
  }
  async store(node: MemoryNode): Promise<void> {
    this.nodes.push(node);
  }
  async get(id: string): Promise<MemoryNode | null> {
    return this.nodes.find((n) => n.id === id) ?? null;
  }
  async queryByEmbedding(_embedding: number[], topK: number): Promise<MemoryNode[]> {
    return this.nodes.slice(0, topK);
  }
  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      const i = this.nodes.findIndex((n) => n.id === id);
      if (i !== -1) this.nodes.splice(i, 1);
    }
  }
  async countRecent(): Promise<number> {
    return this.nodes.length;
  }
  async update(
    id: string,
    changes: Partial<Pick<MemoryNode, 'importance' | 'lastAccessed'>>,
  ): Promise<void> {
    const node = this.nodes.find((n) => n.id === id);
    if (node) Object.assign(node, changes);
  }
  async queryByAgent(agentId: string): Promise<MemoryNode[]> {
    return this.nodes.filter((n) => n.agentId === agentId);
  }
  async exportAll(): Promise<MemoryNode[]> {
    return [...this.nodes];
  }
  async importAll(nodes: MemoryNode[]): Promise<void> {
    this.nodes.length = 0;
    this.nodes.push(...nodes);
  }
}

const fakeEmbeddingProvider: EmbeddingProvider = {
  dimensions: 2,
  embed: async (text: string) => (text === 'query' ? [1, 0] : [0, 1]),
  embedBatch: async (texts: string[]) => texts.map((t) => (t === 'query' ? [1, 0] : [0, 1])),
};

// ─── AC-7 (partial): defaultRetrievalWeights are frozen ───────────────────────

describe('spec 035 / AC-7 (partial): retrieval formula freeze regression', () => {
  it('defaultRetrievalWeights are exactly the spec-014 §11.2 values', () => {
    expect(defaultRetrievalWeights).toEqual({
      recencyWeight: 1.0,
      importanceWeight: 1.0,
      relevanceWeight: 1.0,
      recencyDecayRate: 0.01,
    });
  });

  it('scoring outputs for fixed inputs match independently hand-computed golden values', () => {
    // Fixed fixture; clock = 100; query embedding [1, 0].
    const nodes: MemoryNode[] = [
      // A: age 100, no lastAccessed → recency e^-1, importance 5·e^-0.1, relevance 1
      mkNode('a', [1, 0], { timestamp: 0, importance: 5 }),
      // B: age 50, lastAccessed 90 → recency e^-0.5, importance 8·e^-0.01, relevance 0
      mkNode('b', [0, 1], { timestamp: 50, importance: 8, lastAccessed: 90 }),
      // C: age 0 → recency 1, importance 3, relevance 1/√2
      mkNode('c', [1, 1], { timestamp: 100, importance: 3, lastAccessed: 100 }),
      // D: zero-magnitude embedding → relevance 0 by contract; age 10, impAge 5
      mkNode('d', [0, 0], { timestamp: 90, importance: 2, lastAccessed: 95 }),
    ];
    const clock: SimulationClock = () => 100;
    const engine = new RetrievalEngineImpl({
      vectorStore: new FakeVectorStore(nodes),
      embeddingProvider: fakeEmbeddingProvider,
      clock,
    });

    const scores = engine.score(nodes, [1, 0], 100);
    const byId = new Map(scores.map((s) => [s.memoryId, s]));

    // A: recency 0.36787944117144233, importance 4.524187090179797, relevance 1
    expect(byId.get('a')!.recency).toBeCloseTo(0.36787944117144233, 12);
    expect(byId.get('a')!.importance).toBeCloseTo(4.524187090179797, 12);
    expect(byId.get('a')!.relevance).toBeCloseTo(1, 12);
    expect(byId.get('a')!.composite).toBeCloseTo(5.89206653135124, 12);

    // B: recency 0.6065306597126334, importance 7.920398669993345, relevance 0
    expect(byId.get('b')!.recency).toBeCloseTo(0.6065306597126334, 12);
    expect(byId.get('b')!.importance).toBeCloseTo(7.920398669993345, 12);
    expect(byId.get('b')!.relevance).toBeCloseTo(0, 12);
    expect(byId.get('b')!.composite).toBeCloseTo(8.526929329705979, 12);

    // C: recency 1, importance 3, relevance 0.7071067811865475
    expect(byId.get('c')!.recency).toBeCloseTo(1, 12);
    expect(byId.get('c')!.importance).toBeCloseTo(3, 12);
    expect(byId.get('c')!.relevance).toBeCloseTo(0.7071067811865475, 12);
    expect(byId.get('c')!.composite).toBeCloseTo(4.707106781186548, 12);

    // D: recency 0.9048374180359595, importance 1.9900249583853646, relevance 0
    expect(byId.get('d')!.recency).toBeCloseTo(0.9048374180359595, 12);
    expect(byId.get('d')!.importance).toBeCloseTo(1.9900249583853646, 12);
    expect(byId.get('d')!.relevance).toBeCloseTo(0, 12);
    expect(byId.get('d')!.composite).toBeCloseTo(2.894862376421324, 12);
  });

  it('retrieve() sorts by composite descending and returns the frozen ranking', async () => {
    const nodes: MemoryNode[] = [
      mkNode('a', [1, 0], { timestamp: 0, importance: 5 }), // composite ≈ 5.892
      mkNode('b', [0, 1], { timestamp: 50, importance: 8, lastAccessed: 90 }), // ≈ 8.527
      mkNode('c', [1, 1], { timestamp: 100, importance: 3, lastAccessed: 100 }), // ≈ 4.707
      mkNode('d', [0, 0], { timestamp: 90, importance: 2, lastAccessed: 95 }), // ≈ 2.895
    ];
    const store = new FakeVectorStore(nodes);
    const clock: SimulationClock = () => 100;
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: fakeEmbeddingProvider,
      clock,
    });

    const results = await engine.retrieve('query', 'a1', 4);
    expect(results.map((r) => r.node.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(results[0]!.score.composite).toBeCloseTo(8.526929329705979, 12);
    expect(results[3]!.score.composite).toBeCloseTo(2.894862376421324, 12);
  });

  it('scoring never mutates node.importance — composition must stay at write time (spec 035 Req 14/15)', async () => {
    const nodes: MemoryNode[] = [
      mkNode('a', [1, 0], { timestamp: 0, importance: 5 }),
      mkNode('b', [0, 1], { timestamp: 50, importance: 8, lastAccessed: 90 }),
    ];
    const store = new FakeVectorStore(nodes);
    const clock: SimulationClock = () => 100;
    const engine = new RetrievalEngineImpl({
      vectorStore: store,
      embeddingProvider: fakeEmbeddingProvider,
      clock,
    });

    await engine.retrieve('query', 'a1', 2);
    // lastAccessed may be bumped (spec 014 decay-on-read), but static
    // importance is LLM-assigned at encoding and must be untouched by scoring.
    expect(nodes[0]!.importance).toBe(5);
    expect(nodes[1]!.importance).toBe(8);
  });

  it('explicit weights still override constructor defaults (spec 014 AC-59 contract intact)', () => {
    const nodes: MemoryNode[] = [mkNode('a', [1, 0], { timestamp: 0, importance: 5 })];
    const clock: SimulationClock = () => 100;
    const weights: RetrievalWeights = {
      recencyWeight: 0,
      importanceWeight: 0,
      relevanceWeight: 1,
      recencyDecayRate: 0.5,
    };
    const engine = new RetrievalEngineImpl({
      vectorStore: new FakeVectorStore(nodes),
      embeddingProvider: fakeEmbeddingProvider,
      clock,
    });
    const scores = engine.score(nodes, [1, 0], 100, weights);
    // Only relevance survives: composite = 1 * 1 = 1
    expect(scores[0]!.composite).toBeCloseTo(1, 12);
  });
});
