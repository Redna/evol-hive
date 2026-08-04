# Memory Configuration
# ──────────────────
# This file defines the runtime configuration schema for the memory system.
# Values are loaded from environment variables (see .env.example).

export interface MemoryRuntimeConfig {
  backend: 'lancedb' | 'chromadb' | 'in-memory';
  dataPath: string;
  reflectionThreshold: number;
}

// TODO: Implement config loading from environment with validation.
// Reference: docs/architecture/11-memory-architecture.md