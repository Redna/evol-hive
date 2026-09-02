/**
 * Tests for spec 018 — Multi-Agent Social (cognition layer).
 * Covers AC-25 through AC-48, AC-50 through AC-55.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  AgentSummary,
  SocialMessage,
  SocialToolResult,
  SocialActionBridge,
  CognitiveToolDataProvider,
  PassivePerception,
  PerceptionResult,
  AgentInternalState,
  AgentProfile,
  Affordance,
  Relationship,
  CognitiveToolExecutor,
} from '@evol-hive/shared';
import {
  talkToTool,
  observeAgentTool,
  helpTool,
  ignoreTool,
  chooseActionTool,
  queryMemoryTool,
  updateInternalStateTool,
  formulatePlanTool,
} from '@evol-hive/shared';
import type { LLMContextPayload } from '../src/index.js';
import { OpenAICompatibleLLMClient, LLMError } from '../src/llm/openai-client.js';
import {
  CognitiveToolExecutorImpl,
  type CognitiveToolExecutorOptions,
} from '../src/tools/cognitive-tool-executor.js';
import { defaultCognitiveTools } from '../src/tools/index.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { PassivePerceptionAssembler, PerceptionServiceImpl } from '../src/pper/index.js';
import type { AffordanceClassifier } from '../src/classifier/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:8080/v1';
const CHAT_URL = `${BASE_URL}/chat/completions`;

type FetchArgs = [string, RequestInit];

function callAt(mock: ReturnType<typeof vi.fn>, index: number): FetchArgs {
  return mock.mock.calls[index] as unknown as FetchArgs;
}

function toolCallResponse(
  toolName: string,
  argumentsObj: unknown,
  toolCallId = 'call-1',
): Response {
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
              function: { name: toolName, arguments: JSON.stringify(argumentsObj) },
            },
          ],
        },
      },
    ],
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function makePayload(overrides: Partial<LLMContextPayload> = {}): LLMContextPayload {
  return {
    systemPrompt: 'You are a helpful agent.',
    perceptionContext: 'You are in a kitchen.',
    availableAffordances: [],
    cognitiveTools: [],
    tools: [chooseActionTool],
    agentId: 'agent-1',
    ...overrides,
  };
}

/** Mock SocialActionBridge */
function makeMockBridge(overrides: Partial<SocialActionBridge> = {}): SocialActionBridge {
  return {
    queueMessage: vi.fn(),
    updateRelationship: vi.fn(),
    getAgentSummary: vi.fn().mockReturnValue({
      agentId: 'agent-bob',
      name: 'Bob',
      currentActivity: 'idle',
      isThinking: false,
    }),
    getAgentDrives: vi
      .fn()
      .mockReturnValue({ energy: 40, hunger: 60, social: 80, comfort: 50, curiosity: 50 }),
    ...overrides,
  };
}

/** Mock CognitiveToolDataProvider */
function makeMockStateProvider(): CognitiveToolDataProvider {
  return {
    updateGoal: vi.fn(),
    applyDriveChanges: vi.fn(),
  };
}

// ── AC-25: CognitiveToolExecutorOptions socialBridge and currentTick ──────────

describe('AC-25: CognitiveToolExecutorOptions', () => {
  it('accepts socialBridge and currentTick fields', () => {
    const options: CognitiveToolExecutorOptions = {
      socialBridge: makeMockBridge(),
      currentTick: 42,
    };
    expect(options.socialBridge).toBeDefined();
    expect(options.currentTick).toBe(42);
  });

  it('works without socialBridge or currentTick (backward compat)', () => {
    const executor = new CognitiveToolExecutorImpl({});
    expect(executor).toBeDefined();
  });
});

// ── AC-26: executeTalkTo with socialBridge ───────────────────────────────────

describe('AC-26: executeTalkTo with socialBridge', () => {
  it('calls queueMessage, updateRelationship (bidirectional), applyDriveChanges', async () => {
    const bridge = makeMockBridge();
    const stateProvider = makeMockStateProvider();
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: bridge,
      stateDataProvider: stateProvider,
      currentTick: 500,
    });

    const result = await executor.executeTalkTo('agent-alice', 'agent-bob', 'Hello Bob!');

    expect(result.success).toBe(true);
    expect(result.relationshipUpdated).toBe(true);
    expect(result.message).toContain('Bob');
    expect(bridge.queueMessage).toHaveBeenCalledWith('agent-alice', 'agent-bob', 'Hello Bob!');
    // Bidirectional update
    expect(bridge.updateRelationship).toHaveBeenCalledWith(
      'agent-alice',
      'agent-bob',
      expect.objectContaining({ familiarity: 5, trust: 2 }),
    );
    expect(bridge.updateRelationship).toHaveBeenCalledWith(
      'agent-bob',
      'agent-alice',
      expect.objectContaining({ familiarity: 5, trust: 2 }),
    );
    // Social drive boost
    expect(stateProvider.applyDriveChanges).toHaveBeenCalledWith('agent-alice', { social: 10 });
  });
});

// ── AC-27: executeTalkTo without socialBridge ─────────────────────────────────

describe('AC-27: executeTalkTo without socialBridge', () => {
  it('returns failure result without error', async () => {
    const executor = new CognitiveToolExecutorImpl({});
    const result = await executor.executeTalkTo('agent-alice', 'agent-bob', 'Hello!');
    expect(result).toEqual({
      success: false,
      message: 'Social actions not available.',
      relationshipUpdated: false,
    });
  });
});

// ── AC-28: executeObserveAgent ───────────────────────────────────────────────

describe('AC-28: executeObserveAgent', () => {
  it('returns success with observedAgent including drives', async () => {
    const bridge = makeMockBridge();
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: bridge,
      currentTick: 100,
    });

    const result = await executor.executeObserveAgent('agent-alice', 'agent-bob');

    expect(result.success).toBe(true);
    expect(result.relationshipUpdated).toBe(true);
    expect(result.observedAgent).toBeDefined();
    expect(result.observedAgent!.name).toBe('Bob');
    expect(result.observedAgent!.currentActivity).toBe('idle');
    expect(result.observedAgent!.isThinking).toBe(false);
    expect(result.observedAgent!.drives.energy).toBe(40);
    // Familiarity +1
    expect(bridge.updateRelationship).toHaveBeenCalledWith(
      'agent-alice',
      'agent-bob',
      expect.objectContaining({ familiarity: 1 }),
    );
  });

  it('returns failure when target agent not found', async () => {
    const bridge = makeMockBridge({
      getAgentSummary: vi.fn().mockReturnValue(null),
    });
    const executor = new CognitiveToolExecutorImpl({ socialBridge: bridge });

    const result = await executor.executeObserveAgent('agent-alice', 'nonexistent');
    expect(result.success).toBe(false);
    expect(result.message).toBe('Agent not found.');
    expect(result.relationshipUpdated).toBe(false);
  });
});

// ── AC-29: executeHelp ───────────────────────────────────────────────────────

describe('AC-29: executeHelp', () => {
  it('updates relationships bidirectionally, boosts social +15, boosts target primary drive +10', async () => {
    const bridge = makeMockBridge({
      getAgentDrives: vi
        .fn()
        .mockReturnValue({ energy: 20, hunger: 80, social: 90, comfort: 60, curiosity: 70 }),
    });
    const stateProvider = makeMockStateProvider();
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: bridge,
      stateDataProvider: stateProvider,
      currentTick: 300,
    });

    const result = await executor.executeHelp('agent-alice', 'agent-bob');

    expect(result.success).toBe(true);
    expect(result.relationshipUpdated).toBe(true);
    expect(result.message).toContain('Bob');
    // Bidirectional with familiarity +10, trust +5
    expect(bridge.updateRelationship).toHaveBeenCalledWith(
      'agent-alice',
      'agent-bob',
      expect.objectContaining({ familiarity: 10, trust: 5 }),
    );
    expect(bridge.updateRelationship).toHaveBeenCalledWith(
      'agent-bob',
      'agent-alice',
      expect.objectContaining({ familiarity: 10, trust: 5 }),
    );
    // Helper's social +15
    expect(stateProvider.applyDriveChanges).toHaveBeenCalledWith('agent-alice', { social: 15 });
    // Target's primary drive (energy=20 is lowest) +10
    expect(stateProvider.applyDriveChanges).toHaveBeenCalledWith('agent-bob', { energy: 10 });
  });
});

// ── AC-30: executeIgnore ─────────────────────────────────────────────────────

describe('AC-30: executeIgnore', () => {
  it('updates relationship with familiarity -2, trust -1 and applies social -5', async () => {
    const bridge = makeMockBridge();
    const stateProvider = makeMockStateProvider();
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: bridge,
      stateDataProvider: stateProvider,
      currentTick: 200,
    });

    const result = await executor.executeIgnore('agent-alice', 'agent-bob');

    expect(result.success).toBe(true);
    expect(result.relationshipUpdated).toBe(true);
    expect(result.message).toContain('Bob');
    expect(bridge.updateRelationship).toHaveBeenCalledWith(
      'agent-alice',
      'agent-bob',
      expect.objectContaining({ familiarity: -2, trust: -1 }),
    );
    expect(stateProvider.applyDriveChanges).toHaveBeenCalledWith('agent-alice', { social: -5 });
  });
});

// ── AC-31: Error handling ─────────────────────────────────────────────────────

describe('AC-31: Error handling in social methods', () => {
  it('executeTalkTo catches errors and returns failure', async () => {
    const bridge = makeMockBridge({
      queueMessage: vi.fn().mockImplementation(() => {
        throw new Error('queue full');
      }),
    });
    const executor = new CognitiveToolExecutorImpl({ socialBridge: bridge });

    const result = await executor.executeTalkTo('agent-alice', 'agent-bob', 'Hi');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to send message');
    expect(result.relationshipUpdated).toBe(false);
  });

  it('executeObserveAgent catches errors and returns failure', async () => {
    const bridge = makeMockBridge({
      getAgentSummary: vi.fn().mockImplementation(() => {
        throw new Error('db error');
      }),
    });
    const executor = new CognitiveToolExecutorImpl({ socialBridge: bridge });

    const result = await executor.executeObserveAgent('agent-alice', 'agent-bob');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to observe agent');
  });

  it('executeHelp catches errors and returns failure', async () => {
    const bridge = makeMockBridge({
      updateRelationship: vi.fn().mockImplementation(() => {
        throw new Error('write error');
      }),
    });
    const stateProvider = makeMockStateProvider();
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: bridge,
      stateDataProvider: stateProvider,
    });

    const result = await executor.executeHelp('agent-alice', 'agent-bob');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to help agent');
  });

  it('executeIgnore catches errors and returns failure', async () => {
    const bridge = makeMockBridge({
      updateRelationship: vi.fn().mockImplementation(() => {
        throw new Error('err');
      }),
    });
    const executor = new CognitiveToolExecutorImpl({ socialBridge: bridge });

    const result = await executor.executeIgnore('agent-alice', 'agent-bob');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to ignore agent');
  });
});

// ── AC-32: COGNITIVE_TOOL_NAMES includes social tools ─────────────────────────

describe('AC-32: COGNITIVE_TOOL_NAMES includes social tools', () => {
  it('the tool call loop recognizes social tool names', async () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const executor: CognitiveToolExecutor = {
      executeQueryMemory: vi.fn().mockResolvedValue({ memories: [] }),
      executeUpdateInternalState: vi.fn().mockResolvedValue({
        success: true,
        goalUpdated: false,
        drivesUpdated: false,
        message: '',
      }),
      executeTalkTo: vi
        .fn()
        .mockResolvedValue({ success: true, message: 'sent', relationshipUpdated: true }),
      executeObserveAgent: vi
        .fn()
        .mockResolvedValue({ success: true, message: 'observed', relationshipUpdated: true }),
      executeHelp: vi
        .fn()
        .mockResolvedValue({ success: true, message: 'helped', relationshipUpdated: true }),
      executeIgnore: vi
        .fn()
        .mockResolvedValue({ success: true, message: 'ignored', relationshipUpdated: true }),
    };

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: 'test',
      cognitiveToolExecutor: executor,
      maxToolCallIterations: 5,
    });

    fetchMock.mockResolvedValue(
      toolCallResponse('talk_to', { targetAgentId: 'agent-bob', message: 'Hi!' }),
    );
    fetchMock.mockResolvedValueOnce(
      toolCallResponse('talk_to', { targetAgentId: 'agent-bob', message: 'Hi!' }),
    );
    fetchMock.mockResolvedValueOnce(
      toolCallResponse('choose_action', { reasoning: 'r', action: 'idle' }),
    );

    const payload = makePayload({ tools: [chooseActionTool, talkToTool] });
    await client.completeStructured(payload);

    // The talk_to should have been executed (2 fetch calls: first talk_to, then choose_action)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    globalThis.fetch = originalFetch;
  });
});

// ── AC-33: talk_to tool call in the loop ──────────────────────────────────────

describe('AC-33: LLM calls talk_to, client executes and sends tool result', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls executeTalkTo and constructs tool result message', async () => {
    const executor: CognitiveToolExecutor = {
      executeQueryMemory: vi.fn(),
      executeUpdateInternalState: vi.fn(),
      executeTalkTo: vi.fn().mockResolvedValue({
        success: true,
        message: 'Message sent to Bob.',
        relationshipUpdated: true,
      }),
      executeObserveAgent: vi.fn(),
      executeHelp: vi.fn(),
      executeIgnore: vi.fn(),
    };

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: 'test',
      cognitiveToolExecutor: executor,
      maxToolCallIterations: 5,
    });

    fetchMock.mockResolvedValueOnce(
      toolCallResponse('talk_to', { targetAgentId: 'agent-bob', message: 'Hello!' }),
    );
    fetchMock.mockResolvedValueOnce(
      toolCallResponse('choose_action', { reasoning: 'r', action: 'idle' }),
    );

    const payload = makePayload({ tools: [chooseActionTool, talkToTool] });
    await client.completeStructured(payload);

    expect(executor.executeTalkTo).toHaveBeenCalledWith('agent-1', 'agent-bob', 'Hello!');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Verify second request includes the tool result
    const secondBody = JSON.parse(callAt(fetchMock, 1)[1].body as string);
    const messages = secondBody.messages as unknown[];
    const toolMsg = messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const toolContent = (toolMsg as any).content;
    const parsed = JSON.parse(toolContent);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toBe('Message sent to Bob.');
  });
});

// ── AC-34: observe_agent tool call in the loop ────────────────────────────────

describe('AC-34: LLM calls observe_agent, tool result includes observedAgent', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls executeObserveAgent and result includes observedAgent JSON', async () => {
    const executor: CognitiveToolExecutor = {
      executeQueryMemory: vi.fn(),
      executeUpdateInternalState: vi.fn(),
      executeTalkTo: vi.fn(),
      executeObserveAgent: vi.fn().mockResolvedValue({
        success: true,
        message: 'Observed Bob.',
        relationshipUpdated: true,
        observedAgent: {
          name: 'Bob',
          currentActivity: 'idle',
          isThinking: false,
          drives: { energy: 40 },
        },
      }),
      executeHelp: vi.fn(),
      executeIgnore: vi.fn(),
    };

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: 'test',
      cognitiveToolExecutor: executor,
      maxToolCallIterations: 5,
    });

    fetchMock.mockResolvedValueOnce(
      toolCallResponse('observe_agent', { targetAgentId: 'agent-bob' }),
    );
    fetchMock.mockResolvedValueOnce(
      toolCallResponse('choose_action', { reasoning: 'r', action: 'idle' }),
    );

    const payload = makePayload({ tools: [chooseActionTool, observeAgentTool] });
    await client.completeStructured(payload);

    expect(executor.executeObserveAgent).toHaveBeenCalledWith('agent-1', 'agent-bob');

    const secondBody = JSON.parse(callAt(fetchMock, 1)[1].body as string);
    const messages = secondBody.messages as unknown[];
    const toolMsg = messages.find((m: any) => m.role === 'tool');
    const parsed = JSON.parse((toolMsg as any).content);
    expect(parsed.observedAgent).toBeDefined();
    expect(parsed.observedAgent.drives.energy).toBe(40);
  });
});

// ── AC-35: help and ignore tool calls in the loop ──────────────────────────────

describe('AC-35: LLM calls help/ignore, client executes and continues loop', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls executeHelp for help tool', async () => {
    const executor: CognitiveToolExecutor = {
      executeQueryMemory: vi.fn(),
      executeUpdateInternalState: vi.fn(),
      executeTalkTo: vi.fn(),
      executeObserveAgent: vi.fn(),
      executeHelp: vi.fn().mockResolvedValue({
        success: true,
        message: 'You helped Bob.',
        relationshipUpdated: true,
      }),
      executeIgnore: vi.fn(),
    };

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: 'test',
      cognitiveToolExecutor: executor,
      maxToolCallIterations: 5,
    });

    fetchMock.mockResolvedValueOnce(toolCallResponse('help', { targetAgentId: 'agent-bob' }));
    fetchMock.mockResolvedValueOnce(
      toolCallResponse('choose_action', { reasoning: 'r', action: 'idle' }),
    );

    const payload = makePayload({ tools: [chooseActionTool, helpTool] });
    await client.completeStructured(payload);

    expect(executor.executeHelp).toHaveBeenCalledWith('agent-1', 'agent-bob');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('calls executeIgnore for ignore tool', async () => {
    const executor: CognitiveToolExecutor = {
      executeQueryMemory: vi.fn(),
      executeUpdateInternalState: vi.fn(),
      executeTalkTo: vi.fn(),
      executeObserveAgent: vi.fn(),
      executeHelp: vi.fn(),
      executeIgnore: vi.fn().mockResolvedValue({
        success: true,
        message: 'You chose to ignore Bob.',
        relationshipUpdated: true,
      }),
    };

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: 'test',
      cognitiveToolExecutor: executor,
      maxToolCallIterations: 5,
    });

    fetchMock.mockResolvedValueOnce(toolCallResponse('ignore', { targetAgentId: 'agent-bob' }));
    fetchMock.mockResolvedValueOnce(
      toolCallResponse('choose_action', { reasoning: 'r', action: 'idle' }),
    );

    const payload = makePayload({ tools: [chooseActionTool, ignoreTool] });
    await client.completeStructured(payload);

    expect(executor.executeIgnore).toHaveBeenCalledWith('agent-1', 'agent-bob');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── AC-36: terminal tool after social tool ────────────────────────────────────

describe('AC-36: two-turn flow: social tool then terminal tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('LLM calls talk_to → engine executes → LLM calls choose_action → result is choose_action args', async () => {
    const executor: CognitiveToolExecutor = {
      executeQueryMemory: vi.fn(),
      executeUpdateInternalState: vi.fn(),
      executeTalkTo: vi
        .fn()
        .mockResolvedValue({ success: true, message: 'sent', relationshipUpdated: true }),
      executeObserveAgent: vi.fn(),
      executeHelp: vi.fn(),
      executeIgnore: vi.fn(),
    };

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: 'test',
      cognitiveToolExecutor: executor,
      maxToolCallIterations: 5,
    });

    fetchMock.mockResolvedValueOnce(
      toolCallResponse('talk_to', { targetAgentId: 'agent-bob', message: 'Hi!' }),
    );
    fetchMock.mockResolvedValueOnce(
      toolCallResponse('choose_action', { reasoning: 'I said hi', action: 'idle' }),
    );

    const payload = makePayload({ tools: [chooseActionTool, talkToTool] });
    const result = await client.completeStructured(payload);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(executor.executeTalkTo).toHaveBeenCalledTimes(1);
    expect(result.action).toBe('idle');
    expect(result.reasoning).toBe('I said hi');
  });
});

// ── AC-37: fallback when no executor or agentId ───────────────────────────────

describe('AC-37: fallback to single-request when no executor or agentId', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not execute social tools when no cognitiveToolExecutor', async () => {
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: 'test',
      // no cognitiveToolExecutor
    });

    fetchMock.mockResolvedValue(
      toolCallResponse('choose_action', { reasoning: 'r', action: 'idle' }),
    );

    const payload = makePayload({ tools: [chooseActionTool], agentId: 'agent-1' });
    const result = await client.completeStructured(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.action).toBe('idle');
  });

  it('does not execute social tools when no agentId', async () => {
    const executor: CognitiveToolExecutor = {
      executeQueryMemory: vi.fn(),
      executeUpdateInternalState: vi.fn(),
      executeTalkTo: vi.fn(),
      executeObserveAgent: vi.fn(),
      executeHelp: vi.fn(),
      executeIgnore: vi.fn(),
    };

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: 'test',
      cognitiveToolExecutor: executor,
    });

    fetchMock.mockResolvedValue(
      toolCallResponse('choose_action', { reasoning: 'r', action: 'idle' }),
    );

    const payload = makePayload({ tools: [chooseActionTool], agentId: undefined });
    const result = await client.completeStructured(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(executor.executeTalkTo).not.toHaveBeenCalled();
  });
});

// ── AC-38/39: PassivePerceptionAssembler social context ───────────────────────

describe('AC-38/39: PassivePerceptionAssembler social context', () => {
  function makeProvider(overrides: Partial<any> = {}): any {
    return {
      getAgentLocation: vi.fn().mockReturnValue('kitchen'),
      getObjectsInRoom: vi.fn().mockReturnValue([]),
      getAffordancesInRoom: vi.fn().mockReturnValue([]),
      getAgentDrives: vi.fn().mockReturnValue({ energy: 50 }),
      getPrimaryDriveLabel: vi.fn().mockReturnValue('low energy'),
      getSystemFeedback: vi.fn().mockReturnValue(undefined),
      ...overrides,
    };
  }

  it('includes agentsPresent when getAgentsInRoom returns non-empty', () => {
    const provider = makeProvider({
      getAgentsInRoom: vi
        .fn()
        .mockReturnValue([
          { agentId: 'b', name: 'Bob', currentActivity: 'idle', isThinking: false },
        ]),
    });
    const assembler = new PassivePerceptionAssembler(provider);
    const passive = assembler.buildPassivePerception('a');
    expect(passive.agentsPresent).toHaveLength(1);
    expect(passive.agentsPresent![0].name).toBe('Bob');
  });

  it('agentsPresent is undefined when getAgentsInRoom returns []', () => {
    const provider = makeProvider({
      getAgentsInRoom: vi.fn().mockReturnValue([]),
    });
    const assembler = new PassivePerceptionAssembler(provider);
    const passive = assembler.buildPassivePerception('a');
    expect(passive.agentsPresent).toBeUndefined();
  });

  it('agentsPresent is undefined when getAgentsInRoom is not available', () => {
    const provider = makeProvider(); // no getAgentsInRoom
    const assembler = new PassivePerceptionAssembler(provider);
    const passive = assembler.buildPassivePerception('a');
    expect(passive.agentsPresent).toBeUndefined();
  });

  it('includes socialContext when dequeueSocialMessages returns non-empty', () => {
    const provider = makeProvider({
      dequeueSocialMessages: vi
        .fn()
        .mockReturnValue([
          { fromAgentId: 'a2', fromName: 'Alice2', content: 'Hi!', timestamp: 100 },
        ]),
    });
    const assembler = new PassivePerceptionAssembler(provider);
    const passive = assembler.buildPassivePerception('a');
    expect(passive.socialContext).toHaveLength(1);
    expect(passive.socialContext![0].content).toBe('Hi!');
  });

  it('socialContext is undefined when dequeueSocialMessages returns []', () => {
    const provider = makeProvider({
      dequeueSocialMessages: vi.fn().mockReturnValue([]),
    });
    const assembler = new PassivePerceptionAssembler(provider);
    const passive = assembler.buildPassivePerception('a');
    expect(passive.socialContext).toBeUndefined();
  });

  it('socialContext is undefined when dequeueSocialMessages is not available', () => {
    const provider = makeProvider(); // no dequeueSocialMessages
    const assembler = new PassivePerceptionAssembler(provider);
    const passive = assembler.buildPassivePerception('a');
    expect(passive.socialContext).toBeUndefined();
  });
});

// ── AC-40: PerceptionServiceImpl populates relationships ─────────────────────

describe('AC-40: PerceptionServiceImpl populates relationships', () => {
  it('calls getRelationships and sets result on PerceptionResult', async () => {
    const provider: any = {
      getAgentLocation: vi.fn().mockReturnValue('kitchen'),
      getObjectsInRoom: vi.fn().mockReturnValue([]),
      getAffordancesInRoom: vi.fn().mockReturnValue([]),
      getAgentDrives: vi.fn().mockReturnValue({ energy: 50 }),
      getPrimaryDriveLabel: vi.fn().mockReturnValue('low energy'),
      getSystemFeedback: vi.fn().mockReturnValue(undefined),
      getRelationships: vi
        .fn()
        .mockReturnValue({ 'agent-bob': { trust: 70, familiarity: 40, lastInteraction: 100 } }),
    };
    const classifier: AffordanceClassifier = {
      prune: vi.fn().mockResolvedValue([]),
    };
    const service = new PerceptionServiceImpl({ provider, classifier });
    const result = await service.perceive('a');
    expect(result.relationships).toBeDefined();
    expect(result.relationships!['agent-bob'].trust).toBe(70);
  });

  it('relationships is undefined when getRelationships is not available', async () => {
    const provider: any = {
      getAgentLocation: vi.fn().mockReturnValue('kitchen'),
      getObjectsInRoom: vi.fn().mockReturnValue([]),
      getAffordancesInRoom: vi.fn().mockReturnValue([]),
      getAgentDrives: vi.fn().mockReturnValue({ energy: 50 }),
      getPrimaryDriveLabel: vi.fn().mockReturnValue('low energy'),
      getSystemFeedback: vi.fn().mockReturnValue(undefined),
      // no getRelationships
    };
    const classifier: AffordanceClassifier = {
      prune: vi.fn().mockResolvedValue([]),
    };
    const service = new PerceptionServiceImpl({ provider, classifier });
    const result = await service.perceive('a');
    expect(result.relationships).toBeUndefined();
  });
});

// ── AC-41: PerceptionBuilder with agentsPresent ───────────────────────────────

describe('AC-41: PerceptionBuilderImpl with agentsPresent', () => {
  it('includes "Agents present" context and social tools', () => {
    const builder = new PerceptionBuilderImpl();
    const pr: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 50 },
        agentsPresent: [
          { agentId: 'agent-bob', name: 'Bob', currentActivity: 'idle', isThinking: false },
        ],
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
    };
    const payload = builder.build(pr);
    expect(payload.perceptionContext).toContain('Agents present: Bob (idle)');
    const toolNames = payload.tools.map((t) => t.function.name);
    expect(toolNames).toContain('talk_to');
    expect(toolNames).toContain('observe_agent');
    expect(toolNames).toContain('help');
    expect(toolNames).toContain('ignore');
  });
});

// ── AC-42: PerceptionBuilder without agentsPresent ────────────────────────────

describe('AC-42: PerceptionBuilderImpl without agentsPresent', () => {
  it('does NOT include social tools when agentsPresent is empty/undefined', () => {
    const builder = new PerceptionBuilderImpl();
    const pr: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 50 },
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
    };
    const payload = builder.build(pr);
    const toolNames = payload.tools.map((t) => t.function.name);
    expect(toolNames).not.toContain('talk_to');
    expect(toolNames).not.toContain('observe_agent');
    expect(toolNames).not.toContain('help');
    expect(toolNames).not.toContain('ignore');
  });
});

// ── AC-43: PerceptionBuilder with socialContext ───────────────────────────────

describe('AC-43: PerceptionBuilderImpl with socialContext', () => {
  it('includes message context line', () => {
    const builder = new PerceptionBuilderImpl();
    const pr: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 50 },
        agentsPresent: [
          { agentId: 'agent-bob', name: 'Bob', currentActivity: 'idle', isThinking: false },
        ],
        socialContext: [
          { fromAgentId: 'agent-bob', fromName: 'Bob', content: 'Hey Alice!', timestamp: 100 },
        ],
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
    };
    const payload = builder.build(pr);
    expect(payload.perceptionContext).toContain('Message from Bob: "Hey Alice!"');
  });
});

// ── AC-44: PerceptionBuilder with high trust/familiarity ──────────────────────

describe('AC-44: PerceptionBuilder relationship context (high trust)', () => {
  it('includes trust and familiarity lines for high values', () => {
    const builder = new PerceptionBuilderImpl();
    const pr: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 50 },
        agentsPresent: [
          { agentId: 'agent-bob', name: 'Bob', currentActivity: 'idle', isThinking: false },
        ],
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
      relationships: { 'agent-bob': { trust: 75, familiarity: 65, lastInteraction: 100 } },
    };
    const payload = builder.build(pr);
    expect(payload.perceptionContext).toContain('You trust Bob deeply');
    expect(payload.perceptionContext).toContain('You know Bob very well');
  });
});

// ── AC-45: PerceptionBuilder with low trust/familiarity ───────────────────────

describe('AC-45: PerceptionBuilder relationship context (low trust)', () => {
  it('includes distrust and barely know lines for low values', () => {
    const builder = new PerceptionBuilderImpl();
    const pr: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 50 },
        agentsPresent: [
          { agentId: 'agent-bob', name: 'Bob', currentActivity: 'idle', isThinking: false },
        ],
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
      relationships: { 'agent-bob': { trust: 20, familiarity: 5, lastInteraction: 100 } },
    };
    const payload = builder.build(pr);
    expect(payload.perceptionContext).toContain('You deeply distrust Bob');
    expect(payload.perceptionContext).toContain('You barely know Bob');
  });
});

// ── AC-46: Social drive prompt hint ───────────────────────────────────────────

describe('AC-46: PerceptionBuilder social drive hint', () => {
  it('includes social hint when primary drive is social and agents present', () => {
    const builder = new PerceptionBuilderImpl();
    const pr: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { social: 10 },
        agentsPresent: [
          { agentId: 'agent-bob', name: 'Bob', currentActivity: 'idle', isThinking: false },
        ],
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low social, need to restore social',
    };
    const payload = builder.build(pr);
    expect(payload.perceptionContext).toContain('You feel a strong need for social interaction');
  });

  it('does NOT include social hint when primary drive is NOT social', () => {
    const builder = new PerceptionBuilderImpl();
    const pr: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 10 },
        agentsPresent: [
          { agentId: 'agent-bob', name: 'Bob', currentActivity: 'idle', isThinking: false },
        ],
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy, need to restore energy',
    };
    const payload = builder.build(pr);
    expect(payload.perceptionContext).not.toContain(
      'You feel a strong need for social interaction',
    );
  });

  it('does NOT include social hint when no agents present', () => {
    const builder = new PerceptionBuilderImpl();
    const pr: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { social: 10 },
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low social, need to restore social',
    };
    const payload = builder.build(pr);
    expect(payload.perceptionContext).not.toContain(
      'You feel a strong need for social interaction',
    );
  });
});

// ── AC-47: PlanBuilder with agentsPresent ─────────────────────────────────────

describe('AC-47: PlanBuilderImpl with agentsPresent', () => {
  it('includes social context and social tools alongside formulate_plan', () => {
    const builder = new PlanBuilderImpl();
    const pr: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 50 },
        agentsPresent: [
          { agentId: 'agent-bob', name: 'Bob', currentActivity: 'idle', isThinking: false },
        ],
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
    };
    const payload = builder.build(pr);
    expect(payload.perceptionContext).toContain('Agents present: Bob (idle)');
    const toolNames = payload.tools.map((t) => t.function.name);
    expect(toolNames).toContain('formulate_plan');
    expect(toolNames).toContain('talk_to');
    expect(toolNames).toContain('observe_agent');
    expect(toolNames).toContain('help');
    expect(toolNames).toContain('ignore');
  });
});

// ── AC-48: PlanBuilder social drive hint (spec 024 updated) ───────────────

describe('AC-48: PlanBuilderImpl social drive hint', () => {
  it('includes strengthened social hint when primary drive is social and agents present (spec 024, Req 4)', () => {
    const builder = new PlanBuilderImpl();
    const pr: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { social: 10 },
        agentsPresent: [
          { agentId: 'agent-bob', name: 'Bob', currentActivity: 'idle', isThinking: false },
        ],
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low social, need to restore social',
    };
    const payload = builder.build(pr);
    // Spec 024, Req 4: the old hedging hint is replaced by a stronger imperative.
    expect(payload.perceptionContext).toContain(
      'Your social drive is your most urgent need. Call talk_to or help NOW to interact with another agent in this room. Do not formulate a plan first.',
    );
    // The old soft hint should no longer be present.
    expect(payload.perceptionContext).not.toContain(
      'You feel a strong need for social interaction',
    );
  });
});

// ── AC-54: CognitiveToolExecutorImpl imports from shared only ─────────────────

describe('AC-54: Package boundaries — CognitiveToolExecutorImpl', () => {
  it('does not import from @evol-hive/engine', async () => {
    const source = await import('../src/tools/cognitive-tool-executor.js?raw');
    const code = (source as any).default ?? '';
    // Check that there are no actual import statements from @evol-hive/engine
    const importPattern = /^\s*import[\s\S]*?from\s+['"]@evol-hive\/engine['"]/m;
    expect(importPattern.test(code)).toBe(false);
  });
});

// ── AC-55: OpenAICompatibleLLMClient imports from shared only ─────────────────

describe('AC-55: Package boundaries — OpenAICompatibleLLMClient', () => {
  it('does not import from @evol-hive/engine', async () => {
    const source = await import('../src/llm/openai-client.js?raw');
    const code = (source as any).default ?? '';
    const importPattern = /^\s*import[\s\S]*?from\s+['"]@evol-hive\/engine['"]/m;
    expect(importPattern.test(code)).toBe(false);
  });
});

// ── AC-59: Graceful degradation with missing provider methods ─────────────────

describe('AC-59: PassivePerceptionAssembler handles missing methods gracefully', () => {
  it('works with minimal provider (no social methods)', () => {
    const provider: any = {
      getAgentLocation: vi.fn().mockReturnValue('kitchen'),
      getObjectsInRoom: vi.fn().mockReturnValue([]),
      getAffordancesInRoom: vi.fn().mockReturnValue([]),
      getAgentDrives: vi.fn().mockReturnValue({ energy: 50 }),
      getPrimaryDriveLabel: vi.fn().mockReturnValue('low energy'),
      getSystemFeedback: vi.fn().mockReturnValue(undefined),
    };
    const assembler = new PassivePerceptionAssembler(provider);
    const passive = assembler.buildPassivePerception('a');
    expect(passive.agentsPresent).toBeUndefined();
    expect(passive.socialContext).toBeUndefined();
    expect(passive.roomId).toBe('kitchen');
    expect(passive.drives).toEqual({ energy: 50 });
  });
});
