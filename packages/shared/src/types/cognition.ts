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

import type {
  Affordance,
  AffordanceResult,
  CompoundAction,
  ObjectDependency,
} from './affordance.js';
import type { ConversationSentiment } from './conversation.js';
import type { SelfModel, IdentityChangeDelta, IdentityChangeAudit } from './identity.js';
import type { ModifySceneToolResult, AffordanceGuard } from './mutations.js';
import type {
  AgentInternalState,
  AgentPlan,
  PlanStep,
  AgentProfile,
  Relationship,
} from './agent.js';
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
  /**
   * Other agents present in the same room (spec 018, Req 5). Excludes the
   * perceiving agent. `undefined` when no other agents are present.
   */
  agentsPresent?: AgentSummary[];
  /**
   * Pending social messages for this agent (spec 018, Req 6). Dequeued
   * (consumed) when read. `undefined` when no messages are pending.
   */
  socialContext?: SocialMessage[];
}

/** The bundled output of the Perceive phase (Section 6.1). */
export interface PerceptionResult {
  /** Passive perception snapshot of the agent's surroundings. */
  passive: PassivePerception;
  /**
   * Top-K affordances retained by the System 0 classifier. **Unmasked** —
   * this is the classifier output before guardrail masking. Used by the Plan
   * builder to construct affordance tool definitions (spec 020, Req 2).
   */
  prunedAffordances: Affordance[];
  /**
   * Masked affordances — the output of `GuardrailEngineImpl.maskAffordances`
   * (spec 016, Req 8; spec 020, Req 1). Used by the Perception/Action-choice
   * builder to construct the `availableAffordances` and `tools` in the
   * `LLMContextPayload`. When no guardrail engine is configured, this field is
   * `undefined` and consumers fall back to `prunedAffordances`. When a guardrail
   * is present but masking is disabled (`affordanceMasking === false`), this
   * field equals `prunedAffordances` (masking returns unchanged — spec 016,
   * Req 6). When masking is active and the agent has no plan, this field is `[]`.
   */
  maskedAffordances?: Affordance[];
  /** Semantic label of the agent's primary drive (e.g. "low energy, need to restore energy"). */
  primaryDriveLabel: string;
  /** True when no actionable affordances are available in the room (spec 008, Req 5.2). */
  stuck?: boolean;
  /** The agent's profile (including persona fields), populated by PerceptionServiceImpl (spec 012, Req 6). */
  persona?: AgentProfile | null;
  /** All compound actions defined on objects in the agent's current room (spec 018, Req 10). */
  compoundActions?: CompoundAction[];
  /** All dependencies declared by objects in the agent's current room (spec 018, Req 10). */
  objectDependencies?: ObjectDependency[];
  /**
   * Structured relationship map for the agent (spec 018, Req 36). Populated
   * by `PerceptionServiceImpl` via `provider.getRelationships`. `undefined`
   * when the provider does not implement `getRelationships` or the agent has
   * no relationships.
   */
  relationships?: Record<string, Relationship>;
  /**
   * The evolved identity self-model (spec 033, R11/AC-13). Populated by the
   * perception service via `provider.getSelfModel` when the provider implements
   * it and a self-model exists. `undefined` → prompt falls back to the spawn
   * persona (backward compat).
   */
  selfModel?: SelfModel;
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
// Tool Calling — ToolDefinition (spec 011)
// ─────────────────────────────────────────────────────────────────────────────

/** The OpenAI tool calling format (spec 011, Req 1). */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    /** JSON schema for the tool's arguments. */
    parameters: object;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cognitive Tools — Internal Affordances (Section 8)
// ─────────────────────────────────────────────────────────────────────────────

export type CognitiveToolName =
  | 'formulate_plan'
  | 'query_memory'
  | 'update_internal_state'
  | 'update_self_model'
  | 'talk_to'
  | 'observe_agent'
  | 'help'
  | 'ignore'
  | 'modify_scene';

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
// Multi-Agent Social Types (spec 018)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A compact summary of another agent for passive perception (spec 018, Req 1).
 * `currentActivity` is derived from the agent's state: `"thinking"` when
 * `isThinking` is true, `"working on: <plan.description>"` when the agent
 * has an active plan, `"idle"` otherwise.
 */
export interface AgentSummary {
  agentId: string;
  name: string;
  currentActivity: string;
  isThinking: boolean;
}

/**
 * A queued social message from one agent to another (spec 018, Req 2).
 * `fromName` is included so the perceiving agent knows the sender without
 * an additional lookup.
 */
export interface SocialMessage {
  fromAgentId: string;
  fromName: string;
  content: string;
  timestamp: number;
}

/**
 * The result of executing a social cognitive tool (spec 018, Req 4).
 * Sent back to the LLM as the tool result content.
 */
export interface SocialToolResult {
  success: boolean;
  message: string;
  relationshipUpdated: boolean;
  /**
   * `true` when the exchange was recorded on a conversation object via the
   * open-or-contribute mapping (spec 033, R1/R3). Absent when no conversation
   * bridge is wired (legacy behavior).
   */
  conversationUpdated?: boolean;
  /** Present only for observe_agent: the observed agent's details. */
  observedAgent?: {
    name: string;
    currentActivity: string;
    isThinking: boolean;
    drives: Record<string, number>;
  };
}

/**
 * Bridge interface (defined in `shared`) for social action execution
 * (spec 018, Req 10). The engine implements this (via `SocialManager`);
 * cognition consumes it (via `CognitiveToolExecutorImpl`).
 */
export interface SocialActionBridge {
  /** Queue a social message for the target agent. */
  queueMessage(fromAgentId: string, toAgentId: string, content: string): void;
  /** Update the structured relationship between two agents. */
  updateRelationship(agentId: string, otherAgentId: string, updates: Partial<Relationship>): void;
  /** Get a summary of an agent, or `null` if the agent does not exist. */
  getAgentSummary(agentId: string): AgentSummary | null;
  /** Get an agent's drives as a flat record. Returns `{}` if not found. */
  getAgentDrives(agentId: string): Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────
// Identity Self-Model Bridge (spec 033, R12/R13)
// ─────────────────────────────────────────────────────────────────────────

/** Result of applying guarded identity deltas through the {@link SelfModelBridge}. */
export interface SelfModelApplyResult {
  success: boolean;
  /** How many deltas were applied. */
  applied: number;
  /** How many proposals were dropped by the bound / validation. */
  rejected: number;
  /** Actionable feedback for the LLM. */
  message: string;
  /** The `identity_change` audit event when deltas were applied (R13). */
  audit?: IdentityChangeAudit;
}

/**
 * Bridge interface (defined in `shared` per ADR-0001) for the guarded identity
 * self-model. The engine implements it (`SelfModelManager` — bounded,
 * rate-limited, audited); cognition consumes it from the `update_self_model`
 * tool and the session-end identity consolidation pass. The LLM can only
 * *propose* deltas — application is deterministic engine code (R13).
 */
export interface SelfModelBridge {
  /** The agent's current self-model, or `null` when none exists (persona fallback). */
  getSelfModel(agentId: string): SelfModel | null;
  /** Validate, bound, apply, and audit identity deltas (all guards engine-side). */
  applySelfModelDeltas(agentId: string, deltas: IdentityChangeDelta[]): SelfModelApplyResult;
  /** The agent's `identity_change` audit trail (R13). */
  getIdentityAuditLog(agentId: string): IdentityChangeAudit[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Cognitive Tool Execution (spec 015 — §8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The result of executing `query_memory` mid-loop (spec 015, Req 3).
 *
 * `memories` contains the top-K `MemorySnippet` objects from
 * `MemoryInjector.activeRecall`. An empty array means no memories were found
 * or no memory subsystem is wired (never an error).
 */
export interface QueryMemoryToolResult {
  memories: MemorySnippet[];
}

/**
 * The confirmation result of executing `update_internal_state` mid-loop
 * (spec 015, Req 4). Sent back to the LLM as the tool result content.
 */
export interface UpdateStateToolResult {
  /** `true` when the update was applied (even partially). */
  success: boolean;
  /** `true` only if `newGoal` was provided and applied. */
  goalUpdated: boolean;
  /** `true` only if `driveOverrides` was provided and applied. */
  drivesUpdated: boolean;
  /** Human-readable confirmation sent back to the LLM. */
  message: string;
}

/**
 * The confirmation result of executing `update_self_model` mid-loop
 * (spec 033, R12). Sent back to the LLM as the tool result content.
 */
export interface UpdateSelfModelToolResult {
  /** `true` when at least one delta was applied (or the proposal was valid but rate-limited → `false`). */
  success: boolean;
  /** Number of deltas applied (≤ IDENTITY_MAX_DELTAS_PER_UPDATE). */
  applied: number;
  /** Number of proposals dropped by the bound / validation. */
  rejected: number;
  /** The self-model revision after the update, when applied. */
  revision?: number;
  /** Human-readable confirmation / rejection sent back to the LLM. */
  message: string;
}

/**
 * Bridge interface (defined in `shared`) for the state update operations needed
 * by `update_internal_state` mid-loop (spec 015, Req 2). A focused subset of
 * `ReflectDataProvider` so `CognitiveToolExecutorImpl` does not need to depend
 * on the full `ReflectDataProvider` (which carries memory storage and plan
 * clearing methods unrelated to cognitive tool execution).
 */
export interface CognitiveToolDataProvider {
  /** Update the agent's current goal. */
  updateGoal(agentId: string, goal: string): void;
  /** Apply drive changes (clamped to 0–100 by the DriveSystem). */
  applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void;
}

/**
 * Bridge interface (defined in `shared`) that the cognition layer calls to
 * execute cognitive tools mid-loop (spec 015, Req 1). The application entry
 * point provides a concrete implementation (e.g., `CognitiveToolExecutorImpl`
 * in `cognition`) that wires `MemoryInjector.activeRecall` and the state data
 * provider.
 */
export interface CognitiveToolExecutor {
  /** Execute query_memory: embed the query, search the memory store, return top-K snippets. */
  executeQueryMemory(agentId: string, query: string, topK: number): Promise<QueryMemoryToolResult>;
  /** Execute update_internal_state: update goal and/or drives, return confirmation. */
  executeUpdateInternalState(
    agentId: string,
    newGoal?: string,
    driveOverrides?: Partial<Record<string, number>>,
  ): Promise<UpdateStateToolResult>;
  /**
   * Execute talk_to: queue a message and update relationships (spec 018, Req 11).
   * Spec 033 (R1/R3): the optional `sentiment` argument (LLM-tagged at write
   * time) routes the exchange through the conversation bridge — open-or-
   * contribute — and gates the relationship deltas on the aggregate sentiment.
   */
  executeTalkTo(
    agentId: string,
    targetAgentId: string,
    message: string,
    sentiment?: ConversationSentiment,
  ): Promise<SocialToolResult>;
  /** Execute observe_agent: return the target agent's state (spec 018, Req 11). */
  executeObserveAgent(agentId: string, targetAgentId: string): Promise<SocialToolResult>;
  /** Execute help: boost the target's primary drive and the helper's social drive (spec 018, Req 11). */
  executeHelp(agentId: string, targetAgentId: string): Promise<SocialToolResult>;
  /** Execute ignore: degrade the relationship and social drive (spec 018, Req 11). */
  executeIgnore(agentId: string, targetAgentId: string): Promise<SocialToolResult>;
  /**
   * Execute modify_scene: enqueue a scene mutation proposal (spec 030, Req 13).
   * Optional so existing implementations compile unchanged; when absent, the
   * tool loop reports the tool as unavailable.
   */
  executeModifyScene?(
    agentId: string,
    args: Record<string, unknown>,
  ): Promise<ModifySceneToolResult>;
  /**
   * Execute update_self_model: propose bounded edits to the identity self-model
   * (spec 033, R12). Optional so existing implementations compile unchanged.
   * The LLM only proposes — validation, bounding, rate-limiting, and auditing
   * happen engine-side via the {@link SelfModelBridge} (R13).
   */
  executeUpdateSelfModel?(
    agentId: string,
    args: Record<string, unknown>,
  ): Promise<UpdateSelfModelToolResult>;
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
  /**
   * Max `modify_scene` proposals per agent per PPER cycle (spec 030, Req 14d).
   * Optional — consumers default to 1 when absent.
   */
  maxSceneMutationsPerCycle?: number;
}

/** The result of plan validation (spec 016, Req 3). */
export interface PlanValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Optional context for plan validation (spec 030, Req 10). Carries the agent
 * identity and current room so topology-aware guardrails can reject movement
 * through closed connections (§10 mechanism 3). Existing two-argument calls
 * remain valid — the context is optional.
 *
 * Spec 031 (Req 5) adds the optional `affordanceGuard`: implemented by the
 * engine (backed by `SmartObjectRegistry.getByRoom`) and wired in assembly;
 * the guardrails consume it to reject plan steps whose target affordance is
 * no longer available in the agent's room (stale-plan detection, §10
 * mechanism 3 → reflection tick).
 */
export interface PlanValidationContext {
  agentId: string;
  /** The agent's current room, when known. */
  fromRoom?: string;
  /** Optional affordance guard for stale-step detection (spec 031, Req 5). */
  affordanceGuard?: AffordanceGuard;
}

/** Forcing directive injected when the agent has no plan (spec 016, Req 4). */
export const GUARDRAIL_FORCING_DIRECTIVE =
  'You have no active plan. You must use formulate_plan to create a plan before taking any physical action.';

/** Deviation feedback template — `{action}` is replaced with the rejected action (spec 016, Req 4). */
export const GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE =
  "Action '{action}' deviates from your plan. Use reflect to reconsider.";

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
  /** Only affordances whose conditions are currently met (spec 018, Req 12). */
  getAvailableAffordancesInRoom?(roomId: string): Affordance[];
  /** All compound actions defined on objects in a room (spec 018, Req 12). */
  getCompoundActionsInRoom?(roomId: string): CompoundAction[];
  /** All dependencies declared by objects in a room (spec 018, Req 12). */
  getObjectDependenciesInRoom?(roomId: string): ObjectDependency[];
  /** Snapshot of the agent's current drive values. */
  getAgentDrives(agentId: string): Record<string, number>;
  /** Semantic label of the agent's primary (most urgent) drive. */
  getPrimaryDriveLabel(agentId: string): string;
  /** Pending system feedback from a failed action (Section 9.2), if any. */
  getSystemFeedback(agentId: string): string | undefined;
  /** Associative memories from Track 1 (Section 11.1), if a memory subsystem is wired. */
  getAssociativeMemories?(agentId: string): MemorySnippet[] | undefined;
  /** The agent's full profile (including persona fields), or `null` if the agent does not exist (spec 012, Req 4). */
  getAgentProfile(agentId: string): AgentProfile | null;
  /** The agent's current internal state, or `null` if the agent does not exist (spec 016, Req 8). */
  getAgentState?(agentId: string): AgentInternalState | null;
  /** Other agents in the same room, excluding the given agent (spec 018, Req 9). */
  getAgentsInRoom?(roomId: string, excludingAgentId: string): AgentSummary[];
  /** Dequeue pending social messages for the agent (spec 018, Req 9). */
  dequeueSocialMessages?(agentId: string): SocialMessage[];
  /** The agent's structured relationship map (spec 018, Req 9). */
  getRelationships?(agentId: string): Record<string, Relationship>;
  /**
   * The agent's evolved identity self-model, or `null` when none exists
   * (spec 033, R11/AC-13). Optional so existing implementations compile
   * unchanged — when absent, prompts fall back to the spawn persona.
   */
  getSelfModel?(agentId: string): SelfModel | null;
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
  /** `true` when the action was rejected by plan validation (spec 016, Req 13). */
  deviationRejected?: boolean;
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
  /**
   * Resolve a compound action ID to the smart object in the given room that
   * defines it (spec 028, Req 1). Returns `null` when no object in the room
   * defines a compound action with that ID. Optional so existing custom
   * `ExecuteDataProvider` implementations compile and behave unchanged — when
   * absent, compound step targets are skipped with feedback like any other
   * unresolvable affordance (spec 028, Req 3).
   */
  resolveCompoundAction?(
    roomId: string,
    compoundActionId: string,
  ): { objectId: string; compoundAction: CompoundAction } | null;
  /**
   * Resolve an affordance ID to its owning smart object in ANY room (spec 031,
   * Req 4 support). Room-scoped `resolveAffordance` fails when the target has
   * moved; this global lookup distinguishes "the object left the room"
   * (co-location failure — never silently skipped) from "the affordance does
   * not exist anywhere" (unresolvable — skip path preserved). Optional so
   * existing custom `ExecuteDataProvider` implementations compile and behave
   * unchanged (mirrors the `resolveCompoundAction` pattern, spec 028 Req 3).
   */
  resolveAffordanceAnywhere?(affordanceId: string): {
    objectId: string;
    objectName: string;
    roomId: string;
  } | null;
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
 * Req 2; spec 025, Req 2). Extends `UpdateStateResult` (§8.3) with optional
 * flattened memory fields. All fields are optional — the LLM may choose to
 * update only the goal, only drives, only store a memory, or any combination.
 *
 * Spec 025 replaces the nested `memoryEntry` with four top-level fields:
 * `memoryContent`, `memoryImportance`, `memoryType`, `memoryLocation`.
 * The legacy `memoryEntry` field is retained for backward compatibility —
 * when both are present, the flattened fields take precedence.
 */
export interface ReflectLLMResponse {
  /** The agent's updated goal, if it changed. */
  newGoal?: string;
  /** Drive overrides to apply (clamped to 0–100 by `DriveSystem`). */
  driveOverrides?: Partial<Record<string, number>>;
  /** Memory content to store (spec 025, Req 2.1). */
  memoryContent?: string;
  /** Importance score 1–10 for the memory (spec 025, Req 2.1). */
  memoryImportance?: number;
  /** The type of memory (spec 025, Req 2.1). */
  memoryType?: MemoryType;
  /** Optional room/scene ID where the event occurred (spec 025, Req 2.1). */
  memoryLocation?: string;
  /**
   * Legacy nested memory entry (spec 025, Req 2.2). Accepted for backward
   * compatibility — when both flattened fields and `memoryEntry` are present,
   * the flattened fields take precedence.
   * @deprecated Use `memoryContent` / `memoryImportance` / `memoryType` / `memoryLocation` instead.
   */
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
  /** The agent's full profile (including persona fields), or `null` if the agent does not exist (spec 012, Req 5). */
  getAgentProfile(agentId: string): AgentProfile | null;
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
