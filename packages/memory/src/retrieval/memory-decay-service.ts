/**
 * retrieval/memory-decay-service — background memory decay (spec 014, Req 12, 13)
 * ─────────────────────────────────────────────────────────────────────────────
 * Computes effective importance for an agent's memories on-the-fly (decay is
 * computed, NOT stored — the base `MemoryNode.importance` is never modified by
 * decay). Identifies prune candidates whose effective importance falls below the
 * configured threshold. `pruneMemories` deletes those candidates.
 *
 * Imports from `@evol-hive/shared` only (per ADR-0001 / spec 014, Req 20).
 */

import type { MemoryDecayConfig, DecayResult } from '@evol-hive/shared';
import type { VectorStore, MemoryDecayService } from '../index.js';

/** Constructor options for {@link MemoryDecayServiceImpl}. */
export interface MemoryDecayServiceOptions {
  vectorStore: VectorStore;
  config: MemoryDecayConfig;
}

export class MemoryDecayServiceImpl implements MemoryDecayService {
  private readonly vectorStore: VectorStore;
  private readonly config: MemoryDecayConfig;

  constructor(options: MemoryDecayServiceOptions) {
    this.vectorStore = options.vectorStore;
    this.config = options.config;
  }

  async applyDecay(agentId: string, currentSimTime: number): Promise<DecayResult> {
    const nodes = await this.vectorStore.queryByAgent(agentId);
    const pruneCandidateIds: string[] = [];
    const scores: DecayResult['scores'] = [];
    for (const node of nodes) {
      const lastAccess = node.lastAccessed ?? node.timestamp;
      const effectiveImportance =
        node.importance * Math.exp(-this.config.decayRate * (currentSimTime - lastAccess));
      scores.push({
        memoryId: node.id,
        effectiveImportance,
        baseImportance: node.importance,
      });
      if (effectiveImportance < this.config.pruneThreshold) {
        pruneCandidateIds.push(node.id);
      }
    }
    return { agentId, pruneCandidateIds, scores };
  }

  async pruneMemories(agentId: string, currentSimTime: number): Promise<number> {
    const result = await this.applyDecay(agentId, currentSimTime);
    if (result.pruneCandidateIds.length > 0) {
      await this.vectorStore.delete(result.pruneCandidateIds);
    }
    return result.pruneCandidateIds.length;
  }
}

export {};
