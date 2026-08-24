/**
 * social/social-manager — Social action bridge implementation (spec 018, Req 17–20)
 * ────────────────────────────────────────────────────────────────────────────
 * Implements `SocialActionBridge` (defined in `@evol-hive/shared`). Manages
 * the message queue, structured relationships, and agent summaries. Not a
 * ticked `EngineSystem` — a passive data structure updated on-demand.
 */

import type {
  AgentSummary,
  Relationship,
  SocialActionBridge,
  SocialMessage,
} from '@evol-hive/shared';
import type { AgentManager } from '../agents/index.js';
import { MessageQueue } from './message-queue.js';

/** Clamp a value to the 0–100 range. */
function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Concrete `SocialActionBridge` backed by `AgentManager` and an internal
 * `MessageQueue`. Provides perception queries (`getAgentsInRoom`,
 * `dequeueSocialMessages`, `getRelationships`) and social action execution
 * (`queueMessage`, `updateRelationship`, `getAgentSummary`, `getAgentDrives`).
 */
export class SocialManager implements SocialActionBridge {
  private readonly messageQueue = new MessageQueue();

  constructor(private readonly agentManager: AgentManager) {}

  // ── SocialActionBridge methods ─────────────────────────────────────────────

  /** Queue a social message for the target agent (spec 018, Req 17). */
  queueMessage(fromAgentId: string, toAgentId: string, content: string): void {
    const fromName = this.agentManager.getProfile(fromAgentId)?.name ?? fromAgentId;
    const timestamp = Date.now();
    const message: SocialMessage = { fromAgentId, fromName, content, timestamp };
    this.messageQueue.enqueue(toAgentId, message);
  }

  /** Update a structured relationship between two agents (spec 018, Req 17). */
  updateRelationship(agentId: string, otherAgentId: string, updates: Partial<Relationship>): void {
    const state = this.agentManager.getState(agentId);
    if (!state) return;

    const relationships = state.relationships ? { ...state.relationships } : {};
    const existing: Relationship = relationships[otherAgentId] ?? {
      trust: 50,
      familiarity: 0,
      lastInteraction: 0,
    };

    const merged: Relationship = {
      trust: existing.trust,
      familiarity: existing.familiarity,
      lastInteraction: existing.lastInteraction,
    };

    if (updates.trust !== undefined) {
      merged.trust = clamp(existing.trust + updates.trust);
    }
    if (updates.familiarity !== undefined) {
      merged.familiarity = clamp(existing.familiarity + updates.familiarity);
    }
    if (updates.lastInteraction !== undefined) {
      merged.lastInteraction = updates.lastInteraction;
    }

    relationships[otherAgentId] = merged;
    this.agentManager.updateState(agentId, { relationships });
  }

  /** Get a summary of an agent (spec 018, Req 17). */
  getAgentSummary(agentId: string): AgentSummary | null {
    const state = this.agentManager.getState(agentId);
    const profile = this.agentManager.getProfile(agentId);
    if (!state || !profile) return null;

    let currentActivity: string;
    if (state.isThinking) {
      currentActivity = 'thinking';
    } else if (state.currentPlan !== null) {
      currentActivity = `working on: ${state.currentPlan.description}`;
    } else {
      currentActivity = 'idle';
    }

    return {
      agentId,
      name: profile.name,
      currentActivity,
      isThinking: state.isThinking,
    };
  }

  /** Get an agent's drives as a flat record (spec 018, Req 17). */
  getAgentDrives(agentId: string): Record<string, number> {
    const state = this.agentManager.getState(agentId);
    if (!state) return {};
    return { ...state.drives };
  }

  // ── Perception query methods (spec 018, Req 18–20) ──────────────────────────

  /** Get summaries of all agents in a room except the excluding agent. */
  getAgentsInRoom(roomId: string, excludingAgentId: string): AgentSummary[] {
    const agents = this.agentManager.getActiveAgents();
    const summaries: AgentSummary[] = [];
    for (const agent of agents) {
      if (agent.agentId === excludingAgentId) continue;
      if (agent.location !== roomId) continue;
      const summary = this.getAgentSummary(agent.agentId);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  /** Dequeue pending social messages for the agent (spec 018, Req 19). */
  dequeueSocialMessages(agentId: string): SocialMessage[] {
    return this.messageQueue.dequeue(agentId);
  }

  /** Get the agent's structured relationship map (spec 018, Req 20). */
  getRelationships(agentId: string): Record<string, Relationship> {
    const state = this.agentManager.getState(agentId);
    return state?.relationships ? { ...state.relationships } : {};
  }
}

export {};
