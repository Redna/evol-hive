/**
 * llm/ — LLM Client implementations
 * ─────────────────────────────────────────────
 * Concrete `LLMClient` implementations that speak to OpenAI-compatible
 * inference servers (spec 006). Uses tool calling for structured output (spec 011).
 */

export {
  OpenAICompatibleLLMClient,
  type OpenAICompatibleLLMClientConfig,
  LLMError,
  LLMTimeoutError,
  LLMHTTPError,
  LLMRateLimitError,
  LLMResponseError,
} from './openai-client.js';
export { TokenUsageReporter } from './token-usage-reporter.js';
export { LLMResponseCache, type LLMResponseCacheOptions } from './response-cache.js';
