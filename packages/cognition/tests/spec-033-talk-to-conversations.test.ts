/**
 * Tests for spec 033 — talk_to open-or-contribute + sentiment-gated
 * relationship deltas (issue #128) — cognition executor layer.
 *
 * Covers:
 * - AC-1 (R1, R3): talk_to maps to open-or-contribute via the conversation
 *   bridge — first exchange opens, later exchanges contribute to the thread.
 * - AC-7 (R6, R15): the relationship delta is a function of the conversation's
 *   aggregate sentiment — a negative exchange produces no trust gain, while
 *   positive/neutral keeps the current (+5 fam / +2 trust) deltas.
 * - AC-2 (R8): the message still queues and social drive still applies
 *   (existing talk_to behavior preserved).
 * - AC-14: no LLM on the deterministic path — the executor applies the shared
 *   pure delta mapping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ConversationBridge, ConversationObject } from '@evol-hive/shared';
import { CognitiveToolExecutorImpl } from '../src/tools/cognitive-tool-executor.js';
import type { CognitiveToolExecutorOptions } from '../src/tools/cognitive-tool-executor.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Scriptable ConversationBridge double: one open conversation between a and b. */
function makeConversationBridge(): ConversationBridge & {
  lastSentimentCounts: Record<string, { positive: number; neutral: number; negative: number }>;
} {
  const conv: ConversationObject = {
    id: 'conv-1',
    topic: 'chat',
    roomId: 'garden',
    status: 'active',
    participants: [
      {
        agentId: 'agent-a',
        joinedAtTick: 1,
        turnCount: 1,
        sentimentCounts: { positive: 0, neutral: 1, negative: 0 },
        role: 'initiator',
      },
      {
        agentId: 'agent-b',
        joinedAtTick: 1,
        turnCount: 0,
        sentimentCounts: { positive: 0, neutral: 0, negative: 0 },
        role: 'listener',
      },
    ],
    turns: [],
    openedAt: 1,
    lastActivity: 1,
  };
  const impl = {
    lastSentimentCounts: {} as Record<
      string,
      { positive: number; neutral: number; negative: number }
    >,
    openOrContribute(
      agentId: string,
      _targetAgentId: string,
      _content: string,
      sentiment: 'positive' | 'neutral' | 'negative',
      _tick: number,
    ) {
      const participant = conv.participants.find((p) => p.agentId === agentId)!;
      participant.turnCount += 1;
      participant.sentimentCounts = { ...participant.sentimentCounts };
      participant.sentimentCounts[sentiment] += 1;
      impl.lastSentimentCounts[agentId] = { ...participant.sentimentCounts };
      return { success: true, conversationId: conv.id, message: 'ok', conversation: { ...conv } };
    },
    join() {
      return { success: false, message: 'unused' };
    },
    leave() {
      return { success: false, message: 'unused' };
    },
    contribute() {
      return { success: false, message: 'unused' };
    },
    observe() {
      return { success: false, message: 'unused' };
    },
    getOpenConversationBetween() {
      return null;
    },
    getEligibleAffordances() {
      return [];
    },
  };
  return impl;
}

/** SocialActionBridge double that records relationship updates. */
function makeSocialBridge() {
  const updates: Array<{ agentId: string; other: string; updates: Record<string, unknown> }> = [];
  return {
    updates,
    queueMessage: () => undefined,
    updateRelationship(agentId: string, other: string, updates: Record<string, unknown>) {
      updates;
      this.updates.push({ agentId, other, updates });
    },
    getAgentSummary: () => ({ agentId: 'agent-b', name: 'Bob', currentActivity: 'idle', isThinking: false }),
    getAgentDrives: () => ({ social: 40 }),
  };
}

function makeExecutor(
  overrides: Partial<CognitiveToolExecutorOptions> = {},
): {
  executor: CognitiveToolExecutorImpl;
  social: ReturnType<typeof makeSocialBridge>;
  conversations: ReturnType<typeof makeConversationBridge>;
} {
  const social = makeSocialBridge();
  const conversations = makeConversationBridge();
  const executor = new CognitiveToolExecutorImpl({
    socialBridge: social as never,
    conversationBridge: conversations as unknown as ConversationBridge,
    currentTick: 100,
    ...overrides,
  });
  return { executor, social, conversations };
}

// ── AC-1 — talk_to opens-or-contributes ─────────────────────────────────────

describe('talk_to → open-or-contribute (AC-1, R1/R3)', () => {
  let ctx: ReturnType<typeof makeExecutor>;
  beforeEach(() => {
    ctx = makeExecutor();
  });

  it('routes the message through the conversation bridge', async () => {
    const result = await ctx.executor.executeTalkTo('agent-a', 'agent-b', 'hi there', 'neutral');
    expect(result.success).toBe(true);
    expect(result.conversationUpdated).toBe(true);
  });

  it('falls back to legacy behavior when no conversation bridge is wired', async () => {
    const social = makeSocialBridge();
    const executor = new CognitiveToolExecutorImpl({ socialBridge: social as never });
    const result = await executor.executeTalkTo('agent-a', 'agent-b', 'hi', 'neutral');
    expect(result.success).toBe(true);
    expect(result.conversationUpdated).toBe(false);
    expect(social.updates).toHaveLength(2); // blind +5/+2 both directions (legacy)
  });
});

// ── AC-7 — sentiment-gated relationship deltas ──────────────────────────────

describe('sentiment-gated relationship deltas (AC-7, R6)', () => {
  it('a predominantly negative exchange produces NO trust gain', async () => {
    const { executor, conversations, social } = makeExecutor();
    // Drive the conversation aggregate negative before the message lands.
    conversations.lastSentimentCounts['agent-a'] = { positive: 0, neutral: 1, negative: 3 };
    await executor.executeTalkTo('agent-a', 'agent-b', 'you are the worst', 'negative');
    const aToB = social.updates.find((u) => u.agentId === 'agent-a' && u.other === 'agent-b')!;
    expect(aToB.updates['trust']).toBe(0);
    expect(aToB.updates['familiarity']).toBeGreaterThanOrEqual(0);
  });

  it('a positive exchange preserves the current deltas (+5 fam / +2 trust)', async () => {
    const { executor, conversations, social } = makeExecutor();
    conversations.lastSentimentCounts['agent-a'] = { positive: 3, neutral: 0, negative: 0 };
    await executor.executeTalkTo('agent-a', 'agent-b', 'wonderful!', 'positive');
    const aToB = social.updates.find((u) => u.agentId === 'agent-a' && u.other === 'agent-b')!;
    expect(aToB.updates['trust']).toBe(2);
    expect(aToB.updates['familiarity']).toBe(5);
  });

  it('a neutral exchange preserves the current deltas', async () => {
    const { executor, conversations, social } = makeExecutor();
    conversations.lastSentimentCounts['agent-a'] = { positive: 0, neutral: 2, negative: 0 };
    await executor.executeTalkTo('agent-a', 'agent-b', 'ok', 'neutral');
    const aToB = social.updates.find((u) => u.agentId === 'agent-a' && u.other === 'agent-b')!;
    expect(aToB.updates['trust']).toBe(2);
    expect(aToB.updates['familiarity']).toBe(5);
  });

  it('the aggregate — not just the current message — gates the delta (R15)', async () => {
    // One hostile message in an otherwise friendly thread: aggregate stays
    // positive → current deltas preserved. The aggregate is what matters.
    const { executor, conversations, social } = makeExecutor();
    conversations.lastSentimentCounts['agent-a'] = { positive: 5, neutral: 0, negative: 1 };
    await executor.executeTalkTo('agent-a', 'agent-b', 'ugh', 'negative');
    const aToB = social.updates.find((u) => u.agentId === 'agent-a' && u.other === 'agent-b')!;
    expect(aToB.updates['trust']).toBe(2);
  });
});