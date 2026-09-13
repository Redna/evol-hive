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
  ConversationActionResult,
  ConversationBridge,
  ConversationObject,
  ConversationObserveResult,
  ConversationSentiment,
  OverheardConversation,
} from '@evol-hive/shared';
import { isSocialTalkGapCapped } from '@evol-hive/shared';
import type { AgentManager } from '../agents/index.js';
import type { ConversationManagerImpl } from './conversation-manager.js';
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
export class SocialManager implements SocialActionBridge, ConversationBridge {
  private readonly messageQueue = new MessageQueue();
  /** Conversation lifecycle engine (spec 033) — wired at assembly. */
  private conversationManager: ConversationManagerImpl | undefined;

  constructor(private readonly agentManager: AgentManager) {}

  /** Wire the conversation manager (spec 033, R1) — enables ConversationBridge. */
  setConversationManager(conversationManager: ConversationManagerImpl): void {
    this.conversationManager = conversationManager;
  }

  // ── SocialActionBridge methods ─────────────────────────────────────────────

  /**
   * Queue a social message for the target agent (spec 018, Req 17).
   *
   * Spec 039 (R5 — social fog-lifting): delivering a message shares the
   * speaker's sightings — what the speaker has observed (rooms, doors,
   * object anchors with last-seen room, explored cells) enters the
   * LISTENER's spatial memory using the same representation personal
   * discovery writes, so perception fog and targetArea enums pick it up
   * automatically. Idempotent: already-known rooms/doors/anchors are kept.
   */
  queueMessage(fromAgentId: string, toAgentId: string, content: string): void {
    const fromName = this.agentManager.getProfile(fromAgentId)?.name ?? fromAgentId;
    const timestamp = Date.now();
    const message: SocialMessage = { fromAgentId, fromName, content, timestamp };
    this.messageQueue.enqueue(toAgentId, message);
    this.transferSightings(fromAgentId, toAgentId);
  }

  /**
   * Transfer the speaker's spatial sightings into the listener's spatial
   * memory (spec 039, R5) — same representation as personal discovery:
   * rooms → visitedRooms, doors → knownDoors, object anchors →
   * observedObjects, explored cells → exploredCells. Timestamps carry the
   * speaker's discovery times where present (last-seen state).
   */
  private transferSightings(fromAgentId: string, toAgentId: string): void {
    if (fromAgentId === toAgentId) return;
    const speaker = this.agentManager.getState(fromAgentId);
    const listener = this.agentManager.getState(toAgentId);
    if (!speaker?.spatialMemory || !listener) return;
    const source = speaker.spatialMemory;
    const target = listener.spatialMemory ?? {
      visitedRooms: [],
      knownDoors: [],
      discoveredAt: {},
    };

    const visitedRooms = [...target.visitedRooms];
    const knownDoors = [...target.knownDoors];
    const discoveredAt = { ...target.discoveredAt };
    const observedObjects = { ...(target.observedObjects ?? {}) };
    const exploredCells: Record<string, string[]> = { ...(target.exploredCells ?? {}) };

    for (const room of source.visitedRooms) {
      if (!visitedRooms.includes(room)) {
        visitedRooms.push(room);
        discoveredAt[room] = source.discoveredAt[room] ?? Date.now();
      }
    }
    for (const door of source.knownDoors) {
      if (!knownDoors.includes(door)) knownDoors.push(door);
    }
    for (const [objectId, roomId] of Object.entries(source.observedObjects ?? {})) {
      if (observedObjects[objectId] === undefined) {
        observedObjects[objectId] = roomId;
      }
    }
    for (const [roomId, cells] of Object.entries(source.exploredCells ?? {})) {
      const known = new Set(exploredCells[roomId] ?? []);
      for (const cell of cells) known.add(cell);
      exploredCells[roomId] = [...known];
    }

    this.agentManager.updateState(toAgentId, {
      spatialMemory: {
        visitedRooms,
        knownDoors,
        discoveredAt,
        observedObjects,
        exploredCells,
      },
    });
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
      ...(existing.sentCount !== undefined ? { sentCount: existing.sentCount } : {}),
      ...(existing.receivedCount !== undefined ? { receivedCount: existing.receivedCount } : {}),
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
    // Spec 044 (R2/AC-7): reciprocity counters are ADDITIVE deltas on the
    // same bridge method — the cognition executor passes {sentCount: 1} for
    // the speaker and {receivedCount: 1} for the target, once per exchange,
    // next to the trust/familiarity deltas (no new write path, Decision 3).
    if (updates.sentCount !== undefined) {
      merged.sentCount = Math.max(0, (existing.sentCount ?? 0) + updates.sentCount);
    }
    if (updates.receivedCount !== undefined) {
      merged.receivedCount = Math.max(0, (existing.receivedCount ?? 0) + updates.receivedCount);
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

  /**
   * Resolve a display name (or ID) to the REAL active agent ID (spec 046, R1).
   *
   * Exact agent-ID passthrough first (an active agent state exists with that
   * ID — despawned agents hold no state, so stale IDs fail). Otherwise a
   * case-insensitive match on `profile.name` over active agents, preferring
   * agents co-located with the requester (co-location is what the perception
   * `Agents present` line describes, so a room-local match is almost always
   * the intended target). Returns `null` when nothing matches or the name is
   * ambiguous (duplicate matches even after the co-location preference) —
   * never silent guessing. Deterministic: pure TypeScript over profiles and
   * states, no LLM anywhere.
   */
  resolveAgentId(requesterAgentId: string, nameOrId: string): string | null {
    if (nameOrId.length === 0) return null;
    // Exact agent-ID passthrough — active state only.
    if (this.agentManager.getState(nameOrId) !== null) return nameOrId;
    // Case-insensitive profile-name match over active agents.
    const needle = nameOrId.toLowerCase();
    const requesterState = this.agentManager.getState(requesterAgentId);
    const requesterRoom = requesterState?.location;
    const coLocated: string[] = [];
    const elsewhere: string[] = [];
    for (const agent of this.agentManager.getActiveAgents()) {
      const name = this.agentManager.getProfile(agent.agentId)?.name;
      if (name === undefined || name.toLowerCase() !== needle) continue;
      if (requesterRoom !== undefined && requesterRoom !== '' && agent.location === requesterRoom) {
        coLocated.push(agent.agentId);
      } else {
        elsewhere.push(agent.agentId);
      }
    }
    // Prefer the requester's room; ambiguous duplicates resolve to nothing.
    if (coLocated.length === 1) return coLocated[0]!;
    if (coLocated.length > 1) return null;
    if (elsewhere.length === 1) return elsewhere[0]!;
    return null;
  }

  /**
   * The per-cycle valid talk targets for the requester (spec 051, R3 —
   * issue #186): co-located ACTIVE agents (what the perception 'Agents
   * present' line describes) minus any target whose unanswered gap
   * (`sentCount − receivedCount`) is at or above `SOCIAL_TALK_CAP` for that
   * relationship. The exclusion is per-target: a fresh target with a healthy
   * reciprocity remains valid. Recovery is mechanical — the target's reply
   * raises `receivedCount`, the gap drops below the cap, and the target
   * re-enters the list on the next call (Decision 2 — the gap IS the clock,
   * no cooldown timer). The cap arithmetic is the shared
   * `isSocialTalkGapCapped` helper — the single computation the cognition
   * enum builder also consumes (no second cap computation).
   *
   * This is the runtime value-space the cognition executor's choke point
   * validates against: the enum the LLM sees is built from perception, but
   * the ENGINE is the source of truth for validity (spec 051 Constraints).
   * Deterministic — pure TypeScript over agent states, no LLM anywhere.
   */
  enumerateTalkTargets(requesterAgentId: string): string[] {
    const requesterState = this.agentManager.getState(requesterAgentId);
    if (!requesterState) return [];
    const roomId = requesterState.location;
    if (!roomId || roomId === '') return [];
    const requesterRelationships = requesterState.relationships ?? {};
    const valid: string[] = [];
    for (const summary of this.getAgentsInRoom(roomId, requesterAgentId)) {
      const rel = requesterRelationships[summary.agentId];
      if (isSocialTalkGapCapped(rel?.sentCount ?? 0, rel?.receivedCount ?? 0)) continue;
      valid.push(summary.agentId);
    }
    return valid;
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

  /**
   * Number of pending messages for the agent WITHOUT consuming them
   * (spec 035, Req 5 — the System 1 gate peeks; only the Perceive phase
   * dequeues, so a gated-idle tick never eats a pending message).
   */
  peekPendingMessages(agentId: string): number {
    return this.messageQueue.pendingCount(agentId);
  }

  /** Get the agent's structured relationship map (spec 018, Req 20). */
  getRelationships(agentId: string): Record<string, Relationship> {
    const state = this.agentManager.getState(agentId);
    return state?.relationships ? { ...state.relationships } : {};
  }

  // ── ConversationBridge (spec 033, R1/R3) — delegates to ConversationManager ──

  openOrContribute(
    agentId: string,
    targetAgentId: string,
    content: string,
    sentiment: ConversationSentiment,
    tick: number,
    topic?: string,
  ): ConversationActionResult {
    if (this.conversationManager === undefined) {
      return { success: false, message: 'Conversations are not available in this environment.' };
    }
    return this.conversationManager.openOrContribute(
      agentId,
      targetAgentId,
      content,
      sentiment,
      tick,
      topic,
    );
  }

  join(agentId: string, conversationId: string, tick: number): ConversationActionResult {
    if (this.conversationManager === undefined) {
      return { success: false, message: 'Conversations are not available in this environment.' };
    }
    return this.conversationManager.join(agentId, conversationId, tick);
  }

  leave(agentId: string, conversationId: string, tick: number): ConversationActionResult {
    if (this.conversationManager === undefined) {
      return { success: false, message: 'Conversations are not available in this environment.' };
    }
    return this.conversationManager.leave(agentId, conversationId, tick);
  }

  contribute(
    agentId: string,
    conversationId: string,
    content: string,
    sentiment: ConversationSentiment,
    tick: number,
  ): ConversationActionResult {
    if (this.conversationManager === undefined) {
      return { success: false, message: 'Conversations are not available in this environment.' };
    }
    return this.conversationManager.contribute(agentId, conversationId, content, sentiment, tick);
  }

  observe(agentId: string, conversationId: string): ConversationObserveResult {
    if (this.conversationManager === undefined) {
      return { success: false, message: 'Conversations are not available in this environment.' };
    }
    return this.conversationManager.observe(agentId, conversationId);
  }

  getOpenConversationBetween(agentA: string, agentB: string): ConversationObject | null {
    return this.conversationManager?.getOpenConversationBetween(agentA, agentB) ?? null;
  }

  getEligibleAffordances(conversationId: string, agentId: string): string[] {
    return this.conversationManager?.getEligibleAffordances(conversationId, agentId) ?? [];
  }

  /** Conversations where the agent owes a reply (spec 044, Decision 4). */
  getConversationsAwaitingAgentReply(agentId: string): ConversationObject[] {
    return this.conversationManager?.getConversationsAwaitingAgentReply(agentId) ?? [];
  }

  /**
   * Open/active conversations in the agent's room the agent does NOT
   * participate in (spec 053, R1 — issue #192): the overheard-turn provider
   * scan, delegated to the conversation manager. Empty when conversations
   * are unavailable — no lines, no failure (influence, not force).
   */
  getOverheardConversations(agentId: string): OverheardConversation[] {
    return this.conversationManager?.getOverheardConversations(agentId) ?? [];
  }
}

export {};
