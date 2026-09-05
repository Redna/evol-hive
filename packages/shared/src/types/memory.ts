/**
 * Memory Architecture Types
 * ─────────────────────────
 * Section 11: Dual-track injection, weighted retrieval scoring, and
 * asynchronous reflection/consolidation.
 */

import type { MemoryEntryInput, MemorySnippet } from './cognition.js';

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
  /**
   * The last simulation time the memory was retrieved or accessed (spec 014,
   * Req 1). Set to `timestamp` at creation; updated to the current sim time on
   * retrieval. If `undefined` (legacy nodes), treated as equal to `timestamp`
   * for all decay computations.
   */
  lastAccessed?: number;
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

// ─────────────────────────────────────────────────────────────────────────────
// Spec 014 — Consolidation, Decay & Retrieval additions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bridge interface (defined in `shared` per ADR-0001) that lets the memory
 * layer call the LLM for memory consolidation without importing from the
 * `cognition` package. The `cognition` package provides a concrete
 * implementation wrapping `LLMClient.completeReflection` (spec 014, Req 19).
 */
export interface ConsolidationProvider {
  /** Consolidate low-level memories into higher-level insights via an LLM call. */
  consolidate(
    agentId: string,
    systemPrompt: string,
    memoryNodes: MemorySnippet[],
  ): Promise<ReflectionResult>;
}

/**
 * Configuration for the background memory decay system (spec 014, Req 5).
 * Decay is computed on-the-fly, not stored — see {@link MemoryDecayService}.
 */
export interface MemoryDecayConfig {
  /** Exponential decay rate for importance (per simulation second). Higher = faster decay. */
  decayRate: number;
  /** Effective importance below which a memory is a pruning candidate. */
  pruneThreshold: number;
  /** Run the decay pass every N engine ticks. */
  decayIntervalTicks: number;
}

/**
 * Result of a decay pass over an agent's memories (spec 014, Req 12). The
 * effective importance is computed on-the-fly — the stored `importance` is NOT
 * modified. `pruneCandidateIds` lists memories whose effective importance is
 * below the configured prune threshold.
 */
export interface DecayResult {
  agentId: string;
  /** IDs of memories whose effective importance is below the prune threshold. */
  pruneCandidateIds: string[];
  /** Effective importance scores for all memories (for debugging/inspection). */
  scores: { memoryId: string; effectiveImportance: number; baseImportance: number }[];
}

/** Default retrieval weights from §11.2 (spec 014, Req 6). */
export const defaultRetrievalWeights: RetrievalWeights = {
  recencyWeight: 1.0,
  importanceWeight: 1.0,
  relevanceWeight: 1.0,
  recencyDecayRate: 0.01,
};

/** Default reflection config from §11.3 (spec 014, Req 7). */
export const defaultReflectionConfig: ReflectionConfig = {
  nodeThreshold: 50,
  idleThresholdSeconds: 30,
  enabled: true,
};

/** Default memory decay config (spec 014, Req 8). */
export const defaultMemoryDecayConfig: MemoryDecayConfig = {
  decayRate: 0.001,
  pruneThreshold: 0.5,
  decayIntervalTicks: 100,
};

// ─────────────────────────────────────────────────────────────────────────────
// Spec 035 — Write-time composite importance (Req 14)
// ─────────────────────────────────────────────────────────────────────────────

/** The write-time context handed to an importance composer (spec 035, Req 14). */
export interface ImportanceCompositionContext {
  agentId: string;
  /** The simulation timestamp of the write. */
  timestamp: number;
  /** The memory content (used for related-content utility folding). */
  content: string;
}

/**
 * An injected importance composer (spec 035, Req 14): when wired into the
 * `MemoryStoreImpl` options, `MemoryNode.importance` at write time is the
 * composite (predicted prior ⊕ drive-delta magnitude ⊕ downstream utility ⊕
 * LLM 1–10 as one feature) instead of the raw LLM-assigned score. Implemented
 * in cognition; the memory package only sees this function type (ADR-0001).
 */
export type ImportanceComposer = (
  entry: MemoryEntryInput,
  context: ImportanceCompositionContext,
) => number;
