/**
 * OpenAI-Compatible LLM Client (spec 006, issue #20)
 * ────────────────────────────────────────────────────────────────────────────
 * A concrete `LLMClient` that speaks the standard OpenAI Chat Completions API
 * (`/v1/chat/completions`). Works with any OpenAI-compatible inference server
 * (Ollama, vLLM, llama.cpp, LM Studio, hosted providers) with zero code
 * changes — only config (base URL, model, optional API key).
 *
 * Structured output uses `response_format: { type: "json_schema", ... }`.
 * Non-streaming (`stream: false`). Built-in `fetch` + `AbortController` — no
 * external HTTP library (ADR-0001 lean monorepo).
 */

import type {
  LLMActionResponse,
  FormulatePlanResult,
  ReflectLLMResponse,
  ReflectionResult,
  MemoryNode,
  MemorySnippet,
  MemoryType,
} from '@evol-hive/shared';
import { memoryConsolidationSchema } from '@evol-hive/shared';
import type { LLMContextPayload } from '../index.js';
import type { EmbeddingProvider } from '../classifier/index.js';

// ─── Error Hierarchy (Req 14) ────────────────────────────────────────────────

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

/** Thrown when the response content cannot be parsed as JSON or fails validation. */
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

// ─── Config (Req 3) ──────────────────────────────────────────────────────────

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
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

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
  }

  // ── LLMClient: completeStructured (Req 7) ──────────────────────────────────

  async completeStructured(payload: LLMContextPayload): Promise<LLMActionResponse> {
    const messages = this.buildPayloadMessages(payload);
    const parsed = await this.requestChat(messages, payload.responseSchema);
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

  // ── LLMClient: completePlan (Req 8) ────────────────────────────────────────

  async completePlan(payload: LLMContextPayload): Promise<FormulatePlanResult> {
    const messages = this.buildPayloadMessages(payload);
    const parsed = await this.requestChat(messages, payload.responseSchema);
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
        const step: { description: string; targetAffordance?: string } = {
          description: String(obj['description'] ?? ''),
        };
        if (typeof obj['targetAffordance'] === 'string') {
          step.targetAffordance = obj['targetAffordance'];
        }
        return step;
      }),
    };
  }

  // ── LLMClient: completeReflect (Req 9) ─────────────────────────────────────

  async completeReflect(payload: LLMContextPayload): Promise<ReflectLLMResponse> {
    const messages = this.buildPayloadMessages(payload);
    const parsed = await this.requestChat(messages, payload.responseSchema);
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

  // ── LLMClient: completeReflection (Req 10) ─────────────────────────────────

  async completeReflection(
    systemPrompt: string,
    memoryNodes: MemorySnippet[],
  ): Promise<ReflectionResult> {
    const userContent = this.buildReflectionUserMessage(memoryNodes);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];
    const parsed = await this.requestChat(messages, memoryConsolidationSchema);
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

  // ── Private: shared request method (Req 15) ────────────────────────────────

  /**
   * Shared low-level request method used by all four public methods.
   * Handles HTTP, authorization, timeout, retries (429), JSON parsing, and errors.
   * Returns the parsed JSON object from `choices[0].message.content`.
   */
  private async requestChat(
    messages: ChatMessage[],
    responseSchema: object,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: responseSchema,
          strict: true,
        },
      },
      stream: false,
    });

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
          // Timeout error (spec 008, Req 1.1) — retry if enabled and attempts remain.
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
        // Non-abort fetch error (connection refused, DNS failure) — retry if attempts remain (spec 008, Req 1.1).
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
        // Retry if we haven't exhausted attempts.
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

      // Parse the OpenAI-style response envelope. Read text first so the body
      // can be reused for debugging on parse failure.
      const rawEnvelope = await response.text().catch(() => '');
      let envelope: unknown;
      try {
        envelope = JSON.parse(rawEnvelope);
      } catch {
        throw new LLMResponseError(`LLM response from ${url} is not valid JSON.`, rawEnvelope);
      }

      const choices = (envelope as Record<string, unknown> | null)?.['choices'];
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new LLMResponseError(
          `LLM response from ${url} has no choices array.`,
          JSON.stringify(envelope),
        );
      }

      const choice = choices[0] as Record<string, unknown>;
      const message = choice['message'] as Record<string, unknown> | undefined;
      const content = message?.['content'];
      if (typeof content !== 'string') {
        throw new LLMResponseError(
          `LLM response from ${url} has no string content in choices[0].message.`,
          JSON.stringify(envelope),
        );
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content) as Record<string, unknown>;
      } catch {
        throw new LLMResponseError(`LLM response content from ${url} is not valid JSON.`, content);
      }

      return parsed;
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

  /** Constructs the user message from perception context, affordances, and tools (Req 6). */
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

    return parts.join('\n\n');
  }

  /** Constructs the user message for memory consolidation (Req 10). */
  private buildReflectionUserMessage(memoryNodes: MemorySnippet[]): string {
    const lines = memoryNodes.map(
      (n) => `id: ${n.id}, content: ${n.content}, importance: ${n.importance}`,
    );
    return `Memory nodes to consolidate:\n${lines.join('\n')}`;
  }

  // ── Private: utilities ─────────────────────────────────────────────────────

  private isAbortError(err: unknown): boolean {
    if (err instanceof Error && err.name === 'AbortError') return true;
    // Some runtimes set a `code` property instead.
    const code = (err as Record<string, unknown> | null)?.['code'];
    return code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
