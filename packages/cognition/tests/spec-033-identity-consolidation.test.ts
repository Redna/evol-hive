/**
 * Tests for spec 033 — Session-end identity consolidation (issue #128) —
 * cognition layer.
 *
 * Covers:
 * - AC-11 (R13, R15): the consolidation pass consumes the session's memories
 *   AND conversation threads (sentiment aggregates + derived roles) and emits
 *   bounded, audited identity deltas via the self-model bridge.
 * - AC-8 (R13): bounded — the LLM may propose many deltas but at most
 *   max-N per session are applied; rate-limited across consolidation calls.
 * - AC-14: the LLM is behind an injected provider interface — no LLM on any
 *   deterministic path; the service is deterministic given the provider.
 */
import { describe, it, expect } from 'vitest';
import type { SelfModelBridge, IdentityChangeDelta, MemorySnippet } from '@evol-hive/shared';
import {
  IdentityConsolidationServiceImpl,
  type IdentityProposalProvider,
  type ConversationThreadSummary,
} from '../src/identity/identity-consolidation.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MEMORIES: MemorySnippet[] = [
  { id: 'm1', content: 'Talked with Bob about roses; he was rude.', importance: 7, timestamp: 10 },
  { id: 'm2', content: 'Learned to propagate cuttings.', importance: 6, timestamp: 20 },
];

const THREAD: ConversationThreadSummary = {
  conversationId: 'conv-1',
  topic: 'roses',
  turnCount: 4,
  myRole: 'initiator',
  participants: [
    {
      agentId: 'agent-b',
      role: 'active contributor',
      sentiment: { positive: 1, neutral: 0, negative: 2 },
    },
  ],
  dominantSentiment: 'negative',
};

function makeBridge() {
  const applied: Array<{ agentId: string; deltas: IdentityChangeDelta[] }> = [];
  const impl: SelfModelBridge & { applied: typeof applied } = {
    applied,
    getSelfModel: () => null,
    applySelfModelDeltas(agentId: string, deltas: IdentityChangeDelta[]) {
      applied.push({ agentId, deltas });
      return {
        success: true,
        applied: deltas.length,
        rejected: 0,
        message: `Applied ${deltas.length}.`,
      };
    },
    getIdentityAuditLog: () => [],
  };
  return impl;
}

/** LLM provider double proposing a configurable number of deltas. */
function makeProvider(deltas: IdentityChangeDelta[]): IdentityProposalProvider {
  return {
    async proposeIdentityDeltas() {
      return { deltas };
    },
  };
}

const TRAIT_DELTAS: IdentityChangeDelta[] = [
  { type: 'trait_add', value: 'guarded', reason: 'Bob was hostile' },
  { type: 'trait_add', value: 'resilient' },
  { type: 'trait_add', value: 'observant' },
  { type: 'trait_add', value: 'fourth' },
  { type: 'trait_add', value: 'fifth' },
];

// ── AC-11 — consolidation consumes memories + conversation threads ──────────

describe('session-end identity consolidation (AC-11, R13/R15)', () => {
  it('feeds session memories and conversation sentiment/roles to the LLM provider', async () => {
    let received: { memories: MemorySnippet[]; threads: ConversationThreadSummary[] } | null = null;
    const provider: IdentityProposalProvider = {
      async proposeIdentityDeltas(context) {
        received = context;
        return { deltas: [] };
      },
    };
    const service = new IdentityConsolidationServiceImpl({
      selfModelBridge: makeBridge(),
      provider,
    });
    await service.consolidate('agent-a', MEMORIES, [THREAD]);
    expect(received).not.toBeNull();
    expect(received!.memories.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(received!.threads[0]!.topic).toBe('roses');
    expect(received!.threads[0]!.participants[0]!.sentiment.negative).toBe(2);
    expect(received!.threads[0]!.myRole).toBe('initiator');
  });

  it('applies LLM-proposed deltas through the audited self-model bridge', async () => {
    const bridge = makeBridge();
    const service = new IdentityConsolidationServiceImpl({
      selfModelBridge: bridge,
      provider: makeProvider(TRAIT_DELTAS),
      config: { maxDeltasPerSession: 10, maxConsolidationsPerSession: 3 },
    });
    const result = await service.consolidate('agent-a', MEMORIES, [THREAD]);
    expect(result.success).toBe(true);
    expect(bridge.applied).toHaveLength(1);
    expect(bridge.applied[0]!.deltas).toHaveLength(5);
  });
});

// ── AC-8 — bounded + rate-limited ───────────────────────────────────────────

describe('bounding (AC-8, R13)', () => {
  it('clamps the applied deltas to maxDeltasPerSession across calls', async () => {
    const bridge = makeBridge();
    const service = new IdentityConsolidationServiceImpl({
      selfModelBridge: bridge,
      provider: makeProvider(TRAIT_DELTAS), // 5 deltas per proposal
      config: { maxDeltasPerSession: 7, maxConsolidationsPerSession: 5 },
    });
    const first = await service.consolidate('agent-a', MEMORIES, [THREAD]);
    expect(first.applied).toBe(5); // 5 ≤ 7 budget → all applied
    const second = await service.consolidate('agent-a', MEMORIES, [THREAD]);
    expect(second.applied).toBe(2); // only 2 of the 7-delta budget remain
    const total = bridge.applied.reduce((n, call) => n + call.deltas.length, 0);
    expect(total).toBe(7);
  });

  it('is rate-limited: maxConsolidationsPerSession caps the number of LLM passes', async () => {
    const bridge = makeBridge();
    let proposals = 0;
    const provider: IdentityProposalProvider = {
      async proposeIdentityDeltas() {
        proposals += 1;
        return { deltas: [{ type: 'trait_add', value: `t${proposals}` }] };
      },
    };
    const service = new IdentityConsolidationServiceImpl({
      selfModelBridge: bridge,
      provider,
      config: { maxDeltasPerSession: 10, maxConsolidationsPerSession: 2 },
    });
    await service.consolidate('agent-a', MEMORIES, [THREAD]);
    await service.consolidate('agent-a', MEMORIES, [THREAD]);
    const third = await service.consolidate('agent-a', MEMORIES, [THREAD]);
    expect(third.success).toBe(false);
    expect(proposals).toBe(2);
  });

  it('per-session budgets are per-agent', async () => {
    const bridge = makeBridge();
    const service = new IdentityConsolidationServiceImpl({
      selfModelBridge: bridge,
      provider: makeProvider([{ type: 'trait_add', value: 'x' }]),
      config: { maxDeltasPerSession: 10, maxConsolidationsPerSession: 1 },
    });
    await service.consolidate('agent-a', MEMORIES, [THREAD]);
    const otherAgent = await service.consolidate('agent-b', MEMORIES, [THREAD]);
    expect(otherAgent.success).toBe(true); // agent-b has its own budget
  });

  it('never applies deltas when the provider proposes none (no-op path)', async () => {
    const bridge = makeBridge();
    const service = new IdentityConsolidationServiceImpl({
      selfModelBridge: bridge,
      provider: makeProvider([]),
      config: { maxDeltasPerSession: 10, maxConsolidationsPerSession: 3 },
    });
    const result = await service.consolidate('agent-a', MEMORIES, [THREAD]);
    expect(result.success).toBe(true);
    expect(result.applied).toBe(0);
    expect(bridge.applied).toHaveLength(0);
  });
});
