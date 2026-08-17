/**
 * Spec 014 — ReflectionLoopImpl (memory layer)
 * ──────────────────────────────────────────────
 * Covers AC-30 through AC-36, AC-56, AC-57, AC-58.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  MemoryNode,
  ReflectionConfig,
  ReflectionResult,
  ConsolidationProvider,
  MemorySnippet,
} from '@evol-hive/shared';
import { defaultReflectionConfig } from '@evol-hive/shared';
import { ReflectionLoopImpl } from '../src/reflection/reflection-loop.js';
import { InMemoryVectorStore } from '../src/store/in-memory-vector-store.js';
import type { VectorStore, EmbeddingProvider, ReflectionLoop } from '../src/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkNode(id: string, opts: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id,
    agentId: 'a1',
    content: `c-${id}`,
    embedding: [1, 0, 0],
    timestamp: 0,
    importance: 4,
    type: 'observation',
    ...opts,
  };
}

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 3;
  embed = vi.fn(async (_t: string): Promise<number[]> => [0.5, 0.5, 0]);
  embedBatch = vi.fn(async (texts: string[]): Promise<number[][]> =>
    texts.map(() => [0.5, 0.5, 0]),
  );
}

class FakeConsolidationProvider implements ConsolidationProvider {
  consolidate = vi.fn(
    async (
      agentId: string,
      _prompt: string,
      _snippets: MemorySnippet[],
    ): Promise<ReflectionResult> => {
      return {
        agentId,
        newMemories: [
          {
            id: 'consolidated-1',
            agentId,
            content: 'Insight: the agent likes coffee',
            embedding: [], // empty → ReflectionLoop must generate
            timestamp: 0,
            importance: 9,
            type: 'reflection',
          },
        ],
        consolidatedNodeIds: ['orig-1', 'orig-2'],
      };
    },
  );
}

// ─── AC-30: exported ─────────────────────────────────────────────────────────

describe('AC-30: ReflectionLoopImpl exported', () => {
  it('is importable and implements ReflectionLoop', () => {
    const store = new InMemoryVectorStore();
    const emb = new FakeEmbeddingProvider();
    const cp = new FakeConsolidationProvider();
    const loop: ReflectionLoop = new ReflectionLoopImpl({
      vectorStore: store,
      embeddingProvider: emb,
      consolidationProvider: cp,
      config: defaultReflectionConfig,
      clock: () => 100,
    });
    expect(loop).toBeDefined();
    expect(typeof loop.shouldReflect).toBe('function');
    expect(typeof loop.runReflection).toBe('function');
    expect(typeof loop.start).toBe('function');
    expect(typeof loop.stop).toBe('function');
  });
});

// ─── AC-31: constructor options ──────────────────────────────────────────────

describe('AC-31: constructor accepts { vectorStore, embeddingProvider, consolidationProvider, config, clock }', () => {
  it('constructs with all options', () => {
    const store = new InMemoryVectorStore();
    const loop = new ReflectionLoopImpl({
      vectorStore: store,
      embeddingProvider: new FakeEmbeddingProvider(),
      consolidationProvider: new FakeConsolidationProvider(),
      config: defaultReflectionConfig,
      clock: () => 42,
    });
    expect(loop).toBeDefined();
  });
});

// ─── AC-32: shouldReflect ────────────────────────────────────────────────────

describe('AC-32: shouldReflect triggers', () => {
  it('returns true when node threshold exceeded', async () => {
    const store = new InMemoryVectorStore();
    const config: ReflectionConfig = { nodeThreshold: 2, idleThresholdSeconds: 30, enabled: true };
    const loop = new ReflectionLoopImpl({
      vectorStore: store,
      embeddingProvider: new FakeEmbeddingProvider(),
      consolidationProvider: new FakeConsolidationProvider(),
      config,
      clock: () => 100,
    });
    loop.start();
    // Seed 3 nodes since timestamp 0 (>= nodeThreshold of 2).
    await store.store(mkNode('m1', { timestamp: 10 }));
    await store.store(mkNode('m2', { timestamp: 20 }));
    await store.store(mkNode('m3', { timestamp: 30 }));
    expect(await loop.shouldReflect('a1', 100, false)).toBe(true);
  });

  it('returns true when idle threshold met', async () => {
    const store = new InMemoryVectorStore();
    const config: ReflectionConfig = {
      nodeThreshold: 100,
      idleThresholdSeconds: 30,
      enabled: true,
    };
    const loop = new ReflectionLoopImpl({
      vectorStore: store,
      embeddingProvider: new FakeEmbeddingProvider(),
      consolidationProvider: new FakeConsolidationProvider(),
      config,
      clock: () => 100,
    });
    loop.start();
    // No nodes, but idle for 50 seconds >= 30.
    expect(await loop.shouldReflect('a1', 100, true)).toBe(true);
  });

  it('returns false when neither threshold met', async () => {
    const store = new InMemoryVectorStore();
    const config: ReflectionConfig = {
      nodeThreshold: 100,
      idleThresholdSeconds: 30,
      enabled: true,
    };
    const loop = new ReflectionLoopImpl({
      vectorStore: store,
      embeddingProvider: new FakeEmbeddingProvider(),
      consolidationProvider: new FakeConsolidationProvider(),
      config,
      clock: () => 10,
    });
    loop.start();
    expect(await loop.shouldReflect('a1', 10, false)).toBe(false);
  });

  it('returns false when config.enabled is false', async () => {
    const store = new InMemoryVectorStore();
    const config: ReflectionConfig = { nodeThreshold: 1, idleThresholdSeconds: 1, enabled: false };
    const loop = new ReflectionLoopImpl({
      vectorStore: store,
      embeddingProvider: new FakeEmbeddingProvider(),
      consolidationProvider: new FakeConsolidationProvider(),
      config,
      clock: () => 100,
    });
    loop.start();
    await store.store(mkNode('m1', { timestamp: 50 }));
    expect(await loop.shouldReflect('a1', 100, true)).toBe(false);
  });
});

// ─── AC-33, AC-34, AC-35, AC-57, AC-58: runReflection ───────────────────────

describe('AC-33..35,57,58: runReflection consolidates, stores, deprioritizes', () => {
  let store: InMemoryVectorStore;
  let emb: FakeEmbeddingProvider;
  let cp: FakeConsolidationProvider;
  let loop: ReflectionLoopImpl;

  beforeEach(() => {
    store = new InMemoryVectorStore();
    emb = new FakeEmbeddingProvider();
    cp = new FakeConsolidationProvider();
    loop = new ReflectionLoopImpl({
      vectorStore: store,
      embeddingProvider: emb,
      consolidationProvider: cp,
      config: defaultReflectionConfig,
      clock: () => 500,
    });
    loop.start();
  });

  it('calls consolidationProvider.consolidate with agentId + snippets', async () => {
    await store.store(mkNode('orig-1', { importance: 8, timestamp: 100 }));
    await store.store(mkNode('orig-2', { importance: 6, timestamp: 200 }));
    await loop.runReflection('a1');
    expect(cp.consolidate).toHaveBeenCalledTimes(1);
    expect(cp.consolidate.mock.calls[0]?.[0]).toBe('a1');
    const snippets = cp.consolidate.mock.calls[0]?.[2];
    expect(snippets).toHaveLength(2);
  });

  it('stores new memories and generates embeddings for empty ones (AC-33, AC-34, AC-58)', async () => {
    await store.store(mkNode('orig-1', { timestamp: 100 }));
    const result = await loop.runReflection('a1');
    expect(result.newMemories).toHaveLength(1);
    const stored = await store.get('consolidated-1');
    expect(stored).not.toBeNull();
    expect(stored?.agentId).toBe('a1');
    expect(stored?.lastAccessed).toBe(500);
    // Embedding was generated (provider was called).
    expect(emb.embed).toHaveBeenCalled();
    expect(stored?.embedding).toEqual([0.5, 0.5, 0]);
  });

  it('deprioritizes original nodes by halving importance, min 1 (AC-35, AC-57)', async () => {
    await store.store(mkNode('orig-1', { importance: 8, timestamp: 100 }));
    await store.store(mkNode('orig-2', { importance: 6, timestamp: 200 }));
    await loop.runReflection('a1');
    const o1 = await store.get('orig-1');
    const o2 = await store.get('orig-2');
    expect(o1?.importance).toBe(4); // 8/2
    expect(o2?.importance).toBe(3); // 6/2
  });

  it('never reduces importance below 1', async () => {
    await store.store(mkNode('orig-1', { importance: 1, timestamp: 100 }));
    await loop.runReflection('a1');
    const o1 = await store.get('orig-1');
    expect(o1?.importance).toBe(1); // max(1, 1/2=0.5) = 1
  });

  it('skips consolidated node ids that do not exist in the store', async () => {
    // Only orig-1 exists; orig-2 is missing → no throw.
    await store.store(mkNode('orig-1', { importance: 8, timestamp: 100 }));
    await expect(loop.runReflection('a1')).resolves.toBeDefined();
  });

  it('overrides agentId on new memories to be authoritative', async () => {
    cp.consolidate.mockResolvedValueOnce({
      agentId: 'wrong',
      newMemories: [
        {
          id: 'c-2',
          agentId: 'wrong',
          content: 'x',
          embedding: [1, 0, 0],
          timestamp: 0,
          importance: 7,
          type: 'reflection',
        },
      ],
      consolidatedNodeIds: [],
    });
    await loop.runReflection('a1');
    const stored = await store.get('c-2');
    expect(stored?.agentId).toBe('a1');
  });
});

// ─── AC-36: concurrent reflection guard ──────────────────────────────────────

describe('AC-36: concurrent reflection guard', () => {
  it('returns empty ReflectionResult when agent is already reflecting', async () => {
    const store = new InMemoryVectorStore();
    await store.store(mkNode('orig-1', { timestamp: 100 }));
    let resolveFirst!: () => void;
    const firstPromise = new Promise<ReflectionResult>((res) => {
      resolveFirst = () => res({ agentId: 'a1', newMemories: [], consolidatedNodeIds: [] });
    });
    const cp: ConsolidationProvider = {
      consolidate: vi.fn(() => firstPromise),
    };
    const loop = new ReflectionLoopImpl({
      vectorStore: store,
      embeddingProvider: new FakeEmbeddingProvider(),
      consolidationProvider: cp,
      config: defaultReflectionConfig,
      clock: () => 100,
    });
    loop.start();

    // Start first reflection (hangs on the unresolved promise).
    const inFlight = loop.runReflection('a1');
    // While in flight, a second call returns immediately with empty result.
    const second = await loop.runReflection('a1');
    expect(second.newMemories).toEqual([]);
    expect(second.consolidatedNodeIds).toEqual([]);

    // Release the first so it can complete.
    resolveFirst();
    await inFlight;
  });
});

// ─── AC-56: disabled config is a no-op ───────────────────────────────────────

describe('AC-56: runReflection when config.enabled is false is a no-op', () => {
  it('returns empty ReflectionResult without calling the provider', async () => {
    const store = new InMemoryVectorStore();
    const cp = new FakeConsolidationProvider();
    const loop = new ReflectionLoopImpl({
      vectorStore: store,
      embeddingProvider: new FakeEmbeddingProvider(),
      consolidationProvider: cp,
      config: { nodeThreshold: 1, idleThresholdSeconds: 1, enabled: false },
      clock: () => 100,
    });
    loop.start();
    const result = await loop.runReflection('a1');
    expect(result.newMemories).toEqual([]);
    expect(result.consolidatedNodeIds).toEqual([]);
    expect(cp.consolidate).not.toHaveBeenCalled();
  });
});

// ─── runReflection before start() is a no-op ─────────────────────────────────

describe('runReflection before start() is a no-op', () => {
  it('returns empty result when not running', async () => {
    const store = new InMemoryVectorStore();
    const cp = new FakeConsolidationProvider();
    const loop = new ReflectionLoopImpl({
      vectorStore: store,
      embeddingProvider: new FakeEmbeddingProvider(),
      consolidationProvider: cp,
      config: defaultReflectionConfig,
      clock: () => 100,
    });
    // Not started.
    const result = await loop.runReflection('a1');
    expect(result.newMemories).toEqual([]);
    expect(cp.consolidate).not.toHaveBeenCalled();
  });
});
