/**
 * OpenAI-Compatible LLM Client (spec 006, issue #20; spec 011, issue #40)
 * ────────────────────────────────────────────────────────────────────────────
 * A concrete `LLMClient` that speaks the standard OpenAI Chat Completions API
 * (`/v1/chat/completions`). Works with any OpenAI-compatible inference server
 * (Ollama, vLLM, llama.cpp, LM Studio, hosted providers) with zero code
 * changes — only config (base URL, model, optional API key).
 *
 * Structured output uses **tool calling** (spec 011) — the `tools` parameter
 * is sent with tool definitions, and the response is parsed from
 * `choices[0].message.tool_calls[0].function.arguments`. This guarantees valid
 * JSON with correct field names, eliminating the need for JSON recovery (spec
 * 009) or schema-in-prompt hints (spec 010). Non-streaming (`stream: false`).
 * Built-in `fetch` + `AbortController` — no external HTTP library (ADR-0001).
 */

import type {
  LLMActionResponse,
  FormulatePlanResult,
  ReflectLLMResponse,
  ReflectionResult,
  MemoryNode,
  MemorySnippet,
  MemoryType,
  ToolDefinition,
  CognitiveToolExecutor,
} from '@evol-hive/shared';
import { memoryConsolidationTool } from '@evol-hive/shared';
import type { LLMContextPayload } from '../index.js';
import type { EmbeddingProvider } from '../classifier/index.js';

// ─── Error Hierarchy (Req 15) ────────────────────────────────────────────────

/** Base class for all LLM client errors. */
export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a request exceeds the configured timeout. */
export class LLMTimeoutError extends LLMError {
  readonly timeoutMs: number;
  readonly url: string;

  constructor(message: string, timeoutMs: number, url: string) {
    super(message);
    this.name = 'LLMTimeoutError';
    this.timeoutMs = timeoutMs;
    this.url = url;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown for non-2xx HTTP responses (except 429 which is retried then thrown as LLMRateLimitError). */
export class LLMHTTPError extends LLMError {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(message: string, statusCode: number, responseBody: string) {
    super(message);
    this.name = 'LLMHTTPError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown after all 429 retries are exhausted. Extends LLMHTTPError with statusCode 429. */
export class LLMRateLimitError extends LLMHTTPError {
  constructor(message: string, responseBody: string) {
    super(message, 429, responseBody);
    this.name = 'LLMRateLimitError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the response has no tool_calls or the arguments cannot be parsed (spec 011). */
export class LLMResponseError extends LLMError {
  readonly rawContent?: string;

  constructor(message: string, rawContent?: string) {
    super(message);
    this.name = 'LLMResponseError';
    if (rawContent !== undefined) {
      this.rawContent = rawContent;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Config (spec 011, Req 7/8) ──────────────────────────────────────────────

/** Configuration for {@link OpenAICompatibleLLMClient}. */
export interface OpenAICompatibleLLMClientConfig {
  /** OpenAI-compatible API base URL (default: http://localhost:11434/v1). */
  baseUrl: string;
  /** Model name to use for chat completions (e.g. "llama3.1", "gpt-4o"). */
  model: string;
  /** Optional API key for hosted providers. Local providers ignore this. */
  apiKey?: string;
  /** Request timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
  /** Max retry attempts on HTTP 429 rate limit (default: 3). */
  maxRetries?: number;
  /** Base delay between retries in milliseconds (default: 1000, exponential backoff). */
  retryDelayMs?: number;
  /** Optional embedding provider for constructing MemoryNode objects in completeReflection. */
  embeddingProvider?: EmbeddingProvider;
  /** Optional agent ID for the ReflectionResult returned by completeReflection. */
  agentId?: string;
  /** Whether to retry on timeout errors (default: true). When false, timeout errors are thrown immediately (spec 008, Req 1.2). */
  retryOnTimeout?: boolean;
  /** Optional reasoning effort level (spec 011, Req 7). When set, `reasoning_effort` is included in the request body. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'none';
  /**
   * Optional cognitive tool executor (spec 015, Req 12). When set, the client
   * executes cognitive tools (`query_memory`, `update_internal_state`) mid-loop
   * via this executor. When absent, the client falls back to single-request
   * behavior (no loop).
   */
  cognitiveToolExecutor?: CognitiveToolExecutor;
  /**
   * Maximum number of tool call iterations in the loop (default: 3, spec 015,
   * Req 12). Must be ≥ 1. If set to 0 or negative, defaults to 3.
   */
  maxToolCallIterations?: number;
}

// ─── Internal types ──────────────────────────────────────────────────────────

/**
 * Chat message types used by the client (spec 015, Req 13). The system/user
 * variants are produced by the message builders; the assistant (with
 * `tool_calls`) and tool result variants are constructed internally by the
 * tool call loop.
 */
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; content: string; tool_call_id: string };

/** The set of cognitive tool names executed mid-loop (spec 015, Req 14). */
const COGNITIVE_TOOL_NAMES = new Set<string>(['query_memory', 'update_internal_state']);

interface ConsolidatedMemoryItem {
  content: string;
  importance: number;
  type: MemoryType;
}

interface ConsolidationResult {
  consolidatedMemories?: ConsolidatedMemoryItem[];
  consolidatedNodeIds?: string[];
}

// ─── Client ──────────────────────────────────────────────────────────────────

/**
 * A concrete `LLMClient` that calls the OpenAI-compatible Chat Completions API.
 * Provider-agnostic — works with Ollama, vLLM, llama.cpp, LM Studio, and hosted
 * providers by changing `baseUrl` / `model` / `apiKey`.
 *
 * Uses tool calling (spec 011) for structured output: tool definitions are sent
 * via the `tools` parameter, and the response is parsed from
 * `tool_calls[0].function.arguments`.
 */
export class OpenAICompatibleLLMClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly embeddingProvider: EmbeddingProvider | undefined;
  private readonly agentId: string;
  private readonly retryOnTimeout: boolean;
  private readonly reasoningEffort: 'low' | 'medium' | 'high' | 'none' | undefined;
  private readonly cognitiveToolExecutor: CognitiveToolExecutor | undefined;
  private readonly maxToolCallIterations: number;

  constructor(config: OpenAICompatibleLLMClientConfig) {
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
    this.embeddingProvider = config.embeddingProvider;
    this.agentId = config.agentId ?? '';
    this.retryOnTimeout = config.retryOnTimeout ?? true;
    this.reasoningEffort = config.reasoningEffort;
    this.cognitiveToolExecutor = config.cognitiveToolExecutor;
    const configuredIterations = config.maxToolCallIterations ?? 3;
    this.maxToolCallIterations = configuredIterations >= 1 ? configuredIterations : 3;
  }

  // ── LLMClient: completeStructured (Req 10) ─────────────────────────────────

  async completeStructured(payload: LLMContextPayload): Promise<LLMActionResponse> {
    const messages = this.buildPayloadMessages(payload);
    const parsed = await this.requestChat(messages, payload.tools, payload.agentId);

    const reasoning = parsed['reasoning'];
    const action = parsed['action'];
    if (typeof reasoning !== 'string' || typeof action !== 'string') {
      throw new LLMResponseError(
        'LLM response missing required "reasoning" (string) or "action" (string) field.',
        JSON.stringify(parsed),
      );
    }
    const result: LLMActionResponse = { reasoning, action };

    if (typeof parsed['actionArgs'] === 'object' && parsed['actionArgs'] !== null) {
      result.actionArgs = parsed['actionArgs'] as Record<string, unknown>;
    }
    if (typeof parsed['observeTarget'] === 'string') {
      result.observeTarget = parsed['observeTarget'];
    }
    if (typeof parsed['updatedGoal'] === 'string') {
      result.updatedGoal = parsed['updatedGoal'];
    }
    return result;
  }

  // ── LLMClient: completePlan (Req 11) ───────────────────────────────────────

  async completePlan(payload: LLMContextPayload): Promise<FormulatePlanResult> {
    const messages = this.buildPayloadMessages(payload);
    const parsed = await this.requestChat(messages, payload.tools, payload.agentId);

    const description = parsed['description'];
    const steps = parsed['steps'];
    if (
      typeof description !== 'string' ||
      description.length === 0 ||
      !Array.isArray(steps) ||
      steps.length === 0
    ) {
      throw new LLMResponseError(
        'LLM plan response missing required "description" (non-empty string) or "steps" (non-empty array).',
        JSON.stringify(parsed),
      );
    }
    return {
      description,
      steps: (steps as unknown[]).map((s) => {
        const obj = s as Record<string, unknown>;
        // LLMs may use different field names for step items:
        // - description: the step's human-readable description
        // - targetAffordance: the affordance ID to execute
        // Common aliases: reason→description, action→targetAffordance, affordance→targetAffordance
        const step: { description: string; targetAffordance?: string } = {
          description: String(
            obj['description'] ?? obj['reason'] ?? obj['action'] ?? obj['name'] ?? '',
          ),
        };
        const ta = obj['targetAffordance'] ?? obj['action'] ?? obj['affordance'] ?? obj['target'];
        if (typeof ta === 'string') {
          step.targetAffordance = ta;
        }
        return step;
      }),
    };
  }

  // ── LLMClient: completeReflect (Req 12) ────────────────────────────────────

  async completeReflect(payload: LLMContextPayload): Promise<ReflectLLMResponse> {
    const messages = this.buildPayloadMessages(payload);
    const parsed = await this.requestChat(messages, payload.tools, payload.agentId);

    const result: ReflectLLMResponse = {};
    if (typeof parsed['newGoal'] === 'string') {
      result.newGoal = parsed['newGoal'];
    }
    if (typeof parsed['driveOverrides'] === 'object' && parsed['driveOverrides'] !== null) {
      result.driveOverrides = parsed['driveOverrides'] as Partial<Record<string, number>>;
    }
    const memEntry = parsed['memoryEntry'];
    if (typeof memEntry === 'object' && memEntry !== null) {
      const me = memEntry as Record<string, unknown>;
      const content = me['content'];
      const importance = me['importance'];
      const type = me['type'];
      if (
        typeof content === 'string' &&
        typeof importance === 'number' &&
        typeof type === 'string'
      ) {
        const entry: { content: string; importance: number; type: MemoryType; location?: string } =
          {
            content,
            importance,
            type: type as MemoryType,
          };
        if (typeof me['location'] === 'string') {
          entry.location = me['location'];
        }
        result.memoryEntry = entry;
      }
    }
    return result;
  }

  // ── LLMClient: completeReflection (Req 13) ─────────────────────────────────

  async completeReflection(
    systemPrompt: string,
    memoryNodes: MemorySnippet[],
  ): Promise<ReflectionResult> {
    const userContent = this.buildReflectionUserMessage(memoryNodes);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];
    const parsed = await this.requestChat(messages, [memoryConsolidationTool]);
    const result = parsed as unknown as ConsolidationResult;

    const consolidatedMemories = result.consolidatedMemories ?? [];
    const consolidatedNodeIds = result.consolidatedNodeIds ?? [];

    const now = Date.now();
    const newMemories: MemoryNode[] = [];
    for (let i = 0; i < consolidatedMemories.length; i++) {
      const item = consolidatedMemories[i]!;
      const id = `mem_consolidated_${now}_${i}`;
      let embedding: number[] = [];
      if (this.embeddingProvider) {
        embedding = await this.embeddingProvider.embed(item.content);
      }
      newMemories.push({
        id,
        agentId: this.agentId,
        content: item.content,
        embedding,
        timestamp: now,
        importance: item.importance,
        type: item.type,
      });
    }

    return {
      agentId: this.agentId,
      newMemories,
      consolidatedNodeIds,
    };
  }

  // ── Private: shared request method (spec 011 — tool calling; spec 015 — tool call loop) ────

  /**
   * Shared low-level request method used by all four public methods.
   * Sends tool definitions via the `tools` parameter and parses the response
   * from `choices[0].message.tool_calls[0].function.arguments`.
   *
   * When a `cognitiveToolExecutor` is configured and `agentId` is provided
   * (spec 015, Req 15), runs a multi-turn tool call loop: cognitive tools
   * (`query_memory`, `update_internal_state`) are executed mid-loop and their
   * results fed back to the LLM; the loop terminates when a terminal tool is
   * called or `maxToolCallIterations` is exceeded. Otherwise behaves exactly
   * as the single-request implementation (spec 011).
   */
  private async requestChat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    agentId?: string,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/chat/completions`;

    // When the cognitive tool executor is not wired or no agentId is available,
    // fall back to single-request behavior (spec 015, Req 15 step 5).
    if (this.cognitiveToolExecutor === undefined || agentId === undefined) {
      const { argsStr } = await this.sendRequest(url, messages, tools);
      return this.parseToolCallArgs(argsStr, url);
    }

    // Multi-turn tool call loop (spec 015, Req 15).
    const executor = this.cognitiveToolExecutor;
    const workingMessages = [...messages];
    let iterationCount = 0;

    for (;;) {
      const { toolCallId, toolName, argsStr } = await this.sendRequest(url, workingMessages, tools);

      // Terminal tool — parse arguments and return (Req 15 step 3).
      if (!COGNITIVE_TOOL_NAMES.has(toolName)) {
        return this.parseToolCallArgs(argsStr, url);
      }

      // Cognitive tool — execute mid-loop (Req 15 step 4).
      let toolResultContent: string;
      try {
        const args = this.parseToolCallArgs(argsStr, url);
        let result: unknown;
        if (toolName === 'query_memory') {
          const query = typeof args['query'] === 'string' ? (args['query'] as string) : '';
          const topK = typeof args['topK'] === 'number' ? (args['topK'] as number) : 5;
          result = await executor.executeQueryMemory(agentId, query, topK);
        } else {
          // update_internal_state
          const newGoal =
            typeof args['newGoal'] === 'string' ? (args['newGoal'] as string) : undefined;
          const driveOverrides =
            typeof args['driveOverrides'] === 'object' && args['driveOverrides'] !== null
              ? (args['driveOverrides'] as Partial<Record<string, number>>)
              : undefined;
          result = await executor.executeUpdateInternalState(agentId, newGoal, driveOverrides);
        }
        toolResultContent = JSON.stringify(result);
      } catch (err) {
        // Secondary safety net — send the error back to the LLM (Req 17).
        const message = err instanceof Error ? err.message : String(err);
        toolResultContent = JSON.stringify({ error: message });
      }

      // Append the assistant message (with tool_calls) and the tool result message.
      workingMessages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: toolCallId, type: 'function', function: { name: toolName, arguments: argsStr } },
        ],
      });
      workingMessages.push({
        role: 'tool',
        content: toolResultContent,
        tool_call_id: toolCallId,
      });

      // Increment the iteration counter and enforce the limit (Req 15 step 4e).
      // The limit counts cognitive tool executions — after `maxToolCallIterations`
      // executions, the loop terminates rather than sending another request.
      iterationCount++;
      if (iterationCount >= this.maxToolCallIterations) {
        throw new LLMError(
          `Tool call loop exceeded max iterations (${this.maxToolCallIterations}). Last tool: ${toolName}.`,
        );
      }
    }
  }

  /**
   * Parses the raw `function.arguments` string into an object, throwing
   * `LLMResponseError` on invalid JSON.
   */
  private parseToolCallArgs(argsStr: string, url: string): Record<string, unknown> {
    try {
      return JSON.parse(argsStr) as Record<string, unknown>;
    } catch {
      throw new LLMResponseError(
        `LLM response from ${url} has invalid JSON in tool_calls[0].function.arguments.`,
        argsStr,
      );
    }
  }

  // ── Private: low-level HTTP request with retry loop ─────────────────────────

  /**
   * Sends a single logical request (with 429 retry loop) and returns the raw
   * tool call details (`toolCallId`, `toolName`, `argsStr`) extracted from
   * `choices[0].message.tool_calls[0]` (spec 015 refactor). The caller parses
   * `argsStr` and decides whether to continue the tool call loop.
   */
  private async sendRequest(
    url: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
  ): Promise<{ toolCallId: string; toolName: string; argsStr: string }> {
    const bodyObj: Record<string, unknown> = {
      model: this.model,
      messages,
      tools,
      stream: false,
    };

    // tool_choice: when a single tool is provided, force it; otherwise auto.
    if (tools.length === 1) {
      bodyObj['tool_choice'] = {
        type: 'function',
        function: { name: tools[0]!.function.name },
      };
    } else {
      bodyObj['tool_choice'] = 'auto';
    }

    // Include reasoning_effort when configured (spec 011, Req 7).
    if (this.reasoningEffort !== undefined) {
      bodyObj['reasoning_effort'] = this.reasoningEffort;
    }

    const body = JSON.stringify(bodyObj);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.apiKey && this.apiKey.length > 0) {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.retryDelayMs * 2 ** (attempt - 1);
        await this.sleep(delay);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        if (this.isAbortError(err)) {
          if (!this.retryOnTimeout) {
            throw new LLMTimeoutError(
              `LLM request to ${url} timed out after ${this.timeoutMs}ms.`,
              this.timeoutMs,
              url,
            );
          }
          if (attempt < this.maxRetries) {
            lastError = new LLMTimeoutError(
              `LLM request to ${url} timed out after ${this.timeoutMs}ms.`,
              this.timeoutMs,
              url,
            );
            continue;
          }
          throw new LLMTimeoutError(
            `LLM request to ${url} timed out after ${this.timeoutMs}ms.`,
            this.timeoutMs,
            url,
          );
        }
        if (attempt < this.maxRetries) {
          lastError = new LLMError(`LLM request to ${url} failed: ${(err as Error).message}`);
          continue;
        }
        throw new LLMError(`LLM request to ${url} failed: ${(err as Error).message}`);
      }
      clearTimeout(timeoutId);

      if (response.status === 429) {
        const respBody = await response.text().catch(() => '');
        lastError = new LLMRateLimitError(
          `LLM request to ${url} rate limited (429) after ${attempt} retries.`,
          respBody,
        );
        if (attempt < this.maxRetries) {
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const respBody = await response.text().catch(() => '');
        throw new LLMHTTPError(
          `LLM request to ${url} failed with status ${response.status}.`,
          response.status,
          respBody,
        );
      }

      // Parse the OpenAI-style response envelope.
      const rawEnvelope = await response.text().catch(() => '');
      let parsedEnvelope: unknown;
      try {
        parsedEnvelope = JSON.parse(rawEnvelope);
      } catch {
        throw new LLMResponseError(`LLM response from ${url} is not valid JSON.`, rawEnvelope);
      }

      const choices = (parsedEnvelope as Record<string, unknown> | null)?.['choices'];
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new LLMResponseError(
          `LLM response from ${url} has no choices array.`,
          JSON.stringify(parsedEnvelope),
        );
      }

      const choice = choices[0] as Record<string, unknown>;
      const message = choice['message'] as Record<string, unknown> | undefined;
      const toolCalls = message?.['tool_calls'];

      // When tool_calls is missing or empty, throw LLMResponseError (spec 011, Req 6).
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw new LLMResponseError(
          `LLM response from ${url} has no tool_calls in choices[0].message.`,
          JSON.stringify(parsedEnvelope),
        );
      }

      const toolCall = toolCalls[0] as Record<string, unknown>;
      const toolCallId = typeof toolCall['id'] === 'string' ? (toolCall['id'] as string) : '';
      const fn = toolCall['function'] as Record<string, unknown> | undefined;
      const toolName = typeof fn?.['name'] === 'string' ? (fn!['name'] as string) : '';
      const argsStr = fn?.['arguments'];

      if (typeof argsStr !== 'string') {
        throw new LLMResponseError(
          `LLM response from ${url} has no string arguments in tool_calls[0].function.`,
          JSON.stringify(parsedEnvelope),
        );
      }

      return { toolCallId, toolName, argsStr };
    }

    // Should be unreachable — the loop always returns or throws.
    throw lastError ?? new LLMError(`LLM request to ${url} failed unexpectedly.`);
  }

  // ── Private: message builders ──────────────────────────────────────────────

  /**
   * Builds the system + user messages from an `LLMContextPayload` (Req 6).
   */
  private buildPayloadMessages(payload: LLMContextPayload): ChatMessage[] {
    return [
      { role: 'system', content: payload.systemPrompt },
      { role: 'user', content: this.buildUserMessage(payload) },
    ];
  }

  /** Constructs the user message from perception context, affordances, and tools (Req 14). */
  private buildUserMessage(payload: LLMContextPayload): string {
    const parts: string[] = [payload.perceptionContext];

    if (payload.availableAffordances.length > 0) {
      const lines = payload.availableAffordances.map((a) => `id: ${a.id}, label: ${a.label}`);
      parts.push(`Available actions:\n${lines.join('\n')}`);
    }

    if (payload.cognitiveTools.length > 0) {
      const lines = payload.cognitiveTools.map(
        (t) => `name: ${t.name}, description: ${t.description}`,
      );
      parts.push(`Cognitive tools:\n${lines.join('\n')}`);
    }

    // No schema hint is appended (spec 011, Req 14 — schemaHint field removed).

    return parts.join('\n\n');
  }

  /** Constructs the user message for memory consolidation (Req 13 — no schema hint). */
  private buildReflectionUserMessage(memoryNodes: MemorySnippet[]): string {
    const lines = memoryNodes.map(
      (n) => `id: ${n.id}, content: ${n.content}, importance: ${n.importance}`,
    );
    return `Memory nodes to consolidate:\n${lines.join('\n')}`;
  }

  // ── Private: utilities ─────────────────────────────────────────────────────

  private isAbortError(err: unknown): boolean {
    if (err instanceof Error && err.name === 'AbortError') return true;
    const code = (err as Record<string, unknown> | null)?.['code'];
    return code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
