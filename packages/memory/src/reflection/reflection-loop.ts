/**
 * reflection/reflection-loop — background consolidation (spec 014, Req 14)
 * ─────────────────────────────────────────────────────────────────────────────
 * Implements the `ReflectionLoop` interface. Decides when to consolidate an
 * agent's low-level memories into higher-level insights via the
 * `ConsolidationProvider` bridge (defined in `shared`, implemented in
 * `cognition`). On `runReflection`:
 *   - Gathers all the agent's memories and converts them to `MemorySnippet[]`.
 *   - Calls `consolidationProvider.consolidate` with a system prompt.
 *   - Stores each new consolidated memory (generating embeddings for empty
 *     ones), overriding `agentId` and setting `lastAccessed`.
 *   - Deprioritizes the original consolidated nodes: importance halved, minimum 1
 *     (NOT deleted — §11.3).
 *   - Updates the per-agent `lastReflectionTime`.
 *
 * A concurrent-reflection guard (`reflectingAgents: Set<string>`) prevents
 * duplicate consolidation passes for the same agent.
 *
 * Imports from `@evol-hive/shared` only (per ADR-0001 / spec 014, Req 20).
 */

import type {
  MemoryNode,
  MemorySnippet,
  ReflectionConfig,
  ReflectionResult,
  ConsolidationProvider,
} from '@evol-hive/shared';
import type { VectorStore, EmbeddingProvider, ReflectionLoop, SimulationClock } from '../index.js';

/** Constructor options for {@link ReflectionLoopImpl}. */
export interface ReflectionLoopOptions {
  vectorStore: VectorStore;
  embeddingProvider: EmbeddingProvider;
  consolidationProvider: ConsolidationProvider;
  config: ReflectionConfig;
  clock: SimulationClock;
}

/** System prompt instructing the LLM to consolidate low-level memories. */
const CONSOLIDATION_SYSTEM_PROMPT = `You are a memory consolidation engine for an autonomous NPC. You are given a set of low-level memory snippets (observations, actions, interactions). Consolidate them into higher-level insights — patterns, recurring themes, relationships, and learned preferences.

For each consolidated insight:
- Assign a higher importance (8-10) than the raw observations (typically 3-5).
- Use memory type "reflection" for synthesized insights.
- Reference the original memory IDs that were consolidated.

Return the consolidated memories and the IDs of the original nodes that were consolidated (these will be deprioritized, not deleted).`;

export class ReflectionLoopImpl implements ReflectionLoop {
  readonly config: ReflectionConfig;

  private readonly vectorStore: VectorStore;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly consolidationProvider: ConsolidationProvider;
  private readonly clock: SimulationClock;

  private running = false;
  /** Per-agent last reflection sim time (initialized to 0). */
  private readonly lastReflectionTime = new Map<string, number>();
  /** Agents currently undergoing a reflection pass (concurrent guard, Req 27). */
  private readonly reflectingAgents = new Set<string>();

  constructor(options: ReflectionLoopOptions) {
    this.vectorStore = options.vectorStore;
    this.embeddingProvider = options.embeddingProvider;
    this.consolidationProvider = options.consolidationProvider;
    this.config = options.config;
    this.clock = options.clock;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  async shouldReflect(agentId: string, currentSimTime: number, isIdle: boolean): Promise<boolean> {
    if (!this.config.enabled) return false;
    const lastReflection = this.lastReflectionTime.get(agentId) ?? 0;
    const recentCount = await this.vectorStore.countRecent(agentId, lastReflection);
    if (recentCount >= this.config.nodeThreshold) return true;
    if (isIdle && currentSimTime - lastReflection >= this.config.idleThresholdSeconds) {
      return true;
    }
    return false;
  }

  async runReflection(agentId: string): Promise<ReflectionResult> {
    // No-op if not running or disabled.
    if (!this.running || !this.config.enabled) {
      return { agentId, newMemories: [], consolidatedNodeIds: [] };
    }
    // Concurrent reflection guard (Req 27).
    if (this.reflectingAgents.has(agentId)) {
      return { agentId, newMemories: [], consolidatedNodeIds: [] };
    }
    this.reflectingAgents.add(agentId);
    try {
      const currentSimTime = this.clock();
      const nodes = await this.vectorStore.queryByAgent(agentId);
      const snippets: MemorySnippet[] = nodes.map((n) => ({
        id: n.id,
        content: n.content,
        importance: n.importance,
        timestamp: n.timestamp,
      }));

      const result = await this.consolidationProvider.consolidate(
        agentId,
        CONSOLIDATION_SYSTEM_PROMPT,
        snippets,
      );

      // Store new consolidated memories.
      for (const memory of result.newMemories) {
        const node: MemoryNode = {
          ...memory,
          agentId, // authoritative override (Req 14, Req 19)
          lastAccessed: currentSimTime,
        };
        // Generate embedding if empty/missing.
        if (!node.embedding || node.embedding.length === 0) {
          node.embedding = await this.embeddingProvider.embed(node.content);
        }
        await this.vectorStore.store(node);
      }

      // Deprioritize original consolidated nodes: importance halved, min 1 (Req 22).
      for (const id of result.consolidatedNodeIds) {
        const original = await this.vectorStore.get(id);
        if (!original) continue; // skip missing nodes
        const reduced = Math.max(1, Math.floor(original.importance / 2));
        await this.vectorStore.update(id, { importance: reduced });
      }

      // Mark the reflection time for this agent.
      this.lastReflectionTime.set(agentId, currentSimTime);

      return result;
    } finally {
      this.reflectingAgents.delete(agentId);
    }
  }
}

export {};
