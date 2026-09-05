/**
 * store/ — MemoryStoreImpl (spec 004, Req 8)
 * ─────────────────────────────────────────
 * Concrete `MemoryStore` that wraps `VectorStore` and `EmbeddingProvider` to
 * provide a simplified store API. Generates embeddings from memory content,
 * creates full `MemoryNode` objects with unique IDs, and persists them to the
 * vector store.
 */

import type { ImportanceComposer, MemoryEntryInput, MemoryNode } from '@evol-hive/shared';
import type { VectorStore, EmbeddingProvider, MemoryStore } from '../index.js';

/** Constructor options for {@link MemoryStoreImpl}. */
export interface MemoryStoreImplOptions {
  vectorStore: VectorStore;
  embeddingProvider: EmbeddingProvider;
  /**
   * Optional write-time importance composer (spec 035, Req 14): when wired,
   * `MemoryNode.importance` is the composite (predicted prior ⊕ drive-delta
   * magnitude ⊕ downstream utility ⊕ LLM 1–10 as one feature) clamped to the
   * 1–10 storage contract, instead of the raw LLM-assigned score. When
   * omitted, behavior is unchanged (backward compat).
   */
  importanceComposer?: ImportanceComposer;
}

/**
 * Concrete `MemoryStore` backed by a `VectorStore` and `EmbeddingProvider`.
 * IDs are generated as `mem_${agentId}_${timestamp}_${counter}` using a
 * monotonic counter to guarantee uniqueness within the same millisecond
 * (following the `PlanManagerImpl` pattern from spec 002).
 */
export class MemoryStoreImpl implements MemoryStore {
  /** Monotonic counter to guarantee unique memory ids within the same millisecond. */
  private static memCounter = 0;

  private readonly vectorStore: VectorStore;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly importanceComposer: ImportanceComposer | undefined;

  constructor(options: MemoryStoreImplOptions) {
    this.vectorStore = options.vectorStore;
    this.embeddingProvider = options.embeddingProvider;
    this.importanceComposer = options.importanceComposer;
  }

  async store(agentId: string, entry: MemoryEntryInput, timestamp: number): Promise<MemoryNode> {
    // (a) Generate an embedding via EmbeddingProvider.embed(entry.content).
    const embedding = await this.embeddingProvider.embed(entry.content);

    // (b) Create a MemoryNode with a generated unique id.
    const id = `mem_${agentId}_${timestamp}_${MemoryStoreImpl.memCounter++}`;

    // Spec 035 (Req 14): composition happens at memory-write time —
    // `MemoryNode.importance` holds the composite when a composer is wired.
    let importance = entry.importance;
    if (this.importanceComposer !== undefined) {
      const composed = this.importanceComposer(entry, { agentId, timestamp, content: entry.content });
      importance = Math.min(10, Math.max(1, composed));
    }

    const node: MemoryNode = {
      id,
      agentId,
      content: entry.content,
      embedding,
      importance,
      type: entry.type,
      timestamp,
    };

    // Include location if provided.
    if (entry.location !== undefined) {
      node.location = entry.location;
    }

    // (c) Persist to VectorStore.
    await this.vectorStore.store(node);

    // (d) Return the created MemoryNode.
    return node;
  }

  async get(id: string): Promise<MemoryNode | null> {
    return this.vectorStore.get(id);
  }
}

export {};

export { InMemoryVectorStore, cosineSimilarity } from './in-memory-vector-store.js';
