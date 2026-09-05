/**
 * Conversation Types — Conversations as Perceivable Temporal Objects (spec 033)
 * ────────────────────────────────────────────────────────────────────────────
 * A conversation is a first-class perceivable temporal object: a SmartObject
 * in the room with affordances (`join` / `contribute` / `leave` / `observe`)
 * that agents perceive and act on like any other object (§4). The data shape
 * lives in `shared` (ADR-0001) because both engine (lifecycle, persistence,
 * visualizer) and cognition (sentiment tagging, consolidation) consume it.
 *
 * Bounded state (Redna/yaam#124 bug class): the object stores only the last
 * {@link CONVERSATION_TURN_WINDOW} turns; full history exists only as
 * close-time `interaction` memories (spec 033, R4/R5).
 */

// ── Primitives ───────────────────────────────────────────────────────────────

/** LLM-tagged sentiment of a single turn (spec 033, R3). */
export type ConversationSentiment = 'positive' | 'neutral' | 'negative';

/** Per-participant sentiment tally (spec 033, R4). */
export interface SentimentCounts {
  positive: number;
  neutral: number;
  negative: number;
}

/** Lifecycle: `open` (created, awaiting a second participant turn) → `active` (real exchange) → `closed`. */
export type ConversationStatus = 'open' | 'active' | 'closed';

/**
 * Derived participant role (spec 033, R4): the initiator keeps `'initiator'`;
 * non-initiators are `'listener'` until their second turn, then
 * `'active contributor'`.
 */
export type ParticipantRole = 'initiator' | 'active contributor' | 'listener';

/** One turn in the conversation (spec 033, R4). */
export interface ConversationTurn {
  /** The speaking agent. */
  agentId: string;
  /** The speaker's derived role at the time of the turn. */
  role: ParticipantRole;
  /** The message text. */
  content: string;
  /** LLM-tagged sentiment of this turn (tagged at write time — never re-derived). */
  sentiment: ConversationSentiment;
  /** Engine tick at which the turn was appended. */
  tick: number;
}

/** Per-participant bookkeeping (spec 033, R4). */
export interface ConversationParticipant {
  agentId: string;
  /** Engine tick at which the agent joined (open counts as joining). */
  joinedAtTick: number;
  /** Total turns contributed (never decayed — drives the derived role). */
  turnCount: number;
  /** Running sentiment tally for this participant's turns. */
  sentimentCounts: SentimentCounts;
  /** Derived role (initiator / active contributor / listener). */
  role: ParticipantRole;
}

/**
 * The conversation data payload (spec 033, R1). The engine mirrors this into a
 * `SmartObject` (type `'conversation'`) so perception, classifier pruning,
 * guardrails, co-location, and the visualizer treat it like any other object.
 */
export interface ConversationObject {
  id: string;
  /** LLM-derived topic (derived at open time; stable afterwards). */
  topic: string;
  /** The room the conversation lives in (agents must be co-located to contribute). */
  roomId: string;
  status: ConversationStatus;
  participants: ConversationParticipant[];
  /** Rolling window — at most {@link CONVERSATION_TURN_WINDOW} recent turns. */
  turns: ConversationTurn[];
  /** Engine tick at which the conversation was opened. */
  openedAt: number;
  /** Engine tick of the most recent activity (turns, joins, leaves). */
  lastActivity: number;
  /** Engine tick at which the conversation closed. Present only when closed. */
  closedAt?: number;
}

/** The rolling window cap (spec 033, R4 — "last ~8 turns"). */
export const CONVERSATION_TURN_WINDOW = 8;

/** Configuration for the conversation lifecycle (spec 033, R2). */
export interface ConversationConfig {
  /** Ticks of inactivity before an open/active conversation auto-closes. */
  idleTimeoutTicks: number;
  /** Rolling window cap — mirrors {@link CONVERSATION_TURN_WINDOW}. */
  turnWindow: number;
}

/** Default conversation config (spec 033, R2/R4). */
export function defaultConversationConfig(): ConversationConfig {
  return { idleTimeoutTicks: 120, turnWindow: CONVERSATION_TURN_WINDOW };
}

// ── Pure deterministic helpers (no LLM anywhere — AC-14) ─────────────────────

/**
 * Derive a participant's role (spec 033, R4): the initiator keeps
 * `'initiator'`; everyone else is `'listener'` until their second turn.
 */
export function deriveParticipantRole(isInitiator: boolean, turnCount: number): ParticipantRole {
  if (isInitiator) return 'initiator';
  return turnCount >= 2 ? 'active contributor' : 'listener';
}

/** The dominant sentiment of a tally — ties resolve to `'neutral'` (deterministic). */
export function dominantSentiment(counts: SentimentCounts): ConversationSentiment {
  if (counts.positive > counts.neutral && counts.positive > counts.negative) return 'positive';
  if (counts.negative > counts.positive && counts.negative > counts.neutral) return 'negative';
  return 'neutral';
}

/**
 * Append a turn to a conversation (pure — returns a new object). Updates the
 * rolling window (drops the oldest beyond the cap), the speaker's tally and
 * derived role, the status (`open → active`), and `lastActivity`. Never
 * mutates the input.
 */
export function appendTurn(
  conversation: ConversationObject,
  turn: Omit<ConversationTurn, 'role'> & { role?: ParticipantRole },
): ConversationObject {
  const isInitiator = conversation.participants[0]?.agentId === turn.agentId;
  const speaker = conversation.participants.find((p) => p.agentId === turn.agentId);
  if (speaker === undefined) {
    // Non-participants cannot contribute — the caller gates this; a pure
    // function must still not fabricate participant state.
    return conversation;
  }

  const newTurnCount = speaker.turnCount + 1;
  const role = turn.role ?? deriveParticipantRole(isInitiator, newTurnCount);

  const participants = conversation.participants.map((p) => {
    if (p.agentId !== turn.agentId) return p;
    return {
      ...p,
      turnCount: newTurnCount,
      sentimentCounts: {
        ...p.sentimentCounts,
        [turn.sentiment]: p.sentimentCounts[turn.sentiment] + 1,
      },
      role,
    };
  });

  const turns = [...conversation.turns, { agentId: turn.agentId, role, content: turn.content, sentiment: turn.sentiment, tick: turn.tick }];
  const capped = turns.slice(-CONVERSATION_TURN_WINDOW);

  return {
    ...conversation,
    participants,
    turns: capped,
    status: conversation.status === 'closed' ? 'closed' : 'active',
    lastActivity: turn.tick,
  };
}

/**
 * Remove a participant (pure). Used by `leave`, the co-location sweep, and
 * despawn cleanup. Closing (when the last participant leaves) is the caller's
 * lifecycle decision, not this function's.
 */
export function removeParticipant(
  conversation: ConversationObject,
  agentId: string,
): ConversationObject {
  return {
    ...conversation,
    participants: conversation.participants.filter((p) => p.agentId !== agentId),
  };
}

/** A participant's sentiment tally derived from their turns (spec 033, R4). */
export function participantSentimentCounts(
  conversation: ConversationObject,
  agentId: string,
): SentimentCounts {
  const counts: SentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  for (const turn of conversation.turns) {
    if (turn.agentId === agentId) {
      counts[turn.sentiment] += 1;
    }
  }
  return counts;
}

/**
 * Sentiment → relationship delta mapping (spec 033, R6 — pure TypeScript).
 *
 * A predominantly negative exchange must not build trust (the pre-033 behavior
 * blindly added +2 trust per message); positive/neutral exchanges keep the
 * current deltas (+5 familiarity / +2 trust, spec 018).
 */
export function conversationRelationshipDelta(counts: SentimentCounts): {
  familiarity: number;
  trust: number;
} {
  if (dominantSentiment(counts) === 'negative') {
    // Negative exchange: no trust gain; a minimal familiarity bump reflects
    // that the agents did interact.
    return { familiarity: 1, trust: 0 };
  }
  return { familiarity: 5, trust: 2 };
}

/**
 * Sentiment → visualizer tint (spec 033, R9). Stable, distinct colors per
 * sentiment: green = positive, gray = neutral, red = negative.
 */
export function sentimentTint(sentiment: ConversationSentiment): string {
  switch (sentiment) {
    case 'positive':
      return '#7bd88f';
    case 'negative':
      return '#e06c75';
    default:
      return '#9aa0a6';
  }
}

// ── Bridge interface (ADR-0001 — engine implements, cognition consumes) ─────

/** Result of a conversation lifecycle action (join / leave / contribute / open). */
export interface ConversationActionResult {
  success: boolean;
  /** The conversation ID (present on success; also present on graceful co-location failures). */
  conversationId?: string;
  /** Actionable feedback for the LLM. */
  message: string;
  /** The updated conversation snapshot on success. */
  conversation?: ConversationObject;
}

/** Result of `observe` — non-participants see topic + participants, not turns (R3). */
export interface ConversationObserveResult {
  success: boolean;
  message: string;
  topic?: string;
  participants?: string[];
}

/**
 * Bridge interface (defined in `shared` per ADR-0001) for conversation
 * lifecycle actions. The engine implements it (`ConversationManagerImpl`,
 * exposed through `SocialManager`); cognition consumes it from the
 * `talk_to` execution path (open-or-contribute mapping, spec 033, R3).
 */
export interface ConversationBridge {
  /**
   * `talk_to` maps to open-or-contribute: if the speaker shares an open
   * conversation with the target, this contributes to that conversation;
   * otherwise it opens one (spec 033, R3).
   */
  openOrContribute(
    agentId: string,
    targetAgentId: string,
    content: string,
    sentiment: ConversationSentiment,
    tick: number,
    topic?: string,
  ): ConversationActionResult;
  /** Join as a co-located non-participant (spec 033, R3). */
  join(agentId: string, conversationId: string, tick: number): ConversationActionResult;
  /** Leave the conversation (participants only; last participant closes it). */
  leave(agentId: string, conversationId: string, tick: number): ConversationActionResult;
  /** Contribute a turn (participants only; co-location enforced). */
  contribute(
    agentId: string,
    conversationId: string,
    content: string,
    sentiment: ConversationSentiment,
    tick: number,
  ): ConversationActionResult;
  /** Observe — topic + participants only, never the turn window (spec 033, R3). */
  observe(agentId: string, conversationId: string): ConversationObserveResult;
  /** The open/active conversation shared by both agents, or `null`. */
  getOpenConversationBetween(agentA: string, agentB: string): ConversationObject | null;
  /** The affordance IDs (`join`/`contribute`/`leave`/`observe`) this agent may use. */
  getEligibleAffordances(conversationId: string, agentId: string): string[];
}