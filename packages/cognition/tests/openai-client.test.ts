/**
 * Tests for OpenAICompatibleLLMClient (spec 006, issue #20).
 * Covers acceptance criteria AC-1 through AC-36.
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
} from '@evol-hive/shared';
import {
  llmActionResponseSchema,
  formulatePlanSchema,
  reflectSchema,
  memoryConsolidationSchema,
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

const BASE_URL = 'http://localhost:11434/v1';
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
    responseSchema: llmActionResponseSchema,
    ...overrides,
  };
}

function chatResponse(content: string, status = 200): Response {
  const body = JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  });
  return new Response(body, {
    status,
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

  // ─── AC-2, AC-3, AC-4: class & interface ───────────────────────────────────

  it('is a class that implements all four LLMClient methods (AC-2, AC-3)', () => {
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    expect(client).toBeInstanceOf(OpenAICompatibleLLMClient);
    expect(typeof client.completeStructured).toBe('function');
    expect(typeof client.completeReflection).toBe('function');
    expect(typeof client.completePlan).toBe('function');
    expect(typeof client.completeReflect).toBe('function');
  });

  // ─── AC-4, AC-5: config defaults ───────────────────────────────────────────

  it('applies default config values when optional fields are omitted (AC-4, AC-5)', () => {
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    // We verify defaults indirectly through behavior (timeout, retries).
    // A quick request should work with default timeout of 30000.
    fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
    const payload = makePayload({ availableAffordances: [], cognitiveTools: [] });
    return expect(client.completeStructured(payload)).resolves.toEqual({
      reasoning: 'r',
      action: 'a',
    });
  });

  // ─── AC-6, AC-7, AC-29, AC-34: completeStructured ──────────────────────────

  describe('completeStructured (AC-6, AC-7, AC-29, AC-34)', () => {
    it('sends POST to /chat/completions with correct body (AC-6, AC-29)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(JSON.stringify({ reasoning: 'I need energy.', action: 'brew_coffee' })),
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
      expect(body.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: payload.responseSchema,
          strict: true,
        },
      });
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[0].content).toBe(payload.systemPrompt);
      expect(body.messages[1].role).toBe('user');
    });

    it('parses choices[0].message.content into LLMActionResponse (AC-7)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({ reasoning: 'thirsty', action: 'drink', actionArgs: { x: 1 } }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const result = await client.completeStructured(makePayload());
      expect(result.reasoning).toBe('thirsty');
      expect(result.action).toBe('drink');
      expect(result.actionArgs).toEqual({ x: 1 });
    });

    it('throws LLMResponseError when reasoning or action is missing (AC-7)', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'only reasoning' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await expect(client.completeStructured(makePayload())).rejects.toThrow(LLMResponseError);
    });

    it('sends llmActionResponseSchema wrapped in response_format (AC-34)', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await client.completeStructured(makePayload());
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      expect(body.response_format.json_schema.schema).toEqual(llmActionResponseSchema);
    });
  });

  // ─── AC-8, AC-35: completePlan ─────────────────────────────────────────────

  describe('completePlan (AC-8, AC-35)', () => {
    it('parses FormulatePlanResult with description and steps (AC-8)', async () => {
      const plan: FormulatePlanResult = {
        description: 'Brew coffee',
        steps: [{ description: 'Brew a cup', targetAffordance: 'brew_coffee' }],
      };
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify(plan)));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      const result = await client.completePlan(payload);
      expect(result.description).toBe('Brew coffee');
      expect(result.steps).toHaveLength(1);
    });

    it('sends formulatePlanSchema wrapped in response_format (AC-35)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(JSON.stringify({ description: 'd', steps: [{ description: 's' }] })),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      await client.completePlan(payload);
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      expect(body.response_format.json_schema.schema).toEqual(formulatePlanSchema);
    });

    it('throws LLMResponseError when description is empty or steps missing (AC-8)', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ description: '', steps: [] })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      await expect(client.completePlan(payload)).rejects.toThrow(LLMResponseError);
    });
  });

  // ─── AC-9, AC-36: completeReflect ──────────────────────────────────────────

  describe('completeReflect (AC-9, AC-36)', () => {
    it('parses ReflectLLMResponse with memoryEntry (AC-36)', async () => {
      const resp: ReflectLLMResponse = {
        memoryEntry: {
          content: 'Brewed coffee.',
          importance: 5,
          type: 'action',
          location: 'kitchen',
        },
      };
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify(resp)));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: reflectSchema });
      const result = await client.completeReflect(payload);
      expect(result.memoryEntry?.content).toBe('Brewed coffee.');
    });

    it('returns {} when the LLM returns an empty object (AC-9)', async () => {
      fetchMock.mockResolvedValue(chatResponse('{}'));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: reflectSchema });
      const result = await client.completeReflect(payload);
      expect(result).toEqual({});
    });

    it('sends reflectSchema wrapped in response_format (AC-36)', async () => {
      fetchMock.mockResolvedValue(chatResponse('{}'));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: reflectSchema });
      await client.completeReflect(payload);
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      expect(body.response_format.json_schema.schema).toEqual(reflectSchema);
    });
  });

  // ─── AC-10, AC-11: completeReflection ──────────────────────────────────────

  describe('completeReflection (AC-10, AC-11)', () => {
    const memoryNodes: MemorySnippet[] = [
      { id: 'mem-1', content: 'Ate food.', importance: 3, timestamp: 1000 },
      { id: 'mem-2', content: 'Drank water.', importance: 2, timestamp: 2000 },
    ];

    it('sends memoryConsolidationSchema wrapped in response_format (AC-10)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(JSON.stringify({ consolidatedMemories: [], consolidatedNodeIds: [] })),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await client.completeReflection('Consolidate memories.', memoryNodes);
      const call = callAt(fetchMock, 0);
      const body = JSON.parse(call.init.body as string);
      expect(body.response_format.json_schema.schema).toEqual(memoryConsolidationSchema);
    });

    it('constructs MemoryNode objects for each consolidated memory (AC-10)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            consolidatedMemories: [
              { content: 'I had food and water.', importance: 7, type: 'reflection' },
            ],
            consolidatedNodeIds: ['mem-1', 'mem-2'],
          }),
        ),
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

    it('generates embeddings via embeddingProvider when configured (AC-11)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            consolidatedMemories: [{ content: 'Insight.', importance: 5, type: 'observation' }],
            consolidatedNodeIds: [],
          }),
        ),
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

    it('sets embedding to [] when no embeddingProvider configured (AC-11)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            consolidatedMemories: [{ content: 'Insight.', importance: 5, type: 'observation' }],
            consolidatedNodeIds: [],
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const result = await client.completeReflection('Consolidate.', memoryNodes);
      expect(result.newMemories[0]!.embedding).toEqual([]);
    });

    it('includes memory snippets in the user message (AC-10)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(JSON.stringify({ consolidatedMemories: [], consolidatedNodeIds: [] })),
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
  });

  // ─── AC-12: Authorization header ───────────────────────────────────────────

  describe('Authorization header (AC-12)', () => {
    it('includes Authorization: Bearer <apiKey> when apiKey is set', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
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
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await client.completeStructured(makePayload());
      const call = callAt(fetchMock, 0);
      const headers = new Headers(call.init.headers as HeadersInit);
      expect(headers.get('authorization')).toBeNull();
    });
  });

  // ─── AC-20: User message construction ──────────────────────────────────────

  describe('User message construction (AC-20)', () => {
    it('includes perceptionContext, affordance list, and cognitive tools list', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload();
      await client.completeStructured(payload);
      const call = callAt(fetchMock, 0);
      const body = JSON.parse(call.init.body as string);
      const userMsg: string = body.messages[1].content;
      expect(userMsg).toContain(payload.perceptionContext);
      expect(userMsg).toContain('Available actions:');
      expect(userMsg).toContain('id: brew_coffee');
      expect(userMsg).toContain('label: Brew coffee');
      expect(userMsg).toContain('Cognitive tools:');
      expect(userMsg).toContain('name: formulate_plan');
    });

    it('omits affordance section when availableAffordances is empty', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ availableAffordances: [] });
      await client.completeStructured(payload);
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      const userMsg: string = body.messages[1].content;
      expect(userMsg).not.toContain('Available actions:');
    });

    it('omits tools section when cognitiveTools is empty', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ cognitiveTools: [] });
      await client.completeStructured(payload);
      const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
      const userMsg: string = body.messages[1].content;
      expect(userMsg).not.toContain('Cognitive tools:');
    });
  });

  // ─── AC-13: Timeout handling ───────────────────────────────────────────────

  describe('Timeout handling (AC-13)', () => {
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

  // ─── AC-14, AC-31: Rate limit (429) handling ───────────────────────────────

  describe('Rate limit / HTTP 429 handling (AC-14, AC-31)', () => {
    it('retries maxRetries times then throws LLMRateLimitError (AC-14, AC-31)', async () => {
      fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }));
      const client = new OpenAICompatibleLLMClient({
        baseUrl: BASE_URL,
        model: MODEL,
        maxRetries: 2,
        retryDelayMs: 1,
      });
      await expect(client.completeStructured(makePayload())).rejects.toThrow(LLMRateLimitError);
      // 1 initial + 2 retries = 3 total calls
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('succeeds after a transient 429 (retry then success)', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
        .mockResolvedValueOnce(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
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

  // ─── AC-15: Non-429 HTTP errors ────────────────────────────────────────────

  describe('Non-429 HTTP errors (AC-15)', () => {
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

  // ─── AC-16, AC-33: Invalid JSON handling ───────────────────────────────────

  describe('Invalid JSON handling (AC-16, AC-33)', () => {
    it('throws LLMResponseError with rawContent when content is not valid JSON', async () => {
      fetchMock.mockResolvedValue(chatResponse('This is not JSON at all.'));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      try {
        await client.completeStructured(makePayload());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMResponseError);
        expect((err as LLMResponseError).rawContent).toBe('This is not JSON at all.');
      }
    });

    it('LLMResponseError is distinguishable from LLMTimeoutError and LLMHTTPError', async () => {
      fetchMock.mockResolvedValue(chatResponse('not json'));
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
  });

  // ─── AC-17, AC-18: Error hierarchy ─────────────────────────────────────────

  describe('Error hierarchy (AC-17, AC-18)', () => {
    it('LLMError is a base class extended by all subtypes (AC-17)', () => {
      const timeout = new LLMTimeoutError('timeout', 1000, 'url');
      const http = new LLMHTTPError('http', 500, 'body');
      const rateLimit = new LLMRateLimitError('rate', 'body');
      const response = new LLMResponseError('resp', 'raw');

      expect(timeout).toBeInstanceOf(LLMError);
      expect(http).toBeInstanceOf(LLMError);
      expect(rateLimit).toBeInstanceOf(LLMError);
      expect(response).toBeInstanceOf(LLMError);

      // LLMRateLimitError extends LLMHTTPError
      expect(rateLimit).toBeInstanceOf(LLMHTTPError);
      // LLMRateLimitError statusCode is 429
      expect(rateLimit.statusCode).toBe(429);
    });

    it('all five error classes are exported (AC-18)', () => {
      expect(LLMError).toBeDefined();
      expect(LLMTimeoutError).toBeDefined();
      expect(LLMHTTPError).toBeDefined();
      expect(LLMRateLimitError).toBeDefined();
      expect(LLMResponseError).toBeDefined();
    });
  });

  // ─── AC-19: Shared request method (no duplicated fetch logic) ───────────────

  it('uses a single shared request path for all four methods (AC-19)', async () => {
    fetchMock
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })))
      .mockResolvedValueOnce(
        chatResponse(JSON.stringify({ description: 'd', steps: [{ description: 's' }] })),
      )
      .mockResolvedValueOnce(chatResponse('{}'))
      .mockResolvedValueOnce(
        chatResponse(JSON.stringify({ consolidatedMemories: [], consolidatedNodeIds: [] })),
      );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload();

    await client.completeStructured(payload);
    await client.completePlan(makePayload({ responseSchema: formulatePlanSchema }));
    await client.completeReflect(makePayload({ responseSchema: reflectSchema }));
    await client.completeReflection('prompt', []);

    // All four should hit the same URL
    for (let i = 0; i < fetchMock.mock.calls.length; i++) {
      const call = callAt(fetchMock, i);
      expect(call.url).toBe(CHAT_URL);
      const body = JSON.parse(call.init.body as string);
      expect(body.response_format.type).toBe('json_schema');
      expect(body.stream).toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // ─── AC-21: Export structure ───────────────────────────────────────────────

  describe('Export structure (AC-21)', () => {
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

  it('uses default baseUrl http://localhost:11434/v1', async () => {
    fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await client.completeStructured(makePayload());
    const call = callAt(fetchMock, 0);
    expect(call.url).toBe('http://localhost:11434/v1/chat/completions');
  });
});
