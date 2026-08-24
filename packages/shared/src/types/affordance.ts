/**
 * Smart Objects & Affordances
 * ───────────────────────────
 * Section 4: Every interactable entity exposes a discrete list of
 * Affordances. The LLM only sees the semantic representation. The engine
 * cross-references the selection with the engineEffect to run deterministic
 * physics code.
 */

/** A discrete action that a smart object supports. */
export interface Affordance {
  /** Semantic name passed to the LLM (e.g., "brew_coffee"). */
  id: string;
  /** Human/LLM-readable description. */
  label: string;
  /** The deterministic engine function to invoke when this affordance is selected. */
  engineEffect: string;
  /** Precondition checks the engine runs before executing (e.g., "has_water"). */
  preconditions: string[];
  /** Drive impacts applied on success (e.g., { energy: +20 }). */
  effects: Partial<Record<string, number>>;
  /**
   * Reserved for future use when social affordances target other agents
   * (spec 018, Req 8). Not populated by the current implementation — social
   * actions are cognitive tools, not physical affordances.
   */
  targetAgentId?: string;
}

/** A smart object in the game world that exposes affordances. */
export interface SmartObject {
  id: string;
  /** Display name (e.g., "Coffee Machine"). */
  name: string;
  /** Object type for affordance grouping. */
  type: string;
  /** Current JSON state of the object (e.g., { water_level: "low", bean_count: 12 }). */
  state: Record<string, unknown>;
  /** All affordances this object currently supports. */
  affordances: Affordance[];
  /** Room/scene ID where this object is located. */
  roomId: string;
}

/** The result of executing an affordance via the engine. */
export interface AffordanceResult {
  success: boolean;
  /** If failed, a feedback message injected into the next perception tick. */
  failureReason?: string;
  /** Updated object state after execution. */
  newState?: Record<string, unknown>;
  /** Drive changes applied to the agent. */
  driveChanges?: Partial<Record<string, number>>;
}
