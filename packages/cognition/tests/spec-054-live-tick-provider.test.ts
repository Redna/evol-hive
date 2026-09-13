/**
 * Tests for spec 054 — Live Tick Provider for CognitiveToolExecutor (issue #195).
 *
 * The bug: the executor captured `options.currentTick ?? Date.now()` ONCE at
 * construction (epoch milliseconds, ~1.789e12, where engine tickNumber belongs)
 * and reused the frozen value for every stamp. Conversation turns were stamped
 * with epoch ms → `PendingAddressInfo.age` went ~−1.789e12 → freshness always
 * true → `FRESH:` fired forever; `Relationship.lastInteraction` carried epoch
 * ms everywhere.
 *
 * Covers:
 * - AC-1 (R1/R2): without `tickProvider`, stamps are `Date.now()`-sourced at
 *   CALL time (not construction time); the legacy `currentTick` option keeps
 *   working (spec 018 AC-25); `tickProvider` wins when both are supplied.
 * - AC-2 (R1/R3): with `tickProvider: () => 5000`, a talk_to exchange stamps
 *   the conversation turn and BOTH sides' `Relationship.lastInteraction` with
 *   exactly 5000; rewiring the provider to 6000 stamps 6000 on the next
 *   exchange (live read, not construction capture — same executor instance).
 * - AC-3 (R3): every stamp site reads the provider result — asserted by a
 *   sentinel `424242` far from any plausible epoch ms (~1.789e12), so exact
 *   equality proves no `Date.now()` read. Sites: openOrContribute turn tick
 *   (spec 033 R1/R3, incl. the unresolvable-target refusal path), the six
 *   `Relationship.lastInteraction` writes (talk_to ×2, observe ×1, help ×2,
 *   ignore ×1 — spec 044 R2).
 * - AC-5 (R5, unit level): with tickNumber-unit stamps, the spec 049 R3
 *   freshness discrimination holds — 100 ticks old → fresh + `FRESH:` render,
 *   4000 ticks old → stale + no promotion, `age` non-negative in both.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  ConversationBridge,
  ConversationObject,
  Relationship,
  SocialActionBridge,
} from '@evol-hive/shared';
import { SOCIAL_PENDING_FRESH_TICKS } from '@evol-hive/shared';
import { CognitiveToolExecutorImpl } from '../src/tools/cognitive-tool-executor.js';
import type { CognitiveToolExecutorOptions } from '../src/tools/cognitive-tool-executor.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import type { PendingAddressInfo } from '@evol-hive/shared';

/** Epoch-ms magnitude (the bug's stamp values) — the sentinel must be far away. */
const EPOCH_MS_NOW = Date.now();
const SENTINEL_TICK = 424242;
expect(SENTINEL_TICK).toBeLessThan(EPOCH_MS_NOW / 1_000_000);

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Scriptable ConversationBridge double (spec 033 test pattern): records the
 * exact `tick` argument of every openOrContribute call and maintains a real
 * `turns` array keyed by that tick.
 */
function makeConversationBridge(): ConversationBridge & {
  conv: ConversationObject;
  requestedTicks: number[];
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
    turns: [
      { agentId: 'agent-a', role: 'initiator', content: 'hi', sentiment: 'neutral', tick: 1 },
    ],
    openedAt: 1,
    lastActivity: 1,
  };
  const requestedTicks: number[] = [];
  const impl = {
    conv,
    requestedTicks,
    openOrContribute(
      agentId: string,
      _targetAgentId: string,
      content: string,
      sentiment: 'positive' | 'neutral' | 'negative',
      tick: number,
    ) {
      requestedTicks.push(tick);
      const participant = conv.participants.find((p) => p.agentId === agentId);
      if (participant === undefined) {
        return { success: false, message: 'not present' };
      }
      participant.turnCount += 1;
      participant.sentimentCounts = { ...participant.sentimentCounts };
      participant.sentimentCounts[sentiment] += 1;
      conv.turns.push({ agentId, role: participant.role, content, sentiment, tick });
      conv.lastActivity = tick;
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

/** SocialActionBridge double that records every updateRelationship call. */
function makeSocialBridge(resolver?: (target: string) => string | null): SocialActionBridge & {
  updates: Array<{ agentId: string; other: string; updates: Partial<Relationship> }>;
} {
  const updates: Array<{ agentId: string; other: string; updates: Partial<Relationship> }> = [];
  return {
    updates,
    resolveAgentId: (_agentId: string, target: string) =>
      resolver ? resolver(target) : target,
    queueMessage: () => undefined,
    updateRelationship(agentId: string, other: string, partial: Partial<Relationship>) {
      updates.push({ agentId, other, updates: partial });
    },
    getAgentSummary: (agentId: string) => ({
      agentId,
      name: agentId,
      currentActivity: 'idle',
      isThinking: false,
    }),
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
    socialBridge: social,
    conversationBridge: conversations,
    ...overrides,
  });
  return { executor, social, conversations };
}

function stampOn(social: ReturnType<typeof makeSocialBridge>, agentId: string, other: string): number {
  const entry = social.updates.find((u) => u.agentId === agentId && u.other === other);
  expect(entry, `expected a relationship write ${agentId}→${other}`).toBeDefined();
  return entry!.updates['lastInteraction'] as number;
}

// ── AC-1 — default Date.now() at CALL time; legacy option; precedence ────────

describe('AC-1: default tick source (R1/R2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps Date.now() at CALL time — a construction-time capture is not frozen (R2)', async () => {
    const T0 = 1_700_000_000_000;
    vi.setSystemTime(T0);
    const { executor, social } = makeExecutor(); // no tickProvider, no currentTick

    // Time moves between construction and the call — the stamp must move too.
    vi.setSystemTime(T0 + 50);
    await executor.executeTalkTo('agent-a', 'agent-b', 'hello', 'neutral');

    expect(stampOn(social, 'agent-a', 'agent-b')).toBe(T0 + 50);
    expect(stampOn(social, 'agent-b', 'agent-a')).toBe(T0 + 50);
  });

  it('the legacy static currentTick option keeps working (spec 018 AC-25 seam)', async () => {
    vi.setSystemTime(1_700_000_000_000);
    const { executor, social } = makeExecutor({ currentTick: 500 });

    vi.setSystemTime(1_700_000_001_000); // time advances; the static seam must not
    await executor.executeTalkTo('agent-a', 'agent-b', 'hello', 'neutral');

    expect(stampOn(social, 'agent-a', 'agent-b')).toBe(500);
    expect(stampOn(social, 'agent-b', 'agent-a')).toBe(500);
  });

  it('tickProvider takes precedence over the legacy currentTick option', async () => {
    const { executor, social } = makeExecutor({
      currentTick: 111,
      tickProvider: () => 5000,
    });

    await executor.executeTalkTo('agent-a', 'agent-b', 'hello', 'neutral');
    expect(stampOn(social, 'agent-a', 'agent-b')).toBe(5000);
  });
});

// ── AC-2 — live tick provider: talk_to stamps turns + both relationships ─────

describe('AC-2: tickProvider stamps turn tick and lastInteraction live (R1/R3)', () => {
  it('a talk_to exchange stamps the conversation turn and both sides with exactly 5000', async () => {
    const { executor, social, conversations } = makeExecutor({ tickProvider: () => 5000 });

    const result = await executor.executeTalkTo('agent-a', 'agent-b', 'hi there', 'neutral');
    expect(result.success).toBe(true);

    // The conversation turn carries the provider tick (spec 033 R1/R3).
    const lastTurn = conversations.conv.turns[conversations.conv.turns.length - 1]!;
    expect(lastTurn.tick).toBe(5000);

    // Both sides' Relationship.lastInteraction carry the provider tick.
    expect(stampOn(social, 'agent-a', 'agent-b')).toBe(5000);
    expect(stampOn(social, 'agent-b', 'agent-a')).toBe(5000);
  });

  it('rewiring the provider to 6000 stamps 6000 on the NEXT exchange — live read, same executor', async () => {
    let tick = 5000;
    const { executor, social, conversations } = makeExecutor({ tickProvider: () => tick });

    await executor.executeTalkTo('agent-a', 'agent-b', 'first', 'neutral');
    expect(stampOn(social, 'agent-a', 'agent-b')).toBe(5000);

    // The SAME executor instance — only the provider's return value moves.
    tick = 6000;
    await executor.executeTalkTo('agent-a', 'agent-b', 'second', 'neutral');

    const lastTurn = conversations.conv.turns[conversations.conv.turns.length - 1]!;
    expect(lastTurn.tick).toBe(6000);
    const secondWrite = social.updates.filter(
      (u) => u.agentId === 'agent-a' && u.other === 'agent-b',
    )[1]!;
    expect(secondWrite.updates['lastInteraction']).toBe(6000);
  });
});

// ── AC-3 — every stamp site reads the provider, never Date.now() ─────────────

describe('AC-3: sentinel 424242 proves every stamp site uses the provider (R3)', () => {
  it('talk_to: openOrContribute turn tick and both lastInteraction writes carry the sentinel', async () => {
    const { executor, social, conversations } = makeExecutor({
      tickProvider: () => SENTINEL_TICK,
    });

    await executor.executeTalkTo('agent-a', 'agent-b', 'hello', 'neutral');

    const lastTurn = conversations.conv.turns[conversations.conv.turns.length - 1]!;
    expect(lastTurn.tick).toBe(SENTINEL_TICK);
    expect(stampOn(social, 'agent-a', 'agent-b')).toBe(SENTINEL_TICK);
    expect(stampOn(social, 'agent-b', 'agent-a')).toBe(SENTINEL_TICK);
  });

  it('the unresolvable-target refusal path passes the sentinel tick to openOrContribute', async () => {
    const conversations = makeConversationBridge();
    const social = makeSocialBridge(() => null); // nothing resolves
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: social,
      conversationBridge: conversations,
      tickProvider: () => SENTINEL_TICK,
    });

    await executor.executeTalkTo('agent-a', 'agent-nobody', 'hello', 'neutral');
    // The refusal still routes through the engine-side openOrContribute (the
    // present-agent data lives there) — with the LIVE tick, not Date.now().
    expect(conversations.requestedTicks).toContain(SENTINEL_TICK);
  });

  it('observe_agent stamps the sentinel', async () => {
    const { executor, social } = makeExecutor({ tickProvider: () => SENTINEL_TICK });
    await executor.executeObserveAgent('agent-a', 'agent-b');
    expect(stampOn(social, 'agent-a', 'agent-b')).toBe(SENTINEL_TICK);
  });

  it('help stamps the sentinel on BOTH relationship writes', async () => {
    const { executor, social } = makeExecutor({ tickProvider: () => SENTINEL_TICK });
    await executor.executeHelp('agent-a', 'agent-b');
    expect(stampOn(social, 'agent-a', 'agent-b')).toBe(SENTINEL_TICK);
    expect(stampOn(social, 'agent-b', 'agent-a')).toBe(SENTINEL_TICK);
  });

  it('ignore stamps the sentinel', async () => {
    const { executor, social } = makeExecutor({ tickProvider: () => SENTINEL_TICK });
    await executor.executeIgnore('agent-a', 'agent-b');
    expect(stampOn(social, 'agent-a', 'agent-b')).toBe(SENTINEL_TICK);
  });
});

// ── AC-5 (unit level) — freshness semantics in tick units ────────────────────

describe('AC-5 (unit): fresh vs stale discrimination in tick units (R5)', () => {
  const builder = new PerceptionBuilderImpl();

  function perceptionWithPending(ageTicks: number, currentTick: number): string {
    const pending: PendingAddressInfo = {
      conversationId: 'conv-900-1',
      fromAgentId: 'agent-a',
      content: 'Hello there!',
      lastTurnTick: currentTick - ageTicks,
      currentTick,
    };
    // The age must be non-negative — the epoch-ms bug produced ~−1.789e12.
    const age = pending.currentTick! - pending.lastTurnTick!;
    expect(age).toBe(ageTicks);
    expect(age).toBeGreaterThanOrEqual(0);

    return builder
      .build({
        passive: {
          roomId: 'garden',
          objectsPresent: [],
          drives: { energy: 50, hunger: 50, social: 60, comfort: 50, curiosity: 50 },
          agentsPresent: [
            { agentId: 'agent-a', name: 'Alice', currentActivity: 'idle', isThinking: false },
          ],
        },
        prunedAffordances: [],
        primaryDriveLabel: 'low energy',
        pendingAddresses: [pending],
      })
      .perceptionContext;
  }

  it('100 ticks old → fresh → FRESH:-promoted as the first dynamic line', () => {
    const context = perceptionWithPending(100, 2100);
    const dynamic = context.split('\n').slice(context.split('\n').indexOf('---') + 1);
    expect(dynamic[0]).toBe(
      'FRESH: INFORMATION: Alice addressed you, awaiting response: "Hello there!"',
    );
  });

  it('4000 ticks old → stale → renders WITHOUT promotion, age still non-negative', () => {
    const context = perceptionWithPending(SOCIAL_PENDING_FRESH_TICKS + 400, 6000);
    expect(context).not.toContain('FRESH:');
    expect(context).toContain(
      'INFORMATION: Alice addressed you, awaiting response: "Hello there!"',
    );
  });
});