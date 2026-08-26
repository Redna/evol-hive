/**
 * retrieval/memory-injector — dual-track memory injection (spec 014, Req 15)
 * ─────────────────────────────────────────────────────────────────────────────
 * Track 1 (associative, passive / System 1): builds a semantic query from the
 * agent's room + pressing drives and returns the top-5 relevant memories as
 * `MemorySnippet[]` — NO LLM call (§11.1).
 * Track 2 (active recall): delegates to `RetrievalEngine.retrieve` and maps
 * results to `MemorySnippet[]`.
 *
 * Imports from `@evol-hive/shared` only (per ADR-0001 / spec 014, Req 20).
 */

import type { MemoryNode, MemorySnippet } from '@evol-hive/shared';
import type { RetrievalEngine, MemoryInjector } from '../index.js';

/** Constructor options for {@link MemoryInjectorImpl}. */
export interface MemoryInjectorOptions {
  retrievalEngine: RetrievalEngine;
  /**
   * Optional cap on the number of memories injected by
   * {@link MemoryInjectorImpl.injectAssociative} (spec 022, Req 13, AC-12).
   * Defaults to `3` (down from the previous hardcoded `5`), overridable via
   * the `MEMORY_INJECTION_TOP_K` env var. An explicit `topK` here takes
   * precedence over the env var.
   */
  topK?: number;
}

/** Map a `MemoryNode` to its `MemorySnippet` projection. */
function toSnippet(node: MemoryNode): MemorySnippet {
  return {
    id: node.id,
    content: node.content,
    importance: node.importance,
    timestamp: node.timestamp,
  };
}

export class MemoryInjectorImpl implements MemoryInjector {
  private readonly retrievalEngine: RetrievalEngine;
  private readonly topK: number;

  constructor(options: MemoryInjectorOptions) {
    this.retrievalEngine = options.retrievalEngine;
    // Precedence (spec 022, Req 13, AC-12): explicit topK > MEMORY_INJECTION_TOP_K env > 3.
    const envTopK = Number(process.env['MEMORY_INJECTION_TOP_K']);
    this.topK = options.topK ?? (Number.isFinite(envTopK) && envTopK > 0 ? envTopK : 3);
  }

  async injectAssociative(
    agentId: string,
    roomId: string,
    currentDrives: Record<string, number>,
  ): Promise<MemorySnippet[]> {
    // Build a semantic query from location + pressing needs (drives > 50).
    const pressing = Object.entries(currentDrives)
      .filter(([, v]) => v > 50)
      .map(([k]) => k)
      .join(' ');
    const query = `${roomId} ${pressing}`.trim();
    const results = await this.retrievalEngine.retrieve(query, agentId, this.topK);
    return results.map((r) => toSnippet(r.node));
  }

  async activeRecall(agentId: string, query: string, topK: number): Promise<MemorySnippet[]> {
    const results = await this.retrievalEngine.retrieve(query, agentId, topK);
    return results.map((r) => toSnippet(r.node));
  }
}

export {};
