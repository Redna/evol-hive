/**
 * Spec 014 — InMemoryVectorStore (memory layer)
 * ──────────────────────────────────────────────
 * Covers AC-11 through AC-17 and AC-3, AC-15 (update no-op on missing id).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { MemoryNode } from '@evol-hive/shared';
import { InMemoryVectorStore } from '../src/store/in-memory-vector-store.js';

function node(
  id: string,
  embedding: number[],
  agentId = 'a1',
  timestamp = 0,
  importance = 5,
): MemoryNode {
  return {
    id,
    agentId,
    content: `content-${id}`,
    embedding,
    timestamp,
    importance,
    type: 'observation',
  };
}

describe('AC-11: InMemoryVectorStore is exported', () => {
  it('constructs and implements the VectorStore interface', () => {
    const store = new InMemoryVectorStore();
    expect(store).toBeDefined();
    expect(typeof store.store).toBe('function');
    expect(typeof store.get).toBe('function');
    expect(typeof store.queryByEmbedding).toBe('function');
    expect(typeof store.update).toBe('function');
    expect(typeof store.queryByAgent).toBe('function');
    expect(typeof store.delete).toBe('function');
    expect(typeof store.countRecent).toBe('function');
  });
});

describe('AC-12: queryByEmbedding sorts by cosine similarity desc, limited to topK', () => {
  it('returns the top-K most similar nodes sorted descending', async () => {
    const store = new InMemoryVectorStore();
    // Query vector along x-axis.
    await store.store(node('n1', [1, 0]));
    await store.store(node('n2', [0, 1])); // orthogonal → similarity 0
    await store.store(node('n3', [1, 1])); // 45 degrees → ~0.707
    await store.store(node('n4', [1, 0.0001])); // nearly parallel → ~1

    const results = await store.queryByEmbedding([1, 0], 2);
    expect(results).toHaveLength(2);
    // n1 (sim=1) and n4 (sim≈1) should be the top 2.
    expect(results[0]?.id).toBe('n1');
    expect(results[1]?.id).toBe('n4');
  });

  it('respects the topK limit', async () => {
    const store = new InMemoryVectorStore();
    for (let i = 0; i < 5; i++) {
      await store.store(node(`n${i}`, [i, 1]));
    }
    const results = await store.queryByEmbedding([0, 1], 3);
    expect(results).toHaveLength(3);
  });
});

describe('AC-13: queryByEmbedding returns 0 similarity for zero-magnitude vectors', () => {
  it('a stored zero-magnitude embedding yields similarity 0 (not NaN)', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('zero', [0, 0, 0]));
    await store.store(node('real', [1, 1, 1]));
    const results = await store.queryByEmbedding([1, 1, 1], 5);
    // 'real' should rank above 'zero' because zero has 0 similarity.
    expect(results[0]?.id).toBe('real');
    // zero is still returned but ranked last (similarity 0, not NaN).
    expect(results.some((r) => r.id === 'zero')).toBe(true);
  });

  it('a zero-magnitude query vector yields 0 similarity for all', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('n1', [1, 0]));
    await store.store(node('n2', [0, 1]));
    const results = await store.queryByEmbedding([0, 0], 5);
    // All returned with similarity 0; no NaN, no throw.
    expect(results).toHaveLength(2);
  });
});

describe('AC-14: countRecent(agentId, sinceTimestamp)', () => {
  it('counts nodes for agentId with timestamp >= sinceTimestamp', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('a', [1], 'a1', 10));
    await store.store(node('b', [1], 'a1', 50));
    await store.store(node('c', [1], 'a1', 100));
    await store.store(node('d', [1], 'a2', 100)); // different agent

    expect(await store.countRecent('a1', 50)).toBe(2); // b (50), c (100)
    expect(await store.countRecent('a1', 0)).toBe(3);
    expect(await store.countRecent('a1', 101)).toBe(0);
    expect(await store.countRecent('a2', 0)).toBe(1);
  });
});

describe('AC-15 / AC-3: update applies changes; no-op on missing id', () => {
  it('updates importance and lastAccessed on an existing node', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('m1', [1], 'a1', 0, 8));
    await store.update('m1', { importance: 3, lastAccessed: 500 });
    const updated = await store.get('m1');
    expect(updated?.importance).toBe(3);
    expect(updated?.lastAccessed).toBe(500);
  });

  it('does not throw when updating a non-existent id (no-op)', async () => {
    const store = new InMemoryVectorStore();
    await expect(store.update('nope', { importance: 1 })).resolves.toBeUndefined();
  });

  it('only mutates importance and lastAccessed (immutable fields preserved)', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('m1', [1, 2], 'a1', 42, 5));
    await store.update('m1', { importance: 9 });
    const updated = await store.get('m1');
    expect(updated?.content).toBe('content-m1');
    expect(updated?.embedding).toEqual([1, 2]);
    expect(updated?.timestamp).toBe(42);
    expect(updated?.agentId).toBe('a1');
    expect(updated?.type).toBe('observation');
  });
});

describe('AC-16: queryByAgent(agentId)', () => {
  it('returns all nodes with matching agentId', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('m1', [1], 'a1'));
    await store.store(node('m2', [1], 'a1'));
    await store.store(node('m3', [1], 'a2'));
    const results = await store.queryByAgent('a1');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id).sort()).toEqual(['m1', 'm2']);
  });

  it('returns empty array for an agent with no memories', async () => {
    const store = new InMemoryVectorStore();
    const results = await store.queryByAgent('ghost');
    expect(results).toEqual([]);
  });
});

describe('AC-17: delete(ids)', () => {
  it('removes the specified nodes from the store', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('m1', [1]));
    await store.store(node('m2', [1]));
    await store.store(node('m3', [1]));
    await store.delete(['m1', 'm3']);
    expect(await store.get('m1')).toBeNull();
    expect(await store.get('m3')).toBeNull();
    expect(await store.get('m2')).not.toBeNull();
  });

  it('is a no-op for ids that do not exist', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('m1', [1]));
    await expect(store.delete(['nope'])).resolves.toBeUndefined();
    expect(await store.get('m1')).not.toBeNull();
  });
});

describe('store / get basics', () => {
  beforeEach(() => {
    // fresh instance per test via describe scope
  });

  it('get returns null for missing id', async () => {
    const store = new InMemoryVectorStore();
    expect(await store.get('missing')).toBeNull();
  });

  it('store overwrites an existing id', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('m1', [1], 'a1', 0, 3));
    await store.store(node('m1', [2], 'a1', 0, 9));
    const got = await store.get('m1');
    expect(got?.embedding).toEqual([2]);
    expect(got?.importance).toBe(9);
  });
});
