/**
 * Spec 014 — MemoryDecayService (memory layer)
 * ──────────────────────────────────────────────
 * Covers AC-26 through AC-29, AC-55.
 */
import { describe, it, expect } from 'vitest';
import type { MemoryNode, MemoryDecayConfig, DecayResult } from '@evol-hive/shared';
import { defaultMemoryDecayConfig } from '@evol-hive/shared';
import { MemoryDecayServiceImpl } from '../src/retrieval/memory-decay-service.js';
import { InMemoryVectorStore } from '../src/store/in-memory-vector-store.js';

function mkNode(id: string, opts: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id,
    agentId: 'a1',
    content: `c-${id}`,
    embedding: [1],
    timestamp: 0,
    importance: 10,
    type: 'observation',
    ...opts,
  };
}

// ─── AC-26: MemoryDecayService interface shape ───────────────────────────────

describe('AC-26: MemoryDecayService interface', () => {
  it('MemoryDecayServiceImpl implements applyDecay and pruneMemories', () => {
    const store = new InMemoryVectorStore();
    const svc = new MemoryDecayServiceImpl({
      vectorStore: store,
      config: defaultMemoryDecayConfig,
    });
    expect(typeof svc.applyDecay).toBe('function');
    expect(typeof svc.pruneMemories).toBe('function');
  });
});

// ─── AC-27: exported from index ──────────────────────────────────────────────

describe('AC-27: MemoryDecayServiceImpl exported from package index', () => {
  it('is re-exported from src/index', async () => {
    const mod = await import('../src/index.js');
    expect(mod.MemoryDecayServiceImpl).toBeDefined();
  });
});

// ─── AC-28: applyDecay computes effective importance & prune candidates ──────

describe('AC-28: applyDecay computes effective importance', () => {
  it('collects IDs where effectiveImportance < pruneThreshold', async () => {
    const store = new InMemoryVectorStore();
    // decayRate=0.001, pruneThreshold=0.5
    const config: MemoryDecayConfig = {
      decayRate: 0.001,
      pruneThreshold: 0.5,
      decayIntervalTicks: 100,
    };
    // Node freshly accessed (lastAccessed = simTime) → effective = base, not pruned.
    await store.store(mkNode('fresh', { timestamp: 0, importance: 10, lastAccessed: 5000 }));
    // Node very stale → 10 * e^(-0.001 * 5000) = 10 * e^-5 ≈ 0.067 < 0.5 → pruned
    await store.store(mkNode('stale', { timestamp: 0, importance: 10 }));
    // Node moderately stale → 10 * e^(-0.001 * 1000) ≈ 3.68 > 0.5 → not pruned
    await store.store(mkNode('mid', { timestamp: 0, importance: 10, lastAccessed: 4000 }));

    const svc = new MemoryDecayServiceImpl({ vectorStore: store, config });
    const result = await svc.applyDecay('a1', 5000);

    expect(result.pruneCandidateIds).toContain('stale');
    expect(result.pruneCandidateIds).not.toContain('fresh');
    expect(result.pruneCandidateIds).not.toContain('mid');

    // scores contain all three nodes.
    expect(result.scores).toHaveLength(3);
    const staleScore = result.scores.find((s) => s.memoryId === 'stale');
    expect(staleScore?.baseImportance).toBe(10);
    expect(staleScore?.effectiveImportance).toBeCloseTo(10 * Math.exp(-0.001 * 5000), 5);
  });

  it('treats undefined lastAccessed as timestamp (AC-53)', async () => {
    const store = new InMemoryVectorStore();
    const config: MemoryDecayConfig = {
      decayRate: 0.001,
      pruneThreshold: 0.5,
      decayIntervalTicks: 100,
    };
    await store.store(mkNode('n', { timestamp: 100, importance: 10 })); // no lastAccessed
    const svc = new MemoryDecayServiceImpl({ vectorStore: store, config });
    const result = await svc.applyDecay('a1', 1100);
    const score = result.scores[0];
    // effective = 10 * e^(-0.001 * (1100 - 100)) = 10 * e^-1 ≈ 3.68
    expect(score?.effectiveImportance).toBeCloseTo(10 * Math.exp(-0.001 * 1000), 5);
  });

  it('does NOT modify the stored importance (decay is computed, not stored)', async () => {
    const store = new InMemoryVectorStore();
    const config: MemoryDecayConfig = {
      decayRate: 0.001,
      pruneThreshold: 0.5,
      decayIntervalTicks: 100,
    };
    await store.store(mkNode('stale', { timestamp: 0, importance: 10 }));
    const svc = new MemoryDecayServiceImpl({ vectorStore: store, config });
    await svc.applyDecay('a1', 5000);
    const after = await store.get('stale');
    expect(after?.importance).toBe(10); // unchanged
  });
});

// ─── AC-29: pruneMemories deletes candidates and returns count ───────────────

describe('AC-29: pruneMemories deletes candidates and returns count', () => {
  it('deletes prune candidates via vectorStore.delete and returns the count', async () => {
    const store = new InMemoryVectorStore();
    const config: MemoryDecayConfig = {
      decayRate: 0.001,
      pruneThreshold: 0.5,
      decayIntervalTicks: 100,
    };
    await store.store(mkNode('keep', { timestamp: 0, importance: 10, lastAccessed: 4999 }));
    await store.store(mkNode('drop', { timestamp: 0, importance: 10 }));
    const svc = new MemoryDecayServiceImpl({ vectorStore: store, config });

    const count = await svc.pruneMemories('a1', 5000);
    expect(count).toBe(1);
    expect(await store.get('drop')).toBeNull();
    expect(await store.get('keep')).not.toBeNull();
  });
});

// ─── AC-55: applyDecay with no memories returns empty result ─────────────────

describe('AC-55: applyDecay with no memories returns empty DecayResult', () => {
  it('returns empty pruneCandidateIds and scores', async () => {
    const store = new InMemoryVectorStore();
    const svc = new MemoryDecayServiceImpl({
      vectorStore: store,
      config: defaultMemoryDecayConfig,
    });
    const result: DecayResult = await svc.applyDecay('ghost', 1000);
    expect(result.agentId).toBe('ghost');
    expect(result.pruneCandidateIds).toEqual([]);
    expect(result.scores).toEqual([]);
  });
});
