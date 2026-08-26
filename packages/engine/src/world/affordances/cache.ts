/**
 * affordances/cache — Affordance resolution cache (spec 022, Req 15, AC-15)
 * ────────────────────────────────────────────────────────────────────────────
 * Caches the mapping from `roomId` to available affordance tool definitions.
 * Computing affordance tool definitions for a room requires iterating every
 * smart object in the room and mapping each affordance to a tool definition —
 * work that is wasted when the room has not changed. The cache stores the
 * computed `ToolDefinition[]` per room and is invalidated when a smart object
 * in the room changes state (via {@link AffordanceResolutionCache.invalidate}
 * or {@link AffordanceResolutionCache.invalidateAll}).
 *
 * The cache is opt-in: a {@link SmartObjectRegistry} (or any caller) wires an
 * instance and calls `invalidate(roomId)` from its state-change callback.
 * With no cache wired, behavior is unchanged (the compute function runs every
 * time the caller asks).
 */

import type { ToolDefinition } from '@evol-hive/shared';

/**
 * A function that computes the affordance tool definitions for a room. The
 * cache calls this on a miss. Typically wraps
 * `affordancesToToolDefinitions(registry.getAffordancesInRoom(roomId))`.
 */
export type AffordanceToolComputer = (roomId: string) => ToolDefinition[];

/**
 * In-memory cache of affordance tool definitions per room (spec 022, Req 15).
 * Reference-equality is used for cache hits: the same `ToolDefinition[]`
 * instance is returned for repeated calls to {@link getAffordanceTools} until
 * the room is invalidated.
 */
export class AffordanceResolutionCache {
  private readonly compute: AffordanceToolComputer;
  private readonly cache = new Map<string, ToolDefinition[]>();

  constructor(compute: AffordanceToolComputer) {
    this.compute = compute;
  }

  /**
   * Return the affordance tool definitions for `roomId`. On a cache hit, the
   * cached array reference is returned without recomputation. On a miss, the
   * {@link AffordanceToolComputer} runs and the result is cached.
   */
  getAffordanceTools(roomId: string): ToolDefinition[] {
    const cached = this.cache.get(roomId);
    if (cached !== undefined) {
      return cached;
    }
    const tools = this.compute(roomId);
    this.cache.set(roomId, tools);
    return tools;
  }

  /** Invalidate the cached tool definitions for a single room (spec 022, Req 15). */
  invalidate(roomId: string): void {
    this.cache.delete(roomId);
  }

  /** Invalidate every cached room entry. */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** Number of currently cached rooms (useful for tests). */
  size(): number {
    return this.cache.size;
  }
}

export {};
