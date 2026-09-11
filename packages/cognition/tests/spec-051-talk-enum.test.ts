/**
 * Tests for spec 051 — Enum-Bound Conversation Targeting (issue #186) —
 * cognition layer.
 *
 * Covers:
 * - AC-2 (R1): with agents present, the perception-builder's tool list
 *   contains `talk_to` with the per-cycle enum of present, uncapped agent IDs;
 *   no free-form target description remains. Same for the plan-phase tool
 *   list (plan-builder).
 * - AC-3 (R2): a target with `sentCount − receivedCount ≥ SOCIAL_TALK_CAP` is
 *   absent from the enum while another present target with a healthy gap
 *   remains (per-target exclusion; fixtures extend the spec 047 suite).
 * - AC-4 (R1/R2): when no agents are present, or every present agent is past
 *   the cap, `talk_to` is absent from the perceive/action-choice and plan tool
 *   arrays — no crash, other social tools render.
 * - AC-5 (R2): after the target replies (`receivedCount` incremented so the
 *   gap < cap), the target re-enters the enum on the next cycle.
 * - AC-6 (R3): `executeTalkTo` with a resolved target outside
 *   `enumerateTalkTargets` returns the structured failure naming the cap and
 *   writes NOTHING (queue, conversation, relationships, counters).
 * - AC-7 (R3): a bridge without `enumerateTalkTargets` preserves spec 046
 *   behavior exactly (backward-compat `typeof` guard).
 * - AC-8 (R4): the `[talk-enum]` diagnostic renders present / valid / excluded
 *   counts per cycle; the spec 049 `[social-urge]` diagnostic is untouched.
 *
 * Deterministic throughout — no LLM anywhere.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentSummary,
  ConversationActionResult,
  ConversationBridge,
  ConversationObject,
  ConversationSentiment,
  PassivePerception,
  PerceptionResult,
  Relationship,
  SocialActionBridge,
  SocialMessage,
  SocialUrgeAssessment,
  ToolDefinition,
} from '@evol-hive/shared';
import { computeSocialUrge } from '@evol-hive/shared';
import { CognitiveToolExecutorImpl } from '../src/tools/cognitive-tool-executor.js';
import { PerceptionBuilderImpl, classifySocialUrgeLine } from '../src/pper/perception-builder.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { computeTalkEnum, logTalkEnumDiagnostic } from '../src/pper/talk-enum.js';

// ── Fixtures (extending the spec 047 suite) ──────────────────────────────────

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

/** Build a SocialUrgeAssessment-shaped entry via the real pure computation. */
function assessment(targetAgentId: string, input: Parameters<typeof computeSocialUrge>[0]) {
  return {
    targetAgentId,
    result: computeSocialUrge(input),
    sentCount: input.relationship?.sentCount ?? 0,
    receivedCount: input.relationship?.receivedCount ?? 0,
  } satisfies SocialUrgeAssessment;
}

/** Capped fixture (spec 047 pattern): unanswered = 3 − 0 = 3 ≥ cap. */
function cappedIris() {
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

/** Recovered fixture: the target replied — unanswered = 3 − 3 = 0 < cap. */
function recoveredIris() {
  return assessment('agent-iris', {
    personaSeed: 0.9,
    socialDrive: 10,
    relationship: { sentCount: 3, receivedCount: 3, trust: 50, familiarity: 0 },
  });
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition | undefined {
  return tools.find((t) => t.function.name === name);
}

// ── computeTalkEnum (R2 — the pure per-cycle enum builder) ───────────────────

describe('computeTalkEnum (R2)', () => {
  it('no urge assessments (feature off) → every present agent is a valid target', () => {
    const outcome = computeTalkEnum([IRIS, MAREN], undefined);
    expect(outcome.valid).toEqual(['agent-iris', 'agent-maren']);
    expect(outcome.excluded).toEqual([]);
  });

  it('a capped target is excluded; a healthy target remains (per-target)', () => {
    const outcome = computeTalkEnum([IRIS, MAREN], [cappedIris(), healthyMaren()]);
    expect(outcome.present).toEqual(['agent-iris', 'agent-maren']);
    expect(outcome.valid).toEqual(['agent-maren']);
    expect(outcome.excluded).toEqual(['agent-iris']);
  });

  it('every present agent capped → valid is empty (the tool must not be offered)', () => {
    const cappedMaren = assessment('agent-maren', {
      personaSeed: 0.5,
      socialDrive: 80,
      relationship: { sentCount: 5, receivedCount: 0, trust: 50, familiarity: 0 },
    });
    const outcome = computeTalkEnum([IRIS, MAREN], [cappedIris(), cappedMaren]);
    expect(outcome.valid).toEqual([]);
    expect(outcome.excluded).toEqual(['agent-iris', 'agent-maren']);
  });

  it('no agents present → empty outcome, no crash', () => {
    const outcome = computeTalkEnum(undefined, [cappedIris()]);
    expect(outcome.present).toEqual([]);
    expect(outcome.valid).toEqual([]);
    expect(outcome.excluded).toEqual([]);
  });

  it('a present agent without an assessment is included (partial coverage → fail open)', () => {
    const outcome = computeTalkEnum([IRIS, MAREN], [cappedIris()]);
    expect(outcome.valid).toEqual(['agent-maren']);
    expect(outcome.excluded).toEqual(['agent-iris']);
  });

  it('a target whose replies offset the gap below the cap is valid (AC-5 recovery)', () => {
    const outcome = computeTalkEnum([IRIS, MAREN], [recoveredIris(), healthyMaren()]);
    expect(outcome.valid).toEqual(['agent-iris', 'agent-maren']);
    expect(outcome.excluded).toEqual([]);
  });

  it('excludes by the cap condition regardless of the urge VALUE (mechanical, not attentional)', () => {
    // A capped target with a LOW urge is still excluded — the cap is the
    // value-space condition, not a rendering condition (the `capped`
    // classification only fires for surfaced urges, but the exclusion here is
    // the raw gap).
    const cappedLowUrge = assessment('agent-iris', {
      personaSeed: 0.1,
      socialDrive: 90,
      relationship: { sentCount: 4, receivedCount: 0, trust: 50, familiarity: 0 },
    });
    expect(cappedLowUrge.result.urge).toBeLessThan(0.45);
    expect(classifySocialUrgeLine(cappedLowUrge)).not.toBe('capped');
    const outcome = computeTalkEnum([IRIS], [cappedLowUrge]);
    expect(outcome.valid).toEqual([]);
    expect(outcome.excluded).toEqual(['agent-iris']);
  });
});

// ── AC-2 (R1): perception-builder tool list carries the per-cycle enum ───────

describe('perception-builder enum-bound talk_to (R1, AC-2)', () => {
  const builder = new PerceptionBuilderImpl();

  it('talk_to targetAgentId enum lists the present agent IDs (no free-form target)', () => {
    const payload = builder.build(makePerceptionResult());
    const talkTo = toolByName(payload.tools, 'talk_to');
    expect(talkTo).toBeDefined();
    const target = talkTo!.function.parameters.properties.targetAgentId;
    expect(target.enum).toEqual(['agent-iris', 'agent-maren']);
    expect(target.description).toBe(
      'an agent ID from the enum (agents present right now, not past the unanswered cap)',
    );
    // No free-form resolution language remains on the enum-bound property.
    expect(target.description).not.toContain('display name');
  });

  it('message and sentiment keep their pre-051 shape', () => {
    const payload = builder.build(makePerceptionResult());
    const talkTo = toolByName(payload.tools, 'talk_to')!;
    expect(talkTo.function.parameters.properties.sentiment).toEqual({
      type: 'string',
      enum: ['positive', 'neutral', 'negative'],
      description: expect.any(String),
    });
    expect(talkTo.function.parameters.required).toEqual(['targetAgentId', 'message']);
  });

  it('the KV-cache discipline: the enum lives in the per-cycle tool definition, not the system prompt', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.systemPrompt).not.toContain('agent-iris');
    expect(payload.systemPrompt).not.toContain('enum');
  });
});

describe('plan-builder enum-bound talk_to (R1, AC-2)', () => {
  const builder = new PlanBuilderImpl();

  it('plan-phase talk_to carries the per-cycle enum of present agent IDs', () => {
    const payload = builder.build(makePerceptionResult());
    const talkTo = toolByName(payload.tools, 'talk_to');
    expect(talkTo).toBeDefined();
    const target = talkTo!.function.parameters.properties.targetAgentId;
    expect(target.enum).toEqual(['agent-iris', 'agent-maren']);
  });

  it('a capped target is excluded from the plan-phase enum too (per-target)', () => {
    const payload = builder.build(
      makePerceptionResult({ socialUrges: [cappedIris(), healthyMaren()] }),
    );
    const talkTo = toolByName(payload.tools, 'talk_to')!;
    expect(talkTo.function.parameters.properties.targetAgentId.enum).toEqual(['agent-maren']);
  });
});

// ── AC-3 (R2): capped target excluded, healthy target remains ────────────────

describe('the spec 047 cap participates in enum construction (R2, AC-3)', () => {
  const builder = new PerceptionBuilderImpl();

  it('capped Iris absent from the enum; healthy Maren remains; siblings unaffected', () => {
    const payload = builder.build(
      makePerceptionResult({ socialUrges: [cappedIris(), healthyMaren()] }),
    );
    const talkTo = toolByName(payload.tools, 'talk_to');
    expect(talkTo!.function.parameters.properties.targetAgentId.enum).toEqual(['agent-maren']);
    // The other social tools still list every present agent (their schemas
    // are unchanged — only talk_to is enum-bound).
    const names = payload.tools.map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['observe_agent', 'help', 'ignore', 'talk_to']));
  });

  it('the exclusion is per-target: a fresh target survives while the capped one is removed', () => {
    const healthyIris = assessment('agent-iris', {
      personaSeed: 0.9,
      socialDrive: 10,
      relationship: { trust: 50, familiarity: 0 },
    });
    const cappedMaren = assessment('agent-maren', {
      personaSeed: 0.5,
      socialDrive: 80,
      relationship: { sentCount: 3, receivedCount: 0, trust: 50, familiarity: 0 },
    });
    const payload = builder.build(
      makePerceptionResult({ socialUrges: [healthyIris, cappedMaren] }),
    );
    const talkTo = toolByName(payload.tools, 'talk_to')!;
    expect(talkTo.function.parameters.properties.targetAgentId.enum).toEqual(['agent-iris']);
  });
});

// ── AC-4 (R1/R2): talk_to absent when nothing is valid; siblings render ──────

describe('talk_to omitted when no valid target exists (R1/R2, AC-4)', () => {
  const perceptionBuilder = new PerceptionBuilderImpl();
  const planBuilder = new PlanBuilderImpl();

  it('no agents present → no talk_to in the perception tools (no crash)', () => {
    const payload = perceptionBuilder.build(
      makePerceptionResult({
        passive: { roomId: 'garden', objectsPresent: [], drives: {}, agentsPresent: [] },
      }),
    );
    expect(toolByName(payload.tools, 'talk_to')).toBeUndefined();
  });

  it('no agents present → no talk_to in the plan tools (no crash)', () => {
    const payload = planBuilder.build(
      makePerceptionResult({
        passive: { roomId: 'garden', objectsPresent: [], drives: {}, agentsPresent: [] },
      }),
    );
    expect(toolByName(payload.tools, 'talk_to')).toBeUndefined();
    expect(payload.tools.map((t) => t.function.name)).toContain('formulate_plan');
  });

  it('every present agent past the cap → talk_to omitted; observe_agent/help/ignore render (perception)', () => {
    const cappedMaren = assessment('agent-maren', {
      personaSeed: 0.5,
      socialDrive: 80,
      relationship: { sentCount: 5, receivedCount: 0, trust: 50, familiarity: 0 },
    });
    const payload = perceptionBuilder.build(
      makePerceptionResult({ socialUrges: [cappedIris(), cappedMaren] }),
    );
    const names = payload.tools.map((t) => t.function.name);
    expect(names).not.toContain('talk_to');
    expect(names).toEqual(expect.arrayContaining(['observe_agent', 'help', 'ignore']));
  });

  it('every present agent past the cap → talk_to omitted; siblings render (plan)', () => {
    const cappedMaren = assessment('agent-maren', {
      personaSeed: 0.5,
      socialDrive: 80,
      relationship: { sentCount: 5, receivedCount: 0, trust: 50, familiarity: 0 },
    });
    const payload = planBuilder.build(
      makePerceptionResult({ socialUrges: [cappedIris(), cappedMaren] }),
    );
    const names = payload.tools.map((t) => t.function.name);
    expect(names).not.toContain('talk_to');
    expect(names).toEqual(expect.arrayContaining(['observe_agent', 'help', 'ignore']));
  });
});

// ── AC-5 (R2): mechanical recovery — a reply re-opens the enum ───────────────

describe('reply-driven recovery (R2, AC-5)', () => {
  const builder = new PerceptionBuilderImpl();

  it('after the target replies (gap < cap), the target re-enters the enum on the next cycle', () => {
    const before = builder.build(
      makePerceptionResult({ socialUrges: [cappedIris(), healthyMaren()] }),
    );
    expect(
      toolByName(before.tools, 'talk_to')!.function.parameters.properties.targetAgentId.enum,
    ).toEqual(['agent-maren']);

    // The target replied: receivedCount catches up → gap 0 < cap → next cycle.
    const after = builder.build(
      makePerceptionResult({ socialUrges: [recoveredIris(), healthyMaren()] }),
    );
    expect(
      toolByName(after.tools, 'talk_to')!.function.parameters.properties.targetAgentId.enum,
    ).toEqual(['agent-iris', 'agent-maren']);
  });
});

// ── R3 / AC-6 / AC-7: the executor choke-point validation ────────────────────

const ALICE = 'agent-alice';

interface SocialWrites {
  queued: Array<{ to: string; message: SocialMessage }>;
  relationships: Array<{ agentId: string; otherAgentId: string; updates: Partial<Relationship> }>;
}

/**
 * Scriptable SocialActionBridge double with spec 051 enumeration. `valid`
 * is the per-cycle valid-target list `enumerateTalkTargets` returns.
 */
function makeSocialBridge(
  overrides: {
    valid?: string[];
    withEnumeration?: boolean;
  } = {},
): SocialActionBridge & { writes: SocialWrites; conversationCalls: string[] } {
  const writes: SocialWrites = { queued: [], relationships: [] };
  const conversationCalls: string[] = [];
  const bridge: SocialActionBridge & { writes: SocialWrites; conversationCalls: string[] } = {
    writes,
    conversationCalls,
    queueMessage(fromAgentId: string, toAgentId: string, content: string): void {
      writes.queued.push({
        to: toAgentId,
        message: { fromAgentId, fromName: fromAgentId, content, timestamp: 0 },
      });
    },
    updateRelationship(
      agentId: string,
      otherAgentId: string,
      updates: Partial<Relationship>,
    ): void {
      writes.relationships.push({ agentId, otherAgentId, updates });
    },
    getAgentSummary(agentId: string): AgentSummary | null {
      return {
        agentId,
        name: agentId === 'agent-bob' ? 'Bob' : agentId,
        currentActivity: 'idle',
        isThinking: false,
      };
    },
    getAgentDrives(): Record<string, number> {
      return { social: 50 };
    },
    resolveAgentId(_requesterAgentId: string, nameOrId: string): string | null {
      // Exact agent-ID passthrough first (spec 046 R1); display names resolve.
      if (nameOrId === ALICE || nameOrId === 'agent-bob') return nameOrId;
      if (nameOrId === 'Bob') return 'agent-bob';
      return null;
    },
  };
  if (overrides.withEnumeration !== false) {
    const valid = overrides.valid ?? ['agent-bob'];
    bridge.enumerateTalkTargets = (_requesterAgentId: string): string[] => valid;
  }
  return bridge;
}

/** Conversation stub recording openOrContribute dispatches (nothing written). */
function makeConversationBridge(): ConversationBridge & { opened: string[] } {
  const opened: string[] = [];
  const conv: ConversationObject = {
    id: 'conv-1',
    topic: 'a conversation',
    roomId: 'garden',
    status: 'open',
    participants: [],
    turns: [],
    openedAt: 1,
    lastActivity: 1,
  };
  return {
    opened,
    openOrContribute(
      agentId: string,
      targetAgentId: string,
      _content: string,
      _sentiment: ConversationSentiment,
      _tick: number,
    ): ConversationActionResult {
      opened.push(`${agentId}->${targetAgentId}`);
      return { success: true, conversationId: 'conv-1', conversation: conv };
    },
    join: () => ({ success: false, message: 'unused' }),
    leave: () => ({ success: false, message: 'unused' }),
    contribute: () => ({ success: false, message: 'unused' }),
    observe: () => ({ success: false, message: 'unused' }),
    getOpenConversationBetween: () => null,
    getEligibleAffordances: () => [],
    getConversationsAwaitingAgentReply: () => [],
  };
}

describe('executor choke-point validation (R3, AC-6)', () => {
  it('a resolved-but-excluded target returns the structured failure and writes NOTHING', async () => {
    const bridge = makeSocialBridge({ valid: ['agent-carol'] });
    const conversation = makeConversationBridge();
    const grants: Array<Record<string, number>> = [];
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: bridge as never,
      conversationBridge: conversation,
      stateDataProvider: {
        updateGoal: () => undefined,
        applyDriveChanges: (_agentId, changes) => grants.push(changes),
      },
      currentTick: 100,
    });

    const result = await executor.executeTalkTo(ALICE, 'agent-bob', 'hello?', 'neutral');

    expect(result.success).toBe(false);
    expect(result.message).toContain('agent-bob');
    expect(result.message).toContain('give them space');
    expect(result.message).toContain('reply');
    expect(result.relationshipUpdated).toBe(false);
    // NOTHING is written — no queue message, no conversation, no relationship
    // delta, no reciprocity counter, no drive grant.
    expect(bridge.writes.queued).toEqual([]);
    expect(bridge.writes.relationships).toEqual([]);
    expect(grants).toEqual([]);
    expect(conversation.opened).toEqual([]);
  });

  it('the display-name path resolves FIRST, then the exclusion applies (spec 046 R2 → spec 051 R3 order)', async () => {
    const bridge = makeSocialBridge({ valid: [] });
    const conversation = makeConversationBridge();
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: bridge as never,
      conversationBridge: conversation,
      currentTick: 100,
    });
    const result = await executor.executeTalkTo(ALICE, 'Bob', 'hello?', 'neutral');
    expect(result.success).toBe(false);
    // The failure names the RESOLVED target (the real agent), not the raw string.
    expect(result.message).toContain('agent-bob');
    expect(bridge.writes.queued).toEqual([]);
  });

  it('a target INSIDE the enumeration writes exactly as before (spec 046 behavior)', async () => {
    const bridge = makeSocialBridge({ valid: ['agent-bob'] });
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: bridge as never,
      currentTick: 100,
    });
    const result = await executor.executeTalkTo(ALICE, 'agent-bob', 'hi', 'neutral');
    expect(result.success).toBe(true);
    expect(bridge.writes.queued).toHaveLength(1);
    expect(bridge.writes.queued[0]!.to).toBe('agent-bob');
    expect(bridge.writes.relationships).toHaveLength(2);
  });
});

describe('backward-compat typeof guard (R3, AC-7)', () => {
  it('a bridge WITHOUT enumerateTalkTargets keeps the spec 046 behavior bit-for-bit', async () => {
    const bridge = makeSocialBridge({ withEnumeration: false });
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: bridge as never,
      currentTick: 100,
    });
    const result = await executor.executeTalkTo(ALICE, 'agent-bob', 'hi', 'neutral');
    expect(result.success).toBe(true);
    expect(bridge.writes.queued).toHaveLength(1);
    expect(bridge.writes.relationships).toHaveLength(2);
  });
});

// ── R4 / AC-8: the [talk-enum] telemetry line ────────────────────────────────

describe('[talk-enum] diagnostic (R4, AC-8)', () => {
  it('renders present / valid / excluded counts and excluded IDs per cycle', () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    try {
      logTalkEnumDiagnostic(
        'agent-tomas',
        makePerceptionResult({ socialUrges: [cappedIris(), healthyMaren()] }),
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(logs[0]).toContain('[talk-enum]');
      expect(logs[0]).toContain('agent=agent-tomas');
      expect(logs[0]).toContain('present=2');
      expect(logs[0]).toContain('valid=1');
      expect(logs[0]).toContain('excluded=[agent-iris]');
    } finally {
      spy.mockRestore();
    }
  });

  it('nothing excluded → excluded=[] renders; valid equals present', () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    try {
      logTalkEnumDiagnostic('agent-tomas', makePerceptionResult());
      expect(logs[0]).toContain('present=2');
      expect(logs[0]).toContain('valid=2');
      expect(logs[0]).toContain('excluded=[]');
    } finally {
      spy.mockRestore();
    }
  });

  it('no agents present → no line (nothing to enumerate)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      logTalkEnumDiagnostic('agent-tomas', {
        ...makePerceptionResult(),
        passive: { roomId: 'garden', objectsPresent: [], drives: {}, agentsPresent: [] },
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('the orchestrator emits the line at the perceive→plan seam (wiring pin)', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/pper/orchestrator.ts'),
      'utf8',
    );
    expect(source).toContain('logTalkEnumDiagnostic');
  });
});
