/**
 * system1/feature-service — Per-agent cached feature vectors (spec 035, Req 1, 7)
 * ────────────────────────────────────────────────────────────────────────────────
 * Implements both halves of the feature plumbing:
 *   - `System1FeatureSourcePort` (synchronous cache read for the gate), and
 *   - `System1FeatureRefresherPort` (engine-driven refresh).
 *
 * The scalar part refreshes synchronously every tick from the engine snapshot
 * (drives, flags, deltas — all engine state). The embedding part refreshes
 * asynchronously every N ticks via the shared `EmbeddingProvider` (the ONLY
 * asynchronous input to the extractor, Req 1) — fire-and-forget from the
 * engine's feature system, never awaited in the scheduler hot path (Req 7).
 *
 * Novelty (cosine distance vs the K most recent memories) is recomputed on
 * the async path via the injected `System1RecentMemoriesPort` and cached with
 * the embedding; the synchronous path reuses the cached novelty.
 *
 * Fail-open: `getFeatures` returns `null` before the first refresh — the gate
 * passes the candidate (today's behavior) until features exist.
 */

import type {
  System1EngineSnapshot,
  System1FeatureRefresherPort,
  System1FeatureSourcePort,
  System1FeatureVector,
  System1RecentMemoriesPort,
} from '@evol-hive/shared';
import { FEATURE_SCHEMA_VERSION, extractScalarFeatures } from '@evol-hive/shared';
import type { UnifiedEmbeddingProvider } from '@evol-hive/shared';

/** Options for {@link System1FeatureServiceImpl}. */
export interface System1FeatureServiceOptions {
  /** The shared embedding provider (the ONNX model — shared with classifier/memory). */
  embeddingProvider: UnifiedEmbeddingProvider;
  /** Recent-memory embeddings source (for novelty). */
  recentMemories: System1RecentMemoriesPort;
  /** K most recent memories for novelty (default 5). */
  noveltyMemoryK?: number;
}

interface CacheEntry {
  /** The latest snapshot embedding (null until the first async refresh lands). */
  embedding: number[] | null;
  /** Cached novelty (recomputed on the async path; 1 = maximally novel). */
  novelty: number;
  /** The latest synchronous scalar base (without novelty applied yet). */
  scalar: System1FeatureVector['scalar'] | null;
}

export class System1FeatureServiceImpl implements System1FeatureSourcePort, System1FeatureRefresherPort {
  private readonly embeddingProvider: UnifiedEmbeddingProvider;
  private readonly recentMemories: System1RecentMemoriesPort;
  private readonly noveltyMemoryK: number;
  private readonly cache = new Map<string, CacheEntry>();
  /** In-flight embedding refreshes per agent (dedupe fire-and-forget calls). */
  private readonly inFlight = new Set<string>();

  constructor(options: System1FeatureServiceOptions) {
    this.embeddingProvider = options.embeddingProvider;
    this.recentMemories = options.recentMemories;
    this.noveltyMemoryK = options.noveltyMemoryK ?? 5;
  }

  /** Synchronous cache read (Req 7: no await, no LLM calls). */
  getFeatures(agentId: string): System1FeatureVector | null {
    const entry = this.cache.get(agentId);
    if (!entry || entry.scalar === null) return null;
    const scalar = { ...entry.scalar, novelty: entry.novelty };
    return {
      schemaVersion: FEATURE_SCHEMA_VERSION,
      embedding: entry.embedding ?? [],
      scalar,
    };
  }

  /** Synchronous scalar refresh from engine state (every tick, Req 7). */
  refreshScalars(agentId: string, snapshot: System1EngineSnapshot): void {
    const { scalar } = extractScalarFeatures(snapshot);
    const entry = this.cache.get(agentId) ?? { embedding: null, novelty: 1, scalar: null };
    entry.scalar = scalar;
    this.cache.set(agentId, entry);
  }

  /**
   * Asynchronous embedding refresh (fire-and-forget from the engine feature
   * system): embeds the snapshot text and recomputes novelty against the K
   * most recent memory embeddings. Failures leave the cache untouched.
   */
  async refreshEmbedding(agentId: string, snapshot: System1EngineSnapshot): Promise<void> {
    if (this.inFlight.has(agentId)) return; // one refresh at a time per agent
    this.inFlight.add(agentId);
    try {
      const embedding = await this.embeddingProvider.embed(snapshot.snapshotText);
      let recent: number[][] | undefined;
      try {
        recent = await this.recentMemories.getRecentMemoryEmbeddings(agentId, this.noveltyMemoryK);
      } catch {
        recent = undefined; // novelty falls back to 1 (maximally novel)
      }
      const novelty = extractScalarFeatures(snapshot, {
        snapshotEmbedding: embedding,
        ...(recent !== undefined ? { recentMemoryEmbeddings: recent } : {}),
        noveltyMemoryK: this.noveltyMemoryK,
      }).scalar.novelty;
      const entry = this.cache.get(agentId);
      if (entry) {
        entry.embedding = embedding;
        entry.novelty = novelty;
      }
    } catch {
      // Embedding failures keep the previous cache state (fail-open upstream).
    } finally {
      this.inFlight.delete(agentId);
    }
  }
}