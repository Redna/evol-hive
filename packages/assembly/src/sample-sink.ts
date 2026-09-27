/**
 * sample-sink — the System-1 sample-sink decision (spec 067, R1/R4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Where a run's outcome samples go is a *decision*, not an inline ternary. The
 * measured failure this exists to prevent (spec 067 Problem Summary): a
 * real-LLM visualizer run spent ~16 h and 47,808 cloud LLM calls, and the
 * sink silently fell back to memory, so nothing survived.
 *
 * The rule:
 *
 *   - a run that **spends** (`USE_REAL_LLM=true`) ALWAYS gets a file sink; it
 *     defaults to `session-logs` when no directory is configured, and a blank
 *     or whitespace directory cannot demote it to memory (AC-9/AC-10);
 *   - a **cheap** run (`USE_REAL_LLM=false`) keeps the in-memory sink unless a
 *     directory is explicitly configured — no files are written by default
 *     (AC-4).
 *
 * Pure and dependency-free so the decision is assertable as data (spec Test
 * Seam 1) instead of by launching anything.
 */

/** Default directory for a spending run's samples (`session-logs/`). */
export const DEFAULT_SESSION_LOG_DIR = 'session-logs';

/** The sink a run's samples land in. */
export type SampleSinkKind = 'file' | 'memory';

/**
 * The chosen sink, as data. A discriminated union so callers narrow with
 * `decision.kind === 'file'` and the directory is non-null on the file arm.
 */
export type SampleSinkDecision =
  | { readonly kind: 'file'; readonly directory: string }
  | { readonly kind: 'memory'; readonly directory: null };

/** The run configuration the sink decision is made from. */
export interface SampleSinkConfig {
  /** Whether this run spends real LLM calls (`USE_REAL_LLM=true`). */
  readonly useRealLlm: boolean;
  /** Explicit `SYSTEM1_SESSION_LOG_DIR`; overrides {@link DEFAULT_SESSION_LOG_DIR}. */
  readonly sessionLogDir?: string | undefined;
  /** Directory used for a spending run without an explicit one. */
  readonly defaultDir?: string | undefined;
}

/**
 * Decide where a run's samples go. A spending run can never select the
 * in-memory sink; a cheap run is never forced to write files. An unset, empty
 * or whitespace-only directory is treated as "not configured".
 */
export function resolveSampleSink(config: SampleSinkConfig): SampleSinkDecision {
  const explicit = config.sessionLogDir?.trim();
  if (explicit !== undefined && explicit !== '') {
    return { kind: 'file', directory: explicit };
  }
  if (config.useRealLlm) {
    return { kind: 'file', directory: config.defaultDir ?? DEFAULT_SESSION_LOG_DIR };
  }
  return { kind: 'memory', directory: null };
}
