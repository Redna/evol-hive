/**
 * llm/response-cache — LLM response cache (spec 022, Req 14, AC-13/AC-14)
 * ────────────────────────────────────────────────────────────────────────────
 * Caches LLM responses keyed on a hash of `(systemPrompt + perceptionContext +
 * tools)`. The cache is opt-in: when no `LLMResponseCache` is wired into the
 * LLM client (or used by a caller), behavior is unchanged. On a cache hit
 * within the TTL, the cached `LLMActionResponse` or `FormulatePlanResult` is
 * returned without an LLM call.
 *
 * The cache key includes the full `perceptionContext` (which contains drive
 * values rounded to integers per spec 021), so different drive states produce
 * different cache keys. The default TTL is one tick at 60 FPS (16.67ms),
 * configurable via the `LLM_CACHE_TTL_MS` env var. After the TTL expires, a
 * `get` returns `undefined` (miss) and the stale entry is evicted.
 */

import type { ToolDefinition } from '@evol-hive/shared';

/** A cached entry with its insertion timestamp. */
interface CacheEntry {
  result: unknown;
  insertedAt: number;
}

export interface LLMResponseCacheOptions {
  /** Cache time-to-live in milliseconds (default: `LLM_CACHE_TTL_MS` env or 16.67). */
  ttlMs?: number;
}

/**
 * In-memory LLM response cache keyed on `(systemPrompt, perceptionContext, tools)`.
 */
export class LLMResponseCache {
  private readonly ttlMs: number;
  private readonly store = new Map<string, CacheEntry>();

  constructor(options?: LLMResponseCacheOptions) {
    const envTtl = Number(process.env['LLM_CACHE_TTL_MS']);
    this.ttlMs = options?.ttlMs ?? (Number.isFinite(envTtl) && envTtl > 0 ? envTtl : 16.67);
  }

  /**
   * Look up a cached response for the given tuple. Returns `undefined` on a
   * miss (including expired entries, which are evicted on access).
   */
  get(
    systemPrompt: string,
    perceptionContext: string,
    tools: ToolDefinition[],
  ): unknown | undefined {
    const key = this.computeKey(systemPrompt, perceptionContext, tools);
    const entry = this.store.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }
    return entry.result;
  }

  /** Store a response for the given tuple. */
  set(
    systemPrompt: string,
    perceptionContext: string,
    tools: ToolDefinition[],
    result: unknown,
  ): void {
    const key = this.computeKey(systemPrompt, perceptionContext, tools);
    this.store.set(key, { result, insertedAt: Date.now() });
  }

  /** Number of currently cached entries. */
  size(): number {
    return this.store.size;
  }

  /** Remove all cached entries. */
  clear(): void {
    this.store.clear();
  }

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.insertedAt > this.ttlMs;
  }

  private computeKey(
    systemPrompt: string,
    perceptionContext: string,
    tools: ToolDefinition[],
  ): string {
    const toolKey = tools.map((t) => t.function.name).join(',');
    return `${systemPrompt}\u0000${perceptionContext}\u0000${toolKey}`;
  }
}

export {};
