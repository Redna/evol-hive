# Engine Configuration
# ───────────────────
# This file defines the runtime configuration schema for the deterministic engine.
# Values are loaded from environment variables (see .env.example).

export interface EngineRuntimeConfig {
  fps: number;
  spatialDebounceSeconds: number;
  maxConcurrentLLM: number;
  guardrailsEnabled: boolean;
}

// TODO: Implement config loading from environment with validation.
// Reference: docs/architecture/09-engine-routing.md