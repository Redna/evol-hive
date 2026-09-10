/**
 * Tests for spec 046 — talk_to Target Resolution & Sentiment Passthrough
 * (issue #173) — cognition layer.
 *
 * Covers:
 * - R2 (AC-1/AC-2/AC-7/AC-8 unit level): `CognitiveToolExecutorImpl` normalizes
 *   the target through `resolveAgentId` BEFORE any dispatch — the resolved real
 *   ID reaches `openOrContribute`, `queueMessage`, both `updateRelationship`
 *   directions, and the `[social]` telemetry line, for `talk_to` AND the
 *   sibling social tools `observe_agent` / `help` / `ignore`.
 * - AC-8: an unresolvable target yields a structured failure whose message is
 *   actionable, and NOTHING is written under any key (no conversation, no
 *   relationship entry, no queued message). When a conversation bridge is
 *   wired, the executor surfaces the engine-built refusal verbatim (Req 17
 *   self-correction — the modify_scene rejection pattern).
 * - R5 / AC-5: the mid-loop tool-call branch in `openai-client.ts` maps the
 *   LLM's `sentiment` tool arg through the spec 033 enum — 'negative' reaches
 *   `executeTalkTo` as 'negative'; missing/invalid values map to 'neutral'.
 * - AC-10 (unit level): a bridge predating spec 046 (no `resolveAgentId`) keeps
 *   exact-ID passthrough bit-for-bit — raw strings flow unchanged.
 *
 * Deterministic throughout — no LLM anywhere (spec 033 AC-14 discipline).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  AgentSummary,
  ConversationActionResult,
  ConversationBridge,
  ConversationObject,
  ConversationSentiment,
  CognitiveToolExecutor,
  Relationship,
  SocialActionBridge,
  SocialMessage,
} from '@evol-hive/shared';
import { CognitiveToolExecutorImpl } from '../src/tools/cognitive-tool-executor.js';
import { OpenAICompatibleLLMClient } from '../src/llm/openai-client.js';
import { chooseActionTool, talkToTool } from '@evol-hive/shared';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ALICE = 'agent-alice';

/** Record of every write the social bridge saw. */
interface SocialWrites {
  /** The enqueue KEY (the target the message was queued under) + the message. */
  queued: Array<{ to: string; message: SocialMessage }>;
  relationships: Array<{ agentId: string; otherAgentId: string; updates: Partial<Relationship> }>;
}

/**
 * Scriptable SocialActionBridge double WITH spec 046 R1 resolution.
 * `resolution` maps raw targets to resolved IDs ('Zed' → null by default).
 */
function makeSocialBridge(
  overrides: {
    resolution?: Record<string, string | null>;
    summaries?: Record<string, AgentSummary>;
  } = {},
): SocialActionBridge & { writes: SocialWrites } {
  const resolution = overrides.resolution ?? { Bob: 'agent-bob' };
  const writes: SocialWrites = { queued: [], relationships: [] };
  return {
    writes,
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
      return (
        overrides.summaries?.[agentId] ?? {
          agentId,
          name: agentId,
          currentActivity: 'idle',
          isThinking: false,
        }
      );
    },
    getAgentDrives(): Record<string, number> {
      return { social: 50 };
    },
    resolveAgentId(_requesterAgentId: string, nameOrId: string): string | null {
      // Exact agent-ID passthrough first (R1) — real IDs never hit the map.
      if (nameOrId === ALICE || nameOrId === 'agent-bob') return nameOrId;
      return resolution[nameOrId] ?? null;
    },
  };
}

/** Scriptable ConversationBridge double recording openOrContribute dispatches. */
function makeConversationBridge(
  refusalFor?: (targetKey: string) => ConversationActionResult | undefined,
): ConversationBridge & { opened: Array<{ agentId: string; targetAgentId: string }> } {
  const opened: Array<{ agentId: string; targetAgentId: string }> = [];
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
      opened.push({ agentId, targetAgentId });
      const refusal = refusalFor?.(targetAgentId);
      if (refusal !== undefined) return refusal;
      return { success: true, conversationId: conv.id, message: 'ok', conversation: { ...conv } };
    },
    join(): ConversationActionResult {
      return { success: false, message: 'unused' };
    },
    leave(): ConversationActionResult {
      return { success: false, message: 'unused' };
    },
    contribute(): ConversationActionResult {
      return { success: false, message: 'unused' };
    },
    observe(): { success: boolean; message: string } {
      return { success: false, message: 'unused' };
    },
    getOpenConversationBetween(): ConversationObject | null {
      return null;
    },
    getEligibleAffordances(): string[] {
      return [];
    },
    getConversationsAwaitingAgentReply(): ConversationObject[] {
      return [];
    },
  };
}

// ── R2: executor-side normalization ──────────────────────────────────────────

describe('spec 046 R2 — CognitiveToolExecutorImpl normalizes targets before dispatch', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('talk_to with a display-name target dispatches the RESOLVED real ID everywhere (AC-1/AC-2 unit)', async () => {
    const social = makeSocialBridge();
    const conversations = makeConversationBridge();
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: social,
      conversationBridge: conversations,
      currentTick: 7,
    });

    const result = await executor.executeTalkTo(ALICE, 'Bob', 'Hey Bob!', 'neutral');

    expect(result.success).toBe(true);
    expect(result.conversationUpdated).toBe(true);
    // openOrContribute received the real ID — never the raw display name.
    expect(conversations.opened).toEqual([{ agentId: ALICE, targetAgentId: 'agent-bob' }]);
    // The message queue is keyed by the real ID.
    expect(social.writes.queued).toHaveLength(1);
    expect(social.writes.queued[0]!.to).toBe('agent-bob');
    expect(social.writes.queued[0]!.message.fromAgentId).toBe(ALICE);
    // Both relationship directions use the real ID (spec 044 counters ride along).
    expect(social.writes.relationships).toHaveLength(2);
    expect(social.writes.relationships[0]).toMatchObject({
      agentId: ALICE,
      otherAgentId: 'agent-bob',
      updates: { sentCount: 1 },
    });
    expect(social.writes.relationships[1]).toMatchObject({
      agentId: 'agent-bob',
      otherAgentId: ALICE,
      updates: { receivedCount: 1 },
    });
    // The [social] telemetry line names the real ID (R2).
    const socialLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('[social]'));
    expect(socialLine).toContain('agent-alice talk_to→agent-bob');
    expect(socialLine).not.toContain('talk_to→Bob ');
  });

  it('observe_agent with a display-name target resolves to the real ID (AC-7)', async () => {
    const social = makeSocialBridge({
      summaries: {
        'agent-bob': {
          agentId: 'agent-bob',
          name: 'Bob',
          currentActivity: 'idle',
          isThinking: false,
        },
      },
    });
    const executor = new CognitiveToolExecutorImpl({ socialBridge: social, currentTick: 7 });

    const result = await executor.executeObserveAgent(ALICE, 'Bob');

    expect(result.success).toBe(true);
    expect(result.observedAgent?.name).toBe('Bob');
    // The relationship entry is keyed by the REAL ID — no phantom 'Bob' key.
    expect(social.writes.relationships).toHaveLength(1);
    expect(social.writes.relationships[0]!.otherAgentId).toBe('agent-bob');
  });

  it('help with a display-name target resolves to the real ID in both relationship directions (AC-7)', async () => {
    const social = makeSocialBridge();
    const executor = new CognitiveToolExecutorImpl({ socialBridge: social, currentTick: 7 });

    const result = await executor.executeHelp(ALICE, 'Bob');

    expect(result.success).toBe(true);
    expect(social.writes.relationships).toHaveLength(2);
    expect(social.writes.relationships[0]!.otherAgentId).toBe('agent-bob');
    expect(social.writes.relationships[1]!.agentId).toBe('agent-bob');
    const helpLine = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[social]'));
    expect(helpLine).toContain('help→agent-bob');
  });

  it('ignore with a display-name target resolves to the real ID (AC-7)', async () => {
    const social = makeSocialBridge();
    const executor = new CognitiveToolExecutorImpl({ socialBridge: social, currentTick: 7 });

    const result = await executor.executeIgnore(ALICE, 'Bob');

    expect(result.success).toBe(true);
    expect(social.writes.relationships).toHaveLength(1);
    expect(social.writes.relationships[0]!.otherAgentId).toBe('agent-bob');
  });

  it('an unresolvable talk_to target fails loudly and writes NOTHING under any key (AC-8)', async () => {
    const social = makeSocialBridge();
    const executor = new CognitiveToolExecutorImpl({ socialBridge: social, currentTick: 7 });

    const result = await executor.executeTalkTo(ALICE, 'Zed', 'anyone there?', 'neutral');

    expect(result.success).toBe(false);
    expect(result.relationshipUpdated).toBe(false);
    // No conversation, no relationship entries, no queued message — nothing.
    expect(social.writes.queued).toHaveLength(0);
    expect(social.writes.relationships).toHaveLength(0);
  });

  it('an unresolvable talk_to target surfaces the engine-built refusal listing present agents (AC-8, Req 17)', async () => {
    const social = makeSocialBridge();
    const conversations = makeConversationBridge((targetKey) => ({
      success: false,
      message:
        `No agent matches '${targetKey}' — no conversation was started. ` +
        `Present agents: Bob (agent-bob).`,
    }));
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: social,
      conversationBridge: conversations,
      currentTick: 7,
    });

    const result = await executor.executeTalkTo(ALICE, 'Zed', 'anyone there?', 'neutral');

    expect(result.success).toBe(false);
    // The executor surfaces the engine's actionable refusal verbatim.
    expect(result.message).toContain('Zed');
    expect(result.message).toContain('Present agents: Bob (agent-bob)');
    // …and the probe into the hardened manager wrote nothing on the social side.
    expect(social.writes.queued).toHaveLength(0);
    expect(social.writes.relationships).toHaveLength(0);
  });

  it('unresolvable observe_agent/help/ignore targets fail and write NO relationship keys (AC-7/AC-8)', async () => {
    const social = makeSocialBridge({ resolution: { Bob: null } });
    const executor = new CognitiveToolExecutorImpl({ socialBridge: social, currentTick: 7 });

    for (const run of [
      () => executor.executeObserveAgent(ALICE, 'Zed'),
      () => executor.executeHelp(ALICE, 'Zed'),
      () => executor.executeIgnore(ALICE, 'Zed'),
    ]) {
      const result = await run();
      expect(result.success).toBe(false);
      expect(result.relationshipUpdated).toBe(false);
      expect(result.message).toContain('Zed');
      expect(result.message).toContain('Agents present');
    }
    expect(social.writes.relationships).toHaveLength(0);
    expect(social.writes.queued).toHaveLength(0);
  });

  // ── AC-10 (unit level): legacy bridges and exact IDs behave identically ──

  it('a bridge WITHOUT resolveAgentId keeps exact-ID passthrough bit-for-bit (AC-10)', async () => {
    const social = makeSocialBridge();
    // Strip the spec 046 method — a pre-046 bridge double.
    const legacy = social as SocialActionBridge & { writes: SocialWrites };
    delete (legacy as Partial<SocialActionBridge>).resolveAgentId;
    const executor = new CognitiveToolExecutorImpl({ socialBridge: social, currentTick: 7 });

    const result = await executor.executeTalkTo(ALICE, 'agent-bob', 'hello', 'neutral');

    expect(result.success).toBe(true);
    expect(social.writes.queued[0]!.to).toBe('agent-bob');
    // Speaker→target and target→speaker writes, both under REAL IDs.
    expect(social.writes.relationships[0]).toMatchObject({
      agentId: ALICE,
      otherAgentId: 'agent-bob',
    });
    expect(social.writes.relationships[1]).toMatchObject({
      agentId: 'agent-bob',
      otherAgentId: ALICE,
    });
  });

  it('exact-ID targeting through a resolving bridge is unchanged — no re-resolution surprise (AC-10)', async () => {
    const social = makeSocialBridge({ resolution: { Bob: 'agent-bob' } });
    const executor = new CognitiveToolExecutorImpl({ socialBridge: social, currentTick: 7 });

    const result = await executor.executeTalkTo(ALICE, 'agent-bob', 'hello', 'neutral');

    expect(result.success).toBe(true);
    expect(social.writes.queued[0]!.to).toBe('agent-bob');
    expect(social.writes.relationships[0]).toMatchObject({
      agentId: ALICE,
      otherAgentId: 'agent-bob',
    });
    expect(social.writes.relationships[1]).toMatchObject({
      agentId: 'agent-bob',
      otherAgentId: ALICE,
    });
  });
});

// ── R5 / AC-5: sentiment passthrough in the tool-call loop ───────────────────

describe('spec 046 R5 / AC-5 — the mid-loop talk_to branch maps the sentiment arg', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  /** Executor double that records executeTalkTo arguments. */
  function makeRecordingExecutor(): CognitiveToolExecutor & {
    talkToCalls: Array<[string, string, string, ConversationSentiment]>;
  } {
    const talkToCalls: Array<[string, string, string, ConversationSentiment]> = [];
    return {
      talkToCalls,
      executeQueryMemory: async () => ({ memories: [] }),
      executeUpdateInternalState: async () => ({
        success: true,
        goalUpdated: false,
        drivesUpdated: false,
        message: '',
      }),
      executeTalkTo: async (agentId, targetAgentId, message, sentiment) => {
        talkToCalls.push([agentId, targetAgentId, message, sentiment ?? 'neutral']);
        return { success: true, message: 'sent', relationshipUpdated: true };
      },
      executeObserveAgent: async () => ({ success: true, message: '', relationshipUpdated: false }),
      executeHelp: async () => ({ success: true, message: '', relationshipUpdated: false }),
      executeIgnore: async () => ({ success: true, message: '', relationshipUpdated: false }),
    };
  }

  function toolCallResponse(toolName: string, args: unknown, toolCallId = 'call-1'): Response {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: toolCallId,
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function runTalkToLoop(
    talkToArgs: Record<string, unknown>,
  ): Promise<ReturnType<typeof makeRecordingExecutor>> {
    const executor = makeRecordingExecutor();
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('talk_to', talkToArgs, 'call-talk'))
      .mockResolvedValueOnce(toolCallResponse('choose_action', { reasoning: 'r', action: 'idle' }));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: 'http://localhost:8080/v1',
      model: 'test',
      cognitiveToolExecutor: executor,
      maxToolCallIterations: 5,
    });
    await client.completeStructured({
      systemPrompt: 'sys',
      perceptionContext: 'perception',
      availableAffordances: [],
      cognitiveTools: [],
      tools: [chooseActionTool, talkToTool],
      agentId: ALICE,
    });
    return executor;
  }

  it("an LLM tool-call with sentiment: 'negative' reaches executeTalkTo as 'negative' (AC-5)", async () => {
    const executor = await runTalkToLoop({
      targetAgentId: 'agent-bob',
      message: 'ugh',
      sentiment: 'negative',
    });
    expect(executor.talkToCalls).toEqual([[ALICE, 'agent-bob', 'ugh', 'negative']]);
  });

  it("sentiment: 'positive' reaches executeTalkTo as 'positive'", async () => {
    const executor = await runTalkToLoop({
      targetAgentId: 'agent-bob',
      message: 'nice!',
      sentiment: 'positive',
    });
    expect(executor.talkToCalls).toEqual([[ALICE, 'agent-bob', 'nice!', 'positive']]);
  });

  it('a missing sentiment arg maps to the neutral default (AC-5)', async () => {
    const executor = await runTalkToLoop({ targetAgentId: 'agent-bob', message: 'hello' });
    expect(executor.talkToCalls).toEqual([[ALICE, 'agent-bob', 'hello', 'neutral']]);
  });

  it('an invalid sentiment value maps to the neutral default — never passed through raw (AC-5)', async () => {
    const executor = await runTalkToLoop({
      targetAgentId: 'agent-bob',
      message: 'hello',
      sentiment: 'angry',
    });
    expect(executor.talkToCalls).toEqual([[ALICE, 'agent-bob', 'hello', 'neutral']]);
  });
});

// Silence the unused-import guard for the type-only SocialToolResult reference
// kept in the fixture signatures above.
export type { SocialToolResult };
