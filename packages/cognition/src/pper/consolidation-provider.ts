/**
 * pper/consolidation-provider — bridge from ConsolidationProvider to LLMClient (spec 014, Req 19)
 * ─────────────────────────────────────────────────────────────────────────────
 * A thin adapter that bridges the `ConsolidationProvider` interface (defined in
 * `@evol-hive/shared`) to `LLMClient.completeReflection` (in `cognition`). Per
 * ADR-0001, `cognition` imports from `@evol-hive/shared` (where
 * `ConsolidationProvider` is defined) but NOT from the memory package. The
 * wiring of `ConsolidationProviderImpl` → `ReflectionLoopImpl` happens at the
 * application entry point.
 */

import type { ConsolidationProvider, MemorySnippet, ReflectionResult } from '@evol-hive/shared';
import type { LLMClient } from '../index.js';

/** Constructor options for {@link ConsolidationProviderImpl}. */
export interface ConsolidationProviderOptions {
  llmClient: LLMClient;
}

export class ConsolidationProviderImpl implements ConsolidationProvider {
  private readonly llmClient: LLMClient;

  constructor(options: ConsolidationProviderOptions) {
    this.llmClient = options.llmClient;
  }

  async consolidate(
    agentId: string,
    systemPrompt: string,
    memoryNodes: MemorySnippet[],
  ): Promise<ReflectionResult> {
    const result = await this.llmClient.completeReflection(systemPrompt, memoryNodes);
    // The caller is authoritative — override agentId on each new memory.
    for (const memory of result.newMemories) {
      memory.agentId = agentId;
    }
    return result;
  }
}

export {};
