/**
 * Spec 035 — Write-time composite importance in the memory package
 * (Req 14 / AC-7). Composition happens at memory-write time;
 * `MemoryNode.importance` holds the composite. The retrieval formula is
 * untouched (frozen — see `spec-035-retrieval-frozen-regression.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import type { MemoryEntryInput, MemoryNode } from '@evol-hive/shared';
import { MemoryStoreImpl } from '../src/store/index.js';
import type { VectorStore, EmbeddingProvider } from '../src/index.js';

/** Minimal deterministic embedding provider: maps text to a 3-dim vector. */
const fakeEmbeddingProvider: EmbeddingProvider = {
  dimensions: 3,
  async embed(text: string): Promise<number[]> {
    let h = 0;
    for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 997;
    return [((h % 7) - 3) / 10, ((h % 5) - 2) / 10, ((h % 3) - 1) / 10];
  },
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => fakeEmbeddingProvider.embed(t)));
  },
};

function makeStore(composer?: (entry: MemoryEntryInput, ctx: { agentId: string; timestamp: number; content: string }) => number): {
  store: MemoryStoreImpl;
  nodes: MemoryNode[];
} {
  const nodes: MemoryNode[] = [];
  const vectorStore: VectorStore = {
    async store(node: MemoryNode): Promise<void> {
      nodes.push(node);
    },
    async get(id: string) {
      return nodes.find((n) => n.id === id) ?? null;
    },
    async update(): Promise<void> {},
    async queryByEmbedding(embedding: number[], topK: number) {
      return nodes.slice(0, topK);
    },
    async queryByAgent(agentId: string) {
      return nodes.filter((n) => n.agentId === agentId);
    },
    async countRecent(): Promise<number> {
      return nodes.length;
    },
  };
  return { store: new MemoryStoreImpl({ vectorStore, embeddingProvider: fakeEmbeddingProvider, ...(composer ? { importanceComposer: composer } : {}) }), nodes };
}

function entry(importance = 5): MemoryEntryInput {
  return { content: 'brewed coffee at the machine', importance, type: 'action' };
}

describe('Spec 035 — composite importance at memory-write time (Req 14 / AC-7)', () => {
  it('without a composer, node.importance is the raw LLM-assigned score (backward compat)', async () => {
    const { store } = makeStore();
    const node = await store.store('a1', entry(7), 100);
    expect(node.importance).toBe(7);
  });

  it('with a composer, node.importance holds the composite (not the raw score)', async () => {
    const { store } = makeStore((e) => e.importance * 0.5 + 2.5);
    const node = await store.store('a1', entry(8), 100);
    expect(node.importance).toBeCloseTo(6.5, 12);
  });

  it('the composer receives the write context (agentId, timestamp, content)', async () => {
    let seen: { agentId: string; timestamp: number; content: string } | null = null;
    const { store } = makeStore((e, ctx) => {
      seen = ctx;
      return 5;
    });
    await store.store('a1', entry(3), 250);
    expect(seen).toEqual({ agentId: 'a1', timestamp: 250, content: 'brewed coffee at the machine' });
  });

  it('the composed importance is clamped to the 1..10 storage contract', async () => {
    const { store } = makeStore(() => 42);
    const node = await store.store('a1', entry(1), 100);
    expect(node.importance).toBeLessThanOrEqual(10);
    const { store: store2 } = makeStore(() => -5);
    const node2 = await store2.store('a1', entry(1), 100);
    expect(node2.importance).toBeGreaterThanOrEqual(1);
  });

  it('a fixed input produces a byte-identical node shape (no schema drift)', async () => {
    const { store, nodes } = makeStore((e, ctx) => 3 + ctx.timestamp / 1000);
    const node = await store.store('a1', entry(5), 500);
    expect(nodes).toHaveLength(1);
    expect({ ...node, id: '', embedding: [] }).toEqual({
      id: '',
      agentId: 'a1',
      content: 'brewed coffee at the machine',
      embedding: [],
      importance: 3.5,
      type: 'action',
      timestamp: 500,
    });
  });
});