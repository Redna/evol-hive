/**
 * social/conversation-manager — Conversation lifecycle engine (spec 033, Scope A)
 * ────────────────────────────────────────────────────────────────────────────
 * Owns conversation smart objects: creation on `talk_to` (open-or-contribute),
 * the join/contribute/leave/observe affordances, the bounded rolling turn
 * window, per-participant sentiment aggregates and derived roles, the
 * idle-timeout + co-location lifecycle (open → active → closed), close-time
 * per-participant `interaction` memory consolidation, and persistence
 * export/restore (save format v3).
 *
 * Deterministic core (AC-14): turn appends, lifecycle transitions, sentiment
 * aggregation, and consolidation payload building are pure TypeScript — no LLM
 * anywhere. The LLM only tags sentiment at write time and derives the topic at
 * open time (passed in by the caller).
 *
 * Conversations are mirrored into the `SmartObjectRegistry` as objects of type
 * `'conversation'` so perception, classifier pruning, guardrail masking,
 * spec-031 co-location, and the visualizer treat them like any other object
 * (R7–R9 — verify-first free wins). Conversation objects deliberately carry NO
 * `ObjectStateRule`s (spec 033 constraint: no state evolution on them).
 *
 * Bounded state (Redna/yaam#124 bug class): the object stores only the last
 * {@link CONVERSATION_TURN_WINDOW} turns; full history exists only as
 * close-time `interaction` memories.
 */

import type {
  ConversationActionResult,
  ConversationBridge,
  ConversationConfig,
  ConversationObject,
  ConversationObserveResult,
  ConversationSentiment,
  MemoryEntryInput,
  SmartObject,
} from '@evol-hive/shared';
import {
  CONVERSATION_TURN_WINDOW,
  SOCIAL_EXCHANGE_BONUS,
  appendTurn,
  conversationRelationshipDelta,
  deriveParticipantRole,
  dominantSentiment,
  participantSentimentCounts,
  removeParticipant,
} from '@evol-hive/shared';
import type { AgentManager } from '../agents/index.js';
import type { SmartObjectRegistry } from '../world/index.js';
import type { SceneManager } from '../world/index.js';

/**
 * Close-time consolidation sink (spec 033, R5). The engine core wires this to
 * the memory subsystem; the manager only *produces* the per-participant
 * `interaction` memory payloads. Kept as a narrow interface so the manager
 * never depends on the memory package directly.
 */
export interface ConversationConsolidationSink {
  storeInteraction(agentId: string, entry: MemoryEntryInput): void;
}

/** Constructor dependencies for {@link ConversationManagerImpl}. */
export interface ConversationManagerOptions {
  agentManager: AgentManager;
  /** Smart-object registry — conversation mirrors are registered here. */
  registry: SmartObjectRegistry;
  sceneManager: SceneManager;
  config?: ConversationConfig;
  /** Optional close-time consolidation sink (R5). Inert when absent. */
  consolidationSink?: ConversationConsolidationSink;
  /**
   * Spec 047 (R6 — issue #176): injected drive-apply callback for the
   * deferred exchange restore. When a turn by agent T lands in a
   * conversation, every other participant S whose only contributions so far
   * are unanswered messages (S has ≥ 1 prior turn in that thread) and who has
   * not already been topped up for that thread is reported through this
   * callback with `SOCIAL_EXCHANGE_BONUS`. Idempotent — at most once per
   * (sender, conversation) pair, never re-granted on repeated contributions
   * or thread rejoin. The manager detects; the applier pays — wired in
   * `assembly.ts` to the existing `AgentManager` drive path. Inert when
   * absent.
   */
  onExchangeRestore?: (agentId: string, conversationId: string, amount: number) => void;
}

/** Default lifecycle config (spec 033, R2/R4). */
export function defaultConversationManagerConfig(): ConversationConfig {
  return { idleTimeoutTicks: 120, turnWindow: CONVERSATION_TURN_WINDOW };
}

/** The four affordances every conversation object exposes (R3). */
const CONVERSATION_AFFORDANCES = ['join', 'contribute', 'leave', 'observe'] as const;

/**
 * Concrete `ConversationBridge` + lifecycle engine. Deterministic — no LLM
 * anywhere in this class (AC-14).
 */
export class ConversationManagerImpl implements ConversationBridge {
  private readonly conversations = new Map<string, ConversationObject>();
  private readonly agentManager: AgentManager;
  private readonly registry: SmartObjectRegistry;
  private readonly sceneManager: SceneManager;
  private readonly config: ConversationConfig;
  private readonly sink: ConversationConsolidationSink | undefined;
  private readonly onExchangeRestore:
    ((agentId: string, conversationId: string, amount: number) => void) | undefined;
  /**
   * Granted deferred restores, keyed `${conversationId}:${senderId}` (spec 047,
   * R6 idempotency — at most one top-up per (sender, conversation) pair).
   */
  private readonly exchangeRestored = new Set<string>();
  private nextId = 1;

  constructor(options: ConversationManagerOptions) {
    this.agentManager = options.agentManager;
    this.registry = options.registry;
    this.sceneManager = options.sceneManager;
    this.config = options.config ?? defaultConversationManagerConfig();
    this.sink = options.consolidationSink;
    this.onExchangeRestore = options.onExchangeRestore;
  }

  // ── ConversationBridge (spec 033, R3) ─────────────────────────────────────

  /**
   * Spec 046 (R3): resolve a participant key that matches no active agent ID
   * by case-insensitive profile name via this manager's own `agentManager` —
   * phantom participants are impossible even for direct bridge consumers
   * (tests, future callers). Exact-ID passthrough first; a UNIQUE name match
   * resolves; ambiguous duplicates or no match return `null`.
   */
  private resolveParticipantKey(key: string): string | null {
    if (key.length === 0) return null;
    if (this.agentManager.getState(key) !== null) return key;
    const needle = key.toLowerCase();
    const matches = this.agentManager
      .getActiveAgents()
      .filter((a) => (this.agentManager.getProfile(a.agentId)?.name ?? '').toLowerCase() === needle)
      .map((a) => a.agentId);
    return matches.length === 1 ? matches[0]! : null;
  }

  /**
   * Spec 046 (AC-8/AC-9): actionable refusal for an unresolvable target —
   * names the present agents (Req 17 self-correction pattern) so the LLM can
   * retry with a real ID. Never creates anything.
   */
  private unresolvableTargetMessage(key: string, requesterAgentId: string): string {
    const room = this.agentManager.getState(requesterAgentId)?.location;
    const present =
      room !== undefined && room !== ''
        ? this.agentManager
            .getActiveAgents()
            .filter((a) => a.agentId !== requesterAgentId && a.location === room)
        : [];
    const listing =
      present.length > 0
        ? present
            .map(
              (a) => `${this.agentManager.getProfile(a.agentId)?.name ?? a.agentId} (${a.agentId})`,
            )
            .join(', ')
        : 'none';
    return `No agent matches '${key}' — no conversation was started. Present agents: ${listing}.`;
  }

  openOrContribute(
    agentId: string,
    targetAgentId: string,
    content: string,
    sentiment: ConversationSentiment,
    tick: number,
    topic?: string,
  ): ConversationActionResult {
    // Spec 046 (R3): both keys resolve before anything else — a display name
    // reaches the real agent; an unresolvable key fails WITHOUT creating a
    // phantom participant.
    const speakerId = this.resolveParticipantKey(agentId);
    if (speakerId === null) {
      return {
        success: false,
        message: `No agent matches '${agentId}' — you are not part of this world.`,
      };
    }
    const resolvedTarget = this.resolveParticipantKey(targetAgentId);
    if (resolvedTarget === null) {
      return { success: false, message: this.unresolvableTargetMessage(targetAgentId, speakerId) };
    }
    if (speakerId === resolvedTarget) {
      return { success: false, message: 'You cannot talk to yourself.' };
    }
    const existing = this.getOpenConversationBetween(speakerId, resolvedTarget);
    if (existing !== null) {
      return this.contribute(speakerId, existing.id, content, sentiment, tick);
    }
    return this.open(speakerId, resolvedTarget, content, sentiment, tick, topic);
  }

  join(agentId: string, conversationId: string, tick: number): ConversationActionResult {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined) {
      return { success: false, message: `Conversation '${conversationId}' does not exist.` };
    }
    if (conversation.status === 'closed') {
      return { success: false, conversationId, message: 'That conversation has already ended.' };
    }
    if (conversation.participants.some((p) => p.agentId === agentId)) {
      return {
        success: false,
        conversationId,
        message: 'You are already part of this conversation.',
      };
    }
    // Co-location rule (R3): only co-located agents may join.
    if (this.agentManager.getState(agentId)?.location !== conversation.roomId) {
      return {
        success: false,
        conversationId,
        message: `You are not in the '${conversation.roomId}' — walk there first to join.`,
      };
    }

    const updated: ConversationObject = {
      ...conversation,
      participants: [
        ...conversation.participants,
        {
          agentId,
          joinedAtTick: tick,
          turnCount: 0,
          sentimentCounts: { positive: 0, neutral: 0, negative: 0 },
          role: deriveParticipantRole(false, 0),
        },
      ],
      lastActivity: tick,
    };
    this.commit(updated);
    return {
      success: true,
      conversationId,
      message: `You joined the conversation about '${updated.topic}'.`,
      conversation: updated,
    };
  }

  leave(agentId: string, conversationId: string, tick: number): ConversationActionResult {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined) {
      return { success: false, message: `Conversation '${conversationId}' does not exist.` };
    }
    if (!conversation.participants.some((p) => p.agentId === agentId)) {
      return { success: false, conversationId, message: 'You are not part of this conversation.' };
    }
    const updated = removeParticipant(conversation, agentId);
    if (updated.participants.length === 0) {
      this.close(conversationId, 'last participant left');
      return {
        success: true,
        conversationId,
        message: 'You left the conversation. It has ended.',
      };
    }
    this.commit({ ...updated, lastActivity: tick });
    return { success: true, conversationId, message: 'You left the conversation.' };
  }

  contribute(
    agentId: string,
    conversationId: string,
    content: string,
    sentiment: ConversationSentiment,
    tick: number,
  ): ConversationActionResult {
    // Spec 046 (R3): the speaker key resolves before the participant check —
    // a display name finds the real participant; an unresolvable key fails
    // (a contribution never creates a phantom participant).
    const speakerId = this.resolveParticipantKey(agentId);
    if (speakerId === null) {
      return {
        success: false,
        conversationId,
        message: `No agent matches '${agentId}' — you are not part of this conversation.`,
      };
    }
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined) {
      return { success: false, message: `Conversation '${conversationId}' does not exist.` };
    }
    if (conversation.status === 'closed') {
      return { success: false, conversationId, message: 'That conversation has already ended.' };
    }
    if (!conversation.participants.some((p) => p.agentId === speakerId)) {
      return {
        success: false,
        conversationId,
        message: 'You are not part of this conversation yet — join it first.',
      };
    }

    // Co-location integration (R7 / AC-5): an agent that is no longer in the
    // conversation's room fails `contribute` gracefully and is removed from
    // participants. The last participant leaving closes the conversation.
    if (this.agentManager.getState(speakerId)?.location !== conversation.roomId) {
      const updated = removeParticipant(conversation, agentId);
      if (updated.participants.length === 0) {
        this.close(conversationId, 'last participant left the room');
        return {
          success: false,
          conversationId,
          message: `You are no longer in the '${conversation.roomId}' — you left the conversation, which has now ended.`,
        };
      }
      this.commit(updated);
      return {
        success: false,
        conversationId,
        message: `You are no longer in the '${conversation.roomId}' — you left the conversation.`,
      };
    }

    const isInitiator = conversation.participants[0]?.agentId === speakerId;
    const speaker = conversation.participants.find((p) => p.agentId === speakerId);
    const turn = {
      agentId: speakerId,
      content,
      sentiment,
      tick,
      role: deriveParticipantRole(isInitiator, (speaker?.turnCount ?? 0) + 1),
    };
    this.commit(appendTurn(conversation, turn));
    const updated = this.conversations.get(conversationId);
    // Spec 047 (R6): the turn landed — detect completed exchanges and report
    // the deferred restore for earlier monologue-only participants.
    if (updated !== undefined) {
      this.grantExchangeRestores(updated, speakerId);
    }
    return {
      success: true,
      conversationId,
      message: `You contributed to the conversation about '${conversation.topic}'.`,
      ...(updated !== undefined ? { conversation: updated } : {}),
    };
  }

  observe(_agentId: string, conversationId: string): ConversationObserveResult {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined) {
      return { success: false, message: `Conversation '${conversationId}' does not exist.` };
    }
    // Non-participants see topic + participants, never the turn window (R3).
    return {
      success: true,
      message: `Conversation about '${conversation.topic}' (${conversation.status}).`,
      topic: conversation.topic,
      participants: conversation.participants.map((p) => p.agentId),
    };
  }

  getOpenConversationBetween(agentA: string, agentB: string): ConversationObject | null {
    for (const conversation of this.conversations.values()) {
      if (conversation.status === 'closed') continue;
      const ids = conversation.participants.map((p) => p.agentId);
      if (ids.includes(agentA) && ids.includes(agentB)) return conversation;
    }
    return null;
  }

  getEligibleAffordances(conversationId: string, agentId: string): string[] {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined || conversation.status === 'closed') return [];
    const isParticipant = conversation.participants.some((p) => p.agentId === agentId);
    // Role rules (R3): participants contribute/leave; co-located non-participants join/observe.
    if (isParticipant) return ['contribute', 'leave'];
    if (this.agentManager.getState(agentId)?.location === conversation.roomId) {
      return ['join', 'observe'];
    }
    return ['observe'];
  }

  /**
   * Conversations where the agent still owes a reply (spec 044, Decision 4):
   * open/active conversations where the agent participates and ANOTHER
   * CURRENT participant made the last turn. Pure scan of the conversation
   * map, deterministic order (insertion order) — no LLM, no triggers (R5).
   */
  getConversationsAwaitingAgentReply(agentId: string): ConversationObject[] {
    const awaiting: ConversationObject[] = [];
    for (const conversation of this.conversations.values()) {
      if (conversation.status === 'closed') continue;
      if (!conversation.participants.some((p) => p.agentId === agentId)) continue;
      const last = conversation.turns[conversation.turns.length - 1];
      if (last === undefined) continue;
      if (last.agentId === agentId) continue;
      // The addressee owes the reply to a CURRENT participant — if the
      // addresser left the conversation, the marker no longer binds.
      if (!conversation.participants.some((p) => p.agentId === last.agentId)) continue;
      awaiting.push(conversation);
    }
    return awaiting;
  }

  // ── Deferred exchange restore (spec 047, R5/R6) ─────────────────────────

  /**
   * A turn by `speakerId` just landed in `conversation`. Every other current
   * participant S whose contributions so far are unanswered messages (S has
   * ≥ 1 prior turn in the thread — via `turnCount`, which survives the
   * rolling turn window, or via the windowed turns for rejoined agents) and
   * who has not already been topped up for this thread receives the deferred
   * restore through the injected callback. Idempotent: at most once per
   * (sender, conversation) pair — re-contributions, leave/rejoin, and
   * multi-sender threads never double-grant. Inert without the callback.
   */
  private grantExchangeRestores(conversation: ConversationObject, speakerId: string): void {
    if (this.onExchangeRestore === undefined) return;
    for (const participant of conversation.participants) {
      if (participant.agentId === speakerId) continue;
      const key = `${conversation.id}:${participant.agentId}`;
      if (this.exchangeRestored.has(key)) continue;
      const contributedBefore =
        participant.turnCount > 0 ||
        conversation.turns.some((t) => t.agentId === participant.agentId);
      if (!contributedBefore) continue;
      this.exchangeRestored.add(key);
      this.onExchangeRestore(participant.agentId, conversation.id, SOCIAL_EXCHANGE_BONUS);
    }
  }

  // ── Lifecycle (spec 033, R2) ──────────────────────────────────────────────

  /** Open a new conversation between two agents (A's turn is the first). */
  private open(
    agentId: string,
    targetAgentId: string,
    content: string,
    sentiment: ConversationSentiment,
    tick: number,
    topic?: string,
  ): ConversationActionResult {
    const roomId = this.agentManager.getState(agentId)?.location ?? '';
    if (roomId === '') {
      return { success: false, message: 'You are nowhere — cannot start a conversation.' };
    }
    const id = `conv-${tick}-${this.nextId++}`;
    const base: ConversationObject = {
      id,
      topic: topic ?? 'a conversation',
      roomId,
      status: 'open',
      participants: [
        {
          agentId,
          joinedAtTick: tick,
          turnCount: 0,
          sentimentCounts: { positive: 0, neutral: 0, negative: 0 },
          role: deriveParticipantRole(true, 0),
        },
        {
          agentId: targetAgentId,
          joinedAtTick: tick,
          turnCount: 0,
          sentimentCounts: { positive: 0, neutral: 0, negative: 0 },
          role: deriveParticipantRole(false, 0),
        },
      ],
      turns: [],
      openedAt: tick,
      lastActivity: tick,
    };
    // Record the initiator's opening turn — still `open` until the second
    // participant speaks (AC-1: transitions open → active on B's first contribution).
    const withTurn = appendTurn(base, {
      agentId,
      content,
      sentiment,
      tick,
      role: deriveParticipantRole(true, 1),
    });
    const conversation: ConversationObject = { ...withTurn, status: 'open' };
    this.commit(conversation);
    return {
      success: true,
      conversationId: id,
      message: `You started a conversation about '${conversation.topic}'.`,
      conversation,
    };
  }

  /**
   * Close a conversation (idle timeout or empty — R2) and consolidate
   * per-participant `interaction` memories (R5 / AC-4).
   */
  close(conversationId: string, reason: string): void {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined || conversation.status === 'closed') return;
    const closed: ConversationObject = {
      ...conversation,
      status: 'closed',
      closedAt: conversation.lastActivity,
    };
    this.conversations.set(conversationId, closed);
    this.syncMirror(closed);
    this.consolidate(closed, reason);
  }

  /**
   * Tick sweep (spec 033, R2/R7): closes idle conversations and removes
   * participants who wandered out of the room (wandering off = leaving —
   * the spec-031 co-location guard's lifecycle twin).
   */
  tick(nowTick: number): void {
    for (const conversation of [...this.conversations.values()]) {
      if (conversation.status === 'closed') continue;

      // Co-location sweep (R7 / AC-5).
      let updated = conversation;
      for (const participant of conversation.participants) {
        if (this.agentManager.getState(participant.agentId)?.location !== conversation.roomId) {
          updated = removeParticipant(updated, participant.agentId);
        }
      }
      if (updated !== conversation) {
        if (updated.participants.length === 0) {
          this.close(conversation.id, 'last participant left the room');
          continue;
        }
        updated = { ...updated, lastActivity: nowTick };
        this.commit(updated);
      }

      // Idle timeout (R2).
      if (nowTick - updated.lastActivity > this.config.idleTimeoutTicks) {
        this.close(updated.id, 'idle timeout');
      }
    }
  }

  // ── Queries (perception / visualizer support) ────────────────────────────

  /** The conversation by ID, or `null`. */
  getConversation(conversationId: string): ConversationObject | null {
    return this.conversations.get(conversationId) ?? null;
  }

  /**
   * Remove an agent from every conversation they are in (spec 033, R7 despawn
   * support): participants leave, last-participant conversations close with
   * full consolidation.
   */
  removeAgentEverywhere(agentId: string): void {
    for (const conversation of [...this.conversations.values()]) {
      if (conversation.status === 'closed') continue;
      if (!conversation.participants.some((p) => p.agentId === agentId)) continue;
      const updated = removeParticipant(conversation, agentId);
      if (updated.participants.length === 0) {
        this.close(conversation.id, 'last participant despawned');
      } else {
        this.commit(updated);
      }
    }
  }

  /** All live (non-closed) conversations in a room — visualizer support (R9). */
  listConversationsInRoom(roomId: string): ConversationObject[] {
    return [...this.conversations.values()].filter((c) => c.roomId === roomId);
  }

  /** Number of conversations (useful for tests). */
  size(): number {
    return this.conversations.size;
  }

  /**
   * Serializable export of all conversations (open, active, AND closed —
   * closed conversations are resumable next session, spec 033, R10/AC-9).
   */
  exportConversations(): ConversationObject[] {
    return [...this.conversations.values()].map((c) => structuredCloneSafe(c));
  }

  /** Restore conversations from a persistence snapshot and re-register mirrors. */
  restoreConversations(conversations: ConversationObject[]): void {
    this.conversations.clear();
    for (const conversation of conversations) {
      this.conversations.set(conversation.id, structuredCloneSafe(conversation));
      this.syncMirror(this.conversations.get(conversation.id)!);
    }
  }

  // ── Smart-object mirror (R1/R3 — conversations are perceivable objects) ──

  /** Commit a conversation mutation: store + sync the registry mirror. */
  private commit(conversation: ConversationObject): void {
    this.conversations.set(conversation.id, conversation);
    this.syncMirror(conversation);
  }

  /** Create or refresh the conversation's SmartObject mirror in the registry. */
  private syncMirror(conversation: ConversationObject): void {
    const dominant = dominantSentiment(aggregateCounts(conversation));
    const state: Record<string, unknown> = {
      topic: conversation.topic,
      status: conversation.status,
      participants: conversation.participants.map((p) => p.agentId),
      dominantSentiment: dominant,
      turnCount: conversation.turns.length,
    };

    const affordances = CONVERSATION_AFFORDANCES.map((id) => ({
      id,
      label: CONVERSATION_AFFORDANCE_LABELS[id],
      engineEffect: `conversation_${id}`,
      preconditions: [],
      effects: {},
    }));

    const existing = this.registry.get(conversation.id);
    if (existing !== null) {
      this.registry.applyStatePatch(conversation.id, state);
      return;
    }
    const object: SmartObject = {
      id: conversation.id,
      name: `Conversation: ${conversation.topic}`,
      type: 'conversation',
      state,
      affordances,
      roomId: conversation.roomId,
      // No stateRules (spec 033 constraint: conversation objects never run
      // ObjectStateRule state evolution).
    };
    this.registry.register(object);
    // Keep room.objectIds consistent for perception.
    const room = this.sceneManager.getRoom(conversation.roomId);
    if (room !== null && !room.objectIds.includes(conversation.id)) {
      room.objectIds.push(conversation.id);
    }
  }

  // ── Close-time consolidation (R5 / AC-4) ─────────────────────────────────

  /** Produce per-participant `interaction` memories with role + sentiment summary. */
  private consolidate(conversation: ConversationObject, reason: string): void {
    if (this.sink === undefined) return;
    for (const participant of conversation.participants) {
      const counts = participantSentimentCounts(conversation, participant.agentId);
      const others = conversation.participants
        .filter((p) => p.agentId !== participant.agentId)
        .map((p) => p.agentId);
      const delta = conversationRelationshipDelta(counts);
      const content =
        `Conversation about '${conversation.topic}' ended (${reason}). ` +
        `Your role: ${participant.role}. ` +
        `Sentiment: ${counts.positive} positive, ${counts.neutral} neutral, ${counts.negative} negative ` +
        `(dominant: ${dominantSentiment(counts)}). ` +
        `Exchanged with: ${others.length > 0 ? others.join(', ') : 'no one'}. ` +
        `Relationship effect: familiarity ${delta.familiarity >= 0 ? '+' : ''}${delta.familiarity}, trust ${delta.trust >= 0 ? '+' : ''}${delta.trust}.`;
      this.sink.storeInteraction(participant.agentId, {
        content,
        importance: 6,
        type: 'interaction',
        location: conversation.roomId,
      });
    }
  }
}

/** Aggregate sentiment counts across all participants (tint / mirror support). */
function aggregateCounts(conversation: ConversationObject): {
  positive: number;
  neutral: number;
  negative: number;
} {
  const totals = { positive: 0, neutral: 0, negative: 0 };
  for (const turn of conversation.turns) {
    totals[turn.sentiment] += 1;
  }
  return totals;
}

const CONVERSATION_AFFORDANCE_LABELS: Record<(typeof CONVERSATION_AFFORDANCES)[number], string> = {
  join: 'Join this conversation',
  contribute: 'Say something in this conversation',
  leave: 'Leave this conversation',
  observe: 'Listen in — see the topic and participants',
};

/** JSON-safe deep copy for plain data. */
function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export {};
