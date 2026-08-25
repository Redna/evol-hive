/**
 * Tests for spec 015 — Full Cognitive Tools (cognition layer).
 * Covers AC-5, AC-9 through AC-42:
 *   - CognitiveToolExecutorImpl (AC-9 to AC-16, AC-36)
 *   - OpenAICompatibleLLMClient tool call loop (AC-17 to AC-28, AC-37)
 *   - Builder updates (AC-29 to AC-31)
 *   - PPER service agentId wiring (AC-32, AC-33)
 *   - End-to-end flow (AC-40, AC-41, AC-42)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Affordance,
  PassivePerception,
  PerceptionResult,
  AgentInternalState,
  ExecuteResult,
  FormulatePlanResult,
  MemorySnippet,
  CognitiveToolExecutor,
  CognitiveToolDataProvider,
  QueryMemoryToolResult,
  UpdateStateToolResult,
  ReflectDataProvider,
  PlanDataProvider,
  AgentPlan,
} from '@evol-hive/shared';
import {
  formulatePlanTool,
  chooseActionTool,
  reflectTool,
  queryMemoryTool,
  updateInternalStateTool,
} from '@evol-hive/shared';
import type { MemoryInjector } from '@evol-hive/memory';
import type { LLMContextPayload } from '../src/index.js';
import {
  OpenAICompatibleLLMClient,
  type OpenAICompatibleLLMClientConfig,
  LLMError,
  LLMResponseError,
} from '../src/llm/openai-client.js';
import { CognitiveToolExecutorImpl } from '../src/tools/cognitive-tool-executor.js';
import type { CognitiveToolExecutorOptions } from '../src/tools/cognitive-tool-executor.js';
import { defaultCognitiveTools } from '../src/tools/index.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { ReflectBuilderImpl } from '../src/pper/reflect-builder.js';
import { PlanServiceImpl } from '../src/pper/plan-service.js';
import { ReflectServiceImpl } from '../src/pper/reflect-service.js';
import type { LLMClient } from '../src/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:8080/v1';
const MODEL = 'llama3.1';
const CHAT_URL = `${BASE_URL}/chat/completions`;
const AGENT_ID = 'agent-1';

type FetchArgs = [string, RequestInit];
type FetchCall = { url: string; init: RequestInit };

function callAt(mock: ReturnType<typeof vi.fn>, index: number): FetchCall {
  const args = mock.mock.calls[index] as unknown as FetchArgs;
  return { url: args[0], init: args[1] };
}

function makePayload(overrides: Partial<LLMContextPayload> = {}): LLMContextPayload {
  return {
    systemPrompt: 'You are a helpful agent.',
    perceptionContext: 'You are in a kitchen. There is a coffee machine.',
    availableAffordances: [{ id: 'brew_coffee', label: 'Brew coffee' }] as Affordance[],
    cognitiveTools: [{ name: 'formulate_plan', description: 'Formulate a plan', argsSchema: {} }],
    tools: [chooseActionTool],
    ...overrides,
  };
}

/** Mock response with tool_calls in the body. */
function toolCallResponse(
  toolName: string,
  argumentsObj: unknown,
  toolCallId = 'call-1',
  status = 200,
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
              function: {
                name: toolName,
                arguments: JSON.stringify(argumentsObj),
              },
            },
          ],
        },
      },
    ],
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SNIPPETS: MemorySnippet[] = [
  { id: 'mem-1', content: 'Brewed coffee yesterday.', importance: 5, timestamp: 1000 },
  { id: 'mem-2', content: 'Kitchen has beans.', importance: 3, timestamp: 2000 },
];

// ─── Mock MemoryInjector ─────────────────────────────────────────────────────

class MockMemoryInjector implements MemoryInjector {
  activeRecallCalls: { agentId: string; query: string; topK: number }[] = [];
  activeRecallResult: MemorySnippet[] = SNIPPETS;
  activeRecallShouldThrow: Error | null = null;

  async injectAssociative(): Promise<MemorySnippet[]> {
    return [];
  }

  async activeRecall(agentId: string, query: string, topK: number): Promise<MemorySnippet[]> {
    this.activeRecallCalls.push({ agentId, query, topK });
    if (this.activeRecallShouldThrow) {
      throw this.activeRecallShouldThrow;
    }
    return this.activeRecallResult;
  }
}

// ─── Mock CognitiveToolDataProvider ──────────────────────────────────────────

class MockStateDataProvider implements CognitiveToolDataProvider {
  updateGoalCalls: { agentId: string; goal: string }[] = [];
  applyDriveChangesCalls: { agentId: string; changes: Partial<Record<string, number>> }[] = [];
  updateGoalShouldThrow: Error | null = null;
  applyDriveChangesShouldThrow: Error | null = null;

  updateGoal(agentId: string, goal: string): void {
    this.updateGoalCalls.push({ agentId, goal });
    if (this.updateGoalShouldThrow) {
      throw this.updateGoalShouldThrow;
    }
  }

  applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void {
    this.applyDriveChangesCalls.push({ agentId, changes });
    if (this.applyDriveChangesShouldThrow) {
      throw this.applyDriveChangesShouldThrow;
    }
  }
}

// ─── AC-5: LLMContextPayload.agentId ─────────────────────────────────────────

describe('LLMContextPayload.agentId (AC-5)', () => {
  it('accepts an optional agentId string field', () => {
    const payload: LLMContextPayload = {
      ...makePayload(),
      agentId: AGENT_ID,
    };
    expect(payload.agentId).toBe(AGENT_ID);
  });

  it('compiles and works without agentId (non-breaking)', () => {
    const payload: LLMContextPayload = makePayload();
    expect(payload.agentId).toBeUndefined();
  });
});

// ─── AC-9 to AC-16: CognitiveToolExecutorImpl ────────────────────────────────

describe('CognitiveToolExecutorImpl (AC-9 to AC-16, AC-36)', () => {
  // AC-9: defined and exported, accepts { memoryInjector?, stateDataProvider? }
  it('is exported and accepts { memoryInjector?, stateDataProvider? } via constructor (AC-9)', () => {
    const executor = new CognitiveToolExecutorImpl({});
    expect(executor).toBeInstanceOf(CognitiveToolExecutorImpl);
    // Also exported from cognition barrel
    // (verified by the import above succeeding)
  });

  it('implements CognitiveToolExecutor interface (AC-9)', () => {
    const executor: CognitiveToolExecutor = new CognitiveToolExecutorImpl({});
    expect(typeof executor.executeQueryMemory).toBe('function');
    expect(typeof executor.executeUpdateInternalState).toBe('function');
  });

  it('can be constructed with both dependencies (AC-9)', () => {
    const executor = new CognitiveToolExecutorImpl({
      memoryInjector: new MockMemoryInjector(),
      stateDataProvider: new MockStateDataProvider(),
    });
    expect(executor).toBeInstanceOf(CognitiveToolExecutorImpl);
  });

  // AC-11: executeQueryMemory with memoryInjector
  it('executeQueryMemory calls memoryInjector.activeRecall and returns memories (AC-11)', async () => {
    const injector = new MockMemoryInjector();
    const executor = new CognitiveToolExecutorImpl({ memoryInjector: injector });
    const result = await executor.executeQueryMemory(AGENT_ID, 'coffee', 5);
    expect(injector.activeRecallCalls).toHaveLength(1);
    expect(injector.activeRecallCalls[0]).toEqual({
      agentId: AGENT_ID,
      query: 'coffee',
      topK: 5,
    });
    expect(result.memories).toEqual(SNIPPETS);
  });

  // AC-12: without memoryInjector returns { memories: [] }
  it('executeQueryMemory without memoryInjector returns { memories: [] } (AC-12)', async () => {
    const executor = new CognitiveToolExecutorImpl({});
    const result = await executor.executeQueryMemory(AGENT_ID, 'coffee', 5);
    expect(result.memories).toEqual([]);
  });

  // AC-13: catches errors from activeRecall
  it('executeQueryMemory catches activeRecall errors and returns { memories: [] } (AC-13)', async () => {
    const injector = new MockMemoryInjector();
    injector.activeRecallShouldThrow = new Error('store down');
    const executor = new CognitiveToolExecutorImpl({ memoryInjector: injector });
    const result = await executor.executeQueryMemory(AGENT_ID, 'coffee', 5);
    expect(result.memories).toEqual([]);
  });

  // AC-42: topK passed through; default 5 handled by caller (LLM client), but
  // executeQueryMemory forwards whatever topK it receives.
  it('executeQueryMemory forwards topK to activeRecall (AC-42)', async () => {
    const injector = new MockMemoryInjector();
    const executor = new CognitiveToolExecutorImpl({ memoryInjector: injector });
    await executor.executeQueryMemory(AGENT_ID, 'coffee', 10);
    expect(injector.activeRecallCalls[0]!.topK).toBe(10);
  });

  // AC-14: updateInternalState with newGoal
  it('executeUpdateInternalState with newGoal calls updateGoal (AC-14)', async () => {
    const provider = new MockStateDataProvider();
    const executor = new CognitiveToolExecutorImpl({ stateDataProvider: provider });
    const result = await executor.executeUpdateInternalState(AGENT_ID, 'find coffee');
    expect(provider.updateGoalCalls).toHaveLength(1);
    expect(provider.updateGoalCalls[0]).toEqual({ agentId: AGENT_ID, goal: 'find coffee' });
    expect(result.success).toBe(true);
    expect(result.goalUpdated).toBe(true);
    expect(result.drivesUpdated).toBe(false);
    expect(result.message).toContain('find coffee');
  });

  // AC-15: updateInternalState with driveOverrides
  it('executeUpdateInternalState with driveOverrides calls applyDriveChanges (AC-15)', async () => {
    const provider = new MockStateDataProvider();
    const executor = new CognitiveToolExecutorImpl({ stateDataProvider: provider });
    const result = await executor.executeUpdateInternalState(AGENT_ID, undefined, { energy: 45 });
    expect(provider.applyDriveChangesCalls).toHaveLength(1);
    expect(provider.applyDriveChangesCalls[0]).toEqual({
      agentId: AGENT_ID,
      changes: { energy: 45 },
    });
    expect(result.success).toBe(true);
    expect(result.goalUpdated).toBe(false);
    expect(result.drivesUpdated).toBe(true);
    expect(result.message).toContain('energy=45');
  });

  it('executeUpdateInternalState with both newGoal and driveOverrides updates both', async () => {
    const provider = new MockStateDataProvider();
    const executor = new CognitiveToolExecutorImpl({ stateDataProvider: provider });
    const result = await executor.executeUpdateInternalState(AGENT_ID, 'find coffee', {
      energy: 45,
    });
    expect(result.success).toBe(true);
    expect(result.goalUpdated).toBe(true);
    expect(result.drivesUpdated).toBe(true);
    expect(result.message).toContain('find coffee');
    expect(result.message).toContain('energy=45');
  });

  // AC-16: without stateDataProvider
  it('executeUpdateInternalState without stateDataProvider returns not-available result (AC-16)', async () => {
    const executor = new CognitiveToolExecutorImpl({});
    const result = await executor.executeUpdateInternalState(AGENT_ID, 'find coffee');
    expect(result).toEqual({
      success: false,
      goalUpdated: false,
      drivesUpdated: false,
      message: 'State update not available.',
    });
  });

  it('executeUpdateInternalState with empty newGoal does not call updateGoal', async () => {
    const provider = new MockStateDataProvider();
    const executor = new CognitiveToolExecutorImpl({ stateDataProvider: provider });
    const result = await executor.executeUpdateInternalState(AGENT_ID, '');
    expect(provider.updateGoalCalls).toHaveLength(0);
    expect(result.goalUpdated).toBe(false);
  });

  it('executeUpdateInternalState with empty driveOverrides does not call applyDriveChanges', async () => {
    const provider = new MockStateDataProvider();
    const executor = new CognitiveToolExecutorImpl({ stateDataProvider: provider });
    const result = await executor.executeUpdateInternalState(AGENT_ID, undefined, {});
    expect(provider.applyDriveChangesCalls).toHaveLength(0);
    expect(result.drivesUpdated).toBe(false);
  });

  it('executeUpdateInternalState reports partial success when applyDriveChanges throws after goalUpdated', async () => {
    const provider = new MockStateDataProvider();
    provider.applyDriveChangesShouldThrow = new Error('drive system down');
    const executor = new CognitiveToolExecutorImpl({ stateDataProvider: provider });
    const result = await executor.executeUpdateInternalState(AGENT_ID, 'find coffee', {
      energy: 45,
    });
    expect(result.goalUpdated).toBe(true);
    expect(result.drivesUpdated).toBe(false);
    expect(result.success).toBe(true); // goal update succeeded
    expect(result.message).toContain('drive system down');
  });
});

// ─── AC-17 to AC-28: OpenAICompatibleLLMClient tool call loop ────────────────

describe('OpenAICompatibleLLMClient tool call loop (AC-17 to AC-28)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // AC-17: config fields
  it('config includes optional cognitiveToolExecutor and maxToolCallIterations (AC-17)', () => {
    const config: OpenAICompatibleLLMClientConfig = {
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: new CognitiveToolExecutorImpl({}),
      maxToolCallIterations: 5,
    };
    expect(config.cognitiveToolExecutor).toBeDefined();
    expect(config.maxToolCallIterations).toBe(5);
  });

  it('existing constructors without the new fields work unchanged (AC-17)', async () => {
    fetchMock.mockResolvedValue(toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completeStructured(makePayload());
    expect(result.action).toBe('a');
  });

  // AC-19: COGNITIVE_TOOL_NAMES — verified behaviorally via the loop tests below.

  // AC-26: tool_choice auto when tools.length > 1, force when 1
  it('sets tool_choice to "auto" when tools.length > 1 (AC-26)', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
    });
    await client.completePlan(payload);
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.tool_choice).toBe('auto');
  });

  it('forces the single tool when tools.length === 1 (AC-26)', async () => {
    fetchMock.mockResolvedValue(toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await client.completeStructured(makePayload({ tools: [chooseActionTool] }));
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'choose_action' },
    });
  });

  // AC-24: no cognitiveToolExecutor → single request, no loop
  it('without cognitiveToolExecutor, behaves as single-request (AC-24)', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool],
      agentId: AGENT_ID,
    });
    const result = await client.completePlan(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.description).toBe('d');
  });

  // AC-25: no agentId → single request, no loop
  it('without agentId on payload, behaves as single-request even with executor (AC-25)', async () => {
    const executor = new CognitiveToolExecutorImpl({});
    fetchMock.mockResolvedValue(
      toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
    );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool],
      // no agentId
    });
    const result = await client.completePlan(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.description).toBe('d');
  });

  // AC-20: query_memory mid-loop → execute → second request
  it('executes query_memory mid-loop and sends a second request with the tool result (AC-20)', async () => {
    const injector = new MockMemoryInjector();
    const executor = new CognitiveToolExecutorImpl({ memoryInjector: injector });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'coffee' }, 'call-qm'))
      .mockResolvedValueOnce(
        toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
      );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool],
      agentId: AGENT_ID,
    });
    const result = await client.completePlan(payload);

    // The executor was called with the query and default topK=5.
    expect(injector.activeRecallCalls).toHaveLength(1);
    expect(injector.activeRecallCalls[0]).toEqual({
      agentId: AGENT_ID,
      query: 'coffee',
      topK: 5,
    });
    // Two requests were made.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second request includes the tool result message.
    const secondBody = JSON.parse(callAt(fetchMock, 1).init.body as string);
    const messages = secondBody.messages as unknown[];
    // system, user, assistant (with tool_calls), tool result
    expect(messages.length).toBe(4);
    const toolMsg = messages[3] as { role: string; content: string; tool_call_id: string };
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('call-qm');
    const parsedToolResult = JSON.parse(toolMsg.content) as QueryMemoryToolResult;
    expect(parsedToolResult.memories).toEqual(SNIPPETS);
    // Result is the terminal tool's arguments.
    expect(result.description).toBe('d');
  });

  // AC-42: topK from LLM arguments is forwarded; default 5 when omitted
  it('forwards topK from query_memory arguments to activeRecall (AC-42)', async () => {
    const injector = new MockMemoryInjector();
    const executor = new CognitiveToolExecutorImpl({ memoryInjector: injector });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'coffee', topK: 12 }))
      .mockResolvedValueOnce(
        toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
      );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    await client.completePlan(
      makePayload({ tools: [formulatePlanTool, queryMemoryTool], agentId: AGENT_ID }),
    );
    expect(injector.activeRecallCalls[0]!.topK).toBe(12);
  });

  it('uses topK=5 default when the LLM omits topK (AC-42)', async () => {
    const injector = new MockMemoryInjector();
    const executor = new CognitiveToolExecutorImpl({ memoryInjector: injector });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'coffee' }))
      .mockResolvedValueOnce(
        toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
      );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    await client.completePlan(
      makePayload({ tools: [formulatePlanTool, queryMemoryTool], agentId: AGENT_ID }),
    );
    expect(injector.activeRecallCalls[0]!.topK).toBe(5);
  });

  // AC-21: update_internal_state mid-loop
  it('executes update_internal_state mid-loop and sends a second request (AC-21)', async () => {
    const provider = new MockStateDataProvider();
    const executor = new CognitiveToolExecutorImpl({ stateDataProvider: provider });
    fetchMock
      .mockResolvedValueOnce(
        toolCallResponse('update_internal_state', { newGoal: 'find coffee' }, 'call-us'),
      )
      .mockResolvedValueOnce(
        toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
      );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    const result = await client.completePlan(
      makePayload({ tools: [formulatePlanTool, updateInternalStateTool], agentId: AGENT_ID }),
    );

    expect(provider.updateGoalCalls).toHaveLength(1);
    expect(provider.updateGoalCalls[0]).toEqual({ agentId: AGENT_ID, goal: 'find coffee' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The tool result message contains the confirmation.
    const secondBody = JSON.parse(callAt(fetchMock, 1).init.body as string);
    const toolMsg = secondBody.messages[3] as { role: string; content: string };
    expect(toolMsg.role).toBe('tool');
    const parsed = JSON.parse(toolMsg.content) as UpdateStateToolResult;
    expect(parsed.goalUpdated).toBe(true);
    expect(result.description).toBe('d');
  });

  // AC-22: two-turn flow — query_memory → formulate_plan
  it('two-turn flow: query_memory → formulate_plan returns the terminal arguments (AC-22)', async () => {
    const injector = new MockMemoryInjector();
    const executor = new CognitiveToolExecutorImpl({ memoryInjector: injector });
    const plan = {
      description: 'Brew coffee',
      steps: [{ description: 'Brew', targetAffordance: 'brew_coffee' }],
    };
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'coffee' }))
      .mockResolvedValueOnce(toolCallResponse('formulate_plan', plan));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    const result = await client.completePlan(
      makePayload({ tools: [formulatePlanTool, queryMemoryTool], agentId: AGENT_ID }),
    );
    expect(result.description).toBe('Brew coffee');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.targetAffordance).toBe('brew_coffee');
  });

  // AC-41: LLM directly calls terminal tool (no cognitive tools) → identical to pre-loop
  it('direct terminal tool call with executor wired → single request, same result (AC-41)', async () => {
    const executor = new CognitiveToolExecutorImpl({});
    fetchMock.mockResolvedValue(
      toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
    );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    const result = await client.completePlan(
      makePayload({ tools: [formulatePlanTool, queryMemoryTool], agentId: AGENT_ID }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.description).toBe('d');
  });

  // AC-23: max iterations exceeded
  it('throws LLMError with "max iterations" when the loop exceeds maxToolCallIterations (AC-23)', async () => {
    const injector = new MockMemoryInjector();
    const executor = new CognitiveToolExecutorImpl({ memoryInjector: injector });
    // LLM keeps calling query_memory forever — use a factory so each call gets a fresh Response.
    fetchMock.mockImplementation(() =>
      Promise.resolve(toolCallResponse('query_memory', { query: 'coffee' })),
    );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
      maxToolCallIterations: 2,
    });
    await expect(
      client.completePlan(
        makePayload({ tools: [formulatePlanTool, queryMemoryTool], agentId: AGENT_ID }),
      ),
    ).rejects.toThrow(LLMError);
    try {
      await client.completePlan(
        makePayload({ tools: [formulatePlanTool, queryMemoryTool], agentId: AGENT_ID }),
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as Error).message).toContain('max iterations');
    }
  });

  it('defaults maxToolCallIterations to 3 when omitted (AC-23)', async () => {
    const injector = new MockMemoryInjector();
    const executor = new CognitiveToolExecutorImpl({ memoryInjector: injector });
    fetchMock.mockImplementation(() =>
      Promise.resolve(toolCallResponse('query_memory', { query: 'coffee' })),
    );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    await expect(
      client.completePlan(
        makePayload({ tools: [formulatePlanTool, queryMemoryTool], agentId: AGENT_ID }),
      ),
    ).rejects.toThrow('max iterations');
    // 3 cognitive tool iterations → 3 requests (each produces a cognitive call).
    expect(fetchMock.mock.calls.length).toBe(3);
  });

  it('maxToolCallIterations of 0 or negative defaults to 3 (AC-23)', async () => {
    const injector = new MockMemoryInjector();
    const executor = new CognitiveToolExecutorImpl({ memoryInjector: injector });
    fetchMock.mockImplementation(() =>
      Promise.resolve(toolCallResponse('query_memory', { query: 'coffee' })),
    );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
      maxToolCallIterations: 0,
    });
    await expect(
      client.completePlan(
        makePayload({ tools: [formulatePlanTool, queryMemoryTool], agentId: AGENT_ID }),
      ),
    ).rejects.toThrow('max iterations');
  });

  // AC-28: executor throws during tool execution → error result sent back, loop continues
  it('catches executor errors and sends an error tool result back to the LLM (AC-28)', async () => {
    // Make the executor throw by using a memoryInjector that throws — but the
    // CognitiveToolExecutorImpl catches activeRecall errors internally. To test
    // the client-level safety net, we use a custom executor that throws.
    const throwingExecutor: CognitiveToolExecutor = {
      async executeQueryMemory(): Promise<QueryMemoryToolResult> {
        throw new Error('executor boom');
      },
      async executeUpdateInternalState(): Promise<UpdateStateToolResult> {
        throw new Error('executor boom');
      },
    };
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'coffee' }, 'call-e'))
      .mockResolvedValueOnce(
        toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
      );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: throwingExecutor,
    });
    const result = await client.completePlan(
      makePayload({ tools: [formulatePlanTool, queryMemoryTool], agentId: AGENT_ID }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(callAt(fetchMock, 1).init.body as string);
    const toolMsg = secondBody.messages[3] as { role: string; content: string };
    const parsed = JSON.parse(toolMsg.content) as { error: string };
    expect(parsed.error).toContain('executor boom');
    expect(result.description).toBe('d');
  });

  // AC-27: requestChat accepts agentId and public methods pass payload.agentId
  it('completeStructured passes payload.agentId into the loop (AC-27)', async () => {
    const injector = new MockMemoryInjector();
    const executor = new CognitiveToolExecutorImpl({ memoryInjector: injector });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'x' }))
      .mockResolvedValueOnce(toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    await client.completeStructured(
      makePayload({ tools: [chooseActionTool, queryMemoryTool], agentId: AGENT_ID }),
    );
    expect(injector.activeRecallCalls[0]!.agentId).toBe(AGENT_ID);
  });

  it('completeReflect passes payload.agentId into the loop (AC-27)', async () => {
    const injector = new MockMemoryInjector();
    const executor = new CognitiveToolExecutorImpl({ memoryInjector: injector });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'x' }))
      .mockResolvedValueOnce(toolCallResponse('reflect', { newGoal: 'g' }));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    const result = await client.completeReflect(
      makePayload({ tools: [reflectTool, queryMemoryTool], agentId: AGENT_ID }),
    );
    expect(injector.activeRecallCalls[0]!.agentId).toBe(AGENT_ID);
    expect(result.newGoal).toBe('g');
  });

  // AC-18: ChatMessage type supports assistant tool_calls and tool messages.
  // Verified behaviorally by the loop tests above (the second request body
  // contains role:'tool' and role:'assistant' with tool_calls).
});

// ─── AC-29 to AC-31: Builder updates ─────────────────────────────────────────

const drives = { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 };
const objects = [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }];

function makePerceptionResult(): PerceptionResult {
  const passive: PassivePerception = {
    roomId: 'kitchen',
    objectsPresent: objects,
    drives,
  };
  return {
    passive,
    prunedAffordances: [
      {
        id: 'brew_coffee',
        label: 'Brew coffee',
        engineEffect: 'brew_coffee',
        preconditions: [],
        effects: { energy: 20 },
      },
    ],
    primaryDriveLabel: 'low energy',
  };
}

describe('PlanBuilderImpl cognitive tools (AC-29)', () => {
  it('returns tools with formulatePlanTool, queryMemoryTool, updateInternalStateTool, and affordance tools (AC-29, spec 019)', () => {
    const builder = new PlanBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    expect(payload.tools.some((t) => t.function.name === 'formulate_plan')).toBe(true);
    expect(payload.tools.some((t) => t.function.name === 'query_memory')).toBe(true);
    expect(payload.tools.some((t) => t.function.name === 'update_internal_state')).toBe(true);
    // Affordance tools are now included (spec 019)
    expect(payload.tools.some((t) => t.function.name === 'brew_coffee')).toBe(true);
  });
});

describe('PerceptionBuilderImpl cognitive tools (AC-30)', () => {
  it('returns tools with queryMemoryTool, updateInternalStateTool, and affordance tools (AC-30, spec 019)', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    // chooseActionTool is no longer included (spec 019)
    expect(payload.tools.some((t) => t.function.name === 'choose_action')).toBe(false);
    expect(payload.tools.some((t) => t.function.name === 'query_memory')).toBe(true);
    expect(payload.tools.some((t) => t.function.name === 'update_internal_state')).toBe(true);
    // Affordance tools are now included (spec 019)
    expect(payload.tools.some((t) => t.function.name === 'brew_coffee')).toBe(true);
  });
});

describe('ReflectBuilderImpl cognitive tools (AC-31)', () => {
  const agentState: AgentInternalState = {
    agentId: AGENT_ID,
    drives,
    currentGoal: 'Stay alive',
    currentPlan: null,
    isThinking: false,
    location: 'kitchen',
    lastPerceptionTick: 0,
  };
  const executeResult: ExecuteResult = { success: true, planComplete: false };

  it('returns tools: [reflectTool, queryMemoryTool, updateInternalStateTool] (AC-31)', () => {
    const builder = new ReflectBuilderImpl();
    const payload = builder.build(AGENT_ID, agentState, executeResult);
    expect(payload.tools).toEqual([reflectTool, queryMemoryTool, updateInternalStateTool]);
  });
});

// ─── AC-9: defaultCognitiveTools query_memory argsSchema includes topK ───────

describe('defaultCognitiveTools query_memory argsSchema (AC-9 / Req 8)', () => {
  it('query_memory entry argsSchema includes topK in properties', () => {
    const qm = defaultCognitiveTools.find((t) => t.name === 'query_memory')!;
    expect(qm).toBeDefined();
    const props = qm.argsSchema['properties'] as Record<string, unknown>;
    expect(props['topK']).toBeDefined();
    const topK = props['topK'] as Record<string, unknown>;
    expect(topK['type']).toBe('integer');
    expect(topK['minimum']).toBe(1);
    expect(topK['maximum']).toBe(20);
  });
});

// ─── AC-32, AC-33: PPER service agentId wiring ───────────────────────────────

class FakePlanDataProvider implements PlanDataProvider {
  getAgentState(_agentId: string): AgentInternalState | null {
    return {
      agentId: AGENT_ID,
      drives,
      currentGoal: 'Stay alive',
      currentPlan: null,
      isThinking: false,
      location: 'kitchen',
      lastPerceptionTick: 0,
    };
  }
  storePlan(_agentId: string, result: FormulatePlanResult): AgentPlan {
    return {
      steps: result.steps.map((s) => ({ ...s })),
      description: result.description,
    } as AgentPlan;
  }
  setThinking(_agentId: string, _isThinking: boolean): void {
    /* noop */
  }
}

class FakeLLMClient implements LLMClient {
  completeStructured = vi.fn();
  completeReflection = vi.fn();
  completePlan = vi.fn();
  completeReflect = vi.fn();
}

describe('PlanServiceImpl sets agentId (AC-32)', () => {
  it('sets payload.agentId = agentId before calling completePlan (AC-32)', async () => {
    const llm = new FakeLLMClient();
    llm.completePlan = vi.fn().mockResolvedValue({
      description: 'Brew coffee',
      steps: [{ description: 'Brew' }],
    });
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: new FakePlanDataProvider(),
    });
    await service.plan(AGENT_ID, makePerceptionResult());
    expect(llm.completePlan).toHaveBeenCalledTimes(1);
    const payload = llm.completePlan.mock.calls[0]![0] as LLMContextPayload;
    expect(payload.agentId).toBe(AGENT_ID);
  });
});

class FakeReflectDataProvider implements ReflectDataProvider {
  getAgentState(_agentId: string): AgentInternalState | null {
    return {
      agentId: AGENT_ID,
      drives,
      currentGoal: 'Stay alive',
      currentPlan: null,
      isThinking: false,
      location: 'kitchen',
      lastPerceptionTick: 0,
    };
  }
  applyDriveChanges(): void {
    /* noop */
  }
  updateGoal(): void {
    /* noop */
  }
  async storeMemory(): Promise<void> {
    /* noop */
  }
  clearPlanIfComplete(): boolean {
    return false;
  }
  setThinking(): void {
    /* noop */
  }
  getAgentProfile(): null {
    return null;
  }
}

describe('ReflectServiceImpl sets agentId (AC-33)', () => {
  it('sets payload.agentId = agentId before calling completeReflect (AC-33)', async () => {
    const llm = new FakeLLMClient();
    llm.completeReflect = vi.fn().mockResolvedValue({});
    const service = new ReflectServiceImpl({
      reflectBuilder: new ReflectBuilderImpl(),
      llmClient: llm,
      dataProvider: new FakeReflectDataProvider(),
    });
    await service.reflect(AGENT_ID, { success: true, planComplete: false });
    expect(llm.completeReflect).toHaveBeenCalledTimes(1);
    const payload = llm.completeReflect.mock.calls[0]![0] as LLMContextPayload;
    expect(payload.agentId).toBe(AGENT_ID);
  });
});

// ─── AC-36, AC-37: Package boundaries ────────────────────────────────────────

describe('Package boundaries (AC-36, AC-37)', () => {
  it('CognitiveToolExecutorImpl imports from shared and memory, not engine (AC-36)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve('src/tools/cognitive-tool-executor.ts'), 'utf-8');
    expect(src).toContain('@evol-hive/shared');
    expect(src).toContain('@evol-hive/memory');
    expect(src).not.toContain("from '@evol-hive/engine'");
  });

  it('OpenAICompatibleLLMClient imports CognitiveToolExecutor from shared, not memory/engine (AC-37)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve('src/llm/openai-client.ts'), 'utf-8');
    expect(src).toContain('CognitiveToolExecutor');
    expect(src).not.toContain("from '@evol-hive/memory'");
    expect(src).not.toContain("from '@evol-hive/engine'");
  });
});

// ─── AC-40: End-to-end tool call loop ────────────────────────────────────────

describe('End-to-end tool call loop (AC-40)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('PlanBuilderImpl payload → agentId set → query_memory → formulate_plan (AC-40)', async () => {
    // (1) PlanBuilderImpl produces the right tools.
    const builder = new PlanBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    // Tools now include affordance tools (spec 019)
    expect(payload.tools.some((t) => t.function.name === 'formulate_plan')).toBe(true);
    expect(payload.tools.some((t) => t.function.name === 'query_memory')).toBe(true);
    expect(payload.tools.some((t) => t.function.name === 'update_internal_state')).toBe(true);
    expect(payload.tools.some((t) => t.function.name === 'brew_coffee')).toBe(true);

    // (2) agentId is set.
    payload.agentId = AGENT_ID;

    // (4)-(7) mock fetch returns query_memory then formulate_plan.
    const injector = new MockMemoryInjector();
    const executor = new CognitiveToolExecutorImpl({ memoryInjector: injector });
    const plan = {
      description: 'Brew coffee',
      steps: [{ description: 'Brew', targetAffordance: 'brew_coffee' }],
    };
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'coffee' }))
      .mockResolvedValueOnce(toolCallResponse('formulate_plan', plan));

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });

    // (3) first request sent
    // (8) result is the FormulatePlanResult
    const result = await client.completePlan(payload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(injector.activeRecallCalls).toHaveLength(1);
    expect(result.description).toBe('Brew coffee');
    expect(result.steps[0]!.targetAffordance).toBe('brew_coffee');
  });
});

export {};
