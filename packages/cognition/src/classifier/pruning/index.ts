// pruning/ — Affordance pruning via cosine similarity
// ──────────────────────────────────────────────────────
// Section 5: The System 0 classifier prunes affordances before they
// reach the heavy LLM. It embeds the primary drive label and each
// affordance label, then computes cosine similarity to find the top-K.

import type { Affordance } from '@evol-hive/shared';
import type {
  EmbeddingProvider,
  AffordanceClassifier,
  PruneOptions,
  ScoredAffordance,
} from '../index.js';

/** Classifier configuration (loaded from environment, not hardcoded). */
export interface ClassifierConfig {
  topK: number;
  similarityThreshold: number;
}

/**
 * Compute the cosine similarity between two vectors.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) {
    return 0;
  }
  return dot / denom;
}

/**
 * Implementation of `AffordanceClassifier` using an `EmbeddingProvider`.
 *
 * 1. Embeds the primary drive label.
 * 2. Embeds each affordance's label (falls back to `id` if label is empty).
 * 3. Computes cosine similarity between the drive embedding and each affordance embedding.
 * 4. Filters by the similarity threshold (default from config).
 * 5. Sorts by score descending.
 * 6. Takes the top-K (default from config).
 */
export class AffordanceClassifierImpl implements AffordanceClassifier {
  constructor(
    private embeddingProvider: EmbeddingProvider,
    private config: ClassifierConfig,
  ) {}

  async prune(
    driveLabel: string,
    affordances: Affordance[],
    options?: PruneOptions,
  ): Promise<Affordance[]> {
    // (AC-15) Empty input → empty output, no error.
    if (affordances.length === 0) {
      return [];
    }

    const topK = options?.topK ?? this.config.topK;
    const threshold = options?.similarityThreshold ?? this.config.similarityThreshold;

    // Embed the drive label
    const driveEmbedding = await this.embeddingProvider.embed(driveLabel);

    // Embed all affordance labels in batch
    const affordanceTexts = affordances.map((a) => a.label || a.id);
    const embeddings = await this.embeddingProvider.embedBatch(affordanceTexts);

    // Score each affordance
    const scored: ScoredAffordance[] = [];
    for (const [i, affordance] of affordances.entries()) {
      const emb = embeddings[i];
      if (emb) {
        scored.push({
          affordance,
          score: cosineSimilarity(driveEmbedding, emb),
        });
      }
    }

    // (AC-14) Filter by threshold, sort descending, take top-K
    return scored
      .filter((s) => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => s.affordance);
  }
}
