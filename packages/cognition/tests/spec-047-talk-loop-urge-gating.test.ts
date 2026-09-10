/**
 * Tests for spec 047 — Talk Loop Fix: Urge-Gated Social Urgency & Asymmetric
 * Social Reward (issue #176) — cognition layer.
 *
 * Covers:
 * - AC-3 / AC-8 (R1, R2): with the urge toward ALL present agents reciprocity-
 *   decayed, the spec 024 "IMPORTANT: … Call talk_to …" directive is absent
 *   from the built context, the spec 018 social-drive hint is suppressed, the
 *   no-outlet line renders instead, and the spec 044 per-target "rarely
 *   answers" line still renders. Dynamic section only (KV-cache, spec 021).
 * - R1 backward compat: urges not computed (or not computed for every present
 *   agent) → the directive renders exactly as today.
 * - R3: the urge-driven `talk_to` promotion (spec 044 Decision 5) is a no-op
 *   when every present urge is decayed — even when a decayed urge numerically
 *   exceeds the surface threshold.
 * - AC-5 (R4): the consecutive-unanswered cap (SOCIAL_TALK_CAP = 3,
 *   sentCount − receivedCount ≥ cap) excludes a target from the promotion and
 *   from the "You feel like talking to" social-urgency hint, per-target; a
 *   fresh target with a healthy urge is still rankable.
 * - AC-4 (R5): a monologue grants exactly +2 own social (SOCIAL_MONOLOGUE_REWARD)
 *   — no full restore, and no cognition-side +8 even when a conversation
 *   bridge is wired (the deferred restore is engine-side, R6).
 */
import { describe, it, expect } from 'vitest';
import type {
  AgentSummary,
  ConversationBridge,
  ConversationObject,
  ConversationSentiment,
  ConversationActionResult,
  PassivePerception,
  PerceptionResult,
  SocialUrgeAssessment,
} from '@evol-hive/shared';
import {
  SOCIAL_MONOLOGUE_REWARD,
  SOCIAL_TALK_CAP,
  SOCIAL_URGE_SURFACE_THRESHOLD,
  computeSocialUrge,
} from '@evol-hive/shared';
import { CognitiveToolExecutorImpl } from '../src/tools/cognitive-tool-executor.js';
import type { CognitiveToolExecutorOptions } from '../src/tools/cognitive-tool-executor.js';
import {
  PerceptionBuilderImpl,
  allPresentUrgesDecayed,
  isSocialTalkCapped,
  isSocialUrgeDecayed,
  talkToPromotionRequested,
} from '../src/pper/perception-builder.js';

// ── Fixtures (mirroring the spec 044 cognition suite) ────────────────────────

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
function assessment(targetAgentId: string, input: Parameters<typeof computeSocialUrge>[0]) {
  return {
    targetAgentId,
    result: computeSocialUrge(input),
    sentCount: input.relationship?.sentCount ?? 0,
    receivedCount: input.relationship?.receivedCount ?? 0,
  } satisfies SocialUrgeAssessment;
}

const DIRECTIVE = 'IMPORTANT: Other agents are present.';
const SOCIAL_HINT = 'You feel a strong need for social interaction.';
const NO_OUTLET = 'No one in the room is responsive — consider another activity or help.';

/** Decayed urge (spec 044 fixture): reciprocity 0.36 < 0.7, sentCount > 0. */
function decayedIris() {
  return assessment('agent-iris', {
    personaSeed: 0.5,
    socialDrive: 80,
    relationship: { sentCount: 3, receivedCount: 0, trust: 50, familiarity: 0 },
  });
}

/** Fresh healthy urge: no counters, urge ≈ 0.855 ≥ threshold. */
function healthyMaren() {
  return assessment('agent-maren', {
    personaSeed: 0.9,
    socialDrive: 10,
    relationship: { trust: 50, familiarity: 0 },
  });
}

/** Decayed AND surfaced: reciprocity 0.54 < 0.7 yet urge ≈ 0.50 ≥ threshold. */
function decayedButSurfacedIris() {
  return assessment('agent-iris', {
    personaSeed: 0.9,
    socialDrive: 10,
    relationship: { sentCount: 2, receivedCount: 0, trust: 50, familiarity: 0 },
  });
}

/** Capped AND surfaced: unanswered = 4 − 1 = 3 ≥ cap, urge ≈ 0.52 ≥ threshold. */
function cappedSurfacedIris() {
  return assessment('agent-iris', {
    personaSeed: 0.9,
    socialDrive: 10,
    relationship: { sentCount: 4, receivedCount: 1, trust: 100, familiarity: 100 },
  });
}

// ── R1 — urge-gated urgency directive ────────────────────────────────────────

describe('urge-gated urgency directive (R1, AC-3, AC-8)', () => {
  const builder = new PerceptionBuilderImpl();

  it('all present urges decayed → the 024 directive is replaced by the no-outlet line', () => {
    const payload = builder.build(
      makePerceptionResult({ socialUrges: [decayedIris(), assessment('agent-maren', {
        personaSeed: 0.5,
        socialDrive: 80,
        relationship: { sentCount: 3, receivedCount: 0, trust: 50, familiarity: 0 },
      })] }),
    );
    const { stable, dynamic } = splitSections(payload.perceptionContext);
    expect(payload.perceptionContext).not.toContain(DIRECTIVE);
    expect(dynamic).toContain(NO_OUTLET);
    // KV-cache safety (spec 021): the swap lives in the dynamic section only.
    expect(stable).not.toContain(NO_OUTLET);
  });

  it('no urges computed (feature off) → the directive renders exactly as today', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).toContain(DIRECTIVE);
    expect(payload.perceptionContext).not.toContain(NO_OUTLET);
  });

  it('a healthy urge toward one present target (mixed room) keeps the directive', () => {
    const payload = builder.build(makePerceptionResult({ socialUrges: [decayedIris(), healthyMaren()] }));
    expect(payload.perceptionContext).toContain(DIRECTIVE);
    expect(payload.perceptionContext).not.toContain(NO_OUTLET);
  });

  it('urges computed for only SOME present agents → the directive still renders (parity gate)', () => {
    const payload = builder.build(makePerceptionResult({ socialUrges: [decayedIris()] }));
    expect(payload.perceptionContext).toContain(DIRECTIVE);
    expect(payload.perceptionContext).not.toContain(NO_OUTLET);
  });

  it('empty socialUrges with agents present → the directive still renders', () => {
    const payload = builder.build(makePerceptionResult({ socialUrges: [] }));
    expect(payload.perceptionContext).toContain(DIRECTIVE);
  });
});

// ── R2 — urge-gated social-drive hint ────────────────────────────────────────

describe('urge-gated social-drive hint (R2, AC-3, AC-8)', () => {
  const builder = new PerceptionBuilderImpl();

  it('all decayed → the 018 social hint is suppressed; the no-outlet line stands in', () => {
    const decayedMaren = assessment('agent-maren', {
      personaSeed: 0.5,
      socialDrive: 80,
      relationship: { sentCount: 3, receivedCount: 0, trust: 50, familiarity: 0 },
    });
    const payload = builder.build(makePerceptionResult({ socialUrges: [decayedIris(), decayedMaren] }));
    const { dynamic } = splitSections(payload.perceptionContext);
    expect(dynamic).not.toContain(SOCIAL_HINT);
    expect(dynamic).toContain(NO_OUTLET);
    // The spec 044 per-target decay hint still renders (R2).
    expect(payload.perceptionContext).toContain('Iris rarely answers');
    expect(payload.perceptionContext).toContain('Maren rarely answers');
  });

  it('no urges computed → the 018 social hint renders as today (backward compat)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).toContain(SOCIAL_HINT);
  });

  it('mixed room → the 018 social hint renders (gate is all-decayed)', () => {
    const payload = builder.build(makePerceptionResult({ socialUrges: [decayedIris(), healthyMaren()] }));
    expect(payload.perceptionContext).toContain(SOCIAL_HINT);
    expect(payload.perceptionContext).not.toContain(NO_OUTLET);
  });
});

// ── R3 — urge-gated talk_to ranking ──────────────────────────────────────────

describe('urge-gated talk_to ranking (R3)', () => {
  const builder = new PerceptionBuilderImpl();

  it('every present urge decayed → the promotion is suppressed even when an urge exceeds the threshold', () => {
    const decayedSurfaced = decayedButSurfacedIris();
    expect(decayedSurfaced.result.urge).toBeGreaterThanOrEqual(SOCIAL_URGE_SURFACE_THRESHOLD);
    expect(isSocialUrgeDecayed(decayedSurfaced)).toBe(true);
    expect(allPresentUrgesDecayed([IRIS], [decayedSurfaced])).toBe(true);
    // The urge layer does not request the promotion for an all-decayed room…
    expect(talkToPromotionRequested([decayedSurfaced])).toBe(true);
    // …but the builder gates it: the rendered order stays canonical.
    const payload = builder.build(makePerceptionResult({ socialUrges: [decayedSurfaced] }));
    const names = payload.tools.map((t) => t.function.name);
    // talk_to remains AVAILABLE (influence, not force) at its canonical spot.
    expect(names).toContain('talk_to');
    expect(names.slice(0, 4)).toEqual(['talk_to', 'observe_agent', 'help', 'ignore']);
  });

  it('healthy urge toward a present target → the promotion still fires (canonical first)', () => {
    const payload = builder.build(makePerceptionResult({ socialUrges: [healthyMaren()] }));
    expect(allPresentUrgesDecayed([IRIS, MAREN], [decayedIris(), healthyMaren()])).toBe(false);
    expect(payload.tools[0]!.function.name).toBe('talk_to');
  });
});

// ── R4 / AC-5 — consecutive-unanswered cap ───────────────────────────────────

describe('consecutive-unanswered cap in ranking (R4, AC-5)', () => {
  it('isSocialTalkCapped: sentCount − receivedCount ≥ SOCIAL_TALK_CAP, per target', () => {
    expect(SOCIAL_TALK_CAP).toBe(3);
    expect(isSocialTalkCapped({ ...cappedSurfacedIris() })).toBe(true);
    // Two unanswered → below the cap.
    const below = assessment('agent-iris', {
      personaSeed: 0.9,
      socialDrive: 10,
      relationship: { sentCount: 2, receivedCount: 0, trust: 50, familiarity: 0 },
    });
    expect(isSocialTalkCapped(below)).toBe(false);
    // Replies offset the cap: 4 sent, 2 received → unanswered 2 < 3.
    const offset = assessment('agent-iris', {
      personaSeed: 0.9,
      socialDrive: 10,
      relationship: { sentCount: 4, receivedCount: 2, trust: 100, familiarity: 100 },
    });
    expect(isSocialTalkCapped(offset)).toBe(false);
  });

  it('a capped target is excluded from the promotion even with a surfaced urge; a fresh target is still rankable', () => {
    const capped = cappedSurfacedIris();
    expect(capped.result.urge).toBeGreaterThanOrEqual(SOCIAL_URGE_SURFACE_THRESHOLD);
    expect(isSocialTalkCapped(capped)).toBe(true);
    // Capped alone → no promotion requested (the cap, not the urge, decides).
    expect(talkToPromotionRequested([capped])).toBe(false);
    // Fresh healthy target → promotion requested.
    expect(talkToPromotionRequested([capped, healthyMaren()])).toBe(true);
    expect(talkToPromotionRequested([healthyMaren()])).toBe(true);
    // Below-threshold urges never promote (spec 044 unchanged).
    expect(talkToPromotionRequested([decayedIris()])).toBe(false);
  });

  it('a capped surfaced target gets no "You feel like talking to" line; the fresh target does (per-target)', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(
      makePerceptionResult({ socialUrges: [cappedSurfacedIris(), healthyMaren()] }),
    );
    expect(payload.perceptionContext).toContain('You feel like talking to Maren.');
    expect(payload.perceptionContext).not.toContain('You feel like talking to Iris');
  });

  it('an uncapped surfaced target still gets the hint line (spec 044 unchanged)', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult({ socialUrges: [healthyMaren()] }));
    expect(payload.perceptionContext).toContain('You feel like talking to Maren.');
  });
});

// ── R5 / AC-4 — asymmetric social reward (monologue = +2) ────────────────────

describe('asymmetric social reward (R5, AC-4)', () => {
  function makeSocialBridge() {
    return {
      queueMessage: () => undefined,
      updateRelationship: () => undefined,
      getAgentSummary: () => ({
        agentId: 'agent-b',
        name: 'Bob',
        currentActivity: 'idle',
        isThinking: false,
      }),
      getAgentDrives: () => ({ social: 40 }),
    };
  }

  /** Conversation stub whose thread never contains a turn from the target. */
  function makeMonologueConversationBridge(): ConversationBridge {
    const conversation: ConversationObject = {
      id: 'conv-1',
      topic: 'a conversation',
      roomId: 'garden',
      status: 'open',
      participants: [
        {
          agentId: 'agent-a',
          joinedAtTick: 100,
          turnCount: 1,
          sentimentCounts: { positive: 0, neutral: 1, negative: 0 },
          role: 'initiator',
        },
        {
          agentId: 'agent-b',
          joinedAtTick: 100,
          turnCount: 0,
          sentimentCounts: { positive: 0, neutral: 0, negative: 0 },
          role: 'listener',
        },
      ],
      turns: [
        { agentId: 'agent-a', role: 'initiator', content: 'hello', sentiment: 'neutral', tick: 100 },
      ],
      openedAt: 100,
      lastActivity: 100,
    };
    return {
      openOrContribute: (): ConversationActionResult => ({
        success: true,
        conversationId: 'conv-1',
        conversation,
      }),
      join: () => ({ success: false, message: 'unused' }),
      leave: () => ({ success: false, message: 'unused' }),
      contribute: (
        _agentId: string,
        _conversationId: string,
        _content: string,
        _sentiment: ConversationSentiment,
        _tick: number,
      ): ConversationActionResult => ({ success: false, message: 'unused' }),
      observe: () => ({ success: false, message: 'unused' }),
      getOpenConversationBetween: () => null,
      getEligibleAffordances: () => [],
      getConversationsAwaitingAgentReply: () => [],
    };
  }

  it('a monologue grants exactly +2 own social (SOCIAL_MONOLOGUE_REWARD) — no full restore', async () => {
    const grants: Array<Record<string, number>> = [];
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: makeSocialBridge() as never,
      stateDataProvider: {
        updateGoal: () => undefined,
        applyDriveChanges: (_agentId, changes) => grants.push(changes),
      },
      conversationBridge: makeMonologueConversationBridge(),
      currentTick: 100,
    });
    const result = await executor.executeTalkTo('agent-a', 'agent-b', 'Morning!', 'neutral');
    expect(result.success).toBe(true);
    expect(grants).toEqual([{ social: SOCIAL_MONOLOGUE_REWARD }]);
    expect(grants).toEqual([{ social: 2 }]);
    expect(grants).not.toEqual([{ social: 10 }]);
  });

  it('the legacy path (no conversation bridge) also grants exactly +2 on send', async () => {
    const grants: Array<Record<string, number>> = [];
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: makeSocialBridge() as never,
      stateDataProvider: {
        updateGoal: () => undefined,
        applyDriveChanges: (_agentId, changes) => grants.push(changes),
      },
      currentTick: 100,
    });
    const result = await executor.executeTalkTo('agent-a', 'agent-b', 'hi', 'neutral');
    expect(result.success).toBe(true);
    expect(grants).toEqual([{ social: 2 }]);
  });

  it('the cognition side never grants the deferred +8 — even into an exchange thread (R6 engine-side)', async () => {
    const grants: Array<Record<string, number>> = [];
    const bridge = makeMonologueConversationBridge();
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: makeSocialBridge() as never,
      stateDataProvider: {
        updateGoal: () => undefined,
        applyDriveChanges: (_agentId, changes) => grants.push(changes),
      },
      conversationBridge: bridge,
      currentTick: 101,
    });
    await executor.executeTalkTo('agent-a', 'agent-b', 'again', 'neutral');
    // Exactly one grant per send, and it is the monologue token — the +8
    // arrives (once per sender/thread) from the engine-side completion hook.
    expect(grants).toEqual([{ social: 2 }]);
  });
});