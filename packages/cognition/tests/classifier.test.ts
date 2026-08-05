import { describe, it, expect, beforeEach } from 'vitest';
import type { Affordance } from '@evol-hive/shared';
import type { EmbeddingProvider, ScoredAffordance } from '../src/classifier/index.js';
import { AffordanceClassifierImpl } from '../src/classifier/pruning/index.js';

// AC-13: prune returns at most CLASSIFIER_TOP_K (default 5) affordances.
// AC-14: prune excludes any affordance whose cosine similarity is below threshold.
// AC-15: When a room has 0 affordances, prune returns an empty array without error.

function makeAffordance(id: string, label: string): Affordance {
  return {
    id,
    label,
    engineEffect: `effect_${id}`,
    preconditions: [],
    effects: {},
  };
}

/**
 * Mock embedding provider for deterministic testing.
 * Maps text strings to pre-configured vectors.
 */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private vectors: Map<string, number[]>;

  constructor(dimensions: number, vectors: Map<string, number[]>) {
    this.dimensions = dimensions;
    this.vectors = vectors;
  }

  async embed(text: string): Promise<number[]> {
    return this.vectors.get(text) ?? new Array(this.dimensions).fill(0);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectors.get(t) ?? new Array(this.dimensions).fill(0));
  }
}

describe('AffordanceClassifierImpl', () => {
  const TOP_K = 5;
  const THRESHOLD = 0.3;
  let classifier: AffordanceClassifierImpl;

  // Helper: create a 3D unit vector
  function vec(x: number, y: number, z: number): number[] {
    const mag = Math.sqrt(x * x + y * y + z * z);
    return [x / mag, y / mag, z / mag];
  }

  beforeEach(() => {
    // Drive label "low energy, need to restore energy" maps to vec(1, 0, 0).
    // Affordances with labels close to that direction get high similarity.
    // Affordances orthogonal get ~0 similarity.
    const vectors = new Map<string, number[]>([
      ['low energy, need to restore energy', vec(1, 0, 0)],
      ['Brew coffee to restore energy', vec(0.9, 0.1, 0)], // ~0.994 similarity
      ['Sit down and rest', vec(0.8, 0.2, 0)], // ~0.97 similarity
      ['Sleep on the couch', vec(0.7, 0.3, 0)], // ~0.93 similarity
      ['Drink water', vec(0.6, 0.4, 0)], // ~0.87 similarity
      ['Eat a snack', vec(0.5, 0.5, 0.5)], // ~0.577 similarity
      ['Play video games', vec(0, 1, 0)], // ~0 similarity (orthogonal)
      ['Read a book', vec(0, 0, 1)], // ~0 similarity (orthogonal)
    ]);

    const provider = new MockEmbeddingProvider(3, vectors);
    classifier = new AffordanceClassifierImpl(provider, {
      topK: TOP_K,
      similarityThreshold: THRESHOLD,
    });
  });

  describe('prune — top-K limit (AC-13)', () => {
    it('returns at most CLASSIFIER_TOP_K affordances', async () => {
      // 8 affordances, all above threshold — should cap at TOP_K=5
      const affordances = [
        makeAffordance('a1', 'Brew coffee to restore energy'),
        makeAffordance('a2', 'Sit down and rest'),
        makeAffordance('a3', 'Sleep on the couch'),
        makeAffordance('a4', 'Drink water'),
        makeAffordance('a5', 'Eat a snack'),
        makeAffordance('a6', 'Brew coffee to restore energy'), // duplicate label
        makeAffordance('a7', 'Sit down and rest'),
        makeAffordance('a8', 'Sleep on the couch'),
      ];

      const result = await classifier.prune('low energy, need to restore energy', affordances);

      expect(result.length).toBeLessThanOrEqual(TOP_K);
    });

    it('returns fewer than TOP_K when fewer affordances pass the threshold', async () => {
      const affordances = [
        makeAffordance('a1', 'Brew coffee to restore energy'),
        makeAffordance('a2', 'Play video games'), // below threshold
      ];

      const result = await classifier.prune('low energy, need to restore energy', affordances);

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('a1');
    });
  });

  describe('prune — similarity threshold (AC-14)', () => {
    it('excludes affordances whose cosine similarity is below the threshold', async () => {
      const affordances = [
        makeAffordance('a1', 'Brew coffee to restore energy'), // high similarity
        makeAffordance('a2', 'Play video games'), // ~0, below threshold
        makeAffordance('a3', 'Read a book'), // ~0, below threshold
      ];

      const result = await classifier.prune('low energy, need to restore energy', affordances);

      const ids = result.map((a) => a.id);
      expect(ids).toContain('a1');
      expect(ids).not.toContain('a2');
      expect(ids).not.toContain('a3');
    });
  });

  describe('prune — empty input (AC-15)', () => {
    it('returns an empty array without error when room has 0 affordances', async () => {
      const result = await classifier.prune('low energy, need to restore energy', []);

      expect(result).toEqual([]);
    });
  });

  describe('prune — ordering', () => {
    it('returns affordances sorted by similarity score descending', async () => {
      const affordances = [
        makeAffordance('a4', 'Drink water'), // 4th highest
        makeAffordance('a1', 'Brew coffee to restore energy'), // 1st
        makeAffordance('a3', 'Sleep on the couch'), // 3rd
        makeAffordance('a2', 'Sit down and rest'), // 2nd
      ];

      const result = await classifier.prune('low energy, need to restore energy', affordances);

      expect(result).toHaveLength(4);
      expect(result[0]?.id).toBe('a1');
      expect(result[1]?.id).toBe('a2');
      expect(result[2]?.id).toBe('a3');
      expect(result[3]?.id).toBe('a4');
    });
  });

  describe('prune — custom options', () => {
    it('respects custom topK option', async () => {
      const affordances = [
        makeAffordance('a1', 'Brew coffee to restore energy'),
        makeAffordance('a2', 'Sit down and rest'),
        makeAffordance('a3', 'Sleep on the couch'),
      ];

      const result = await classifier.prune('low energy, need to restore energy', affordances, {
        topK: 2,
      });

      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe('a1');
      expect(result[1]?.id).toBe('a2');
    });

    it('respects custom similarityThreshold option', async () => {
      const affordances = [
        makeAffordance('a1', 'Brew coffee to restore energy'), // ~0.994
        makeAffordance('a5', 'Eat a snack'), // ~0.577
      ];

      // With a high threshold, only the top match passes
      const result = await classifier.prune('low energy, need to restore energy', affordances, {
        similarityThreshold: 0.9,
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('a1');
    });
  });
});
