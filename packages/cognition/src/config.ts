// config/ — Cognition runtime configuration loaded from environment
// ──────────────────────────────────────────────────────────────────
// Section 5: Classifier config values are loaded from environment
// variables (see .env.example). Defaults match the .env.example values.

/** Classifier configuration loaded from environment. */
export interface ClassifierEnvConfig {
  /** Top-K affordances to retain after pruning. */
  topK: number;
  /** Minimum cosine similarity threshold for pruning. */
  similarityThreshold: number;
}

/**
 * Load classifier config from environment variables.
 * Defaults: CLASSIFIER_TOP_K=5, CLASSIFIER_SIMILARITY_THRESHOLD=0.3
 */
export function loadClassifierEnvConfig(): ClassifierEnvConfig {
  return {
    topK: Number(process.env['CLASSIFIER_TOP_K'] ?? 5),
    similarityThreshold: Number(process.env['CLASSIFIER_SIMILARITY_THRESHOLD'] ?? 0.3),
  };
}
