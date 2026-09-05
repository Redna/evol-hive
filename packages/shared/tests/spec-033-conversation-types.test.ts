/**
 * Tests for spec 033 — Conversations as Perceivable Temporal Objects (issue #128)
 * — shared layer: conversation data types and pure deterministic functions.
 *
 * Covers:
 * - AC-3 (R1, R3, R4): turns append with {agentId, role, content, sentiment, tick};
 *   derived participant roles and per-participant sentiment aggregates update on
 *   each turn.
 * - AC-6 (R4): the rolling window never exceeds the cap — bounded state, no
 *   unbounded growth (Redna/yaam#124 bug class).
 * - AC-7 (R6): sentiment → relationship delta mapping is pure TypeScript — a
 *   predominantly negative exchange yields NO trust gain; positive/neutral
 *   preserves the current (+5 fam / +2 trust) deltas.
 * - AC-14: all functions are pure/deterministic — no LLM anywhere.
 */
import { describe, it, expect } from 'vitest';
import type { ConversationObject, ConversationTurn } from '@evol-hive/shared';
import {
  CONVERSATION_TURN_WINDOW,
  appendTurn,
  removeParticipant,
  deriveParticipantRole,
  dominantSentiment,
  participantSentimentCounts,
  conversationRelationshipDelta,
  sentimentTint,
  defaultConversationConfig,
} from '@evol-hive/shared';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeConversation(overrides: Partial<ConversationObject> = {}): ConversationObject {
  return {
    id: 'conv-1',
    topic: 'watering schedule',
    roomId: 'garden',
    status: 'open',
    participants: [
      {
        agentId: 'agent-a',
        joinedAtTick: 10,
        turnCount: 0,
        sentimentCounts: { positive: 0, neutral: 0, negative: 0 },
        role: 'initiator',
      },
      {
        agentId: 'agent-b',
        joinedAtTick: 10,
        turnCount: 0,
        sentimentCounts: { positive: 0, neutral: 0, negative: 0 },
        role: 'listener',
      },
    ],
    turns: [],
    openedAt: 10,
    lastActivity: 10,
    ...overrides,
  };
}

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    agentId: 'agent-a',
    role: 'initiator',
    content: 'hello',
    sentiment: 'neutral',
    tick: 11,
    ...overrides,
  };
}

// ── AC-3 — turn shape, derived roles, sentiment aggregates ──────────────────

describe('appendTurn (AC-3, R1/R4)', () => {
  it('appends a turn carrying {agentId, role, content, sentiment, tick}', () => {
    const conv = appendTurn(makeConversation(), turn());
    expect(conv.turns).toHaveLength(1);
    expect(conv.turns[0]).toMatchObject({
      agentId: 'agent-a',
      role: 'initiator',
      content: 'hello',
      sentiment: 'neutral',
      tick: 11,
    });
  });

  it('transitions the conversation open → active on a turn', () => {
    const conv = appendTurn(makeConversation(), turn());
    expect(conv.status).toBe('active');
  });

  it('updates the speaker turnCount and sentiment aggregate', () => {
    let conv = appendTurn(makeConversation(), turn({ sentiment: 'positive' }));
    conv = appendTurn(conv, turn({ agentId: 'agent-b', role: 'listener', sentiment: 'negative' }));
    const a = conv.participants.find((p) => p.agentId === 'agent-a')!;
    const b = conv.participants.find((p) => p.agentId === 'agent-b')!;
    expect(a.turnCount).toBe(1);
    expect(a.sentimentCounts).toEqual({ positive: 1, neutral: 0, negative: 0 });
    expect(b.turnCount).toBe(1);
    expect(b.sentimentCounts.negative).toBe(1);
  });

  it('bumps lastActivity to the turn tick', () => {
    const conv = appendTurn(makeConversation(), turn({ tick: 42 }));
    expect(conv.lastActivity).toBe(42);
  });

  it('does not mutate the input conversation (pure function)', () => {
    const original = makeConversation();
    const snapshot = JSON.stringify(original);
    appendTurn(original, turn());
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('deriveParticipantRole (AC-3, R4)', () => {
  it('gives the initiator the initiator role regardless of turn count', () => {
    expect(deriveParticipantRole(true, 0)).toBe('initiator');
    expect(deriveParticipantRole(true, 5)).toBe('initiator');
  });
  it('gives non-initiators listener at 0-1 turns and active contributor at 2+', () => {
    expect(deriveParticipantRole(false, 0)).toBe('listener');
    expect(deriveParticipantRole(false, 1)).toBe('listener');
    expect(deriveParticipantRole(false, 2)).toBe('active contributor');
    expect(deriveParticipantRole(false, 9)).toBe('active contributor');
  });
});

// ── AC-6 — bounded rolling window ─────────────────────────────────────────────

describe('rolling window cap (AC-6, R4)', () => {
  it('exposes the ~8-turn window constant', () => {
    expect(CONVERSATION_TURN_WINDOW).toBe(8);
  });

  it('never stores more than the cap, even across arbitrarily many turns', () => {
    let conv = makeConversation();
    for (let i = 0; i < 100; i++) {
      conv = appendTurn(conv, turn({ agentId: i % 2 === 0 ? 'agent-a' : 'agent-b', tick: 11 + i }));
    }
    expect(conv.turns).toHaveLength(CONVERSATION_TURN_WINDOW);
  });

  it('keeps the most recent turns (drops the oldest)', () => {
    let conv = makeConversation();
    for (let i = 0; i < 12; i++) {
      conv = appendTurn(conv, turn({ content: `t${i}`, tick: 11 + i }));
    }
    expect(conv.turns[0]!.content).toBe('t4'); // 12 - 8 = 4 oldest dropped
    expect(conv.turns[conv.turns.length - 1]!.content).toBe('t11');
  });

  it('preserves full aggregates even when window drops turns (AC-6)', () => {
    let conv = makeConversation();
    for (let i = 0; i < 20; i++) {
      conv = appendTurn(conv, turn({ agentId: 'agent-a', sentiment: 'positive', tick: 11 + i }));
    }
    const a = conv.participants.find((p) => p.agentId === 'agent-a')!;
    expect(a.turnCount).toBe(20);
    expect(a.sentimentCounts.positive).toBe(20);
  });

  it('default config carries the window cap', () => {
    const config = defaultConversationConfig();
    expect(config.turnWindow).toBe(CONVERSATION_TURN_WINDOW);
    expect(config.idleTimeoutTicks).toBeGreaterThan(0);
  });
});

// ── participant removal (R2/R7 — leave & co-location exit) ──────────────────

describe('removeParticipant (R2, R7)', () => {
  it('removes the participant without mutating the input', () => {
    const original = makeConversation();
    const conv = removeParticipant(original, 'agent-b');
    expect(conv.participants.map((p) => p.agentId)).toEqual(['agent-a']);
    expect(original.participants).toHaveLength(2);
  });

  it('is a no-op for a non-participant', () => {
    const conv = removeParticipant(makeConversation(), 'agent-z');
    expect(conv.participants).toHaveLength(2);
  });
});

// ── sentiment aggregation + mapping (AC-7, R6) ──────────────────────────────

describe('dominantSentiment / participantSentimentCounts (AC-7, R4)', () => {
  it('returns the majority sentiment', () => {
    expect(dominantSentiment({ positive: 1, neutral: 0, negative: 3 })).toBe('negative');
    expect(dominantSentiment({ positive: 3, neutral: 0, negative: 1 })).toBe('positive');
  });

  it('breaks ties as neutral (deterministic)', () => {
    expect(dominantSentiment({ positive: 1, neutral: 1, negative: 1 })).toBe('neutral');
    expect(dominantSentiment({ positive: 0, neutral: 0, negative: 0 })).toBe('neutral');
  });

  it('counts per-participant sentiment from the conversation turns', () => {
    let conv = makeConversation();
    conv = appendTurn(conv, turn({ agentId: 'agent-b', sentiment: 'negative' }));
    conv = appendTurn(conv, turn({ agentId: 'agent-b', sentiment: 'negative' }));
    conv = appendTurn(conv, turn({ agentId: 'agent-b', sentiment: 'positive' }));
    expect(participantSentimentCounts(conv, 'agent-b')).toEqual({
      positive: 1,
      neutral: 0,
      negative: 2,
    });
  });
});

describe('conversationRelationshipDelta (AC-7, R6)', () => {
  it('gives NO trust gain for a predominantly negative exchange', () => {
    const delta = conversationRelationshipDelta({ positive: 0, neutral: 1, negative: 3 });
    expect(delta.trust).toBe(0);
    expect(delta.familiarity).toBeGreaterThanOrEqual(0);
  });

  it('preserves the current deltas (+5 fam / +2 trust) for a positive exchange', () => {
    expect(conversationRelationshipDelta({ positive: 3, neutral: 0, negative: 0 })).toEqual({
      familiarity: 5,
      trust: 2,
    });
  });

  it('preserves the current deltas for a neutral exchange', () => {
    expect(conversationRelationshipDelta({ positive: 0, neutral: 2, negative: 0 })).toEqual({
      familiarity: 5,
      trust: 2,
    });
  });

  it('is a pure deterministic mapping', () => {
    const counts = { positive: 1, neutral: 1, negative: 2 };
    expect(conversationRelationshipDelta(counts)).toEqual(conversationRelationshipDelta(counts));
  });
});

describe('sentimentTint (AC-10, R9)', () => {
  it('maps each sentiment to a distinct stable tint', () => {
    const positive = sentimentTint('positive');
    const neutral = sentimentTint('neutral');
    const negative = sentimentTint('negative');
    expect(positive).not.toBe(neutral);
    expect(neutral).not.toBe(negative);
    expect(positive).not.toBe(negative);
    // stable across calls
    expect(sentimentTint('positive')).toBe(positive);
  });
});
