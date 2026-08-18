/**
 * Spec 017 — VectorStore export/import (memory layer)
 * ─────────────────────────────────────────────────────
 * Covers AC-9 through AC-12.
 */
import { describe, it, expect } from 'vitest';
import type { MemoryNode } from '@evol-hive/shared';
import { InMemoryVectorStore } from '../src/store/in-memory-vector-store.js';
import type { VectorStore } from '../src/index.js';

function node(
  id: string,
  embedding: number[],
  agentId = 'a1',
  timestamp = 0,
  importance = 5,
  type: MemoryNode['type'] = 'observation',
  lastAccessed?: number,
): MemoryNode {
  const n: MemoryNode = {
    id,
    agentId,
    content: `content-${id}`,
    embedding,
    timestamp,
    importance,
    type,
  };
  if (lastAccessed !== undefined) n.lastAccessed = lastAccessed;
  return n;
}

// ─── AC-9: VectorStore.exportAll ─────────────────────────────────────────────

describe('AC-9: VectorStore interface includes exportAll()', () => {
  it('exportAll is part of the VectorStore interface', () => {
    const store: VectorStore = new InMemoryVectorStore();
    expect(typeof store.exportAll).toBe('function');
  });
});

// ─── AC-10: VectorStore.importAll ────────────────────────────────────────────

describe('AC-10: VectorStore interface includes importAll()', () => {
  it('importAll is part of the VectorStore interface', () => {
    const store: VectorStore = new InMemoryVectorStore();
    expect(typeof store.importAll).toBe('function');
  });
});

// ─── AC-11: InMemoryVectorStore.exportAll returns copies ─────────────────────

describe('AC-11: InMemoryVectorStore.exportAll() returns copies', () => {
  it('returns all stored MemoryNode objects', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('n1', [1, 0]));
    await store.store(node('n2', [0, 1]));
    await store.store(node('n3', [1, 1], 'a2'));

    const all = await store.exportAll();
    expect(all).toHaveLength(3);
    const ids = all.map((n) => n.id).sort();
    expect(ids).toEqual(['n1', 'n2', 'n3']);
  });

  it('returns an empty array when the store is empty', async () => {
    const store = new InMemoryVectorStore();
    const all = await store.exportAll();
    expect(all).toEqual([]);
  });

  it('mutating a returned node does not affect the store', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('n1', [1, 0], 'a1', 10, 5));

    const all = await store.exportAll();
    expect(all).toHaveLength(1);
    // Mutate the returned copy's top-level fields.
    all[0]!.importance = 99;
    all[0]!.content = 'hacked';

    // The store should be unaffected (exportAll returns shallow copies — spec 017, Req 11).
    const stored = await store.get('n1');
    expect(stored).not.toBeNull();
    expect(stored!.importance).toBe(5);
    expect(stored!.content).toBe('content-n1');
  });

  it('preserves lastAccessed and importance fields', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('n1', [1, 0], 'a1', 10, 7, 'observation', 20));

    const all = await store.exportAll();
    expect(all[0]!.importance).toBe(7);
    expect(all[0]!.lastAccessed).toBe(20);
  });
});

// ─── AC-12: InMemoryVectorStore.importAll clears and stores copies ───────────

describe('AC-12: InMemoryVectorStore.importAll() clears and stores copies', () => {
  it('clears existing nodes and stores the provided nodes', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('old1', [1, 0]));
    await store.store(node('old2', [0, 1]));

    const newNodes = [node('new1', [1, 1]), node('new2', [1, 2])];
    await store.importAll(newNodes);

    const all = await store.exportAll();
    expect(all).toHaveLength(2);
    const ids = all.map((n) => n.id).sort();
    expect(ids).toEqual(['new1', 'new2']);
  });

  it('after importAll, exportAll returns the same nodes (deep equality)', async () => {
    const store = new InMemoryVectorStore();
    const nodes = [
      node('n1', [1, 0], 'a1', 5, 3, 'observation', 10),
      node('n2', [0, 1], 'a2', 15, 8, 'reflection', 25),
      node('n3', [1, 1], 'a1', 20, 1, 'action'),
    ];

    await store.importAll(nodes);
    const all = await store.exportAll();
    expect(all).toHaveLength(3);

    // Deep equality check (sort by id for stable comparison).
    const sortedOriginal = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
    const sortedExported = [...all].sort((a, b) => a.id.localeCompare(b.id));
    expect(sortedExported).toEqual(sortedOriginal);
  });

  it('importing an empty array clears the store', async () => {
    const store = new InMemoryVectorStore();
    await store.store(node('n1', [1, 0]));
    await store.importAll([]);

    const all = await store.exportAll();
    expect(all).toEqual([]);
  });

  it('mutating the input array after importAll does not affect the store', async () => {
    const store = new InMemoryVectorStore();
    const nodes = [node('n1', [1, 0], 'a1', 10, 5)];
    await store.importAll(nodes);

    // Mutate the original input.
    nodes[0]!.importance = 99;

    const stored = await store.get('n1');
    expect(stored).not.toBeNull();
    expect(stored!.importance).toBe(5);
  });
});
