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

/** Active observation result (Section 6.2) — deep JSON state of a target object. */
export interface ActiveObservation {
  objectId: string;
  /** Full object state (e.g., { water_level: "low", bean_count: 12 }). */
  state: Record<string, unknown>;
  /** Affordances available on this object right now. */
  availableAffordances: string[];
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
