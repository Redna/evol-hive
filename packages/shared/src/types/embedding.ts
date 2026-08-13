/**
 * Unified Embedding Provider Interface
 * ──────────────────────────────────────
 * Spec 007, Req 1: The canonical embedding interface, defined in `shared` so that
 * both the cognition-level `EmbeddingProvider` (System 0 affordance pruning) and
 * the memory-level `EmbeddingProvider` (semantic memory search) can be satisfied
 * by a single concrete implementation (e.g. `OnnxEmbeddingProvider`).
 *
 * The cognition-level interface (in `@evol-hive/cognition`) already has all three
 * members. The memory-level interface (in `@evol-hive/memory`) is extended in the
 * same spec to include `embedBatch`, making both structurally compatible with this
 * unified interface.
 */

/** The canonical embedding provider interface shared across cognition and memory. */
export interface UnifiedEmbeddingProvider {
  /** Embedding dimensionality (e.g. 384 for gte-small). */
  readonly dimensions: number;
  /** Generate an embedding vector for a single text input. */
  embed(text: string): Promise<number[]>;
  /** Batch embed multiple strings. Returns one vector per input, in order. */
  embedBatch(texts: string[]): Promise<number[][]>;
}
