/**
 * Tests for OpenAICompatibleLLMClient (spec 006, issue #20; spec 011, issue #40).
 * Covers acceptance criteria AC-8 through AC-21, AC-30, AC-31, AC-36.
 *
 * Tests mock the global `fetch` API and do NOT require a running LLM instance.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  LLMActionResponse,
  FormulatePlanResult,
  ReflectLLMResponse,
  ReflectionResult,
  MemoryNode,
  MemorySnippet,
  Affordance,
  CognitiveTool,
  ToolDefinition,
} from '@evol-hive/shared';
import {
  chooseActionTool,
  formulatePlanTool,
  reflectTool,
  memoryConsolidationTool,
} from '@evol-hive/shared';
import type { LLMContextPayload, EmbeddingProvider } from '../src/index.js';
import {
  OpenAICompatibleLLMClient,
  type OpenAICompatibleLLMClientConfig,
  LLMError,
  LLMTimeoutError,
  LLMHTTPError,
  LLMRateLimitError,
  LLMResponseError,
} from '../src/llm/openai-client.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:8080/v1';
const MODEL = 'llama3.1';
const CHAT_URL = `${BASE_URL}/chat/completions`;

type FetchArgs = [string, RequestInit];

type FetchCall = {
  url: string;
  init: RequestInit;
};

function callAt(mock: ReturnType<typeof vi.fn>, index: number): FetchCall {
  const args = mock.mock.calls[index] as unknown as FetchArgs;
  return { url: args[0], init: args[1] };
}

function makePayload(overrides: Partial<LLMContextPayload> = {}): LLMContextPayload {
  return {
    systemPrompt: 'You are a helpful agent.',
    perceptionContext: 'You are in a kitchen. There is a coffee machine.',
    availableAffordances: [{ id: 'brew_coffee', label: 'Brew coffee' }] as Affordance[],
    cognitiveTools: [
      { name: 'formulate_plan', description: 'Formulate a plan', argsSchema: {} },
    ] as CognitiveTool[],
    tools: [chooseActionTool],
    ...overrides,
  };
}

/** Mock response with tool_calls in the body (spec 011 format). */
function toolCallResponse(toolName: string, argumentsObj: unknown, status = 200): Response {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
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

/** Mock response without tool_calls (content-only — should trigger error). */
function noToolCallsResponse(content: string | null = 'some text', status = 200): Response {
  const body = JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Mock response with empty tool_calls array. */
function emptyToolCallsResponse(): Response {
  const body = JSON.stringify({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [] } }],
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyChoicesResponse(): Response {
  return new Response(JSON.stringify({ choices: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ─── Test setup ──────────────────────────────────────────────────────────────

describe('OpenAICompatibleLLMClient', () => {
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

  // ─── AC-21: class & interface ──────────────────────────────────────────────

  it('is a class that implements all four LLMClient methods (AC-21)', () => {
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    expect(client).toBeInstanceOf(OpenAICompatibleLLMClient);
    expect(typeof client.completeStructured).toBe('function');
    expect(typeof client.completeReflection).toBe('function');
    expect(typeof client.completePlan).toBe('function');
    expect(typeof client.completeReflect).toBe('function');
  });

  it('applies default config values when optional fields are omitted', () => {
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    fetchMock.mockResolvedValue(toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }));
    const payload = makePayload({ availableAffordances: [], cognitiveTools: [] });
    return expect(client.completeStructured(payload)).resolves.toEqual({
      reasoning: 'r',
      action: 'a',
    });
  });

  // ─── AC-8, AC-9: request body includes tools, no response_format ──────────

  describe('completeStructured — tool calling (AC-8, AC-9, AC-15)', () => {
    it('sends POST to /chat/completions with tools array in body (AC-8)', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('choose_action', { reasoning: 'I need energy.', action: 'brew_coffee' }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload();

      await client.completeStructured(payload);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = callAt(fetchMock, 0);
      expect(call.url).toBe(CHAT_URL);
      expect(call.init.method).toBe('POST');

      const body = JSON.parse(call.init.body as string);
      expect(body.model).toBe(MODEL);
      expect(body.stream).toBe(false);
      // Must include tools, NOT response_format
      expect(body.tools).toBeDefined();
      expect(Array.isArray(body.tools)).toBe(true);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].type).toBe('function');
      expect(body.tools[0].function.name).toBe('choose_action');
      expect(body.response_format).toBeUndefined();
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[0].content).toBe(payload.systemPrompt);
      expect(body.messages[1].role).toBe('user');
    });

    it('parses tool_calls[0].function.arguments into LLMActionResponse (AC-9, AC-15)', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('choose_action', {
          reasoning: 'thirsty',
          action: 'drink',
          actionArgs: { x: 1 },
        }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const result = await client.completeStructured(makePayload());
      expect(result.reasoning).toBe('thirsty');
      expect(result.action).toBe('drink');
      expect(result.actionArgs).toEqual({ x: 1 });
    });

    it('throws LLMResponseError when reasoning or action is missing from tool call args', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('choose_action', { reasoning: 'only reasoning' }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await expect(client.completeStructured(makePayload())).rejects.toThrow(LLMResponseError);
    });

    it('sends payload.tools in the request body (AC-8)', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ tools: [chooseActionTool] });
      await client.completeStructured(payload);
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      expect(body.tools).toEqual([chooseActionTool]);
    });
  });

  // ─── AC-10: missing tool_calls ─────────────────────────────────────────────

  describe('missing tool_calls (AC-10)', () => {
    it('throws LLMResponseError with rawContent when tool_calls is missing', async () => {
      fetchMock.mockResolvedValue(noToolCallsResponse('some text content'));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      try {
        await client.completeStructured(makePayload());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMResponseError);
        expect((err as LLMResponseError).rawContent).toBeDefined();
      }
    });

    it('throws LLMResponseError when tool_calls array is empty', async () => {
      fetchMock.mockResolvedValue(emptyToolCallsResponse());
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await expect(client.completeStructured(makePayload())).rejects.toThrow(LLMResponseError);
    });
  });

  // ─── AC-11: reasoningEffort config ─────────────────────────────────────────

  describe('reasoningEffort config (AC-11, AC-31)', () => {
    it('includes reasoning_effort in request body when set (AC-11, AC-31)', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }),
      );
      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        reasoningEffort: 'low',
      });
      await client.completeStructured(makePayload());
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      expect(body.reasoning_effort).toBe('low');
    });

    it('omits reasoning_effort from request body when not set (AC-31)', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await client.completeStructured(makePayload());
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      expect(body.reasoning_effort).toBeUndefined();
    });

    it('supports medium and high values', async () => {
      for (const effort of ['medium', 'high'] as const) {
        fetchMock.mockResolvedValue(
          toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }),
        );
        const client = new OpenAICompatibleLLMClient({
          baseUrl: BASE_URL,
          model: MODEL,
          reasoningEffort: effort,
        });
        await client.completeStructured(makePayload());
        const body = JSON.parse(
          callAt(fetchMock, fetchMock.mock.calls.length - 1).init.body as string,
        );
        expect(body.reasoning_effort).toBe(effort);
      }
    });
  });

  // ─── AC-12: removed config fields ──────────────────────────────────────────

  describe('removed config fields (AC-12)', () => {
    it('config does not have responseFormat, useJsonSchema, or enableJsonRecovery fields', () => {
      const config: OpenAICompatibleLLMClientConfig = {
        baseUrl: BASE_URL,
        model: MODEL,
      };
      expect((config as Record<string, unknown>)['responseFormat']).toBeUndefined();
      expect((config as Record<string, unknown>)['useJsonSchema']).toBeUndefined();
      expect((config as Record<string, unknown>)['enableJsonRecovery']).toBeUndefined();
    });
  });

  // ─── AC-16: completePlan with tool calling ─────────────────────────────────

  describe('completePlan (AC-16)', () => {
    it('parses FormulatePlanResult from tool call arguments (AC-16)', async () => {
      const plan: FormulatePlanResult = {
        description: 'Brew coffee',
        steps: [{ description: 'Brew a cup', targetAffordance: 'brew_coffee' }],
      };
      fetchMock.mockResolvedValue(toolCallResponse('formulate_plan', plan));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ tools: [formulatePlanTool] });
      const result = await client.completePlan(payload);
      expect(result.description).toBe('Brew coffee');
      expect(result.steps).toHaveLength(1);
    });

    it('sends tools array (not response_format) in request body (AC-8)', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ tools: [formulatePlanTool] });
      await client.completePlan(payload);
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      expect(body.tools).toEqual([formulatePlanTool]);
      expect(body.response_format).toBeUndefined();
    });

    it('throws LLMResponseError when description is empty or steps missing (AC-16)', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('formulate_plan', { description: '', steps: [] }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ tools: [formulatePlanTool] });
      await expect(client.completePlan(payload)).rejects.toThrow(LLMResponseError);
    });
  });

  // ─── AC-17: completeReflect with tool calling ──────────────────────────────

  describe('completeReflect (AC-17)', () => {
    it('parses ReflectLLMResponse from tool call arguments (AC-17)', async () => {
      const resp: ReflectLLMResponse = {
        memoryEntry: {
          content: 'Brewed coffee.',
          importance: 5,
          type: 'action',
          location: 'kitchen',
        },
      };
      fetchMock.mockResolvedValue(toolCallResponse('reflect', resp));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ tools: [reflectTool] });
      const result = await client.completeReflect(payload);
      expect(result.memoryEntry?.content).toBe('Brewed coffee.');
    });

    it('returns {} when the LLM returns an empty object (AC-17)', async () => {
      fetchMock.mockResolvedValue(toolCallResponse('reflect', {}));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ tools: [reflectTool] });
      const result = await client.completeReflect(payload);
      expect(result).toEqual({});
    });

    it('sends tools array (not response_format) in request body (AC-8)', async () => {
      fetchMock.mockResolvedValue(toolCallResponse('reflect', {}));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ tools: [reflectTool] });
      await client.completeReflect(payload);
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      expect(body.tools).toEqual([reflectTool]);
      expect(body.response_format).toBeUndefined();
    });
  });

  // ─── AC-18: completeReflection with tool calling ───────────────────────────

  describe('completeReflection (AC-18)', () => {
    const memoryNodes: MemorySnippet[] = [
      { id: 'mem-1', content: 'Ate food.', importance: 3, timestamp: 1000 },
      { id: 'mem-2', content: 'Drank water.', importance: 2, timestamp: 2000 },
    ];

    it('sends memoryConsolidationTool in tools array (AC-18)', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('consolidate_memories', {
          consolidatedMemories: [],
          consolidatedNodeIds: [],
        }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await client.completeReflection('Consolidate memories.', memoryNodes);
      const call = callAt(fetchMock, 0);
      const body = JSON.parse(call.init.body as string);
      expect(body.tools).toEqual([memoryConsolidationTool]);
      expect(body.response_format).toBeUndefined();
    });

    it('constructs MemoryNode objects for each consolidated memory (AC-18)', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('consolidate_memories', {
          consolidatedMemories: [
            { content: 'I had food and water.', importance: 7, type: 'reflection' },
          ],
          consolidatedNodeIds: ['mem-1', 'mem-2'],
        }),
      );
      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        agentId: 'agent-1',
      });
      const result: ReflectionResult = await client.completeReflection(
        'Consolidate memories.',
        memoryNodes,
      );
      expect(result.agentId).toBe('agent-1');
      expect(result.consolidatedNodeIds).toEqual(['mem-1', 'mem-2']);
      expect(result.newMemories).toHaveLength(1);
      const node: MemoryNode = result.newMemories[0]!;
      expect(node.agentId).toBe('agent-1');
      expect(node.content).toBe('I had food and water.');
      expect(node.importance).toBe(7);
      expect(node.type).toBe('reflection');
      expect(node.id).toContain('mem_consolidated_');
      expect(typeof node.timestamp).toBe('number');
    });

    it('generates embeddings via embeddingProvider when configured', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('consolidate_memories', {
          consolidatedMemories: [{ content: 'Insight.', importance: 5, type: 'observation' }],
          consolidatedNodeIds: [],
        }),
      );
      const embedMock = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
      const embeddingProvider: EmbeddingProvider = {
        embed: embedMock,
        embedBatch: vi.fn(),
        dimensions: 3,
      };
      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        embeddingProvider,
      });
      const result = await client.completeReflection('Consolidate.', memoryNodes);
      expect(embedMock).toHaveBeenCalledWith('Insight.');
      expect(result.newMemories[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it('sets embedding to [] when no embeddingProvider configured', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('consolidate_memories', {
          consolidatedMemories: [{ content: 'Insight.', importance: 5, type: 'observation' }],
          consolidatedNodeIds: [],
        }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const result = await client.completeReflection('Consolidate.', memoryNodes);
      expect(result.newMemories[0]!.embedding).toEqual([]);
    });

    it('includes memory snippets in the user message (AC-18)', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('consolidate_memories', {
          consolidatedMemories: [],
          consolidatedNodeIds: [],
        }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await client.completeReflection('Consolidate.', memoryNodes);
      const call = callAt(fetchMock, 0);
      const body = JSON.parse(call.init.body as string);
      const userMsg: string = body.messages[1].content;
      expect(userMsg).toContain('mem-1');
      expect(userMsg).toContain('Ate food.');
      expect(userMsg).toContain('mem-2');
    });

    it('user message does NOT contain MEMORY_CONSOLIDATION_SCHEMA_HINT (AC-18)', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('consolidate_memories', {
          consolidatedMemories: [],
          consolidatedNodeIds: [],
        }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await client.completeReflection('Consolidate.', memoryNodes);
      const call = callAt(fetchMock, 0);
      const body = JSON.parse(call.init.body as string);
      const userMsg: string = body.messages[1].content;
      expect(userMsg).not.toContain('Respond with JSON in this exact format');
    });
  });

  // ─── Authorization header ───────────────────────────────────────────────────

  describe('Authorization header', () => {
    it('includes Authorization: Bearer <apiKey> when apiKey is set', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }),
      );
      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        apiKey: 'sk-secret',
      });
      await client.completeStructured(makePayload());
      const call = callAt(fetchMock, 0);
      const headers = new Headers(call.init.headers as HeadersInit);
      expect(headers.get('authorization')).toBe('Bearer sk-secret');
    });

    it('does NOT include Authorization header when apiKey is not set', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await client.completeStructured(makePayload());
      const call = callAt(fetchMock, 0);
      const headers = new Headers(call.init.headers as HeadersInit);
      expect(headers.get('authorization')).toBeNull();
    });
  });

  // ─── AC-19: User message construction ──────────────────────────────────────

  describe('User message construction (AC-19)', () => {
    it('includes perceptionContext, affordance list, and cognitive tools list', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload();
      await client.completeStructured(payload);
      const call = callAt(fetchMock, 0);
      const body = JSON.parse(call.init.body as string);
      const userMsg: string = body.messages[1].content;
      expect(userMsg).toContain(payload.perceptionContext);
      // "Available actions" text is no longer in the user message (spec 019)
      expect(userMsg).not.toContain('Available actions:');
      expect(userMsg).toContain('Cognitive tools:');
      expect(userMsg).toContain('name: formulate_plan');
    });

    it('omits affordance section when availableAffordances is empty', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ availableAffordances: [] });
      await client.completeStructured(payload);
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      const userMsg: string = body.messages[1].content;
      expect(userMsg).not.toContain('Available actions:');
    });

    it('omits tools section when cognitiveTools is empty', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ cognitiveTools: [] });
      await client.completeStructured(payload);
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      const userMsg: string = body.messages[1].content;
      expect(userMsg).not.toContain('Cognitive tools:');
    });

    it('does NOT append any schema hint to the user message (AC-19)', async () => {
      fetchMock.mockResolvedValue(
        toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload();
      await client.completeStructured(payload);
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      const userMsg: string = body.messages[1].content;
      expect(userMsg).not.toContain('Respond with JSON in this exact format');
      expect(userMsg).not.toContain('IMPORTANT: Respond ONLY with a valid JSON object');
    });
  });

  // ─── Timeout handling ───────────────────────────────────────────────────────

  describe('Timeout handling', () => {
    it('throws LLMTimeoutError when the request exceeds timeoutMs', async () => {
      fetchMock.mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('Aborted') as Error & { name: string };
            err.name = 'AbortError';
            reject(err);
          });
        });
      });
      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        timeoutMs: 50,
        retryOnTimeout: false,
      });
      const promise = client.completeStructured(makePayload());
      await expect(promise).rejects.toThrow(LLMTimeoutError);
      try {
        await promise;
      } catch (err) {
        expect(err).toBeInstanceOf(LLMError);
      }
    });

    it('LLMTimeoutError message includes the timeout duration and URL', async () => {
      fetchMock.mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('Aborted') as Error & { name: string };
            err.name = 'AbortError';
            reject(err);
          });
        });
      });
      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        timeoutMs: 50,
        retryOnTimeout: false,
      });
      try {
        await client.completeStructured(makePayload());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMTimeoutError);
        const msg = (err as Error).message;
        expect(msg).toContain('50');
        expect(msg).toContain(CHAT_URL);
      }
    });
  });

  // ─── Rate limit (429) handling ──────────────────────────────────────────────

  describe('Rate limit / HTTP 429 handling', () => {
    it('retries maxRetries times then throws LLMRateLimitError', async () => {
      fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }));
      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        maxRetries: 2,
        retryDelayMs: 1,
      });
      await expect(client.completeStructured(makePayload())).rejects.toThrow(LLMRateLimitError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('succeeds after a transient 429 (retry then success)', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
        .mockResolvedValueOnce(toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }));
      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        maxRetries: 3,
        retryDelayMs: 1,
      });
      const result = await client.completeStructured(makePayload());
      expect(result.action).toBe('a');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('LLMRateLimitError has statusCode 429', async () => {
      fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }));
      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        maxRetries: 1,
        retryDelayMs: 1,
      });
      try {
        await client.completeStructured(makePayload());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMRateLimitError);
        expect(err).toBeInstanceOf(LLMHTTPError);
        expect((err as LLMRateLimitError).statusCode).toBe(429);
      }
    });
  });

  // ─── Non-429 HTTP errors ────────────────────────────────────────────────────

  describe('Non-429 HTTP errors', () => {
    it('throws LLMHTTPError with statusCode and responseBody for 404', async () => {
      fetchMock.mockResolvedValue(new Response('Not Found', { status: 404 }));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      try {
        await client.completeStructured(makePayload());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMHTTPError);
        expect((err as LLMHTTPError).statusCode).toBe(404);
        expect((err as LLMHTTPError).responseBody).toContain('Not Found');
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws LLMHTTPError for 500 (no retry on non-429)', async () => {
      fetchMock.mockResolvedValue(new Response('Server Error', { status: 500 }));
      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        maxRetries: 3,
        retryDelayMs: 1,
      });
      await expect(client.completeStructured(makePayload())).rejects.toThrow(LLMHTTPError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─── AC-20: LLMResponseError simplified ────────────────────────────────────

  describe('LLMResponseError simplified (AC-20)', () => {
    it('LLMResponseError does not have originalRawContent or recoveryAttempted fields', () => {
      const err = new LLMResponseError('test', 'raw');
      expect((err as Record<string, unknown>)['originalRawContent']).toBeUndefined();
      expect((err as Record<string, unknown>)['recoveryAttempted']).toBeUndefined();
      expect(err.rawContent).toBe('raw');
    });

    it('LLMResponseError is distinguishable from LLMTimeoutError and LLMHTTPError', async () => {
      fetchMock.mockResolvedValue(noToolCallsResponse('no tool calls'));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      try {
        await client.completeStructured(makePayload());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMResponseError);
        expect(err).not.toBeInstanceOf(LLMTimeoutError);
        expect(err).not.toBeInstanceOf(LLMHTTPError);
        expect(err).toBeInstanceOf(LLMError);
      }
    });

    it('LLMError is a base class extended by all subtypes', () => {
      const timeout = new LLMTimeoutError('timeout', 1000, 'url');
      const http = new LLMHTTPError('http', 500, 'body');
      const rateLimit = new LLMRateLimitError('rate', 'body');
      const response = new LLMResponseError('resp', 'raw');

      expect(timeout).toBeInstanceOf(LLMError);
      expect(http).toBeInstanceOf(LLMError);
      expect(rateLimit).toBeInstanceOf(LLMError);
      expect(response).toBeInstanceOf(LLMError);

      expect(rateLimit).toBeInstanceOf(LLMHTTPError);
      expect(rateLimit.statusCode).toBe(429);
    });

    it('all five error classes are exported', () => {
      expect(LLMError).toBeDefined();
      expect(LLMTimeoutError).toBeDefined();
      expect(LLMHTTPError).toBeDefined();
      expect(LLMRateLimitError).toBeDefined();
      expect(LLMResponseError).toBeDefined();
    });
  });

  // ─── Shared request method ──────────────────────────────────────────────────

  it('uses a single shared request path for all four methods', async () => {
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }))
      .mockResolvedValueOnce(
        toolCallResponse('formulate_plan', { description: 'd', steps: [{ description: 's' }] }),
      )
      .mockResolvedValueOnce(toolCallResponse('reflect', {}))
      .mockResolvedValueOnce(
        toolCallResponse('consolidate_memories', {
          consolidatedMemories: [],
          consolidatedNodeIds: [],
        }),
      );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload();

    await client.completeStructured(payload);
    await client.completePlan(makePayload({ tools: [formulatePlanTool] }));
    await client.completeReflect(makePayload({ tools: [reflectTool] }));
    await client.completeReflection('prompt', []);

    // All four should hit the same URL and use tools (not response_format)
    for (let i = 0; i < fetchMock.mock.calls.length; i++) {
      const call = callAt(fetchMock, i);
      expect(call.url).toBe(CHAT_URL);
      const body = JSON.parse(call.init.body as string);
      expect(body.tools).toBeDefined();
      expect(body.response_format).toBeUndefined();
      expect(body.stream).toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // ─── Export structure ───────────────────────────────────────────────────────

  describe('Export structure', () => {
    it('re-exports from cognition barrel', async () => {
      const mod = await import('../src/index.js');
      expect(mod.OpenAICompatibleLLMClient).toBeDefined();
      expect(mod.LLMError).toBeDefined();
      expect(mod.LLMTimeoutError).toBeDefined();
      expect(mod.LLMHTTPError).toBeDefined();
      expect(mod.LLMRateLimitError).toBeDefined();
      expect(mod.LLMResponseError).toBeDefined();
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────────

  it('throws LLMResponseError when choices array is empty', async () => {
    fetchMock.mockResolvedValue(emptyChoicesResponse());
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await expect(client.completeStructured(makePayload())).rejects.toThrow(LLMResponseError);
  });

  it('uses the configured baseUrl for the request URL', async () => {
    fetchMock.mockResolvedValue(toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await client.completeStructured(makePayload());
    const call = callAt(fetchMock, 0);
    expect(call.url).toBe(`${BASE_URL}/chat/completions`);
  });

  // ─── AC-13: json-recovery.ts deleted ───────────────────────────────────────

  describe('json-recovery deleted (AC-13)', () => {
    it('extractJsonFromText is not exported from cognition barrel', async () => {
      const mod = await import('../src/index.js');
      expect((mod as Record<string, unknown>)['extractJsonFromText']).toBeUndefined();
    });

    it('resolveField is not exported from cognition barrel', async () => {
      const mod = await import('../src/index.js');
      expect((mod as Record<string, unknown>)['resolveField']).toBeUndefined();
    });

    it('ResponseFormat type is not exported from llm barrel', async () => {
      const mod = await import('../src/llm/index.js');
      expect((mod as Record<string, unknown>)['ResponseFormat']).toBeUndefined();
    });
  });

  // ─── AC-36: End-to-end flow ─────────────────────────────────────────────────

  describe('End-to-end flow (AC-36)', () => {
    it('PerceptionBuilderImpl payload → completeStructured → tool call parsed', async () => {
      const { PerceptionBuilderImpl } = await import('../src/pper/perception-builder.js');
      const builder = new PerceptionBuilderImpl();
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

      // Verify the payload has affordance tools (spec 019)
      expect(payload.tools).toBeDefined();
      expect(payload.tools.some((t) => t.function.name === 'brew_coffee')).toBe(true);
      expect(payload.tools.some((t) => t.function.name === 'choose_action')).toBe(false);
      // No responseSchema or schemaHint
      expect((payload as Record<string, unknown>)['responseSchema']).toBeUndefined();
      expect((payload as Record<string, unknown>)['schemaHint']).toBeUndefined();

      // Mock fetch returns an affordance tool call (spec 019)
      fetchMock.mockResolvedValue(toolCallResponse('brew_coffee', {}));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const result = await client.completeStructured(payload);

      // Verify tools were sent
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      expect(body.tools).toBeDefined();
      expect(body.response_format).toBeUndefined();

      // Verify parsed response — affordance tool name becomes the action
      expect(result.action).toBe('brew_coffee');
      expect(result.reasoning).toBe('');
    });
  });
});
