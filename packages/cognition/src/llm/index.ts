/**
 * llm/ — LLM Client implementations
 * ─────────────────────────────────────────────
 * Concrete `LLMClient` implementations that speak to OpenAI-compatible
 * inference servers (spec 006). JSON recovery utilities (spec 009).
 */

export {
  OpenAICompatibleLLMClient,
  type OpenAICompatibleLLMClientConfig,
  type ResponseFormat,
  LLMError,
  LLMTimeoutError,
  LLMHTTPError,
  LLMRateLimitError,
  LLMResponseError,
  extractJsonFromText,
  resolveField,
} from './openai-client.js';
