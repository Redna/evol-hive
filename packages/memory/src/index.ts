/**
 * @evol-hive/memory — Memory Architecture
 * ─────────────────────────────────────────
 * Section 11: Dual-track injection, weighted retrieval scoring,
 * and asynchronous reflection/consolidation.
 */

// ── Vector Store ─────────────────────────────────────────────────────────────

/** The vector store backend (LanceDB, ChromaDB, or in-memory). */
export interface VectorStore {
  /** Store a new memory node. */
  store(node: import('@evol-hive/shared').MemoryNode): Promise<void>;
  /** Retrieve a memory by ID. */
  get(id: string): Promise<import('@evol-hive/shared').MemoryNode | null>;
  /** Query by embedding similarity (returns raw results before scoring). */
  queryByEmbedding(
    embedding: number[],
    topK: number,
  ): Promise<import('@evol-hive/shared').MemoryNode[]>;
  /** Delete memories by ID (for consolidation cleanup). */
  delete(ids: string[]): Promise<void>;
  /** Get count of recent nodes for reflection threshold check. */
  countRecent(agentId: string, sinceTimestamp: number): Promise<number>;
}

// ── Retrieval (Section 11.2) ──────────────────────────────────────────────────

/** Weighted retrieval scoring engine. */
export interface RetrievalEngine {
  /** Calculate composite scores for a set of memory nodes. */
  score(
    nodes: import('@evol-hive/shared').MemoryNode[],
    queryEmbedding: number[],
    currentSimTime: number,
    weights?: import('@evol-hive/shared').RetrievalWeights,
  ): import('@evol-hive/shared').RetrievalScore[];

  /** Full retrieval: embed query → search store → score → rank → return top results. */
  retrieve(
    query: string,
    agentId: string,
    topK: number,
  ): Promise<
    {
      node: import('@evol-hive/shared').MemoryNode;
      score: import('@evol-hive/shared').RetrievalScore;
    }[]
  >;
}

// ── Dual-Track Injection (Section 11.1) ───────────────────────────────────────

/** Manages the two memory injection tracks. */
export interface MemoryInjector {
  /**
   * Track 1: Associative Memory (Passive - System 1)
   * Auto-injects highly relevant contextual memories during Perceive step
   * based on the agent's immediate spatial surroundings.
   */
  injectAssociative(
    agentId: string,
    roomId: string,
    currentDrives: Record<string, number>,
  ): Promise<import('@evol-hive/shared').MemorySnippet[]>;

  /**
   * Track 2: Active Recall (Tool-Driven - System 2)
   * Agent explicitly uses query_memory tool to fetch specific data.
   */
  activeRecall(
    agentId: string,
    query: string,
    topK: number,
  ): Promise<import('@evol-hive/shared').MemorySnippet[]>;
}

// ── Reflection & Consolidation (Section 11.3) ────────────────────────────────

/** The asynchronous reflection loop. */
export interface ReflectionLoop {
  config: import('@evol-hive/shared').ReflectionConfig;
  /** Check if reflection should trigger for an agent. */
  shouldReflect(agentId: string, currentSimTime: number, isIdle: boolean): Promise<boolean>;
  /** Run a reflection pass — consolidates low-level memories into higher-level ones. */
  runReflection(agentId: string): Promise<import('@evol-hive/shared').ReflectionResult>;
  /** Start the background loop. */
  start(): void;
  /** Stop the background loop. */
  stop(): void;
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export * from './store/index.js';
export * from './retrieval/index.js';
export * from './reflection/index.js';
