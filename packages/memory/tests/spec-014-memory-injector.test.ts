/**
 * Spec 014 — MemoryInjectorImpl (memory layer)
 * ──────────────────────────────────────────────
 * Covers AC-37, AC-38, AC-39, AC-60.
 */
import { describe, it, expect, vi } from 'vitest';
import type { MemoryNode } from '@evol-hive/shared';
import { MemoryInjectorImpl } from '../src/retrieval/memory-injector.js';
import type { RetrievalEngine, MemoryInjector } from '../src/index.js';

function mkNode(id: string, content: string): MemoryNode {
  return {
    id,
    agentId: 'a1',
    content,
    embedding: [1],
    timestamp: 0,
    importance: 5,
    type: 'observation',
  };
}

class FakeRetrievalEngine implements RetrievalEngine {
  retrieve = vi.fn(async (_query: string, _agentId: string, _topK: number) => [
    {
      node: mkNode('m1', 'saw a bed'),
      score: { memoryId: 'm1', recency: 1, importance: 5, relevance: 0.9, composite: 2.9 },
    },
  ]);
  score = vi.fn(() => []);
}

// ─── AC-37: exported & implements MemoryInjector ─────────────────────────────

describe('AC-37: MemoryInjectorImpl exported', () => {
  it('constructs and implements MemoryInjector', () => {
    const engine = new FakeRetrievalEngine();
    const injector: MemoryInjector = new MemoryInjectorImpl({ retrievalEngine: engine });
    expect(injector).toBeDefined();
    expect(typeof injector.injectAssociative).toBe('function');
    expect(typeof injector.activeRecall).toBe('function');
  });
});

// ─── AC-38, AC-60: injectAssociative builds query, returns snippets, no LLM ─

describe('AC-38, AC-60: injectAssociative', () => {
  it('builds a query from room + drives and returns top-5 MemorySnippet[]', async () => {
    const engine = new FakeRetrievalEngine();
    // Spec 022, Req 13: the default topK changed from 5 to 3. This test
    // verifies the original top-5 behavior when an explicit topK is provided.
    const injector = new MemoryInjectorImpl({ retrievalEngine: engine, topK: 5 });

    const snippets = await injector.injectAssociative('a1', 'bedroom', {
      energy: 20, // > 50? no → excluded
      hunger: 80, // > 50 → included
      social: 10,
    });

    // retrieve was called with topK=5.
    expect(engine.retrieve).toHaveBeenCalledTimes(1);
    const call = engine.retrieve.mock.calls[0];
    expect(call?.[1]).toBe('a1');
    expect(call?.[2]).toBe(5);
    // The query string includes the roomId and the pressing drive (hunger).
    expect(call?.[0]).toContain('bedroom');
    expect(call?.[0]).toContain('hunger');
    // Results are mapped to MemorySnippet.
    expect(snippets).toHaveLength(1);
    expect(snippets[0]?.id).toBe('m1');
    expect(snippets[0]?.content).toBe('saw a bed');
    expect(snippets[0]?.importance).toBe(5);
  });

  it('does not invoke any LLM (pure embedding-based retrieval)', async () => {
    const engine = new FakeRetrievalEngine();
    const injector = new MemoryInjectorImpl({ retrievalEngine: engine });
    await injector.injectAssociative('a1', 'kitchen', { energy: 90 });
    // The injector only calls retrievalEngine.retrieve — no LLM client present.
    expect(engine.retrieve).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-39: activeRecall delegates to retrieve ───────────────────────────────

describe('AC-39: activeRecall', () => {
  it('delegates to retrievalEngine.retrieve and returns MemorySnippet[]', async () => {
    const engine = new FakeRetrievalEngine();
    const injector = new MemoryInjectorImpl({ retrievalEngine: engine });

    const snippets = await injector.activeRecall('a1', 'where is food', 3);
    expect(engine.retrieve).toHaveBeenCalledWith('where is food', 'a1', 3);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]?.content).toBe('saw a bed');
  });
});
