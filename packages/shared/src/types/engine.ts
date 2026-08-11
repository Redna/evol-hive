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

/** Engine configuration. */
export interface EngineConfig {
  fps: number;
  spatialDebounceSeconds: number;
  maxConcurrentLLM: number;
  guardrailsEnabled: boolean;
}

/** A single game loop tick. */
export interface GameTick {
  tickNumber: number;
  simulationTime: number; // seconds since start
  deltaSeconds: number;
}

/**
 * Configuration for the {@link PPEROrchestratorPort} scheduler (spec 005, Req 9).
 * Limits how many agents can be in a PPER cycle simultaneously (default 8,
 * matching `ENGINE_MAX_CONCURRENT_LLM`).
 */
export interface PPERSchedulerConfig {
  maxConcurrentCycles: number;
}

/** Default PPER scheduler config — `maxConcurrentCycles` of 8 (§9). */
export function defaultPPERSchedulerConfig(): PPERSchedulerConfig {
  const maxConcurrentCycles = Number(process.env['ENGINE_MAX_CONCURRENT_LLM'] ?? 8);
  return { maxConcurrentCycles };
}

/**
 * Port interface (defined in `shared`) that lets the engine's `PPERScheduler`
 * drive the PPER cycle without coupling the `engine` and `cognition` packages
 * (per ADR-0001). The `cognition` package's `PPEROrchestrator` interface is
 * structurally compatible with this port.
 */
export interface PPEROrchestratorPort {
  /** Run a single PPER cycle for the given agent (fire-and-forget from the loop). */
  runCycle(agentId: string): Promise<void>;
  /** Get the current phase for an agent. */
  getPhase(agentId: string): import('./cognition.js').PPERPhase;
}
