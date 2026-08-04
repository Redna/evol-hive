# LLM Configuration
# ────────────────
# This file defines the runtime configuration schema for the LLM backend.
# Values are loaded from environment variables (see .env.example).

export interface LLMRuntimeConfig {
  provider: 'ollama' | 'llamacpp' | 'vllm';
  baseUrl: string;
  model: string;
  reflectionModel: string;
  maxTokens: number;
  temperature: number;
}

// TODO: Implement config loading from environment with validation.
// Reference: docs/architecture/07-structured-outputs.md