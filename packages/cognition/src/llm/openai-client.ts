/**
 * OpenAI-Compatible LLM Client (spec 006, issue #20; spec 009, issue #34)
 * ────────────────────────────────────────────────────────────────────────────
 * A concrete `LLMClient` that speaks the standard OpenAI Chat Completions API
 * (`/v1/chat/completions`). Works with any OpenAI-compatible inference server
 * (Ollama, vLLM, llama.cpp, LM Studio, hosted providers) with zero code
 * changes — only config (base URL, model, optional API key).
 *
 * Structured output uses `response_format` — either `{ type: "json_schema", ... }`
 * (default for non-Ollama providers) or `{ type: "json_object" }` (Ollama or
 * explicit config). Non-streaming (`stream: false`). Built-in `fetch` +
 * `AbortController` — no external HTTP library (ADR-0001 lean monorepo).
 *
 * JSON Recovery (spec 009): when `JSON.parse(content)` fails, the client
 * attempts to extract a JSON object from the raw text (substring search). If
 * that fails, a single re-prompt is sent with `{ type: "json_object" }` and an
 * explicit JSON instruction. This handles Ollama cloud-backed models that wrap
 * responses in XML-like tags instead of enforcing `json_schema`.
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
import { extractJsonFromText } from './json-recovery.js';

// Re-export for discoverability (spec 009, Req 19).
export { extractJsonFromText } from './json-recovery.js';

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
  /** Raw content from the first response that triggered recovery (spec 009, Req 7). */
  readonly originalRawContent?: string;
  /** Whether JSON recovery (extraction + re-prompt) was attempted (spec 009, Req 7). */
  readonly recoveryAttempted?: boolean;

  constructor(
    message: string,
    rawContent?: string,
    options?: { originalRawContent?: string; recoveryAttempted?: boolean },
  ) {
    super(message);
    this.name = 'LLMResponseError';
    if (rawContent !== undefined) {
      this.rawContent = rawContent;
    }
    if (options?.originalRawContent !== undefined) {
      this.originalRawContent = options.originalRawContent;
    }
    if (options?.recoveryAttempted !== undefined) {
      this.recoveryAttempted = options.recoveryAttempted;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Config (Req 3, spec 009 Req 4/8) ─────────────────────────────────────────

/** Preferred response format selection (spec 009, Req 4). */
export type ResponseFormat = 'json_schema' | 'json_object' | 'auto';

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
  /** Preferred response format (spec 009, Req 4). `'auto'` uses `json_schema` for non-Ollama and `json_object` for Ollama (auto-detected from baseUrl). Default: `'auto'`. */
  responseFormat?: ResponseFormat;
  /** Backward-compatible boolean for response format (spec 009, Req 3). `true` → `json_schema`, `false` → `json_object`. Ignored when `responseFormat` is explicitly set. */
  useJsonSchema?: boolean;
  /** Whether to enable JSON recovery (extraction + re-prompt) on parse failure (spec 009, Req 8). Default: `true`. */
  enableJsonRecovery?: boolean;
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

/** The response_format envelope sent in the request body. */
type ResponseFormatEnvelope =
  | { type: 'json_schema'; json_schema: { name: string; schema: object; strict: true } }
  | { type: 'json_object' };

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
  private readonly responseFormat: ResponseFormat;
  private readonly enableJsonRecovery: boolean;

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
    this.enableJsonRecovery = config.enableJsonRecovery ?? true;

    // Resolve response format (spec 009, Req 4):
    //   - responseFormat takes precedence if explicitly set.
    //   - useJsonSchema maps to 'json_schema' (true) / 'json_object' (false).
    //   - Default: 'auto'.
    if (config.responseFormat !== undefined) {
      this.responseFormat = config.responseFormat;
    } else if (config.useJsonSchema !== undefined) {
      this.responseFormat = config.useJsonSchema ? 'json_schema' : 'json_object';
    } else {
      this.responseFormat = 'auto';
    }
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

  // ── Private: shared request method (Req 15, spec 009 recovery) ──────────────

  /**
   * Shared low-level request method used by all four public methods.
   * Handles HTTP, authorization, timeout, retries (429), JSON parsing,
   * JSON recovery (extraction + re-prompt, spec 009), and errors.
   * Returns the parsed JSON object from `choices[0].message.content`.
   */
  private async requestChat(
    messages: ChatMessage[],
    responseSchema: object,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/chat/completions`;
    const envelope = this.resolveResponseFormat(responseSchema);

    // Initial request.
    const { content } = await this.sendRequest(url, messages, envelope);

    // Try direct parse first.
    const direct = this.tryParse(content);
    if (direct !== undefined) {
      return direct;
    }

    // JSON.parse failed — attempt recovery (spec 009).
    if (!this.enableJsonRecovery) {
      throw new LLMResponseError(`LLM response content from ${url} is not valid JSON.`, content);
    }

    // Step 1: extraction from raw text (Req 1).
    const extracted = extractJsonFromText(content);
    if (extracted !== null) {
      this.warnRecovery(content, true, false);
      return extracted.json as Record<string, unknown>;
    }

    // Step 2: re-prompt with json_object + schema summary (Req 2).
    this.warnRecovery(content, false, true);
    const rePromptMessages = this.buildRePromptMessages(messages, responseSchema);
    const rePromptEnvelope: ResponseFormatEnvelope = { type: 'json_object' };

    let rePromptContent: string;
    try {
      const reResult = await this.sendRequest(url, rePromptMessages, rePromptEnvelope);
      rePromptContent = reResult.content;
    } catch (err) {
      // If the re-prompt itself throws (HTTP error, timeout), enrich and rethrow.
      throw new LLMResponseError(
        `LLM response content from ${url} is not valid JSON and re-prompt failed: ${(err as Error).message}`,
        undefined,
        { originalRawContent: content, recoveryAttempted: true },
      );
    }

    // Try to parse the re-prompt response (direct + extraction).
    const reParsed = this.tryParse(rePromptContent);
    if (reParsed !== undefined) {
      return reParsed;
    }
    const reExtracted = extractJsonFromText(rePromptContent);
    if (reExtracted !== null) {
      return reExtracted.json as Record<string, unknown>;
    }

    // Both original and re-prompt failed — throw enriched error (Req 6).
    throw new LLMResponseError(
      `LLM response content from ${url} is not valid JSON after recovery attempt.`,
      rePromptContent,
      { originalRawContent: content, recoveryAttempted: true },
    );
  }

  // ── Private: low-level HTTP request with retry loop ─────────────────────────

  /**
   * Sends a single logical request (with 429 retry loop) and returns the raw
   * `content` string from `choices[0].message.content`. Does NOT parse the
   * content as JSON — that is the caller's responsibility (allows recovery).
   */
  private async sendRequest(
    url: string,
    messages: ChatMessage[],
    envelope: ResponseFormatEnvelope,
  ): Promise<{ content: string }> {
    const body = JSON.stringify({
      model: this.model,
      messages,
      response_format: envelope,
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
      const content = message?.['content'];
      if (typeof content !== 'string') {
        throw new LLMResponseError(
          `LLM response from ${url} has no string content in choices[0].message.`,
          JSON.stringify(parsedEnvelope),
        );
      }

      return { content };
    }

    // Should be unreachable — the loop always returns or throws.
    throw lastError ?? new LLMError(`LLM request to ${url} failed unexpectedly.`);
  }

  // ── Private: response format resolution (spec 009, Req 3/4) ────────────────

  /**
   * Resolves the `response_format` envelope based on config and baseUrl.
   * - `'json_schema'` → always `{ type: "json_schema", ... }`.
   * - `'json_object'` → always `{ type: "json_object" }`.
   * - `'auto'` → `json_object` if baseUrl matches Ollama, `json_schema` otherwise.
   */
  private resolveResponseFormat(responseSchema: object): ResponseFormatEnvelope {
    let useSchema: boolean;
    if (this.responseFormat === 'json_schema') {
      useSchema = true;
    } else if (this.responseFormat === 'json_object') {
      useSchema = false;
    } else {
      // 'auto' — detect Ollama from baseUrl.
      useSchema = !this.isOllamaBaseUrl(this.baseUrl);
    }

    if (useSchema) {
      return {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: responseSchema,
          strict: true,
        },
      };
    }
    return { type: 'json_object' };
  }

  /** Returns true when the baseUrl hostname matches an Ollama instance. */
  private isOllamaBaseUrl(baseUrl: string): boolean {
    try {
      const url = new URL(baseUrl);
      const host = url.hostname;
      const port = url.port;
      return (host === 'localhost' || host === '127.0.0.1') && port === '11434';
    } catch {
      return false;
    }
  }

  // ── Private: JSON parsing helpers ──────────────────────────────────────────

  /** Tries to parse `content` as a JSON object. Returns `undefined` on failure. */
  private tryParse(content: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return parsed;
    } catch {
      return undefined;
    }
  }

  // ── Private: re-prompt construction (spec 009, Req 2/5) ─────────────────────

  /**
   * Builds the messages array for the re-prompt: original messages plus an
   * additional user message instructing the LLM to respond in valid JSON with a
   * human-readable summary of the expected schema.
   */
  private buildRePromptMessages(
    originalMessages: ChatMessage[],
    responseSchema: object,
  ): ChatMessage[] {
    const summary = this.summarizeSchema(responseSchema);
    const instruction: ChatMessage = {
      role: 'user',
      content: `Your previous response was not valid JSON. Respond ONLY with a valid JSON object matching this structure: ${summary}. Do not include any prose, markdown, or code fences.`,
    };
    return [...originalMessages, instruction];
  }

  /**
   * Generates a human-readable summary of a JSON schema (spec 009, Req 5).
   * Includes top-level property names, their types, and required fields.
   * For nested objects, only the first level of properties is summarized.
   */
  private summarizeSchema(schema: object): string {
    const s = schema as Record<string, unknown>;
    const properties = s['properties'] as Record<string, unknown> | undefined;
    const required = s['required'] as string[] | undefined;

    if (!properties || typeof properties !== 'object') {
      return '{}';
    }

    const parts: string[] = [];
    for (const [name, def] of Object.entries(properties)) {
      const d = def as Record<string, unknown> | undefined;
      if (!d) continue;
      const type = d['type'];
      let typeStr: string;
      if (Array.isArray(type)) {
        typeStr = type.join(' | ');
      } else if (typeof type === 'string') {
        typeStr = type;
      } else if (d['properties'] !== undefined) {
        typeStr = 'object';
      } else if (d['items'] !== undefined) {
        typeStr = 'array';
      } else {
        typeStr = 'unknown';
      }
      const isRequired = required?.includes(name) ?? false;
      parts.push(`${name}: ${typeStr}${isRequired ? ' (required)' : ''}`);
    }

    const requiredList =
      required && required.length > 0 ? ` Required: ${required.join(', ')}.` : '';
    return `{ ${parts.join(', ')} }${requiredList}`;
  }

  // ── Private: observability (spec 009, Req 18) ───────────────────────────────

  /** Logs a recovery warning with truncated raw content (≤500 chars). */
  private warnRecovery(
    rawContent: string,
    extractionSucceeded: boolean,
    rePromptAttempted: boolean,
  ): void {
    const truncated = rawContent.length > 500 ? rawContent.slice(0, 500) + '…' : rawContent;
    console.warn(
      `[JSON recovery] extractionSucceeded=${extractionSucceeded}, rePromptAttempted=${rePromptAttempted}, rawContent=${truncated}`,
    );
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
    const code = (err as Record<string, unknown> | null)?.['code'];
    return code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
