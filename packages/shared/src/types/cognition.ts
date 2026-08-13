/**
 * Cognition Types — PPER Loop, Cognitive Tools, Structured Outputs
 * ─────────────────────────────────────────────────────────────────
 * Sections 6-8: The PPER loop, intrinsic cognitive tools, and the strict
 * JSON schema for LLM structured outputs.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PPER Loop
// ─────────────────────────────────────────────────────────────────────────────

/** The four phases of the cognitive loop. */
export type PPERPhase = 'perceive' | 'plan' | 'execute' | 'reflect';

import type { Affordance, AffordanceResult } from './affordance.js';
import type { AgentInternalState, AgentPlan, PlanStep } from './agent.js';
import type { MemoryType } from './memory.js';

/** Passive perception data (Section 6.1) — high-level object presence. */
export interface PassivePerception {
  /** Room/scene the agent is currently in. */
  roomId: string;
  /** Object names present (no detailed state — that requires `observe`). */
  objectsPresent: { objectId: string; name: string; type: string }[];
  /** The agent's current drives snapshot. */
  drives: Record<string, number>;
  /** System feedback injected by the engine (e.g., action failure notes). */
  systemFeedback?: string;
  /** Associative memories auto-injected by Track 1 (Section 11.1). */
  associativeMemories?: MemorySnippet[];
}

/** The bundled output of the Perceive phase (Section 6.1). */
export interface PerceptionResult {
  /** Passive perception snapshot of the agent's surroundings. */
  passive: PassivePerception;
  /** Top-K affordances retained by the System 0 classifier. */
  prunedAffordances: Affordance[];
  /** Semantic label of the agent's primary drive (e.g. "low energy, need to restore energy"). */
  primaryDriveLabel: string;
  /** True when no actionable affordances are available in the room (spec 008, Req 5.2). */
  stuck?: boolean;
}

/** Active observation result (Section 6.2) — deep JSON state of a target object. */
export interface ActiveObservation {
  objectId: string;
  /** Full object state (e.g., { water_level: "low", bean_count: 12 }). */
  state: Record<string, unknown>;
  /** Affordances available on this object right now. */
  availableAffordances: string[];
}

/** The outcome of the Plan phase (Section 6.2 / spec 002). */
export interface PlanResult {
  /** Whether plan formulation succeeded. */
  success: boolean;
  /** The stored `AgentPlan` on success. `undefined` on failure. */
  plan?: AgentPlan;
  /** Failure reason. Present only when `success` is `false`. */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured Output — LLM Response Schema (Section 7)
// ─────────────────────────────────────────────────────────────────────────────

/** The strict JSON schema that the LLM must return via Structured Outputs. */
export interface LLMActionResponse {
  /** The agent's reasoning text (internal monologue — not shown to player). */
  reasoning: string;
  /** The chosen action — either an affordance ID or a cognitive tool name. */
  action: string;
  /** Arguments for the action, if any. */
  actionArgs?: Record<string, unknown>;
  /** Whether the agent wants to observe an object before acting. */
  observeTarget?: string;
  /** The agent's updated goal, if it changed. */
  updatedGoal?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cognitive Tools — Internal Affordances (Section 8)
// ─────────────────────────────────────────────────────────────────────────────

export type CognitiveToolName = 'formulate_plan' | 'query_memory' | 'update_internal_state';

/** A cognitive tool the LLM can invoke instead of a physical action. */
export interface CognitiveTool {
  name: CognitiveToolName;
  description: string;
  /** Schema for the arguments this tool accepts. */
  argsSchema: Record<string, unknown>;
}

/** Result of the formulate_plan tool. */
export interface FormulatePlanResult {
  description: string;
  steps: { description: string; targetAffordance?: string }[];
}

/** Result of the query_memory tool (active recall). */
export interface QueryMemoryResult {
  memories: MemorySnippet[];
}

/** Result of the update_internal_state tool. */
export interface UpdateStateResult {
  newGoal?: string;
  driveOverrides?: Partial<Record<string, number>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cognitive Guardrails (Section 10)
// ─────────────────────────────────────────────────────────────────────────────

/** Guardrail configuration for preventing erratic behavior. */
export interface GuardrailConfig {
  /** If current_plan is empty, restrict actions toward cognitive tools. */
  affordanceMasking: boolean;
  /** Inject system prompt directive to use formulate_plan. */
  contextualForcing: boolean;
  /** Reject physical actions deviating from active_plan, forcing reflection. */
  planValidation: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports
// ─────────────────────────────────────────────────────────────────────────────

export interface MemorySnippet {
  id: string;
  content: string;
  importance: number;
  timestamp: number;
}

/**
 * A compact projection of a SmartObject for passive perception — no deep
 * `state`, no `affordances`. Used by the engine's room queries and the
 * cognition layer's perception compilation (Section 6.1).
 */
export interface SmartObjectSummary {
  id: string;
  name: string;
  type: string;
}

/**
 * Bridge interface (defined in `shared`) that lets the cognition layer read
 * agent state and store plans in the engine without coupling the two packages
 * (per ADR-0001). The engine implements this; cognition consumes it.
 *
 * Follows the `PerceptionDataProvider` pattern from spec 001.
 */
export interface PlanDataProvider {
  /** The agent's current internal state, or `null` if the agent does not exist. */
  getAgentState(agentId: string): AgentInternalState | null;
  /** Create and store an `AgentPlan` from formulate_plan tool output. Returns the stored plan. */
  storePlan(agentId: string, result: FormulatePlanResult): AgentPlan;
  /** Set the agent's `isThinking` flag (Section 9.1). */
  setThinking(agentId: string, isThinking: boolean): void;
}

/**
 * Bridge interface (defined in `shared`) that lets the cognition layer read
 * passive world/agent data from the engine without coupling the two packages
 * (per ADR-0001). The engine implements this; cognition consumes it.
 */
export interface PerceptionDataProvider {
  /** The agent's current room/scene ID. */
  getAgentLocation(agentId: string): string;
  /** Smart objects in a room — projected to `{ id, name, type }` (no deep state). */
  getObjectsInRoom(roomId: string): SmartObjectSummary[];
  /** Every affordance available in a room (input to the System 0 classifier). */
  getAffordancesInRoom(roomId: string): Affordance[];
  /** Snapshot of the agent's current drive values. */
  getAgentDrives(agentId: string): Record<string, number>;
  /** Semantic label of the agent's primary (most urgent) drive. */
  getPrimaryDriveLabel(agentId: string): string;
  /** Pending system feedback from a failed action (Section 9.2), if any. */
  getSystemFeedback(agentId: string): string | undefined;
  /** Associative memories from Track 1 (Section 11.1), if a memory subsystem is wired. */
  getAssociativeMemories?(agentId: string): MemorySnippet[] | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute Phase (spec 003)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The outcome of the Execute phase (spec 003, Req 1). On success with a
 * physical affordance, `result` contains the raw `AffordanceResult`. On
 * failure, `error` contains the failure reason and `result` is `undefined`.
 * `planComplete` indicates whether the plan has no remaining steps after
 * this execution. `stepSkipped` is `true` when the current step had no
 * `targetAffordance` and was advanced without physical execution.
 */
export interface ExecuteResult {
  success: boolean;
  result?: AffordanceResult;
  error?: string;
  planComplete: boolean;
  stepSkipped?: boolean;
}

/**
 * The intermediate result of resolving and attempting an affordance (spec 003,
 * Req 2). `resolved` is `false` when no smart object in the agent's room exposes
 * the requested affordance. `preconditionsMet` is `false` when one or more
 * precondition checks failed (with `failedPreconditions` listing the failed
 * precondition names). `result` is present only when the affordance was executed
 * (preconditions passed).
 */
export interface ExecutionOutcome {
  resolved: boolean;
  objectId?: string;
  preconditionsMet: boolean;
  failedPreconditions?: string[];
  result?: AffordanceResult;
}

/**
 * Bridge interface (defined in `shared`) that lets the cognition layer drive
 * the Execute phase via the engine without coupling the two packages (per
 * ADR-0001). The engine implements this; cognition consumes it.
 *
 * Follows the `PlanDataProvider` and `PerceptionDataProvider` bridge pattern
 * from specs 001 and 002.
 */
export interface ExecuteDataProvider {
  /** The agent's current internal state, or `null` if the agent does not exist. */
  getAgentState(agentId: string): AgentInternalState | null;
  /** The current `PlanStep` in the agent's plan, or `null` if no plan or no step. */
  getCurrentStep(agentId: string): PlanStep | null;
  /** Whether the agent's plan has no remaining steps. */
  isPlanComplete(agentId: string): boolean;
  /** Resolve an affordance ID to a specific smart object in a room. Returns `null` if no object exposes it. */
  resolveAffordance(
    roomId: string,
    affordanceId: string,
  ): { objectId: string; affordance: Affordance } | null;
  /** Check all preconditions for an affordance on a specific object. */
  checkPreconditions(
    affordanceId: string,
    objectId: string,
  ): { satisfied: boolean; failed: string[] };
  /** Execute an affordance's engine effect on the world. */
  executeAffordance(
    objectId: string,
    affordanceId: string,
    agentId: string,
  ): Promise<AffordanceResult>;
  /** Advance to the next step in the plan. */
  advanceStep(agentId: string): void;
  /** Apply drive changes from an affordance result (clamped to 0–100). */
  applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void;
  /** Store system feedback for the next Perceive tick (Section 9.2). */
  setSystemFeedback(agentId: string, feedback: string): void;
  /** Set the agent's `isThinking` flag (Section 9.1). */
  setThinking(agentId: string, isThinking: boolean): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reflect Phase (spec 004)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The LLM-generated memory entry to store (spec 004, Req 3). Excludes `id`,
 * `agentId`, `embedding`, and `timestamp` — those are generated by the system
 * when the full `MemoryNode` is created.
 */
export interface MemoryEntryInput {
  /** Natural-language description of what happened and/or what was learned. */
  content: string;
  /** Static importance score 1–10 (per §11.2). */
  importance: number;
  /** The type of memory. */
  type: MemoryType;
  /** Optional room/scene ID where the event occurred. */
  location?: string;
}

/**
 * The structured output the LLM returns during the Reflect phase (spec 004,
 * Req 2). Extends `UpdateStateResult` (§8.3) with an optional `memoryEntry`.
 * All three fields are optional — the LLM may choose to update only the goal,
 * only drives, only store a memory, or any combination.
 */
export interface ReflectLLMResponse {
  /** The agent's updated goal, if it changed. */
  newGoal?: string;
  /** Drive overrides to apply (clamped to 0–100 by `DriveSystem`). */
  driveOverrides?: Partial<Record<string, number>>;
  /** A memory entry to store, if the LLM decides to record one. */
  memoryEntry?: MemoryEntryInput;
}

/**
 * The outcome of the Reflect phase (spec 004, Req 1). On success,
 * `cycleComplete` is `true` (the PPER cycle is done and ready for the next
 * Perceive). On failure, `cycleComplete` is `false` (the PPER orchestrator
 * should retry on the next tick), `error` contains the failure reason, and
 * `memoryStored`, `goalUpdated`, and `drivesUpdated` are all `false`.
 */
export interface ReflectResult {
  /** Whether the Reflect phase succeeded. */
  success: boolean;
  /** Failure reason. Present only when `success` is `false`. */
  error?: string;
  /** Whether the PPER cycle is complete and ready for the next Perceive. */
  cycleComplete: boolean;
  /** `true` only if a memory entry was provided and successfully stored. */
  memoryStored: boolean;
  /** `true` only if `newGoal` was provided and applied. */
  goalUpdated: boolean;
  /** `true` only if `driveOverrides` were provided and applied. */
  drivesUpdated: boolean;
}

/**
 * Bridge interface (defined in `shared`) that lets the cognition layer read
 * agent state, apply drive/goal changes, store memories, and clear plans
 * during the Reflect phase — without coupling the two packages (per ADR-0001).
 * The engine implements this; cognition consumes it.
 *
 * Follows the `ExecuteDataProvider` and `PlanDataProvider` bridge pattern
 * from specs 002 and 003.
 */
export interface ReflectDataProvider {
  /** The agent's current internal state, or `null` if the agent does not exist. */
  getAgentState(agentId: string): AgentInternalState | null;
  /** Apply drive changes (clamped to 0–100 by `DriveSystem`). */
  applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void;
  /** Update the agent's current goal. */
  updateGoal(agentId: string, goal: string): void;
  /** Store a memory entry — generates embedding, creates MemoryNode, persists. */
  storeMemory(agentId: string, entry: MemoryEntryInput): Promise<void>;
  /**
   * Check if the plan is complete (all steps executed). If so, clear it (set
   * `currentPlan` to `null`) and return `true`. If not, return `false` without
   * modifying the plan.
   */
  clearPlanIfComplete(agentId: string): boolean;
  /** Set the agent's `isThinking` flag (Section 9.1). */
  setThinking(agentId: string, isThinking: boolean): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// PPER Error Recovery (spec 008)
// ─────────────────────────────────────────────────────────────────────────────

/** Status of a PPER cycle for an agent (spec 008, Req 2.4, AC-9). */
export interface PPERCycleStatus {
  /** Number of consecutive cycle failures (resets to 0 on a successful cycle). */
  consecutiveFailures: number;
  /** `true` when the orchestrator is in cooldown (failures reached threshold). */
  coolingDown: boolean;
  /** The last error message, if any. */
  lastError?: string;
}

/** Configuration for PPER cycle error recovery (spec 008, Req 8.1, AC-23). */
export interface PPERErrorConfig {
  /** Max consecutive failures before the orchestrator enters cooldown (default 3). */
  maxConsecutiveFailures: number;
  /** Cooldown period in milliseconds before retrying (default 5000). */
  failureCooldownMs: number;
}

/** Default PPER error config — overridable via env vars (spec 008, Req 8.2, AC-24). */
export function defaultPPERErrorConfig(): PPERErrorConfig {
  const maxConsecutiveFailures = Number(process.env['PPER_MAX_CONSECUTIVE_FAILURES'] ?? 3);
  const failureCooldownMs = Number(process.env['PPER_FAILURE_COOLDOWN_MS'] ?? 5000);
  return { maxConsecutiveFailures, failureCooldownMs };
}
