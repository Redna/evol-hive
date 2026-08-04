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
