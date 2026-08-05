import { describe, it, expect, beforeEach } from 'vitest';
import type { Affordance } from '@evol-hive/shared';
import type { EmbeddingProvider } from '../src/classifier/index.js';
import { AffordanceClassifierImpl, cosineSimilarity } from '../src/classifier/pruning/index.js';

const DRIVE_LABEL = 'low energy, need to restore energy';

function makeAffordance(id: string, label: string): Affordance {
  return {
    id,
    label,
    engineEffect: id,
    preconditions: [],
    effects: { energy: 10 },
  };
}

/** Embedding provider keyed by affordance label; the drive label maps to [1, 0]. */
class FakeEmbeddingProvider implements EmbeddingProvider {
  constructor(private vectors: Record<string, number[]>) {}
  dimensions = 2;
  async embed(text: string): Promise<number[]> {
    return this.vectors[text] ?? [0, 0];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectors[t] ?? [0, 0]);
  }
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });
});

describe('AffordanceClassifier.prune (AC-13, AC-14, AC-15)', () => {
  let classifier: AffordanceClassifierImpl;

  beforeEach(() => {
    const vectors: Record<string, number[]> = {
      [DRIVE_LABEL]: [1, 0],
      'Brew coffee': [1, 0],
      'Drink water': [0.95, 0.3123],
      'Sit down': [0.8, 0.6],
      'Sleep on couch': [0.5, 0.866],
      'Eat snack': [0.3, 0.9539], // cosine == 0.3 (boundary)
      'Chat with friend': [0, 1], // cosine == 0 (below threshold)
      'Read book': [-0.5, 0.866], // cosine negative (below threshold)
    };
    const provider = new FakeEmbeddingProvider(vectors);
    classifier = new AffordanceClassifierImpl(provider, { topK: 5, similarityThreshold: 0.3 });
  });

  it('returns at most CLASSIFIER_TOP_K (5) affordances (AC-13)', async () => {
    const affordances: Affordance[] = [
      makeAffordance('brew_coffee', 'Brew coffee'),
      makeAffordance('drink_water', 'Drink water'),
      makeAffordance('sit_down', 'Sit down'),
      makeAffordance('sleep', 'Sleep on couch'),
      makeAffordance('eat_snack', 'Eat snack'),
      makeAffordance('brew_tea', 'Brew coffee'), // duplicate-high similarity
      makeAffordance('nap', 'Sit down'), // duplicate-high similarity
    ];
    const pruned = await classifier.prune(DRIVE_LABEL, affordances);
    expect(pruned.length).toBeLessThanOrEqual(5);
  });

  it('excludes affordances whose cosine similarity is below threshold (AC-14)', async () => {
    const affordances: Affordance[] = [
      makeAffordance('brew_coffee', 'Brew coffee'), // sim 1.0
      makeAffordance('chat', 'Chat with friend'), // sim 0
      makeAffordance('read', 'Read book'), // sim negative
    ];
    const pruned = await classifier.prune(DRIVE_LABEL, affordances);
    const ids = pruned.map((a) => a.id);
    expect(ids).toContain('brew_coffee');
    expect(ids).not.toContain('chat');
    expect(ids).not.toContain('read');
  });

  it('retains affordances at exactly the similarity threshold (>= threshold)', async () => {
    const affordances: Affordance[] = [
      makeAffordance('brew_coffee', 'Brew coffee'), // sim 1.0
      makeAffordance('eat_snack', 'Eat snack'), // sim 0.3 (boundary)
    ];
    const pruned = await classifier.prune(DRIVE_LABEL, affordances);
    expect(pruned.map((a) => a.id).sort()).toEqual(['brew_coffee', 'eat_snack']);
  });

  it('returns an empty array without error when the room has 0 affordances (AC-15)', async () => {
    const pruned = await classifier.prune(DRIVE_LABEL, []);
    expect(pruned).toEqual([]);
  });
});
