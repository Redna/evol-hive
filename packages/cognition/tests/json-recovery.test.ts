/**
 * Tests for LLM JSON Response Recovery & Provider-Aware Structured Output
 * (spec 009, issue #34).
 *
 * Covers acceptance criteria AC-1 through AC-36 (the spec-009 additions).
 * Tests mock the global `fetch` API and do NOT require a running LLM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Affordance, CognitiveTool } from '@evol-hive/shared';
import { llmActionResponseSchema, JSON_INSTRUCTION_SUFFIX } from '@evol-hive/shared';
import type { LLMContextPayload } from '../src/index.js';
import {
  OpenAICompatibleLLMClient,
  type OpenAICompatibleLLMClientConfig,
  LLMResponseError,
  LLMError,
  extractJsonFromText,
} from '../src/llm/openai-client.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const OLLAMA_URL = 'http://localhost:11434/v1';
const OPENAI_URL = 'https://api.openai.com/v1';
const MODEL = 'llama3.1';

type FetchArgs = [string, RequestInit];

function callAt(mock: ReturnType<typeof vi.fn>, index: number): { url: string; init: RequestInit } {
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

function validJson(): string {
  return JSON.stringify({ reasoning: 'I need energy.', action: 'brew_coffee' });
}

// ─── extractJsonFromText unit tests (AC-14, AC-26, AC-27, Req 19) ─────────────

describe('extractJsonFromText', () => {
  it('returns the JSON object when the content is already valid JSON (AC-14)', () => {
    const result = extractJsonFromText('{"reasoning":"r","action":"a"}');
    expect(result).not.toBeNull();
    expect(result!.json).toEqual({ reasoning: 'r', action: 'a' });
  });

  it('extracts a JSON object embedded in prose (AC-14)', () => {
    const content = 'Here is my plan: {"reasoning":"thinking","action":"brew"} hope that helps.';
    const result = extractJsonFromText(content);
    expect(result).not.toBeNull();
    expect(result!.json).toEqual({ reasoning: 'thinking', action: 'brew' });
  });

  it('extracts JSON embedded in XML-like tags (AC-26)', () => {
    const content =
      '<formulate_plan>{"reasoning":"need coffee","action":"brew_coffee"}</formulate_plan>';
    const result = extractJsonFromText(content);
    expect(result).not.toBeNull();
    expect(result!.json).toEqual({ reasoning: 'need coffee', action: 'brew_coffee' });
  });

  it('extracts a JSON array by finding first [ and last ] (AC-2)', () => {
    const content = 'Some text [{"a":1},{"b":2}] trailing text';
    const result = extractJsonFromText(content);
    expect(result).not.toBeNull();
    expect(result!.json).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('returns null when multiple unconnected JSON objects are present (Req 19 — simple extraction)', () => {
    // The spec uses a simple first-{ + last-} approach. With multiple separate
    // objects, the span is not valid JSON, so extraction returns null and the
    // re-prompt path handles recovery.
    const content = '{"first":true} then {"second":true}';
    const result = extractJsonFromText(content);
    expect(result).toBeNull();
  });

  it('returns null when no JSON object or array is present (AC-27)', () => {
    expect(extractJsonFromText('This is just plain text with no braces.')).toBeNull();
  });

  it('returns null when braces exist but do not form valid JSON', () => {
    // Opening brace present but content not valid JSON, no closing brace.
    expect(extractJsonFromText('here { is some text { not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractJsonFromText('')).toBeNull();
  });

  it('prefers object extraction over array extraction (AC-1 before AC-2)', () => {
    // Both { } and [ ] present — object should win.
    const content = 'text {"obj":1} [not relevant]';
    const result = extractJsonFromText(content);
    expect(result).not.toBeNull();
    expect(result!.json).toEqual({ obj: 1 });
  });

  it('falls back to array extraction when object extraction fails', () => {
    // Object braces present but invalid; array is valid.
    const content = '{ invalid } but [1, 2, 3] is valid';
    const result = extractJsonFromText(content);
    expect(result).not.toBeNull();
    expect(result!.json).toEqual([1, 2, 3]);
  });
});

// ─── requestChat recovery behavior tests ──────────────────────────────────────

describe('OpenAICompatibleLLMClient JSON recovery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ─── AC-1, AC-21: extraction of object embedded in XML tags ────────────────

  it('extracts JSON from XML-wrapped content without throwing (AC-1, AC-21)', async () => {
    const xmlWrapped =
      '<formulate_plan>\n{"reasoning":"restore energy","action":"brew_coffee"}\n</formulate_plan>';
    fetchMock.mockResolvedValue(chatResponse(xmlWrapped));
    const client = new OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    const result = await client.completeStructured(makePayload());
    expect(result.action).toBe('brew_coffee');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ─── AC-1: simple embedded JSON object ────────────────────────────────────

  it('extracts a JSON object embedded in prose (AC-1)', async () => {
    const prose = `Sure! Here's my response: {"reasoning":"tired","action":"brew_coffee"} Let me know.`;
    fetchMock.mockResolvedValue(chatResponse(prose));
    const client = new OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    const result = await client.completeStructured(makePayload());
    expect(result.action).toBe('brew_coffee');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ─── AC-2: array extraction fallback ──────────────────────────────────────

  it('falls back to array extraction when object braces fail (AC-2)', async () => {
    // Object braces are invalid JSON, but there's a valid array.
    const content = '{ not valid } [{"reasoning":"r","action":"a"}]';
    fetchMock.mockResolvedValue(chatResponse(content));
    const client = new OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    // completeStructured expects an object; extraction returns array → parse
    // should fail at the validation step (missing reasoning/action) and throw
    // LLMResponseError — but recovery itself should not throw during extraction.
    // The array is extracted; then completeStructured validation throws.
    await expect(client.completeStructured(makePayload())).rejects.toThrow(LLMResponseError);
  });

  // ─── AC-3, AC-22: re-prompt on parse failure ───────────────────────────────

  it('sends a re-prompt with json_object when first response is plain text (AC-3, AC-22)', async () => {
    fetchMock
      .mockResolvedValueOnce(chatResponse('I cannot do that.'))
      .mockResolvedValueOnce(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    const result = await client.completeStructured(makePayload());
    expect(result.action).toBe('brew_coffee');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second call should use json_object response_format.
    const rePromptBody = JSON.parse(callAt(fetchMock, 1).init.body as string);
    expect(rePromptBody.response_format).toEqual({ type: 'json_object' });
    // The re-prompt appends an additional user message.
    expect(rePromptBody.messages.length).toBeGreaterThanOrEqual(3);
    const lastMsg = rePromptBody.messages[rePromptBody.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toContain('valid JSON');
  });

  // ─── AC-4, AC-29: re-prompt also fails → enriched error ─────────────────────

  it('throws enriched LLMResponseError when re-prompt also fails (AC-4, AC-29)', async () => {
    fetchMock
      .mockResolvedValueOnce(chatResponse('plain text, no json'))
      .mockResolvedValueOnce(chatResponse('still no json here'));
    const client = new OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    try {
      await client.completeStructured(makePayload());
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMResponseError);
      const e = err as LLMResponseError;
      expect(e.recoveryAttempted).toBe(true);
      expect(e.originalRawContent).toBe('plain text, no json');
      // rawContent is the final (re-prompt) response content.
      expect(e.rawContent).toBe('still no json here');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ─── AC-5: at most one re-prompt ───────────────────────────────────────────

  it('attempts at most one re-prompt per original request (AC-5)', async () => {
    fetchMock.mockResolvedValue(chatResponse('no json at all, ever'));
    const client = new OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    await expect(client.completeStructured(makePayload())).rejects.toThrow(LLMResponseError);
    // Exactly 2 calls: original + one re-prompt. No third call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ─── AC-11, AC-30: enableJsonRecovery=false skips recovery ─────────────────

  it('throws immediately without re-prompt when enableJsonRecovery is false (AC-11, AC-30)', async () => {
    fetchMock.mockResolvedValue(chatResponse('not json'));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: OLLAMA_URL,
      model: MODEL,
      enableJsonRecovery: false,
    });
    await expect(client.completeStructured(makePayload())).rejects.toThrow(LLMResponseError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ─── AC-11: recovery enabled by default ────────────────────────────────────

  it('enableJsonRecovery defaults to true (AC-11)', async () => {
    fetchMock
      .mockResolvedValueOnce(chatResponse('not json'))
      .mockResolvedValueOnce(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    await client.completeStructured(makePayload());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ─── AC-6: responseFormat config field exists ──────────────────────────────

  it('accepts responseFormat config field (AC-6)', () => {
    const client = new OpenAICompatibleLLMClient({
      baseUrl: OLLAMA_URL,
      model: MODEL,
      responseFormat: 'json_object',
    });
    expect(client).toBeInstanceOf(OpenAICompatibleLLMClient);
  });

  // ─── AC-7: responseFormat json_schema vs json_object ───────────────────────

  it('uses json_schema envelope when responseFormat is json_schema (AC-7)', async () => {
    fetchMock.mockResolvedValue(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: OLLAMA_URL,
      model: MODEL,
      responseFormat: 'json_schema',
    });
    await client.completeStructured(makePayload());
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema).toBeDefined();
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it('uses json_object when responseFormat is json_object (AC-7, AC-31)', async () => {
    fetchMock.mockResolvedValue(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: OPENAI_URL,
      model: MODEL,
      responseFormat: 'json_object',
    });
    await client.completeStructured(makePayload());
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.response_format.json_schema).toBeUndefined();
  });

  // ─── AC-8: auto-detection from baseUrl ─────────────────────────────────────

  it('uses json_object when responseFormat is auto and baseUrl is Ollama (AC-8, AC-32)', async () => {
    fetchMock.mockResolvedValue(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: 'http://localhost:11434/v1',
      model: MODEL,
      responseFormat: 'auto',
    });
    await client.completeStructured(makePayload());
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('uses json_object when responseFormat is auto and baseUrl is 127.0.0.1:11434 (AC-8)', async () => {
    fetchMock.mockResolvedValue(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: MODEL,
      responseFormat: 'auto',
    });
    await client.completeStructured(makePayload());
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('uses json_schema when responseFormat is auto and baseUrl is OpenAI (AC-8, AC-33)', async () => {
    fetchMock.mockResolvedValue(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: OPENAI_URL,
      model: MODEL,
      responseFormat: 'auto',
    });
    await client.completeStructured(makePayload());
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema).toBeDefined();
  });

  // ─── AC-9: explicit json_schema overrides Ollama auto-detection ────────────

  it('explicit responseFormat json_schema overrides Ollama auto-detection (AC-9)', async () => {
    fetchMock.mockResolvedValue(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: 'http://localhost:11434/v1',
      model: MODEL,
      responseFormat: 'json_schema',
    });
    await client.completeStructured(makePayload());
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.response_format.type).toBe('json_schema');
  });

  // ─── AC-10: useJsonSchema backward compat ──────────────────────────────────

  it('useJsonSchema true maps to json_schema (AC-10)', async () => {
    fetchMock.mockResolvedValue(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: OLLAMA_URL,
      model: MODEL,
      useJsonSchema: true,
    });
    await client.completeStructured(makePayload());
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.response_format.type).toBe('json_schema');
  });

  it('useJsonSchema false maps to json_object (AC-10)', async () => {
    fetchMock.mockResolvedValue(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: OPENAI_URL,
      model: MODEL,
      useJsonSchema: false,
    });
    await client.completeStructured(makePayload());
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('responseFormat takes precedence over useJsonSchema when both set (AC-10)', async () => {
    fetchMock.mockResolvedValue(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: OLLAMA_URL,
      model: MODEL,
      useJsonSchema: true,
      responseFormat: 'json_object',
    });
    await client.completeStructured(makePayload());
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  // ─── AC-10: default (neither set) → auto on Ollama → json_object ────────────

  it('default config (neither set) auto-detects Ollama → json_object (AC-10)', async () => {
    fetchMock.mockResolvedValue(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    await client.completeStructured(makePayload());
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('default config (neither set) on non-Ollama → json_schema (AC-10)', async () => {
    fetchMock.mockResolvedValue(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({ baseUrl: OPENAI_URL, model: MODEL });
    await client.completeStructured(makePayload());
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.response_format.type).toBe('json_schema');
  });

  // ─── AC-12: schema summary in re-prompt message ─────────────────────────────

  it('re-prompt message includes schema summary with property names and types (AC-12)', async () => {
    fetchMock
      .mockResolvedValueOnce(chatResponse('no json'))
      .mockResolvedValueOnce(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    await client.completeStructured(makePayload());
    const rePromptBody = JSON.parse(callAt(fetchMock, 1).init.body as string);
    const recoveryMsg = rePromptBody.messages[rePromptBody.messages.length - 1].content as string;
    // Should mention top-level property names from llmActionResponseSchema.
    expect(recoveryMsg).toContain('reasoning');
    expect(recoveryMsg).toContain('action');
    // Should mention required fields.
    expect(recoveryMsg.toLowerCase()).toContain('required');
  });

  // ─── AC-13: LLMResponseError new optional fields ───────────────────────────

  it('LLMResponseError has optional originalRawContent and recoveryAttempted fields (AC-13)', () => {
    const err = new LLMResponseError('test', 'raw', {
      originalRawContent: 'orig',
      recoveryAttempted: true,
    });
    expect(err).toBeInstanceOf(LLMResponseError);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.rawContent).toBe('raw');
    expect(err.originalRawContent).toBe('orig');
    expect(err.recoveryAttempted).toBe(true);
  });

  it('LLMResponseError works without new fields (backward compat) (AC-13)', () => {
    const err = new LLMResponseError('test', 'raw');
    expect(err.rawContent).toBe('raw');
    expect(err.originalRawContent).toBeUndefined();
    expect(err.recoveryAttempted).toBeUndefined();
  });

  // ─── AC-20: logging/observability ──────────────────────────────────────────

  it('logs a warning when recovery is triggered (extraction success) (AC-20)', async () => {
    fetchMock.mockResolvedValue(
      chatResponse('<tag>{"reasoning":"r","action":"brew_coffee"}</tag>'),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    await client.completeStructured(makePayload());
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0]![0] as string;
    expect(warnMsg).toContain('JSON recovery');
  });

  it('logs a warning when re-prompt is attempted (AC-20)', async () => {
    fetchMock
      .mockResolvedValueOnce(chatResponse('no json'))
      .mockResolvedValueOnce(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    await client.completeStructured(makePayload());
    expect(warnSpy).toHaveBeenCalled();
  });

  it('warning truncates raw content to ≤500 chars (AC-20)', async () => {
    const longText = 'x'.repeat(600);
    fetchMock
      .mockResolvedValueOnce(chatResponse(longText))
      .mockResolvedValueOnce(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    await client.completeStructured(makePayload());
    expect(warnSpy).toHaveBeenCalled();
    // At least one call should contain the truncated content.
    const allWarnText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // The truncated version should not contain the full 600-char string.
    expect(allWarnText).not.toContain('x'.repeat(600));
  });

  it('does not log a warning when no recovery is needed (AC-20)', async () => {
    fetchMock.mockResolvedValue(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    await client.completeStructured(makePayload());
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // ─── AC-23: LLMClient interface unchanged ───────────────────────────────────

  it('LLMClient interface methods are unchanged (AC-23)', async () => {
    const mod = await import('../src/index.js');
    // The interface is unchanged — still 4 methods.
    expect(typeof mod.OpenAICompatibleLLMClient).toBe('function');
    const client = new mod.OpenAICompatibleLLMClient({ baseUrl: OLLAMA_URL, model: MODEL });
    expect(typeof client.completeStructured).toBe('function');
    expect(typeof client.completeReflection).toBe('function');
    expect(typeof client.completePlan).toBe('function');
    expect(typeof client.completeReflect).toBe('function');
  });

  // ─── AC-25: no engine import ───────────────────────────────────────────────

  it('does not import from @evol-hive/engine (AC-25)', async () => {
    // Read the source file and check for engine imports.
    const fs = await import('fs');
    const src = fs.readFileSync('src/llm/openai-client.ts', 'utf-8');
    expect(src).not.toContain('@evol-hive/engine');
  });

  // ─── AC-36: no regression when recovery disabled + json_schema ──────────────

  it('no regression: recovery disabled + json_schema works as spec 006 (AC-36)', async () => {
    fetchMock.mockResolvedValue(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: OPENAI_URL,
      model: MODEL,
      responseFormat: 'json_schema',
      enableJsonRecovery: false,
    });
    const result = await client.completeStructured(makePayload());
    expect(result.action).toBe('brew_coffee');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    expect(body.response_format.type).toBe('json_schema');
  });

  // ─── Re-prompt uses same timeout/retry logic ───────────────────────────────

  it('re-prompt respects timeout and retry config', async () => {
    // Re-prompt gets a 429 then succeeds.
    fetchMock
      .mockResolvedValueOnce(chatResponse('no json'))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(chatResponse(validJson()));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: OLLAMA_URL,
      model: MODEL,
      maxRetries: 2,
      retryDelayMs: 1,
    });
    const result = await client.completeStructured(makePayload());
    expect(result.action).toBe('brew_coffee');
    // Original call + re-prompt (1 initial + 1 retry) = 3 total.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
