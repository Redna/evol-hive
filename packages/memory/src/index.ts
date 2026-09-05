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
  /**
   * Partially update a stored `MemoryNode` — only `importance` and
   * `lastAccessed` are mutable (spec 014, Req 2). No-op if the `id` does not
   * exist (does not throw).
   */
  update(
    id: string,
    changes: Partial<Pick<import('@evol-hive/shared').MemoryNode, 'importance' | 'lastAccessed'>>,
  ): Promise<void>;
  /** Return all `MemoryNode` objects stored for the given `agentId` (spec 014, Req 3). */
  queryByAgent(agentId: string): Promise<import('@evol-hive/shared').MemoryNode[]>;
  /**
   * Count the nodes stored for the given `agentId` (spec 035, Req 9 — the
   * outcome probe's memoryWritten signal). Optional so existing custom
   * stores compile unchanged.
   */
  countByAgent?(agentId: string): Promise<number>;
  /** Return all `MemoryNode` objects in the store, regardless of `agentId` (spec 017, Req 9). */
  exportAll(): Promise<import('@evol-hive/shared').MemoryNode[]>;
  /** Clear the store and replace its contents with the provided nodes (spec 017, Req 10). */
  importAll(nodes: import('@evol-hive/shared').MemoryNode[]): Promise<void>;
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

// ── Memory Decay (Section 11.3 / spec 014, Req 12) ───────────────────────────

/** A simulation clock — `() => number` returning the current sim time (spec 014, Req 28). */
export type SimulationClock = () => number;

/**
 * Computes effective importance (decay is computed, not stored) and identifies
 * prune candidates. The stored `MemoryNode.importance` is NOT modified.
 */
export interface MemoryDecayService {
  /** Compute effective importance for all of an agent's memories and identify prune candidates. */
  applyDecay(
    agentId: string,
    currentSimTime: number,
  ): Promise<import('@evol-hive/shared').DecayResult>;
  /** Prune memories whose effective importance is below the threshold. Returns count of pruned nodes. */
  pruneMemories(agentId: string, currentSimTime: number): Promise<number>;
}

// ── Embedding Provider (spec 004, Req 6) ─────────────────────────────────────

/** Generates embedding vectors from text for memory storage. */
export interface EmbeddingProvider {
  /** Embedding dimensionality (must match the vector store's expected dimension). */
  readonly dimensions: number;
  /** Generate an embedding vector for a single text input. */
  embed(text: string): Promise<number[]>;
  /** Batch embed multiple strings. Returns one vector per input, in order. */
  embedBatch(texts: string[]): Promise<number[][]>;
}

// ── Memory Store (spec 004, Req 7) ────────────────────────────────────────────

/**
 * Wraps `VectorStore` and `EmbeddingProvider` to provide a simplified store API
 * (spec 004, Req 7). Abstracts embedding generation away from the engine.
 */
export interface MemoryStore {
  /** Store a memory entry — generates embedding, creates full MemoryNode, persists to VectorStore. */
  store(
    agentId: string,
    entry: import('@evol-hive/shared').MemoryEntryInput,
    timestamp: number,
  ): Promise<import('@evol-hive/shared').MemoryNode>;
  /** Retrieve a memory by ID. */
  get(id: string): Promise<import('@evol-hive/shared').MemoryNode | null>;
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export * from './store/index.js';
export * from './retrieval/index.js';
export * from './reflection/index.js';
