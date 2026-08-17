/**
 * retrieval/retrieval-engine — weighted retrieval scoring engine (spec 014, Req 10, 11)
 * ─────────────────────────────────────────────────────────────────────────────
 * Implements the `RetrievalEngine` interface. Computes a composite retrieval
 * score per memory node from three components (§11.2):
 *   - recency    = e^(-recencyDecayRate * (simTime - timestamp))
 *   - importance = node.importance * e^(-importanceDecayRate * (simTime - (lastAccessed ?? timestamp)))
 *                  where importanceDecayRate = recencyDecayRate * 0.1
 *   - relevance  = cosine similarity(queryEmbedding, node.embedding) (0 for zero-magnitude)
 *   - composite  = recency*recencyWeight + importance*importanceWeight + relevance*relevanceWeight
 *
 * `retrieve` embeds the query, over-fetches candidates from the `VectorStore`,
 * filters by `agentId`, scores, sorts by `composite` descending, takes the
 * top-K, and fire-and-forgets a `lastAccessed` update for each returned node.
 *
 * Imports from `@evol-hive/shared` only (per ADR-0001 / spec 014, Req 20).
 */

import type { MemoryNode, RetrievalScore, RetrievalWeights } from '@evol-hive/shared';
import { defaultRetrievalWeights } from '@evol-hive/shared';
import type { RetrievalEngine, VectorStore, EmbeddingProvider, SimulationClock } from '../index.js';
import { cosineSimilarity } from '../store/in-memory-vector-store.js';

/** Constructor options for {@link RetrievalEngineImpl}. */
export interface RetrievalEngineOptions {
  vectorStore: VectorStore;
  embeddingProvider: EmbeddingProvider;
  weights?: RetrievalWeights;
  clock: SimulationClock;
}

/** A scored retrieval result. */
export interface RetrievalResult {
  node: MemoryNode;
  score: RetrievalScore;
}

export class RetrievalEngineImpl implements RetrievalEngine {
  private readonly vectorStore: VectorStore;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly defaultWeights: RetrievalWeights;
  private readonly clock: SimulationClock;

  constructor(options: RetrievalEngineOptions) {
    this.vectorStore = options.vectorStore;
    this.embeddingProvider = options.embeddingProvider;
    this.defaultWeights = options.weights ?? defaultRetrievalWeights;
    this.clock = options.clock;
  }

  score(
    nodes: MemoryNode[],
    queryEmbedding: number[],
    currentSimTime: number,
    weights?: RetrievalWeights,
  ): RetrievalScore[] {
    const w = weights ?? this.defaultWeights;
    const importanceDecayRate = w.recencyDecayRate * 0.1;
    const scores: RetrievalScore[] = [];
    for (const node of nodes) {
      const age = currentSimTime - node.timestamp;
      const recency = Math.exp(-w.recencyDecayRate * age);
      const lastAccess = node.lastAccessed ?? node.timestamp;
      const importanceAge = currentSimTime - lastAccess;
      const importance = node.importance * Math.exp(-importanceDecayRate * importanceAge);
      const relevance = cosineSimilarity(queryEmbedding, node.embedding);
      const composite =
        recency * w.recencyWeight + importance * w.importanceWeight + relevance * w.relevanceWeight;
      scores.push({
        memoryId: node.id,
        recency,
        importance,
        relevance,
        composite,
      });
    }
    return scores;
  }

  async retrieve(query: string, agentId: string, topK: number): Promise<RetrievalResult[]> {
    const embedding = await this.embeddingProvider.embed(query);
    const currentSimTime = this.clock();
    const candidates = await this.vectorStore.queryByEmbedding(embedding, topK * 3);
    const filtered = candidates.filter((node) => node.agentId === agentId);
    const scores = this.score(filtered, embedding, currentSimTime);

    const paired = filtered.map((node, i) => ({ node, score: scores[i]! }));
    paired.sort((a, b) => b.score.composite - a.score.composite);
    const top = paired.slice(0, topK);

    // Fire-and-forget lastAccessed updates (spec 014, Req 11, 21).
    await Promise.all(
      top.map((result) =>
        this.vectorStore
          .update(result.node.id, { lastAccessed: currentSimTime })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              `[RetrievalEngineImpl] failed to update lastAccessed for ${result.node.id}: ${message}`,
            );
          }),
      ),
    );

    return top;
  }
}

export {};
