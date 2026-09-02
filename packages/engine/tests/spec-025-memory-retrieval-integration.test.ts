/**
 * Spec 025 — Memory Entry Flatten & Auto-Fallback
 * Integration test for the engine ↔ memory boundary.
 *
 * Covers AC-2 (every stored memory has non-empty content) and AC-3 (stored
 * memories are retrievable via the retrieval engine, which backs the
 * `query_memory` cognitive tool).
 *
 * The existing `reflect-integration.test.ts` uses a FakeVectorStore whose
 * `queryByEmbedding` returns `[]`, so retrieval is never exercised. This
 * test wires the real `InMemoryVectorStore` + `RetrievalEngineImpl` so we
 * can verify the full store → embed → retrieve round-trip.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { MemoryEntryInput } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { PlanManagerImpl } from '../src/agents/plans/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { ReflectDataProviderImpl } from '../src/agents/reflect/index.js';
import type { EmbeddingProvider, VectorStore } from '@evol-hive/memory';
import { MemoryStoreImpl, InMemoryVectorStore, RetrievalEngineImpl } from '@evol-hive/memory';

const AGENT_ID = 'a1';

// ─── Fakes ───────────────────────────────────────────────────────────────────

/**
 * Deterministic embedding provider that maps each unique word to a fixed
 * dimension, producing embeddings where similar texts have high cosine
 * similarity. This lets us test retrieval ranking without a real model.
 */
class SemanticEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 8;
  private readonly vocab = new Map<string, number>();

  private encode(text: string): number[] {
    const vec = new Array(this.dimensions).fill(0);
    for (const word of text.toLowerCase().split(/\W+/)) {
      if (!word) continue;
      let idx = this.vocab.get(word);
      if (idx === undefined) {
        idx = this.vocab.size % this.dimensions;
        this.vocab.set(word, idx);
      }
      vec[idx]! += 1;
    }
    return vec;
  }

  async embed(text: string): Promise<number[]> {
    return this.encode(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.encode(t));
  }
}

// ─── Setup ───────────────────────────────────────────────────────────────────

function setup(clockReturn: number = 1000) {
  const agentManager = new AgentManagerImpl();
  const planManager = new PlanManagerImpl(agentManager, () => clockReturn);
  const driveSystem = new DriveSystemImpl(agentManager);
  const vectorStore: VectorStore = new InMemoryVectorStore();
  const embeddingProvider = new SemanticEmbeddingProvider();
  const memoryStore = new MemoryStoreImpl({ vectorStore, embeddingProvider });
  const clock = () => clockReturn;

  const provider = new ReflectDataProviderImpl(
    agentManager,
    driveSystem,
    planManager,
    memoryStore,
    clock,
  );

  const retrievalEngine = new RetrievalEngineImpl({
    vectorStore,
    embeddingProvider,
    clock,
  });

  agentManager.spawn({
    id: AGENT_ID,
    name: 'Test Agent',
    description: '',
    traits: [],
    initialDrives: { energy: 50, hunger: 50 },
  });

  return { provider, vectorStore, embeddingProvider, retrievalEngine, clock };
}

// ─── Integration Tests ───────────────────────────────────────────────────────

describe('Spec 025 — memory storage & retrieval integration (AC-2, AC-3)', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  // AC-2 + AC-3: auto-fallback memory (importance=3, type=action) is stored
  // with non-empty content and is retrievable.
  it('auto-fallback memory (importance=3, type=action) is stored with non-empty content and retrievable (AC-2, AC-3)', async () => {
    // Simulate the auto-fallback output from ReflectServiceImpl (R5).
    const entry: MemoryEntryInput = {
      content: 'Action succeeded: Brew coffee. Goal: Brew coffee',
      importance: 3,
      type: 'action',
      location: 'kitchen',
    };

    await ctx.provider.storeMemory(AGENT_ID, entry);

    // AC-2: content is non-empty.
    expect(entry.content.length).toBeGreaterThan(0);

    // AC-3: retrieve via the retrieval engine (backs query_memory).
    const results = await ctx.retrievalEngine.retrieve('Brew coffee', AGENT_ID, 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.node.content).toBe(entry.content);
    expect(results[0]!.node.importance).toBe(3);
    expect(results[0]!.node.type).toBe('action');
    expect(results[0]!.node.location).toBe('kitchen');
  });

  // AC-2 + AC-3: LLM-provided memory (flattened fields) is stored with
  // non-empty content and retrievable.
  it('LLM-provided memory (flattened fields) is stored with non-empty content and retrievable (AC-2, AC-3)', async () => {
    const entry: MemoryEntryInput = {
      content: 'Discovered a hidden passage behind the bookshelf',
      importance: 8,
      type: 'reflection',
      location: 'library',
    };

    await ctx.provider.storeMemory(AGENT_ID, entry);

    expect(entry.content.length).toBeGreaterThan(0);

    const results = await ctx.retrievalEngine.retrieve('hidden passage bookshelf', AGENT_ID, 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.node.content).toBe(entry.content);
    expect(results[0]!.node.importance).toBe(8);
    expect(results[0]!.node.type).toBe('reflection');
  });

  // AC-2: multiple memories stored (mix of auto-fallback and LLM-provided)
  // are all retrievable and all have non-empty content.
  it('multiple memories (auto-fallback + LLM-provided) are all retrievable with non-empty content (AC-2, AC-3)', async () => {
    const autoFallback: MemoryEntryInput = {
      content: 'Action failed: No water. Goal: Brew coffee',
      importance: 3,
      type: 'observation',
      location: 'kitchen',
    };
    const llmProvided: MemoryEntryInput = {
      content: 'Found a coffee grinder in the pantry',
      importance: 6,
      type: 'observation',
      location: 'pantry',
    };

    await ctx.provider.storeMemory(AGENT_ID, autoFallback);
    await ctx.provider.storeMemory(AGENT_ID, llmProvided);

    const results = await ctx.retrievalEngine.retrieve('coffee', AGENT_ID, 10);
    expect(results).toHaveLength(2);

    // AC-2: every stored memory has non-empty content.
    for (const result of results) {
      expect(result.node.content.length).toBeGreaterThan(0);
    }

    const contents = results.map((r) => r.node.content);
    expect(contents).toContain(autoFallback.content);
    expect(contents).toContain(llmProvided.content);
  });

  // AC-3: retrieval respects agentId filtering — memories from other agents
  // are not returned.
  it('retrieval only returns memories for the queried agent (AC-3)', async () => {
    // Store memory for agent a1.
    await ctx.provider.storeMemory(AGENT_ID, {
      content: 'Agent a1 memory about coffee',
      importance: 5,
      type: 'action',
    });

    // Manually store a memory for a different agent via the vector store.
    const otherNode = {
      id: 'a2-1000-0',
      agentId: 'a2',
      content: 'Agent a2 memory about tea',
      embedding: await ctx.embeddingProvider.embed('Agent a2 memory about tea'),
      importance: 5,
      type: 'observation' as const,
      timestamp: 1000,
    };
    await ctx.vectorStore.store(otherNode);

    // Retrieve for a1 — should only get a1's memory.
    const results = await ctx.retrievalEngine.retrieve('coffee', AGENT_ID, 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.node.agentId).toBe(AGENT_ID);
    expect(results[0]!.node.content).toContain('coffee');
  });

  // AC-3: retrieval returns empty array when no memories exist for the agent.
  it('retrieval returns empty array when no memories stored for agent (AC-3)', async () => {
    const results = await ctx.retrievalEngine.retrieve('anything', AGENT_ID, 5);
    expect(results).toHaveLength(0);
  });
});