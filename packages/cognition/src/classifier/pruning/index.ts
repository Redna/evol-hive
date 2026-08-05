/**
 * pruning/ — Affordance pruning via cosine similarity
 * ──────────────────────────────────────────────────
 * Section 5: Given the agent's primary drive label and every affordance in a
 * room, embed both, score by cosine similarity, drop anything below the
 * threshold, and keep only the top-K most relevant affordances.
 */

import type { Affordance } from '@evol-hive/shared';
import type {
  AffordanceClassifier,
  ClassifierConfig,
  EmbeddingProvider,
  PruneOptions,
} from '../index.js';

/** Cosine similarity between two equal-length vectors. Returns 0 for zero vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Concrete AffordanceClassifier backed by an EmbeddingProvider. */
export class AffordanceClassifierImpl implements AffordanceClassifier {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly config: ClassifierConfig,
  ) {}

  async prune(
    driveLabel: string,
    affordances: Affordance[],
    options?: PruneOptions,
  ): Promise<Affordance[]> {
    if (affordances.length === 0) return [];

    const topK = options?.topK ?? this.config.topK;
    const threshold = options?.similarityThreshold ?? this.config.similarityThreshold;

    const queryVec = await this.embeddingProvider.embed(driveLabel);
    const labels = affordances.map((a) => a.label);
    const vectors = await this.embeddingProvider.embedBatch(labels);

    const scored = affordances.map((affordance, i) => ({
      affordance,
      score: cosineSimilarity(queryVec, vectors[i] ?? []),
    }));

    return scored
      .filter((s) => s.score >= threshold)
      .sort((x, y) => y.score - x.score)
      .slice(0, topK)
      .map((s) => s.affordance);
  }
}

export {};
