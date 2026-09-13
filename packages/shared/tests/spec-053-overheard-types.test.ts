/**
 * Tests for spec 053 — Room-Perceivable Conversation Content (issue #192)
 * — shared layer: the overheard data types and the per-cycle render cap.
 *
 * Covers:
 * - AC-4 (R2): `CONVERSATION_OVERHEARD_LINES_PER_CYCLE` is exported from
 *   shared and equals 3 — the per-conversation per-cycle prompt budget.
 * - AC-1/AC-2 (R1, R3): `OverheardConversation` (conversationId, topic,
 *   bounded latest-first lines, availableLines), `OverheardLine`
 *   (speaker/addressee/content — agent IDs, never names), and the extended
 *   `ConversationObserveResult.turns` (full rolling-window history with
 *   agent, content, sentiment, tick — oldest first) are part of the shared
 *   contract. No schema change to `ConversationObject` and no
 *   `SAVE_FORMAT_VERSION` bump (AC-9 — overheard is a derived read-only view).
 */
import { describe, it, expect } from 'vitest';
import type {
  ConversationObserveResult,
  OverheardConversation,
  OverheardLine,
} from '@evol-hive/shared';
import {
  CONVERSATION_OVERHEARD_LINES_PER_CYCLE,
  CONVERSATION_TURN_WINDOW,
} from '@evol-hive/shared';

// ── AC-4 (R2) — the render cap constant ──────────────────────────────────────

describe('spec 053 — CONVERSATION_OVERHEARD_LINES_PER_CYCLE (AC-4, R2)', () => {
  it('is exported from shared and bounds the per-conversation per-cycle budget to 3', () => {
    expect(CONVERSATION_OVERHEARD_LINES_PER_CYCLE).toBe(3);
  });

  it('never exceeds the rolling turn window it draws from (spec 033, R4)', () => {
    expect(CONVERSATION_OVERHEARD_LINES_PER_CYCLE).toBeLessThanOrEqual(CONVERSATION_TURN_WINDOW);
  });
});

// ── AC-1 (R1) — the OverheardConversation contract ───────────────────────────

describe('spec 053 — OverheardConversation / OverheardLine shape (AC-1, R1)', () => {
  it('carries conversationId, topic, bounded latest-first lines, and the available count', () => {
    const lines: OverheardLine[] = [
      { speakerId: 'agent-b', addresseeId: 'agent-a', content: 'I will bring a wrench' },
      { speakerId: 'agent-a', addresseeId: 'agent-b', content: 'the pump is clogged again' },
    ];
    const conversation: OverheardConversation = {
      conversationId: 'conv-100-1',
      topic: 'greenhouse repairs',
      lines,
      availableLines: 2,
    };
    expect(conversation.conversationId).toBe('conv-100-1');
    expect(conversation.topic).toBe('greenhouse repairs');
    // Latest first (R2): the most recent turn is lines[0].
    expect(conversation.lines[0]?.content).toBe('I will bring a wrench');
    expect(conversation.availableLines).toBeGreaterThanOrEqual(conversation.lines.length);
  });

  it('lines carry agent IDs — names are a cognition-side rendering concern (R1)', () => {
    const line: OverheardLine = {
      speakerId: 'agent-a',
      addresseeId: 'agent-b',
      content: 'hello',
    };
    expect(line.speakerId).toBe('agent-a');
    expect(line.addresseeId).toBe('agent-b');
    expect(line.content).toBe('hello');
  });
});

// ── AC-2 (R3) — the extended observe result ──────────────────────────────────

describe('spec 053 — ConversationObserveResult.turns (AC-2, R3)', () => {
  it('accepts the full rolling-window turn history (agent, content, sentiment, tick)', () => {
    const result: ConversationObserveResult = {
      success: true,
      message: "Conversation about 'greenhouse repairs' (active). Speakers: Fern, Willow.",
      topic: 'greenhouse repairs',
      participants: ['agent-a', 'agent-b'],
      turns: [
        {
          agentId: 'agent-a',
          content: 'the pump is clogged again',
          sentiment: 'negative',
          tick: 100,
        },
        {
          agentId: 'agent-b',
          content: 'I will bring a wrench',
          sentiment: 'positive',
          tick: 105,
        },
      ],
    };
    expect(result.turns).toHaveLength(2);
    // Oldest first (R3).
    expect(result.turns?.[0]?.tick).toBeLessThan(result.turns?.[1]?.tick ?? Infinity);
    expect(result.turns?.[0]?.sentiment).toBe('negative');
  });
});
