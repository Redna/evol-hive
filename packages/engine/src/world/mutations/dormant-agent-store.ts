/**
 * world/mutations/dormant-agent-store — Despawn/respawn state export (spec 030, Req 7/8)
 * ──────────────────────────────────────────────────────────────────────────────────────
 * In-memory store of despawned agents' full serializable state, keyed by
 * `agentId`. `DespawnAgent` exports the agent's profile, `AgentInternalState`
 * (drives, goal, plan, location), and memory nodes here instead of dropping
 * the data, so a later `SpawnAgent` with the dormant `agentId` restores the
 * exact pre-despawn state (AC-3) and save/load round-trips dormancy (AC-7).
 *
 * Snapshots are plain JSON-compatible objects — `snapshot()` yields a
 * serializable map for persistence (`SaveState.dynamic.dormantAgents`).
 */

import type { DormantAgentSnapshot } from '@evol-hive/shared';

/** In-memory Map of dormant agent snapshots, keyed by `agentId`. */
export class DormantAgentStore {
  private readonly dormant = new Map<string, DormantAgentSnapshot>();

  /** Store (or replace) a dormant agent snapshot. */
  put(agentId: string, snapshot: DormantAgentSnapshot): void {
    this.dormant.set(agentId, snapshot);
  }

  /** Get a dormant snapshot, or `null` when the agent is not dormant. */
  get(agentId: string): DormantAgentSnapshot | null {
    return this.dormant.get(agentId) ?? null;
  }

  /** Remove and return a dormant snapshot (used when re-spawn claims it). */
  take(agentId: string): DormantAgentSnapshot | null {
    const snapshot = this.dormant.get(agentId) ?? null;
    if (snapshot !== null) {
      this.dormant.delete(agentId);
    }
    return snapshot;
  }

  /** Whether an agent is dormant. */
  has(agentId: string): boolean {
    return this.dormant.has(agentId);
  }

  /** Serializable snapshot of all dormant agents (for persistence, Req 11). */
  snapshot(): Record<string, DormantAgentSnapshot> {
    const result: Record<string, DormantAgentSnapshot> = {};
    for (const [id, snap] of this.dormant) {
      result[id] = snap;
    }
    return result;
  }

  /** Restore from a persistence snapshot (replaces current contents). */
  restore(snapshot: Record<string, DormantAgentSnapshot>): void {
    this.dormant.clear();
    for (const [id, snap] of Object.entries(snapshot)) {
      this.dormant.set(id, snap);
    }
  }

  /** Number of dormant agents (useful for tests). */
  size(): number {
    return this.dormant.size;
  }
}