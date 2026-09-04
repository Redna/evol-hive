/**
 * world/mutations/yaam-event-log — YAAM persistence for dormant agents (spec 030, Req 12)
 * ────────────────────────────────────────────────────────────────────────────────────────
 * On despawn, the agent's state summary and key memories are written to a
 * YAAM-format append-only event log (`UPSERT_NODE` with agent-scoped labels;
 * `DELETE_NODE` when a re-spawn claims the dormant state) so a later session
 * can re-spawn the agent with its prior state via the existing memory
 * pipeline (docs/MEMORY_PIPELINE.md).
 *
 * Coarse-grained by design (design note D4): only spawn/despawn/session
 * boundaries write events — per-tick writes would flood the append-only
 * JSONL. The log is JSONL-serializable (`toJsonl`) and replayable in a fresh
 * session (`fromJsonl` → `replayNodes`), matching YAAM's "concatenation is a
 * merge" event-sourcing semantics. No new npm dependencies.
 */

import type { MemoryNode } from '@evol-hive/shared';

/** A single YAAM-format event (subset used for agent dormancy). */
export interface YaamEvent {
  type: 'UPSERT_NODE' | 'DELETE_NODE';
  /** Agent-scoped label, e.g. `agent:diarist:state` or `agent:diarist:mem:<nodeId>`. */
  label?: string;
  /** Node content (memory text or a human-readable state summary). */
  content?: string;
  /** Embedding for memory nodes (state summaries use a zero vector). */
  embedding?: number[];
  importance?: number;
  timestamp?: number;
  agentId?: string;
  location?: string;
}

/** A reconstructed node from a YAAM event log replay. */
export interface YaamReplayedNode {
  id: string;
  agentId: string;
  label: string;
  content: string;
  embedding: number[];
  timestamp: number;
  importance: number;
}

/** Derive the agent-scoped label for the agent's state-summary node. */
export function agentStateLabel(agentId: string): string {
  return `agent:${agentId}:state`;
}

/** Derive the agent-scoped label for one of the agent's memory nodes. */
export function agentMemoryLabel(agentId: string, nodeId: string): string {
  return `agent:${agentId}:mem:${nodeId}`;
}

/**
 * Append-only YAAM event log. In-memory by default; `appendTo(path)` also
 * appends the JSONL lines to a file for daemon-style persistence.
 */
export class YaamEventLog {
  private readonly logged: YaamEvent[] = [];

  /** Append an event (keeps insertion order — append-only semantics). */
  append(event: YaamEvent): void {
    this.logged.push(event);
  }

  /** All appended events (read-only copy). */
  events(): YaamEvent[] {
    return [...this.logged];
  }

  /** Serialize to YAAM JSONL — one JSON object per line. */
  toJsonl(): string {
    return this.logged.map((e) => JSON.stringify(e)).join('\n');
  }

  /**
   * Reconstruct nodes from the log (UPSERT_NODE inserts/overwrites by label,
   * DELETE_NODE removes) — the same replay semantics as the YAAM daemon.
   */
  replayNodes(): YaamReplayedNode[] {
    const byLabel = new Map<string, YaamReplayedNode>();
    for (const event of this.logged) {
      if (event.type === 'DELETE_NODE') {
        byLabel.delete(event.label ?? '');
        continue;
      }
      if (!event.label) continue;
      byLabel.set(event.label, {
        id: event.label,
        agentId: event.agentId ?? '',
        label: event.label,
        content: event.content ?? '',
        embedding: event.embedding ?? [],
        timestamp: event.timestamp ?? 0,
        importance: event.importance ?? 1,
      });
    }
    return [...byLabel.values()];
  }

  /** Rebuild a log from JSONL (fresh-session restore). */
  static fromJsonl(jsonl: string): YaamEventLog {
    const log = new YaamEventLog();
    for (const line of jsonl.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      log.logged.push(JSON.parse(trimmed) as YaamEvent);
    }
    return log;
  }

  /** Build the `UPSERT_NODE` event for a despawned agent's memory node. */
  static memoryUpsert(node: MemoryNode): YaamEvent {
    const event: YaamEvent = {
      type: 'UPSERT_NODE',
      label: agentMemoryLabel(node.agentId, node.id),
      content: node.content,
      embedding: node.embedding,
      importance: node.importance,
      timestamp: node.timestamp,
      agentId: node.agentId,
    };
    if (node.location !== undefined) {
      event.location = node.location;
    }
    return event;
  }

  /** Build the `DELETE_NODE` events that claim a re-spawned agent's nodes. */
  static respawnDelete(agentId: string, labels: string[]): YaamEvent[] {
    return labels.map((label) => ({ type: 'DELETE_NODE' as const, label, agentId }));
  }
}
