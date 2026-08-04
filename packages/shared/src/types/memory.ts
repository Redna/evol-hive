/**
 * Memory Architecture Types
 * ─────────────────────────
 * Section 11: Dual-track injection, weighted retrieval scoring, and
 * asynchronous reflection/consolidation.
 */

/** A single memory node in the vector store. */
export interface MemoryNode {
  id: string;
  agentId: string;
  /** The text content of the memory. */
  content: string;
  /** Embedding vector for cosine similarity. */
  embedding: number[];
  /** When the memory was created (simulation time). */
  timestamp: number;
  /** Static importance score 1-10, assigned by LLM at encoding. */
  importance: number;
  /** The type of memory (observation, reflection, action, interaction). */
  type: MemoryType;
  /** Optional spatial tag — where the memory occurred. */
  location?: string;
  /** IDs of related memory nodes (for associative chaining). */
  relatedNodes?: string[];
}

export type MemoryType = 'observation' | 'reflection' | 'action' | 'interaction';

/** The composite retrieval score for a memory node. */
export interface RetrievalScore {
  memoryId: string;
  /** Exponential decay based on simulation time since creation. */
  recency: number;
  /** Static importance integer (1-10). */
  importance: number;
  /** Cosine similarity between query embedding and memory embedding. */
  relevance: number;
  /** Weighted composite score. */
  composite: number;
}

/** Parameters controlling the weighted retrieval formula. */
export interface RetrievalWeights {
  recencyWeight: number;
  importanceWeight: number;
  relevanceWeight: number;
  /** Exponential decay rate for recency (higher = faster decay). */
  recencyDecayRate: number;
}

/** Result of a reflection/consolidation pass. */
export interface ReflectionResult {
  agentId: string;
  /** New higher-level memory nodes created from consolidation. */
  newMemories: MemoryNode[];
  /** IDs of low-level nodes that were consolidated (and can be deprioritized). */
  consolidatedNodeIds: string[];
}

/** Configuration for the reflection loop. */
export interface ReflectionConfig {
  /** Trigger reflection when short-term buffer reaches this count. */
  nodeThreshold: number;
  /** Also trigger during physical inactivity (sleep, idle) — in sim seconds. */
  idleThresholdSeconds: number;
  /** Whether the reflection loop is currently running in the background. */
  enabled: boolean;
}
