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

import type { Affordance } from './affordance.js';
import type { AgentInternalState, AgentPlan } from './agent.js';

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
