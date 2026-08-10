/**
 * Tests for MemoryStoreImpl — embedding generation, MemoryNode creation,
 * VectorStore delegation, and unique ID generation.
 *
 * Covers AC-6, AC-7, AC-8, AC-9, AC-39.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MemoryNode, MemoryType } from '@evol-hive/shared';
import type { MemoryEntryInput } from '@evol-hive/shared';
import type { VectorStore, EmbeddingProvider, MemoryStore } from '../src/index.js';
import { MemoryStoreImpl } from '../src/store/index.js';

// ─── EmbeddingProvider interface (AC-6) ──────────────────────────────────────

describe('EmbeddingProvider interface (AC-6)', () => {
  it('can be implemented with dimensions and embed', async () => {
    const provider: EmbeddingProvider = {
      dimensions: 384,
      async embed(_text: string): Promise<number[]> {
        return [0.1, 0.2, 0.3];
      },
    };
    expect(provider.dimensions).toBe(384);
    await expect(provider.embed('hello')).resolves.toEqual([0.1, 0.2, 0.3]);
  });
});

// ─── MemoryStore interface (AC-7) ────────────────────────────────────────────

describe('MemoryStore interface (AC-7)', () => {
  it('can be implemented with store and get', async () => {
    const store: MemoryStore = {
      async store(
        _agentId: string,
        _entry: MemoryEntryInput,
        _timestamp: number,
      ): Promise<MemoryNode> {
        return {
          id: 'test',
          agentId: _agentId,
          content: _entry.content,
          embedding: [],
          timestamp: _timestamp,
          importance: _entry.importance,
          type: _entry.type,
        };
      },
      async get(_id: string): Promise<MemoryNode | null> {
        return null;
      },
    };
    await expect(store.get('x')).resolves.toBeNull();
  });
});

// ─── MemoryStoreImpl (AC-8, AC-9, AC-39) ─────────────────────────────────────

class FakeVectorStore implements VectorStore {
  storeCalls: MemoryNode[] = [];
  getReturn: MemoryNode | null = null;
  getCalls: string[] = [];

  async store(node: MemoryNode): Promise<void> {
    this.storeCalls.push(node);
  }
  async get(id: string): Promise<MemoryNode | null> {
    this.getCalls.push(id);
    return this.getReturn;
  }
  async queryByEmbedding(): Promise<MemoryNode[]> {
    return [];
  }
  async delete(): Promise<void> {
    // no-op
  }
  async countRecent(): Promise<number> {
    return 0;
  }
}

class FakeEmbeddingProvider implements EmbeddingProvider {
  embedCalls: string[] = [];
  readonly dimensions = 384;

  async embed(text: string): Promise<number[]> {
    this.embedCalls.push(text);
    return [0.1, 0.2, 0.3, 0.4];
  }
}

describe('MemoryStoreImpl (AC-8, AC-39)', () => {
  let vectorStore: FakeVectorStore;
  let embeddingProvider: FakeEmbeddingProvider;
  let store: MemoryStoreImpl;

  beforeEach(() => {
    vectorStore = new FakeVectorStore();
    embeddingProvider = new FakeEmbeddingProvider();
    store = new MemoryStoreImpl({ vectorStore, embeddingProvider });
  });

  it('accepts { vectorStore, embeddingProvider } via constructor (AC-39)', () => {
    expect(store).toBeDefined();
  });

  it('store generates an embedding via EmbeddingProvider.embed(entry.content) (AC-8)', async () => {
    const entry: MemoryEntryInput = {
      content: 'Ate a snack',
      importance: 5,
      type: 'action',
    };
    await store.store('a1', entry, 1000);
    expect(embeddingProvider.embedCalls).toEqual(['Ate a snack']);
  });

  it('store creates a MemoryNode with the correct fields and stores it (AC-8)', async () => {
    const entry: MemoryEntryInput = {
      content: 'Found a key',
      importance: 7,
      type: 'observation',
      location: 'bedroom',
    };
    const node = await store.store('a1', entry, 2000);

    expect(node.agentId).toBe('a1');
    expect(node.content).toBe('Found a key');
    expect(node.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(node.importance).toBe(7);
    expect(node.type).toBe('observation');
    expect(node.location).toBe('bedroom');
    expect(node.timestamp).toBe(2000);
    expect(node.id).toBeDefined();
    expect(vectorStore.storeCalls).toHaveLength(1);
    expect(vectorStore.storeCalls[0]).toBe(node);
  });

  it('store creates a MemoryNode without location when not provided (AC-8)', async () => {
    const entry: MemoryEntryInput = {
      content: 'Reflected',
      importance: 8,
      type: 'reflection',
    };
    const node = await store.store('a1', entry, 3000);
    expect(node.location).toBeUndefined();
  });

  it('get delegates to VectorStore.get (AC-8)', async () => {
    const fakeNode: MemoryNode = {
      id: 'mem_1',
      agentId: 'a1',
      content: 'test',
      embedding: [],
      timestamp: 0,
      importance: 5,
      type: 'action',
    };
    vectorStore.getReturn = fakeNode;
    const result = await store.get('mem_1');
    expect(result).toBe(fakeNode);
    expect(vectorStore.getCalls).toEqual(['mem_1']);
  });

  it('get returns null when VectorStore returns null', async () => {
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });
});

// ─── Unique ID generation (AC-9) ─────────────────────────────────────────────

describe('MemoryStoreImpl unique IDs (AC-9)', () => {
  it('calling store twice with the same arguments produces different IDs', async () => {
    const vectorStore = new FakeVectorStore();
    const embeddingProvider = new FakeEmbeddingProvider();
    const store = new MemoryStoreImpl({ vectorStore, embeddingProvider });

    const entry: MemoryEntryInput = {
      content: 'Same content',
      importance: 5,
      type: 'action',
    };
    const node1 = await store.store('a1', entry, 1000);
    const node2 = await store.store('a1', entry, 1000);

    expect(node1.id).not.toBe(node2.id);
  });

  it('IDs contain the agentId and timestamp', async () => {
    const vectorStore = new FakeVectorStore();
    const embeddingProvider = new FakeEmbeddingProvider();
    const store = new MemoryStoreImpl({ vectorStore, embeddingProvider });

    const node = await store.store(
      'agent42',
      {
        content: 'test',
        importance: 3,
        type: 'observation',
      },
      9999,
    );

    expect(node.id).toContain('agent42');
    expect(node.id).toContain('9999');
  });
});
