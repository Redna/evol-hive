/**
 * llm/ — LLM Client implementations
 * ─────────────────────────────────────
 * Concrete `LLMClient` implementations that speak to OpenAI-compatible
 * inference servers (spec 006).
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
