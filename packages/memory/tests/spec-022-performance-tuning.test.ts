/**
 * Spec 022 — Performance Tuning: memory injection top-K cap (AC-12).
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { MemoryNode } from '@evol-hive/shared';
import { MemoryInjectorImpl } from '../src/retrieval/memory-injector.js';
import type { RetrievalEngine, MemoryInjector } from '../src/index.js';

function makeNode(id: string, content: string, importance = 5): MemoryNode {
  return {
    id,
    agentId: 'a1',
    content,
    embedding: [],
    timestamp: 0,
    importance,
    type: 'observation',
  };
}

/** A fake retrieval engine that returns a fixed list of `count` nodes. */
function fakeEngine(count: number): RetrievalEngine {
  const nodes: MemoryNode[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push(makeNode(`m${i}`, `memory ${i}`, 5));
  }
  return {
    async retrieve(_query: string, _agentId: string, topK: number) {
      return nodes.slice(0, topK).map((node) => ({
        node,
        score: { recency: 0, relevance: 0, importance: 0, total: 0 },
      }));
    },
    score() {
      return [];
    },
  };
}

describe('AC-12: MemoryInjectorImpl.injectAssociative topK (Req 13)', () => {
  const origEnv = process.env['MEMORY_INJECTION_TOP_K'];

  afterEach(() => {
    if (origEnv === undefined) delete process.env['MEMORY_INJECTION_TOP_K'];
    else process.env['MEMORY_INJECTION_TOP_K'] = origEnv;
  });

  it('default topK is 3 (down from 5) — returns at most 3 snippets', async () => {
    delete process.env['MEMORY_INJECTION_TOP_K'];
    const injector = new MemoryInjectorImpl({ retrievalEngine: fakeEngine(10) });
    const snippets = await injector.injectAssociative('a1', 'kitchen', { energy: 80 });
    expect(snippets.length).toBeLessThanOrEqual(3);
    expect(snippets.length).toBe(3);
  });

  it('explicit topK: 1 returns at most 1 snippet', async () => {
    const injector = new MemoryInjectorImpl({
      retrievalEngine: fakeEngine(10),
      topK: 1,
    });
    const snippets = await injector.injectAssociative('a1', 'kitchen', { energy: 80 });
    expect(snippets.length).toBe(1);
  });

  it('explicit topK: 5 returns at most 5 snippets', async () => {
    const injector = new MemoryInjectorImpl({
      retrievalEngine: fakeEngine(10),
      topK: 5,
    });
    const snippets = await injector.injectAssociative('a1', 'kitchen', { energy: 80 });
    expect(snippets.length).toBe(5);
  });

  it('MEMORY_INJECTION_TOP_K=1 env var results in at most 1 snippet', async () => {
    process.env['MEMORY_INJECTION_TOP_K'] = '1';
    const injector = new MemoryInjectorImpl({ retrievalEngine: fakeEngine(10) });
    const snippets = await injector.injectAssociative('a1', 'kitchen', { energy: 80 });
    expect(snippets.length).toBe(1);
  });

  it('MEMORY_INJECTION_TOP_K=2 env var results in at most 2 snippets', async () => {
    process.env['MEMORY_INJECTION_TOP_K'] = '2';
    const injector = new MemoryInjectorImpl({ retrievalEngine: fakeEngine(10) });
    const snippets = await injector.injectAssociative('a1', 'kitchen', { energy: 80 });
    expect(snippets.length).toBe(2);
  });

  it('explicit topK overrides env var', async () => {
    process.env['MEMORY_INJECTION_TOP_K'] = '1';
    const injector = new MemoryInjectorImpl({
      retrievalEngine: fakeEngine(10),
      topK: 4,
    });
    const snippets = await injector.injectAssociative('a1', 'kitchen', { energy: 80 });
    expect(snippets.length).toBe(4);
  });

  it('activeRecall still uses its explicit topK parameter (unchanged)', async () => {
    const injector = new MemoryInjectorImpl({ retrievalEngine: fakeEngine(10) });
    const snippets = await injector.activeRecall('a1', 'query', 7);
    expect(snippets.length).toBe(7);
  });
});
