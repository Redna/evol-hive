/**
 * Engine Types — Game Loop, Physics, Spatial, Routing
 * ───────────────────────────────────────────────────────────────────
 * Section 9: TypeScript engine routing & asynchronous execution.
 */

/** The status of an agent's action execution. */
export type ExecutionStatus = 'pending' | 'thinking' | 'executing' | 'success' | 'failed';

/** A queued action awaiting LLM response or engine execution. */
export interface PendingAction {
  agentId: string;
  action: string;
  actionArgs?: Record<string, unknown>;
  status: ExecutionStatus;
  /** Set by the engine after execution. */
  result?: {
    success: boolean;
    failureReason?: string;
  };
}

import type { GuardrailConfig } from './cognition.js';

/**
 * Drive-decay scaling mode (spec 048, Req 1). At concurrency 3 the PPER
 * scheduler spreads cycles across agents, stretching each agent's effective
 * cycle interval while ambient decay accrues per wall sim-second — the economy
 * becomes structurally net-negative. `per-agent` (default) makes decay a
 * scene-level constant: each agent decays at `decayRate / N` per wall
 * sim-second (N = live agent count), so per-agent decay tracks the agent's own
 * cycle cadence. `none` restores the legacy per-agent wall-time rate.
 */
export type DecayScaling = 'per-agent' | 'none';

/**
 * Default decay scaling — `'per-agent'` unless `ENGINE_DECAY_SCALING` is set
 * to `'none'` (spec 048, Req 1; surfaced from env the same way
 * `ENGINE_MAX_CONCURRENT_LLM` is, spec 022). Any other value falls back to the
 * default so typos cannot silently disable scaling.
 */
export function defaultDecayScaling(): DecayScaling {
  return process.env['ENGINE_DECAY_SCALING'] === 'none' ? 'none' : 'per-agent';
}

/** Engine configuration. */
export interface EngineConfig {
  fps: number;
  spatialDebounceSeconds: number;
  maxConcurrentLLM: number;
  guardrailsEnabled: boolean;
  /** Per-guardrail toggle flags (spec 016, Req 1). */
  guardrails: GuardrailConfig;
  /**
   * Rate at which all drives decay per second (drive-points / second).
   * When omitted, defaults to `0.1`. Configurable so scenes/tests/providers
   * can tune urgency (spec 019, Req 1, AC-1).
   */
  driveDecayRate?: number;
  /**
   * How ambient decay scales with the live agent population (spec 048, Req 1).
   * `'per-agent'` (default) applies `decayRate / N` per wall sim-second to each
   * agent — a no-op at N = 1, so cc=1 behavior is unchanged. `'none'` keeps the
   * legacy raw rate regardless of N. Surfaced from `ENGINE_DECAY_SCALING`.
   */
  decayScaling?: DecayScaling;
}

/** A single game loop tick. */
export interface GameTick {
  tickNumber: number;
  simulationTime: number; // seconds since start
  deltaSeconds: number;
}

/**
 * Configuration for the {@link PPEROrchestratorPort} scheduler (spec 005, Req 9).
 * Limits how many agents can be in a PPER cycle simultaneously. The default is
 * `1` (spec 022, Req 4) to protect single-model Ollama setups from
 * quota-limited concurrent requests; multi-model / self-hosted setups can
 * override via the `ENGINE_MAX_CONCURRENT_LLM` env var or a per-scene config.
 */
export interface PPERSchedulerConfig {
  maxConcurrentCycles: number;
}

/**
 * Default PPER scheduler config — `maxConcurrentCycles` of `1` when
 * `ENGINE_MAX_CONCURRENT_LLM` is unset (spec 022, Req 4, AC-3). When the env
 * var is set, that value is used.
 */
export function defaultPPERSchedulerConfig(): PPERSchedulerConfig {
  const maxConcurrentCycles = Number(process.env['ENGINE_MAX_CONCURRENT_LLM'] ?? 1);
  return { maxConcurrentCycles };
}

/**
 * Derive a scheduler config override from `EngineConfig.maxConcurrentLLM`
 * (spec 050, R6 / AC-6). The field was historically declared-but-unread — the
 * scheduler only consulted the `ENGINE_MAX_CONCURRENT_LLM` env var (spec 022,
 * R4) — so the promoted assembler forwards the field to the scheduler.
 *
 * Returns `undefined` when the env var is set: the env var keeps override
 * semantics and `defaultPPERSchedulerConfig()` consumes it downstream.
 * Otherwise returns `{ maxConcurrentCycles: config.maxConcurrentLLM }`.
 *
 * Callers should skip forwarding entirely when a scene-level config exists
 * (`SceneDefinition.maxConcurrentCycles` via `loadScene`, spec 022 Req 1) —
 * scene-level data keeps precedence over the generic engine knob.
 */
export function overrideSchedulerConfig(config: EngineConfig): PPERSchedulerConfig | undefined {
  if (process.env['ENGINE_MAX_CONCURRENT_LLM'] !== undefined) return undefined;
  return { maxConcurrentCycles: config.maxConcurrentLLM };
}

/** Default guardrail config — all three guardrails enabled (spec 016, Req 2, AC-1). */
export function defaultGuardrailConfig(): GuardrailConfig {
  // Spec 052 (Req 3): waitSuppression defaults true — only an explicit false
  // turns the critical-drive wait guard off.
  return {
    affordanceMasking: true,
    contextualForcing: true,
    planValidation: true,
    waitSuppression: true,
  };
}

/** Default engine config with all existing defaults plus guardrails (spec 016, Req 2, AC-2). */
export function defaultEngineConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: defaultGuardrailConfig(),
    driveDecayRate: 0.1,
    decayScaling: defaultDecayScaling(),
  };
}

/**
 * Port interface (defined in `shared`) that lets the engine's `PPERScheduler`
 * drive the PPER cycle without coupling the `engine` and `cognition` packages
 * (per ADR-0001). The `cognition` package's `PPEROrchestrator` interface is
 * structurally compatible with this port.
 */
export interface PPEROrchestratorPort {
  /**
   * Run a single PPER cycle for the given agent (fire-and-forget from the
   * loop). Resolves with the cycle's causal outcome (spec 041, R1.2): what
   * the phases DID — not what state looks like afterward. The scheduler
   * forwards it to the outcome recorder for labeling; a rejected cycle
   * carries no outcome (the scheduler passes `undefined` + the message).
   */
  runCycle(agentId: string): Promise<PPERCycleOutcome>;
  /** Get the current phase for an agent. */
  getPhase(agentId: string): import('./cognition.js').PPERPhase;
}

/**
 * The causal outcome of one PPER cycle (spec 041, R1.1): what the phases DID,
 * not what diffed state looks like afterward. Ambient drive decay is
 * invisible by construction — any applied affordance delta, however small,
 * counts.
 */
export interface PPERCycleOutcome {
  /**
   * `true` when the cycle applied drive changes: the Execute phase's
   * aggregate `driveChanges` was non-empty (the compound action's
   * once-applied merged map included) OR the Reflect phase applied sanitized
   * `driveOverrides` (`drivesUpdated: true` — the deviation-rejected reflect
   * branch included). `false` when the cycle did not touch drives (wait-only
   * cycles, plan/execute failures, cooldown skips, no-op reflects).
   */
  appliedDriveChanges: boolean;
}
