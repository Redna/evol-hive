/**
 * Tests for spec 044 — Social Urge Model (issue #160) — cognition layer.
 *
 * Covers:
 * - AC-7 (R2): executing `talk_to` (A→B) increments A's `sentCount` toward B
 *   and B's `receivedCount` toward A exactly once per exchange, alongside the
 *   existing trust/familiarity delta.
 * - AC-3 (R4a): with a pending-address item on the perception result, the
 *   built payload contains the pending-address line quoting the actual
 *   message text — dynamic section only.
 * - AC-8 (R3, R4b): a high urge toward a present agent renders the
 *   "you feel like talking to <name>" line in the dynamic section; a decayed
 *   urge renders the "rarely answers" line instead.
 * - AC-9 (R4c, Decision 5): with urge above the surface threshold toward a
 *   present agent, `talk_to` appears first in the rendered tool list; below
 *   the threshold the canonical order is unchanged.
 * - R5: none of this enqueues or forces anything — pure payload shaping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type {
  Affordance,
  AgentSummary,
  ConversationBridge,
  ConversationObject,
  PassivePerception,
  PerceptionResult,
  Relationship,
} from '@evol-hive/shared';
import { SOCIAL_URGE_SURFACE_THRESHOLD, computeSocialUrge } from '@evol-hive/shared';
import { CognitiveToolExecutorImpl } from '../src/tools/cognitive-tool-executor.js';
import type { CognitiveToolExecutorOptions } from '../src/tools/cognitive-tool-executor.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { PerceptionServiceImpl } from '../src/pper/index.js';
import type { PerceptionDataProvider } from '@evol-hive/shared';
import type { AffordanceClassifier } from '../src/classifier/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** SocialActionBridge double that records relationship updates. */
function makeSocialBridge() {
  const updates: Array<{ agentId: string; other: string; updates: Record<string, unknown> }> = [];
  return {
    updates,
    queueMessage: () => undefined,
    updateRelationship(agentId: string, other: string, updates: Record<string, unknown>) {
      this.updates.push({ agentId, other, updates });
    },
    getAgentSummary: () => ({
      agentId: 'agent-b',
      name: 'Bob',
      currentActivity: 'idle',
      isThinking: false,
    }),
    getAgentDrives: () => ({ social: 40 }),
  };
}

function makeExecutor(overrides: Partial<CognitiveToolExecutorOptions> = {}) {
  const social = makeSocialBridge();
  const executor = new CognitiveToolExecutorImpl({
    socialBridge: social as never,
    currentTick: 100,
    ...overrides,
  });
  return { executor, social };
}

function makeAgentSummary(agentId: string, name: string): AgentSummary {
  return { agentId, name, currentActivity: 'idle', isThinking: false };
}

const IRIS = makeAgentSummary('agent-iris', 'Iris');
const MAREN = makeAgentSummary('agent-maren', 'Maren');

function makePerceptionResult(overrides: Partial<PerceptionResult> = {}): PerceptionResult {
  const passive: PassivePerception = {
    roomId: 'garden',
    objectsPresent: [],
    drives: { energy: 50, hunger: 50, social: 60, comfort: 50, curiosity: 50 },
    agentsPresent: [IRIS, MAREN],
  };
  return {
    passive,
    prunedAffordances: [],
    primaryDriveLabel: 'low social, need to restore social',
    ...overrides,
  };
}

/** Split a perceptionContext at the `---` separator into [stable, dynamic]. */
function splitSections(context: string): { stable: string; dynamic: string } {
  const lines = context.split('\n');
  const sep = lines.indexOf('---');
  expect(sep, 'perceptionContext must contain a --- separator line').toBeGreaterThan(-1);
  return { stable: lines.slice(0, sep).join('\n'), dynamic: lines.slice(sep + 1).join('\n') };
}

/** Build a SocialUrgeAssessment-shaped entry via the real pure computation. */
function assessment(
  targetAgentId: string,
  input: Parameters<typeof computeSocialUrge>[0],
): {
  targetAgentId: string;
  result: ReturnType<typeof computeSocialUrge>;
  sentCount: number;
  receivedCount: number;
} {
  return {
    targetAgentId,
    result: computeSocialUrge(input),
    sentCount: input.relationship?.sentCount ?? 0,
    receivedCount: input.relationship?.receivedCount ?? 0,
  };
}

// ── AC-7 — executeTalkTo counter increments (R2) ─────────────────────────────

describe('executeTalkTo reciprocity counters (AC-7, R2)', () => {
  it('A→B increments A sentCount toward B and B receivedCount toward A exactly once', async () => {
    const { executor, social } = makeExecutor();
    const result = await executor.executeTalkTo('agent-a', 'agent-b', 'hello', 'neutral');
    expect(result.success).toBe(true);

    const aToB = social.updates.find((u) => u.agentId === 'agent-a' && u.other === 'agent-b')!;
    expect(aToB).toBeDefined();
    expect(aToB.updates['sentCount']).toBe(1);
    expect(aToB.updates['receivedCount']).toBeUndefined();

    const bFromA = social.updates.find((u) => u.agentId === 'agent-b' && u.other === 'agent-a')!;
    expect(bFromA).toBeDefined();
    expect(bFromA.updates['receivedCount']).toBe(1);
    expect(bFromA.updates['sentCount']).toBeUndefined();
  });

  it('counters ride the SAME update as the trust/familiarity delta (one update per side)', async () => {
    const { executor, social } = makeExecutor();
    await executor.executeTalkTo('agent-a', 'agent-b', 'hello', 'neutral');
    const aToB = social.updates.find((u) => u.agentId === 'agent-a' && u.other === 'agent-b')!;
    expect(aToB.updates['trust']).toBe(2); // neutral exchange → existing deltas
    expect(aToB.updates['familiarity']).toBe(5);
    expect(aToB.updates['lastInteraction']).toBe(100);
    expect(aToB.updates['sentCount']).toBe(1);
    // Exactly one update per side per exchange.
    expect(social.updates).toHaveLength(2);
  });

  it('legacy path (no conversation bridge) still increments the counters', async () => {
    const { executor, social } = makeExecutor();
    const result = await executor.executeTalkTo('agent-a', 'agent-b', 'hi', 'neutral');
    expect(result.success).toBe(true);
    const aToB = social.updates.find((u) => u.agentId === 'agent-a' && u.other === 'agent-b')!;
    expect(aToB.updates['sentCount']).toBe(1);
    const bFromA = social.updates.find((u) => u.agentId === 'agent-b' && u.other === 'agent-a')!;
    expect(bFromA.updates['receivedCount']).toBe(1);
  });
});

// ── AC-3 — pending-address line rendering (R4a) ──────────────────────────────

describe('pending-address perception line (AC-3, R4a)', () => {
  const builder = new PerceptionBuilderImpl();

  it('renders the INFORMATION line quoting the actual message, in the dynamic section', () => {
    const payload = builder.build(
      makePerceptionResult({
        pendingAddresses: [
          { conversationId: 'conv-1', fromAgentId: 'agent-iris', content: 'Hello there, B!' },
        ],
      }),
    );
    const { stable, dynamic } = splitSections(payload.perceptionContext);
    expect(payload.perceptionContext).toContain(
      'Iris addressed you, awaiting response: "Hello there, B!"',
    );
    expect(dynamic).toContain('Iris addressed you, awaiting response: "Hello there, B!"');
    expect(stable).not.toContain('addressed you');
  });

  it('falls back to the raw agent id when the addressee is not co-present', () => {
    const payload = builder.build(
      makePerceptionResult({
        pendingAddresses: [
          { conversationId: 'conv-1', fromAgentId: 'agent-ghost', content: 'anyone there?' },
        ],
      }),
    );
    expect(payload.perceptionContext).toContain(
      'agent-ghost addressed you, awaiting response: "anyone there?"',
    );
  });

  it('no pendingAddresses field → no pending-address line (backward compat)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).not.toContain('awaiting response');
  });
});

// ── AC-8 — urge hint lines (R3, R4b) ─────────────────────────────────────────

describe('urge hint lines (AC-8, R4b)', () => {
  const builder = new PerceptionBuilderImpl();

  it('a high urge toward a present agent renders "You feel like talking to <name>."', () => {
    const high = assessment('agent-iris', {
      personaSeed: 0.9,
      socialDrive: 10,
      relationship: { trust: 50, familiarity: 0 },
    });
    expect(high.result.urge).toBeGreaterThanOrEqual(SOCIAL_URGE_SURFACE_THRESHOLD);
    const payload = builder.build(makePerceptionResult({ socialUrges: [high] }));
    const { stable, dynamic } = splitSections(payload.perceptionContext);
    expect(payload.perceptionContext).toContain('You feel like talking to Iris.');
    expect(dynamic).toContain('You feel like talking to Iris.');
    expect(stable).not.toContain('You feel like talking to');
  });

  it('a decayed urge renders the "rarely answers" line instead', () => {
    const decayed = assessment('agent-maren', {
      personaSeed: 0.5,
      socialDrive: 80,
      relationship: { sentCount: 3, receivedCount: 0, trust: 50, familiarity: 0 },
    });
    expect(decayed.result.urge).toBeLessThan(SOCIAL_URGE_SURFACE_THRESHOLD);
    expect(decayed.result.factors.reciprocityFactor).toBeLessThan(0.7);
    const payload = builder.build(makePerceptionResult({ socialUrges: [decayed] }));
    expect(payload.perceptionContext).toContain('Maren rarely answers');
    expect(payload.perceptionContext).not.toContain('You feel like talking to Maren');
  });

  it('no urge data → no urge lines (backward compat)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).not.toContain('You feel like talking to');
    expect(payload.perceptionContext).not.toContain('rarely answers');
  });

  it('mixed urges render one line per present agent, in assessment order', () => {
    const high = assessment('agent-iris', {
      personaSeed: 0.9,
      socialDrive: 10,
      relationship: { trust: 50, familiarity: 0 },
    });
    const decayed = assessment('agent-maren', {
      personaSeed: 0.5,
      socialDrive: 80,
      relationship: { sentCount: 3, receivedCount: 0, trust: 50, familiarity: 0 },
    });
    const payload = builder.build(makePerceptionResult({ socialUrges: [high, decayed] }));
    const dynamic = splitSections(payload.perceptionContext).dynamic;
    const irisLine = dynamic.indexOf('You feel like talking to Iris.');
    const marenLine = dynamic.indexOf('Maren rarely answers');
    expect(irisLine).toBeGreaterThan(-1);
    expect(marenLine).toBeGreaterThan(-1);
    expect(irisLine).toBeLessThan(marenLine);
  });
});

// ── AC-9 — talk_to ranking shift (R4c, Decision 5) ───────────────────────────

describe('talk_to ranking shift (AC-9, R4c)', () => {
  const builder = new PerceptionBuilderImpl();

  it('with urge above the threshold, talk_to is first in the rendered tool list', () => {
    const high = assessment('agent-iris', {
      personaSeed: 0.9,
      socialDrive: 10,
      relationship: { trust: 50, familiarity: 0 },
    });
    const payload = builder.build(makePerceptionResult({ socialUrges: [high] }));
    expect(payload.tools[0]!.function.name).toBe('talk_to');
    // The social block order itself is unchanged (stable otherwise).
    const names = payload.tools.map((t) => t.function.name);
    expect(names.slice(0, 4)).toEqual(['talk_to', 'observe_agent', 'help', 'ignore']);
  });

  it('below the threshold the canonical tool order is unchanged', () => {
    const low = assessment('agent-iris', {
      personaSeed: 0.1,
      socialDrive: 100,
      relationship: { trust: 50, familiarity: 0 },
    });
    expect(low.result.urge).toBeLessThan(SOCIAL_URGE_SURFACE_THRESHOLD);
    const payload = builder.build(makePerceptionResult({ socialUrges: [low] }));
    const names = payload.tools.map((t) => t.function.name);
    // Spec 024 canonical order: social tools first, talk_to first among them.
    expect(names.slice(0, 4)).toEqual(['talk_to', 'observe_agent', 'help', 'ignore']);
  });

  it('the shift also applies on the masked (no-plan) path', () => {
    const high = assessment('agent-iris', {
      personaSeed: 0.9,
      socialDrive: 10,
      relationship: { trust: 50, familiarity: 0 },
    });
    const affordances: Affordance[] = [
      {
        id: 'sit_outside',
        label: 'Sit',
        engineEffect: 'sit_outside',
        preconditions: [],
        effects: {},
      },
    ];
    const payload = builder.build(
      makePerceptionResult({ socialUrges: [high], maskedAffordances: affordances }),
      { hasPlan: false, maskingEnabled: true },
    );
    expect(payload.tools[0]!.function.name).toBe('talk_to');
  });
});

// ── PerceptionServiceImpl — urge + pending-address population ────────────────

describe('PerceptionServiceImpl — urge population (R3/R4 wiring)', () => {
  const STUB_AFFORDANCES: Affordance[] = [];
  const stubClassifier: AffordanceClassifier = {
    prune: async () => STUB_AFFORDANCES,
  };

  function makeProvider(overrides: Partial<PerceptionDataProvider> = {}): PerceptionDataProvider {
    const relationships: Record<string, Relationship> = {
      'agent-iris': { trust: 50, familiarity: 0, lastInteraction: 0 },
      'agent-maren': {
        trust: 50,
        familiarity: 0,
        lastInteraction: 0,
        sentCount: 3,
        receivedCount: 0,
      },
    };
    return {
      getAgentLocation: () => 'garden',
      getObjectsInRoom: () => [],
      getAffordancesInRoom: () => STUB_AFFORDANCES,
      getAgentDrives: () => ({ energy: 50, hunger: 50, social: 30, comfort: 50, curiosity: 50 }),
      getPrimaryDriveLabel: () => 'low social, need to restore social',
      getSystemFeedback: () => undefined,
      getAgentProfile: (agentId) =>
        agentId === 'agent-self'
          ? {
              id: 'agent-self',
              name: 'Self',
              description: '',
              traits: ['energetic'],
              initialDrives: {},
            }
          : null,
      getAgentsInRoom: () => [IRIS, MAREN],
      getRelationships: () => relationships,
      ...overrides,
    } as PerceptionDataProvider;
  }

  function makeService(provider: PerceptionDataProvider): PerceptionServiceImpl {
    return new PerceptionServiceImpl({ provider, classifier: stubClassifier });
  }

  it('populates socialUrges for every present agent, differentiating by relationship', async () => {
    const service = makeService(makeProvider());
    const result = await service.perceive('agent-self');
    expect(result.socialUrges).toHaveLength(2);
    const iris = result.socialUrges!.find((u) => u.targetAgentId === 'agent-iris')!;
    const maren = result.socialUrges!.find((u) => u.targetAgentId === 'agent-maren')!;
    // Iris: no counters → neutral reciprocity; Maren: 3 unreplied → decayed.
    expect(maren.result.factors.reciprocityFactor).toBeLessThan(
      iris.result.factors.reciprocityFactor,
    );
  });

  it('populates pendingAddresses from the provider bridge query', async () => {
    const provider = makeProvider({
      getConversationsAwaitingAgentReply: () => [
        {
          id: 'conv-9',
          topic: 'chat',
          roomId: 'garden',
          status: 'active',
          participants: [],
          turns: [
            {
              agentId: 'agent-iris',
              role: 'initiator',
              content: 'the actual message',
              sentiment: 'neutral',
              tick: 3,
            },
          ],
          openedAt: 3,
          lastActivity: 3,
        } as ConversationObject,
      ],
    });
    const service = makeService(provider);
    const result = await service.perceive('agent-self');
    expect(result.pendingAddresses).toHaveLength(1);
    expect(result.pendingAddresses![0]).toEqual({
      conversationId: 'conv-9',
      fromAgentId: 'agent-iris',
      content: 'the actual message',
    });
  });

  it('omits both fields when the provider lacks the optional methods (legacy providers)', async () => {
    const service = makeService(makeProvider());
    const result = await service.perceive('agent-self');
    // makeProvider has no getConversationsAwaitingAgentReply → undefined.
    expect(result.pendingAddresses).toBeUndefined();
  });

  it('a provider with agents present but no relationships still yields neutral urge assessments', async () => {
    const provider = makeProvider({ getRelationships: () => ({}) });
    const service = makeService(provider);
    const result = await service.perceive('agent-self');
    expect(result.socialUrges).toHaveLength(2);
    for (const urge of result.socialUrges!) {
      expect(urge.result.factors.reciprocityFactor).toBe(1);
    }
  });
});
