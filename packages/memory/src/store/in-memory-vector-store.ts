/**
 * store/in-memory-vector-store — default in-memory VectorStore (spec 014, Req 9)
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores `MemoryNode` objects in an in-memory `Map` keyed by `id`. Implements
 * the full `VectorStore` interface including `update` and `queryByAgent`.
 * `queryByEmbedding` computes cosine similarity and returns the top-K most
 * similar nodes (sorted by similarity descending). This is the default store
 * for testing and single-process deployments.
 */

import type { MemoryNode } from '@evol-hive/shared';
import type { VectorStore } from '../index.js';

/** Compute cosine similarity `dot(a,b)/(|a|*|b|)`. Returns 0 for zero-magnitude vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Concrete `VectorStore` backed by an in-memory `Map`. Implements the full
 * `VectorStore` interface (spec 014, Req 9).
 */
export class InMemoryVectorStore implements VectorStore {
  private readonly nodes = new Map<string, MemoryNode>();

  async store(node: MemoryNode): Promise<void> {
    this.nodes.set(node.id, { ...node });
  }

  async get(id: string): Promise<MemoryNode | null> {
    const node = this.nodes.get(id);
    return node ? { ...node } : null;
  }

  async queryByEmbedding(embedding: number[], topK: number): Promise<MemoryNode[]> {
    const scored = [...this.nodes.values()].map((node) => ({
      node,
      sim: cosineSimilarity(embedding, node.embedding),
    }));
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, topK).map((s) => ({ ...s.node }));
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.nodes.delete(id);
    }
  }

  async countRecent(agentId: string, sinceTimestamp: number): Promise<number> {
    let count = 0;
    for (const node of this.nodes.values()) {
      if (node.agentId === agentId && node.timestamp >= sinceTimestamp) {
        count += 1;
      }
    }
    return count;
  }

  async update(
    id: string,
    changes: Partial<Pick<MemoryNode, 'importance' | 'lastAccessed'>>,
  ): Promise<void> {
    const existing = this.nodes.get(id);
    if (!existing) return; // no-op for missing ids
    const updated: MemoryNode = { ...existing };
    if (changes.importance !== undefined) {
      updated.importance = changes.importance;
    }
    if (changes.lastAccessed !== undefined) {
      updated.lastAccessed = changes.lastAccessed;
    }
    this.nodes.set(id, updated);
  }

  async queryByAgent(agentId: string): Promise<MemoryNode[]> {
    const result: MemoryNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.agentId === agentId) {
        result.push({ ...node });
      }
    }
    return result;
  }

  async exportAll(): Promise<MemoryNode[]> {
    // Copies (including the embedding array) so mutating a returned node does
    // not affect the store (spec 017, Req 11 / AC-11).
    return [...this.nodes.values()].map((n) => ({ ...n, embedding: [...n.embedding] }));
  }

  async importAll(nodes: MemoryNode[]): Promise<void> {
    this.nodes.clear();
    for (const node of nodes) {
      this.nodes.set(node.id, { ...node, embedding: [...node.embedding] });
    }
  }
}

export {};
