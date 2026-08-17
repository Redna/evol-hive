/**
 * Spec 014 — Memory Consolidation, Decay & Retrieval
 * ────────────────────────────────────────────────────
 * Type-level & constant tests for the shared-layer additions:
 * MemoryNode.lastAccessed, ConsolidationProvider, MemoryDecayConfig,
 * DecayResult, defaultRetrievalWeights, defaultReflectionConfig,
 * defaultMemoryDecayConfig.
 *
 * Covers AC-1, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-53.
 */
import { describe, it, expect } from 'vitest';
import type {
  MemoryNode,
  ConsolidationProvider,
  MemoryDecayConfig,
  DecayResult,
  RetrievalWeights,
  ReflectionConfig,
  ReflectionResult,
  MemorySnippet,
} from '../src/index.js';
import {
  defaultRetrievalWeights,
  defaultReflectionConfig,
  defaultMemoryDecayConfig,
} from '../src/index.js';

// ─── AC-1: MemoryNode.lastAccessed ───────────────────────────────────────────

describe('AC-1: MemoryNode.lastAccessed field', () => {
  it('accepts an optional lastAccessed number', () => {
    const node: MemoryNode = {
      id: 'm1',
      agentId: 'a1',
      content: 'saw a coffee machine',
      embedding: [0.1, 0.2],
      timestamp: 100,
      importance: 5,
      type: 'observation',
      lastAccessed: 250,
    };
    expect(node.lastAccessed).toBe(250);
  });

  it('allows lastAccessed to be omitted (undefined)', () => {
    const node: MemoryNode = {
      id: 'm2',
      agentId: 'a1',
      content: 'legacy',
      embedding: [],
      timestamp: 0,
      importance: 1,
      type: 'action',
    };
    expect(node.lastAccessed).toBeUndefined();
  });
});

// ─── AC-5: ConsolidationProvider interface ───────────────────────────────────

describe('AC-5: ConsolidationProvider interface', () => {
  it('can be implemented with consolidate(agentId, systemPrompt, memoryNodes)', async () => {
    const provider: ConsolidationProvider = {
      async consolidate(
        agentId: string,
        _systemPrompt: string,
        _memoryNodes: MemorySnippet[],
      ): Promise<ReflectionResult> {
        return { agentId, newMemories: [], consolidatedNodeIds: [] };
      },
    };
    const result = await provider.consolidate('a1', 'prompt', []);
    expect(result.agentId).toBe('a1');
    expect(result.newMemories).toEqual([]);
    expect(result.consolidatedNodeIds).toEqual([]);
  });
});

// ─── AC-6: MemoryDecayConfig ─────────────────────────────────────────────────

describe('AC-6: MemoryDecayConfig type', () => {
  it('accepts decayRate, pruneThreshold, decayIntervalTicks', () => {
    const config: MemoryDecayConfig = {
      decayRate: 0.001,
      pruneThreshold: 0.5,
      decayIntervalTicks: 100,
    };
    expect(config.decayRate).toBe(0.001);
    expect(config.pruneThreshold).toBe(0.5);
    expect(config.decayIntervalTicks).toBe(100);
  });
});

// ─── AC-7: DecayResult ───────────────────────────────────────────────────────

describe('AC-7: DecayResult type', () => {
  it('accepts agentId, pruneCandidateIds, scores', () => {
    const result: DecayResult = {
      agentId: 'a1',
      pruneCandidateIds: ['m1', 'm2'],
      scores: [
        { memoryId: 'm1', effectiveImportance: 0.3, baseImportance: 5 },
        { memoryId: 'm2', effectiveImportance: 0.4, baseImportance: 2 },
      ],
    };
    expect(result.agentId).toBe('a1');
    expect(result.pruneCandidateIds).toEqual(['m1', 'm2']);
    expect(result.scores).toHaveLength(2);
    expect(result.scores[0]?.effectiveImportance).toBe(0.3);
    expect(result.scores[0]?.baseImportance).toBe(5);
  });
});

// ─── AC-8: defaultRetrievalWeights ───────────────────────────────────────────

describe('AC-8: defaultRetrievalWeights', () => {
  it('has the §11.2 default weights', () => {
    const w: RetrievalWeights = defaultRetrievalWeights;
    expect(w.recencyWeight).toBe(1.0);
    expect(w.importanceWeight).toBe(1.0);
    expect(w.relevanceWeight).toBe(1.0);
    expect(w.recencyDecayRate).toBe(0.01);
  });
});

// ─── AC-9: defaultReflectionConfig ───────────────────────────────────────────

describe('AC-9: defaultReflectionConfig', () => {
  it('has the §11.3 defaults', () => {
    const c: ReflectionConfig = defaultReflectionConfig;
    expect(c.nodeThreshold).toBe(50);
    expect(c.idleThresholdSeconds).toBe(30);
    expect(c.enabled).toBe(true);
  });
});

// ─── AC-10: defaultMemoryDecayConfig ─────────────────────────────────────────

describe('AC-10: defaultMemoryDecayConfig', () => {
  it('has decayRate 0.001, pruneThreshold 0.5, decayIntervalTicks 100', () => {
    const c: MemoryDecayConfig = defaultMemoryDecayConfig;
    expect(c.decayRate).toBe(0.001);
    expect(c.pruneThreshold).toBe(0.5);
    expect(c.decayIntervalTicks).toBe(100);
  });
});

// ─── AC-53: lastAccessed undefined treated as timestamp ──────────────────────

describe('AC-53: lastAccessed undefined semantics', () => {
  it('a node without lastAccessed is a valid MemoryNode (treated as timestamp downstream)', () => {
    const node: MemoryNode = {
      id: 'm3',
      agentId: 'a1',
      content: 'no last accessed',
      embedding: [1],
      timestamp: 500,
      importance: 8,
      type: 'reflection',
    };
    // Downstream code uses (node.lastAccessed ?? node.timestamp).
    const effectiveLastAccessed = node.lastAccessed ?? node.timestamp;
    expect(effectiveLastAccessed).toBe(500);
  });
});
