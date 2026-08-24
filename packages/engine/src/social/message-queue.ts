/**
 * social/message-queue — In-memory social message queue (spec 018, Req 16)
 * ────────────────────────────────────────────────────────────────────────────
 * Manages a `Map<string, SocialMessage[]>` for agent-to-agent communication.
 * Messages are consumed (dequeued) when the target agent's Perceive phase reads
 * them. Not a ticked system — updated on-demand by social tool execution.
 */

import type { SocialMessage } from '@evol-hive/shared';

/** In-memory message queue keyed by target agent ID. */
export class MessageQueue {
  private readonly queues = new Map<string, SocialMessage[]>();

  /** Append a message to the target agent's queue. */
  enqueue(toAgentId: string, message: SocialMessage): void {
    const existing = this.queues.get(toAgentId);
    if (existing) {
      existing.push(message);
    } else {
      this.queues.set(toAgentId, [message]);
    }
  }

  /** Return all pending messages for the agent and clear the queue. */
  dequeue(agentId: string): SocialMessage[] {
    const messages = this.queues.get(agentId);
    if (!messages || messages.length === 0) return [];
    this.queues.set(agentId, []);
    return messages;
  }

  /** Number of pending messages for the agent (for debugging/testing). */
  pendingCount(agentId: string): number {
    return this.queues.get(agentId)?.length ?? 0;
  }
}

export {};
