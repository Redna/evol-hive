/**
 * @evol-hive/classifier — System 0 Fast-Path Classifier
 * ──────────────────────────────────────────────────────
 * Section 5: A blazing-fast, lightweight local embedding model prunes
 * affordances before they reach the heavy LLM (System 2).
 *
 * The classifier takes the agent's current primary drive and runs a cosine
 * similarity check against embeddings of all affordances in the room.
 * It prunes 50+ affordances down to the top-K most semantically relevant.
 */

// ── Embedding ─────────────────────────────────────────────────────────────────

/** Abstraction over the embedding model (Model2Vec, ONNX, Ollama embeddings). */
export interface EmbeddingProvider {
  /** Generate an embedding vector for a text string. */
  embed(text: string): Promise<number[]>;
  /** Batch embed multiple strings. */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** The dimensionality of the embedding vectors. */
  dimensions: number;
}

// ── Affordance Pruning ────────────────────────────────────────────────────────

/** The core classifier that prunes affordances by semantic relevance to drives. */
export interface AffordanceClassifier {
  /**
   * Given an agent's primary drive and all affordances in a room,
   * return only the top-K most semantically relevant ones.
   */
  prune(
    driveLabel: string,
    affordances: import('@evol-hive/shared').Affordance[],
    options?: PruneOptions,
  ): Promise<import('@evol-hive/shared').Affordance[]>;
}

/** Configuration for pruning. */
export interface PruneOptions {
  /** Number of affordances to retain (default from config CLASSIFIER_TOP_K). */
  topK?: number;
  /** Minimum cosine similarity threshold (default from config). */
  similarityThreshold?: number;
}

/** A scored affordance after cosine similarity computation. */
export interface ScoredAffordance {
  affordance: import('@evol-hive/shared').Affordance;
  score: number;
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export * from './embedding/index.js';
export * from './pruning/index.js';
