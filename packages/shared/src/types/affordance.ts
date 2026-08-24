/**
 * Smart Objects & Affordances
 * ───────────────────────────
 * Section 4: Every interactable entity exposes a discrete list of
 * Affordances. The LLM only sees the semantic representation. The engine
 * cross-references the selection with the engineEffect to run deterministic
 * physics code.
 */

/**
 * A structured condition evaluated against a smart object's `state` at
 * perception time (spec 018, Req 1). Unlike `preconditions: string[]` which
 * require a registered `PreconditionChecker`, `AffordanceCondition` is
 * declarative and self-describing — the engine evaluates it without
 * registration.
 */
export interface AffordanceCondition {
  /** A key in `SmartObject.state`. */
  field: string;
  /** The comparison operator to apply. */
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=';
  /** The comparison target value. */
  value: number | string | boolean;
}

/**
 * A multi-step sequence of affordances on a single smart object (spec 018,
 * Req 3). Provides the LLM with a high-level view of compound interactions.
 */
export interface CompoundAction {
  /** Semantic name (e.g., "brew_coffee"). */
  id: string;
  /** Human-readable description. */
  label: string;
  /** Ordered list mapping to affordance IDs on this object. */
  steps: { affordanceId: string; description: string }[];
}

/**
 * Declares that one object's affordance depends on another object's
 * affordance being executed first (spec 018, Req 4).
 */
export interface ObjectDependency {
  /** The affordance on this object that has the dependency. */
  affordanceId: string;
  /** The ID of the object that must be interacted with first. */
  requiresObjectId: string;
  /** The affordance on the required object that must be executed first. */
  requiresAffordance: string;
  /** Human-readable explanation for the LLM context. */
  description: string;
}

/**
 * A declarative state evolution rule applied each tick by `ObjectStateSystem`
 * (spec 018, Req 5). For `operation: 'decay'`, subtracts `rate * deltaSeconds`
 * from `state[field]` (clamped to ≥ 0). For `operation: 'approach'`, moves
 * `state[field]` toward `target` by `rate * deltaSeconds` (clamped to not
 * overshoot). `interval` throttles application.
 */
export interface ObjectStateRule {
  /** A key in `SmartObject.state` whose value must be a number. */
  field: string;
  /** The evolution operation. */
  operation: 'decay' | 'approach';
  /** Rate of change per second. */
  rate: number;
  /** Target value for `approach` operation. */
  target?: number;
  /** Minimum time in seconds between applications (throttling). */
  interval: number;
}

/**
 * A cross-object state change applied after a successful affordance execution
 * (spec 018, Req 8). The engine merges `statePatch` into the target object's
 * state via `SmartObjectRegistry.applyStatePatch` (shallow merge).
 */
export interface CrossObjectStateChange {
  /** The ID of another `SmartObject` whose state should be modified. */
  objectId: string;
  /** Partial state object — merged (shallow) into the target object's state. */
  statePatch: Record<string, unknown>;
}

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
  /** Semantic group name linking related affordances into a multi-step sequence (spec 018, Req 2). */
  stepGroup?: string;
  /** 1-based ordinal indicating the step's position within its `stepGroup` (spec 018, Req 2). */
  stepOrder?: number;
  /** Structured conditions evaluated at perception time to determine availability (spec 018, Req 7). */
  conditions?: AffordanceCondition[];
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
  /** Declarative state evolution rules applied each tick by `ObjectStateSystem` (spec 018, Req 6). */
  stateRules?: ObjectStateRule[];
  /** Multi-step action sequences for LLM context (spec 018, Req 6). */
  compoundActions?: CompoundAction[];
  /** Cross-object affordance dependencies (spec 018, Req 6). */
  dependencies?: ObjectDependency[];
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
  /** Cross-object state changes applied on success via `SmartObjectRegistry.applyStatePatch` (spec 018, Req 9). */
  crossObjectStateChanges?: CrossObjectStateChange[];
}
