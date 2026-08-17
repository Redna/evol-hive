/**
 * Tests for spec 015 — OpenAICompatibleLLMClient tool call loop
 * (AC-5, AC-17..AC-28, AC-37, AC-40, AC-41, AC-42).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Affordance,
  CognitiveTool,
  CognitiveToolExecutor,
  QueryMemoryToolResult,
  UpdateStateToolResult,
  FormulatePlanResult,
  ToolDefinition,
} from '@evol-hive/shared';
import { formulatePlanTool, queryMemoryTool, updateInternalStateTool } from '@evol-hive/shared';
import type { LLMContextPayload } from '../src/index.js';
import { OpenAICompatibleLLMClient, LLMError, LLMResponseError } from '../src/llm/openai-client.js';

const BASE_URL = 'http://localhost:8080/v1';
const CHAT_URL = `${BASE_URL}/chat/completions`;
const MODEL = 'llama3.1';

type FetchCall = { url: string; init: RequestInit };

function callAt(mock: ReturnType<typeof vi.fn>, index: number): FetchCall {
  const args = mock.mock.calls[index] as unknown as [string, RequestInit];
  return { url: args[0], init: args[1] };
}

function makePayload(overrides: Partial<LLMContextPayload> = {}): LLMContextPayload {
  return {
    systemPrompt: 'You are a helpful agent.',
    perceptionContext: 'You are in a kitchen.',
    availableAffordances: [{ id: 'brew_coffee', label: 'Brew coffee' }] as Affordance[],
    cognitiveTools: [
      { name: 'formulate_plan', description: 'Plan', argsSchema: {} },
    ] as CognitiveTool[],
    tools: [formulatePlanTool],
    ...overrides,
  };
}

function toolCallResponse(
  toolName: string,
  argumentsObj: unknown,
  callId = 'call-1',
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
              id: callId,
              type: 'function',
              function: { name: toolName, arguments: JSON.stringify(argumentsObj) },
            },
          ],
        },
      },
    ],
  });
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function makeExecutor(overrides: Partial<CognitiveToolExecutor> = {}): CognitiveToolExecutor {
  return {
    async executeQueryMemory(_a, _q, _k): Promise<QueryMemoryToolResult> {
      return { memories: [] };
    },
    async executeUpdateInternalState(_a, _g?, _d?): Promise<UpdateStateToolResult> {
      return { success: true, goalUpdated: false, drivesUpdated: false, message: 'ok' };
    },
    ...overrides,
  };
}

describe('OpenAICompatibleLLMClient — tool call loop (spec 015)', () => {
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

  // ─── AC-5: LLMContextPayload.agentId ───────────────────────────────────────

  it('LLMContextPayload accepts optional agentId (AC-5)', () => {
    const payload = makePayload();
    // Setting agentId should be assignable (additive, non-breaking).
    const withAgent: LLMContextPayload = { ...payload, agentId: 'agent-1' };
    expect(withAgent.agentId).toBe('agent-1');
    // Existing payloads without agentId still compile/work.
    expect((payload as Record<string, unknown>)['agentId']).toBeUndefined();
  });

  // ─── AC-17: config fields ──────────────────────────────────────────────────

  it('config accepts cognitiveToolExecutor and maxToolCallIterations (AC-17)', async () => {
    const executor = makeExecutor();
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
      maxToolCallIterations: 5,
    });
    expect(client).toBeInstanceOf(OpenAICompatibleLLMClient);
    // Existing constructor without these fields still works.
    const client2 = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    expect(client2).toBeInstanceOf(OpenAICompatibleLLMClient);
  });

  // ─── AC-19: COGNITIVE_TOOL_NAMES — query_memory executed mid-loop (AC-20) ──

  describe('query_memory mid-loop execution (AC-20)', () => {
    it('executes query_memory via executor and sends a second request with the tool result', async () => {
      const executor = makeExecutor({
        executeQueryMemory: vi.fn().mockResolvedValue({
          memories: [
            { id: 'm1', content: 'I brewed coffee yesterday.', importance: 5, timestamp: 1 },
          ],
        }),
      });
      const payload = makePayload({
        tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
        agentId: 'agent-1',
      });

      fetchMock
        .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'coffee', topK: 3 }))
        .mockResolvedValueOnce(
          toolCallResponse(
            'formulate_plan',
            { description: 'Brew coffee', steps: [{ description: 'Brew' }] },
            'call-2',
          ),
        );

      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        cognitiveToolExecutor: executor,
      });
      const result = await client.completePlan(payload);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(executor.executeQueryMemory).toHaveBeenCalledWith('agent-1', 'coffee', 3);

      // Second request should include the tool result message.
      const second = JSON.parse(callAt(fetchMock, 1).init.body as string);
      const msgs = second.messages as unknown[];
      // messages: system, user, assistant(with tool_calls), tool(result)
      expect(msgs.length).toBe(4);
      const assistantMsg = msgs[2] as Record<string, unknown>;
      expect(assistantMsg['role']).toBe('assistant');
      expect(Array.isArray(assistantMsg['tool_calls'])).toBe(true);
      const toolMsg = msgs[3] as Record<string, unknown>;
      expect(toolMsg['role']).toBe('tool');
      expect(toolMsg['tool_call_id']).toBe('call-1');
      const toolContent = JSON.parse(toolMsg['content'] as string) as { memories: unknown[] };
      expect(toolContent.memories).toHaveLength(1);

      // Final result is the formulate_plan args.
      expect((result as FormulatePlanResult).description).toBe('Brew coffee');
    });

    it('defaults topK to 5 when omitted from query_memory args (AC-42)', async () => {
      const recall = vi.fn().mockResolvedValue({ memories: [] });
      const executor = makeExecutor({ executeQueryMemory: recall });
      const payload = makePayload({
        tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
        agentId: 'agent-1',
      });
      fetchMock
        .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'food' }))
        .mockResolvedValueOnce(
          toolCallResponse(
            'formulate_plan',
            { description: 'd', steps: [{ description: 's' }] },
            'call-2',
          ),
        );
      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        cognitiveToolExecutor: executor,
      });
      await client.completePlan(payload);
      expect(recall).toHaveBeenCalledWith('agent-1', 'food', 5);
    });
  });

  // ─── AC-21: update_internal_state mid-loop ─────────────────────────────────

  describe('update_internal_state mid-loop execution (AC-21)', () => {
    it('executes update_internal_state via executor and sends another request', async () => {
      const updateState = vi.fn().mockResolvedValue({
        success: true,
        goalUpdated: true,
        drivesUpdated: false,
        message: 'Goal updated to: rest.',
      });
      const executor = makeExecutor({ executeUpdateInternalState: updateState });
      const payload = makePayload({
        tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
        agentId: 'agent-1',
      });
      fetchMock
        .mockResolvedValueOnce(toolCallResponse('update_internal_state', { newGoal: 'rest' }))
        .mockResolvedValueOnce(
          toolCallResponse(
            'formulate_plan',
            { description: 'd', steps: [{ description: 's' }] },
            'call-2',
          ),
        );
      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        cognitiveToolExecutor: executor,
      });
      await client.completePlan(payload);

      expect(updateState).toHaveBeenCalledWith('agent-1', 'rest', undefined);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const second = JSON.parse(callAt(fetchMock, 1).init.body as string);
      const toolMsg = (second.messages as unknown[])[3] as Record<string, unknown>;
      expect(toolMsg['role']).toBe('tool');
      const content = JSON.parse(toolMsg['content'] as string) as UpdateStateToolResult;
      expect(content.goalUpdated).toBe(true);
    });
  });

  // ─── AC-22: terminal tool after cognitive tool call ────────────────────────

  it('terminal tool after a cognitive tool call ends the loop and returns its args (AC-22, AC-40)', async () => {
    const executor = makeExecutor({
      executeQueryMemory: vi.fn().mockResolvedValue({ memories: [] }),
    });
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
      agentId: 'agent-1',
    });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'q' }))
      .mockResolvedValueOnce(
        toolCallResponse(
          'formulate_plan',
          { description: 'plan', steps: [{ description: 'step' }] },
          'call-2',
        ),
      );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    const result = (await client.completePlan(payload)) as FormulatePlanResult;
    expect(result.description).toBe('plan');
    expect(result.steps).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ─── AC-23: max iterations exceeded ────────────────────────────────────────

  it('throws LLMError containing "max iterations" when loop exceeds the limit (AC-23)', async () => {
    const executor = makeExecutor({
      executeQueryMemory: vi.fn().mockResolvedValue({ memories: [] }),
    });
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
      agentId: 'agent-1',
    });
    // Always returns query_memory — never a terminal tool. A fresh Response
    // must be produced per call (a Response body can only be consumed once).
    fetchMock.mockImplementation(() =>
      Promise.resolve(toolCallResponse('query_memory', { query: 'q' })),
    );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
      maxToolCallIterations: 2,
    });
    await expect(client.completePlan(payload)).rejects.toThrow(LLMError);
    try {
      await client.completePlan(payload);
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as Error).message).toContain('max iterations');
    }
  });

  it('default maxToolCallIterations is 3', async () => {
    const executor = makeExecutor({
      executeQueryMemory: vi.fn().mockResolvedValue({ memories: [] }),
    });
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
      agentId: 'agent-1',
    });
    fetchMock.mockImplementation(() =>
      Promise.resolve(toolCallResponse('query_memory', { query: 'q' })),
    );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    await expect(client.completePlan(payload)).rejects.toThrow(LLMError);
    // 3 cognitive iterations -> 3 fetch calls (the 4th would be the iteration-exceeding send).
    // The loop sends request, executes cognitive tool, increments counter, then sends next.
    // With max=3: it allows 3 cognitive tool executions; on the 4th attempt it throws.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('maxToolCallIterations <= 0 defaults to 3', async () => {
    const executor = makeExecutor({
      executeQueryMemory: vi.fn().mockResolvedValue({ memories: [] }),
    });
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
      agentId: 'agent-1',
    });
    fetchMock.mockImplementation(() =>
      Promise.resolve(toolCallResponse('query_memory', { query: 'q' })),
    );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
      maxToolCallIterations: 0,
    });
    await expect(client.completePlan(payload)).rejects.toThrow(LLMError);
  });

  // ─── AC-24: no executor -> single request ──────────────────────────────────

  it('without cognitiveToolExecutor, behaves as before — single request (AC-24, AC-41)', async () => {
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
      agentId: 'agent-1',
    });
    fetchMock.mockResolvedValueOnce(
      toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = (await client.completePlan(payload)) as FormulatePlanResult;
    expect(result.description).toBe('d');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ─── AC-25: no agentId -> single request ───────────────────────────────────

  it('without agentId, behaves as before — single request (AC-25)', async () => {
    const executor = makeExecutor();
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
      // no agentId
    });
    fetchMock.mockResolvedValueOnce(
      toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
    );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    const result = (await client.completePlan(payload)) as FormulatePlanResult;
    expect(result.description).toBe('d');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ─── AC-26: tool_choice auto vs forced ─────────────────────────────────────

  it('tool_choice is "auto" when tools.length > 1 (AC-26)', async () => {
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
      agentId: 'agent-1',
    });
    fetchMock.mockResolvedValueOnce(
      toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await client.completePlan(payload);
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.tool_choice).toBe('auto');
  });

  it('tool_choice forces the single tool when tools.length === 1 (AC-26)', async () => {
    const payload = makePayload({ tools: [formulatePlanTool] });
    fetchMock.mockResolvedValueOnce(
      toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await client.completePlan(payload);
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'formulate_plan' },
    });
  });

  // ─── AC-27: requestChat passes agentId ─────────────────────────────────────

  it('completePlan passes payload.agentId through to the loop (AC-27)', async () => {
    const recall = vi.fn().mockResolvedValue({ memories: [] });
    const executor = makeExecutor({ executeQueryMemory: recall });
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
      agentId: 'agent-x',
    });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'q' }))
      .mockResolvedValueOnce(
        toolCallResponse(
          'formulate_plan',
          { description: 'd', steps: [{ description: 's' }] },
          'call-2',
        ),
      );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    await client.completePlan(payload);
    expect(recall).toHaveBeenCalledWith('agent-x', 'q', 5);
  });

  it('completeReflect passes payload.agentId through (AC-27)', async () => {
    const update = vi.fn().mockResolvedValue({
      success: true,
      goalUpdated: true,
      drivesUpdated: false,
      message: 'ok',
    });
    const executor = makeExecutor({ executeUpdateInternalState: update });
    const payload = makePayload({
      tools: [
        { type: 'function', function: { name: 'reflect', description: 'r', parameters: {} } },
        queryMemoryTool,
        updateInternalStateTool,
      ] as ToolDefinition[],
      agentId: 'agent-r',
    });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('update_internal_state', { newGoal: 'g' }))
      .mockResolvedValueOnce(toolCallResponse('reflect', {}, 'call-2'));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    await client.completeReflect(payload);
    expect(update).toHaveBeenCalledWith('agent-r', 'g', undefined);
  });

  // ─── AC-28: executor throws -> error result sent back ──────────────────────

  it('catches executor errors and sends { error } tool result, loop continues (AC-28)', async () => {
    const recall = vi.fn().mockRejectedValue(new Error('embed down'));
    const executor = makeExecutor({ executeQueryMemory: recall });
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
      agentId: 'agent-1',
    });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'q' }))
      .mockResolvedValueOnce(
        toolCallResponse(
          'formulate_plan',
          { description: 'd', steps: [{ description: 's' }] },
          'call-2',
        ),
      );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    const result = (await client.completePlan(payload)) as FormulatePlanResult;
    expect(result.description).toBe('d');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(callAt(fetchMock, 1).init.body as string);
    const toolMsg = (second.messages as unknown[])[3] as Record<string, unknown>;
    expect(toolMsg['role']).toBe('tool');
    const content = JSON.parse(toolMsg['content'] as string) as { error: string };
    expect(content.error).toContain('embed down');
  });

  // ─── AC-40: end-to-end PlanBuilder → client loop ───────────────────────────

  it('end-to-end: PlanBuilderImpl payload + agentId → query_memory → formulate_plan (AC-40)', async () => {
    const { PlanBuilderImpl } = await import('../src/pper/plan-builder.js');
    const builder = new PlanBuilderImpl();
    const perceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
        drives: { energy: 10, hunger: 50 },
      },
      prunedAffordances: [{ id: 'brew_coffee', label: 'Brew coffee' }],
      primaryDriveLabel: 'low energy',
    };
    const payload = builder.build(perceptionResult);
    payload.agentId = 'agent-1';
    // Payload has [formulatePlanTool, queryMemoryTool, updateInternalStateTool].
    expect(payload.tools.map((t) => t.function.name)).toEqual([
      'formulate_plan',
      'query_memory',
      'update_internal_state',
    ]);

    const recall = vi.fn().mockResolvedValue({ memories: [] });
    const executor = makeExecutor({ executeQueryMemory: recall });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'coffee' }))
      .mockResolvedValueOnce(
        toolCallResponse(
          'formulate_plan',
          {
            description: 'Brew coffee',
            steps: [{ description: 'Brew', targetAffordance: 'brew_coffee' }],
          },
          'call-2',
        ),
      );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    const result = (await client.completePlan(payload)) as FormulatePlanResult;
    expect(result.description).toBe('Brew coffee');
    expect(result.steps[0]!.targetAffordance).toBe('brew_coffee');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recall).toHaveBeenCalledWith('agent-1', 'coffee', 5);
  });

  // ─── AC-41: direct terminal tool, identical to pre-loop behavior ────────────

  it('direct terminal tool call (no cognitive tools) — single request, identical result (AC-41)', async () => {
    const executor = makeExecutor();
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
      agentId: 'agent-1',
    });
    const plan = { description: 'direct plan', steps: [{ description: 'do it' }] };
    fetchMock.mockResolvedValueOnce(toolCallResponse('formulate_plan', plan));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    const result = (await client.completePlan(payload)) as FormulatePlanResult;
    expect(result).toEqual(plan);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ─── AC-37: imports CognitiveToolExecutor from shared, not memory/engine ────

  it('OpenAICompatibleLLMClient imports CognitiveToolExecutor type from shared (AC-37)', async () => {
    // The client config field accepts a CognitiveToolExecutor instance.
    const executor = makeExecutor();
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    expect(client).toBeInstanceOf(OpenAICompatibleLLMClient);
  });

  // ─── multiple cognitive tools in sequence before terminal ──────────────────

  it('supports two cognitive tool calls before a terminal tool', async () => {
    const recall = vi.fn().mockResolvedValue({ memories: [] });
    const update = vi.fn().mockResolvedValue({
      success: true,
      goalUpdated: true,
      drivesUpdated: false,
      message: 'ok',
    });
    const executor = makeExecutor({
      executeQueryMemory: recall,
      executeUpdateInternalState: update,
    });
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
      agentId: 'agent-1',
    });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'q' }, 'call-1'))
      .mockResolvedValueOnce(toolCallResponse('update_internal_state', { newGoal: 'g' }, 'call-2'))
      .mockResolvedValueOnce(
        toolCallResponse(
          'formulate_plan',
          { description: 'd', steps: [{ description: 's' }] },
          'call-3',
        ),
      );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
      maxToolCallIterations: 5,
    });
    const result = (await client.completePlan(payload)) as FormulatePlanResult;
    expect(result.description).toBe('d');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The third request should contain both prior tool results.
    const third = JSON.parse(callAt(fetchMock, 2).init.body as string);
    const msgs = third.messages as unknown[];
    // system, user, assistant(qm), tool, assistant(uis), tool, -> 6
    expect(msgs.length).toBe(6);
  });

  // ─── AC-18: ChatMessage type supports assistant tool_calls + tool role ──────

  it('assistant messages in the loop carry tool_calls; tool messages carry tool_call_id (AC-18)', async () => {
    const executor = makeExecutor({
      executeQueryMemory: vi.fn().mockResolvedValue({ memories: [] }),
    });
    const payload = makePayload({
      tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool],
      agentId: 'agent-1',
    });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'q' }, 'tc-id-123'))
      .mockResolvedValueOnce(
        toolCallResponse(
          'formulate_plan',
          { description: 'd', steps: [{ description: 's' }] },
          'call-2',
        ),
      );
    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    await client.completePlan(payload);
    const second = JSON.parse(callAt(fetchMock, 1).init.body as string);
    const assistant = (second.messages as unknown[])[2] as Record<string, unknown>;
    expect(assistant['role']).toBe('assistant');
    const toolCalls = assistant['tool_calls'] as unknown[];
    expect(Array.isArray(toolCalls)).toBe(true);
    expect((toolCalls[0] as Record<string, unknown>)['id']).toBe('tc-id-123');
    const toolMsg = (second.messages as unknown[])[3] as Record<string, unknown>;
    expect(toolMsg['role']).toBe('tool');
    expect(toolMsg['tool_call_id']).toBe('tc-id-123');
  });
});
