/**
 * Spec 017 — Memory layer VectorStore export/import
 * ──────────────────────────────────────────────────
 * Covers AC-9 through AC-12.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { MemoryNode } from '@evol-hive/shared';
import { InMemoryVectorStore } from '../src/store/in-memory-vector-store.js';
import type { VectorStore } from '../src/index.js';

function node(
  id: string,
  embedding: number[],
  agentId = 'a1',
  importance = 5,
  lastAccessed?: number,
): MemoryNode {
  return {
    id,
    agentId,
    content: `content-${id}`,
    embedding,
    timestamp: 10,
    importance,
    type: 'observation',
    lastAccessed,
  };
}

describe('AC-9: VectorStore interface includes exportAll(): Promise<MemoryNode[]>', () => {
  it('InMemoryVectorStore has an exportAll method', () => {
    const store = new InMemoryVectorStore();
    expect(typeof store.exportAll).toBe('function');
  });

  it('the VectorStore interface declares exportAll (structural check via duck-typing)', () => {
    const store: VectorStore = new InMemoryVectorStore();
    expect(typeof store.exportAll).toBe('function');
  });
});

describe('AC-10: VectorStore interface includes importAll(nodes): Promise<void>', () => {
  it('InMemoryVectorStore has an importAll method', () => {
    const store = new InMemoryVectorStore();
    expect(typeof store.importAll).toBe('function');
  });

  it('the VectorStore interface declares importAll (structural check via duck-typing)', () => {
    const store: VectorStore = new InMemoryVectorStore();
    expect(typeof store.importAll).toBe('function');
  });
});

describe('AC-11: InMemoryVectorStore.exportAll() returns copies of all nodes', () => {
  let store: InMemoryVectorStore;

  beforeEach(() => {
    store = new InMemoryVectorStore();
  });

  it('returns an empty array when the store is empty', async () => {
    const all = await store.exportAll();
    expect(all).toEqual([]);
  });

  it('returns all stored nodes regardless of agentId', async () => {
    await store.store(node('n1', [1, 0], 'a1'));
    await store.store(node('n2', [0, 1], 'a2'));
    await store.store(node('n3', [1, 1], 'a3'));
    const all = await store.exportAll();
    expect(all).toHaveLength(3);
    const ids = all.map((n) => n.id).sort();
    expect(ids).toEqual(['n1', 'n2', 'n3']);
  });

  it('returns copies — mutating a returned node does not affect the store', async () => {
    await store.store(node('n1', [1, 0]));
    const all = await store.exportAll();
    all[0]!.importance = 99;
    all[0]!.embedding[0]! = 999;
    const refetched = await store.get('n1');
    expect(refetched?.importance).toBe(5);
    expect(refetched?.embedding[0]).toBe(1);
  });
});

describe('AC-12: InMemoryVectorStore.importAll() clears and stores copies', () => {
  let store: InMemoryVectorStore;

  beforeEach(() => {
    store = new InMemoryVectorStore();
  });

  it('clears existing nodes and stores the provided nodes', async () => {
    await store.store(node('old1', [1, 0]));
    await store.store(node('old2', [0, 1]));
    expect(await store.exportAll()).toHaveLength(2);

    await store.importAll([node('new1', [1, 1], 'a1', 8), node('new2', [1, 2], 'a2', 3)]);

    const all = await store.exportAll();
    expect(all).toHaveLength(2);
    const ids = all.map((n) => n.id).sort();
    expect(ids).toEqual(['new1', 'new2']);
  });

  it('after importAll, exportAll returns the same nodes (deep equality)', async () => {
    const nodes = [
      node('m1', [0.1, 0.2, 0.3], 'a1', 7, 12),
      node('m2', [0.4, 0.5, 0.6], 'a1', 4, 9),
    ];
    await store.importAll(nodes);
    const exported = await store.exportAll();
    expect(exported).toHaveLength(2);
    // Order is unspecified — sort by id for deterministic comparison.
    const sorted = exported.sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted[0]).toEqual(nodes[0]);
    expect(sorted[1]).toEqual(nodes[1]);
  });

  it('stores copies — mutating the input array after importAll does not affect the store', async () => {
    const nodes = [node('m1', [1, 0], 'a1', 5)];
    await store.importAll(nodes);
    nodes[0]!.importance = 100;
    const refetched = await store.get('m1');
    expect(refetched?.importance).toBe(5);
  });

  it('importAll with an empty array clears the store', async () => {
    await store.store(node('old1', [1, 0]));
    await store.importAll([]);
    expect(await store.exportAll()).toEqual([]);
  });
});
