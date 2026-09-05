/**
 * Scene Mutation Types — Dynamic Scenes / Living Worlds (spec 030)
 * ─────────────────────────────────────────────────────────────────
 * Runtime structural changes to a loaded scene (object add/remove/move,
 * agent spawn/despawn, room connection state). All structural changes funnel
 * through one engine-internal `SceneMutationService` (Req 1); every applied
 * mutation is recorded as an append-only `SceneMutationEvent` (Req 2) whose
 * replay over the base scene reproduces the live scene exactly (Req 8).
 *
 * `SceneMutationPort` is a bridge interface (defined in `shared` per
 * ADR-0001): the engine implements it; the cognition layer consumes it via
 * the `modify_scene` cognitive tool (Req 13). The LLM can only *propose*
 * mutations — validation and application always happen engine-side (Req 14).
 */

import type { AgentInternalState, AgentProfile } from './agent.js';
import type { MemoryNode } from './memory.js';
import type { SmartObject } from './affordance.js';
import type { ConversationObject } from './conversation.js';
import type { SelfModel } from './identity.js';

// ── Mutation operations ──────────────────────────────────────────────────────

/** The supported structural mutation operations (spec 030, Req 1). */
export type SceneMutationType =
  | 'add_object'
  | 'remove_object'
  | 'move_object'
  | 'spawn_agent'
  | 'despawn_agent'
  | 'set_connection_state';

/** Who proposed a mutation (recorded on every applied event). */
export type SceneMutationSource = 'engine' | 'agent' | 'llm' | 'system';

/** Connection actions for `set_connection_state` (spec 030, Req 9). */
export type ConnectionAction = 'open' | 'close' | 'insert' | 'remove';

/** Payload for `add_object`. */
export interface AddObjectPayload {
  object: SmartObject;
}

/** Payload for `remove_object`. */
export interface RemoveObjectPayload {
  objectId: string;
}

/** Payload for `move_object`. */
export interface MoveObjectPayload {
  objectId: string;
  toRoomId: string;
}

/**
 * Payload for `spawn_agent` (spec 030, Req 6/8). Either a fresh profile or a
 * dormant `agentId` (re-spawn from dormancy restores drives, goal, plan,
 * location, and memories from the `DormantAgentStore`).
 */
export interface SpawnAgentPayload {
  profile?: AgentProfile;
  dormantAgentId?: string;
}

/** Payload for `despawn_agent`. */
export interface DespawnAgentPayload {
  agentId: string;
}

/** Payload for `set_connection_state`. */
export interface SetConnectionStatePayload {
  roomA: string;
  roomB: string;
  action: ConnectionAction;
}

/** Union of all mutation payloads. */
export type SceneMutationPayload =
  | AddObjectPayload
  | RemoveObjectPayload
  | MoveObjectPayload
  | SpawnAgentPayload
  | DespawnAgentPayload
  | SetConnectionStatePayload;

/** A mutation proposal — validated, then queued for the next tick boundary. */
export interface SceneMutationProposal {
  type: SceneMutationType;
  payload: SceneMutationPayload;
  /** Defaults to `'engine'` when omitted. */
  source?: SceneMutationSource;
}

// ── Event log (append-only, Req 2) ───────────────────────────────────────────

/** An applied mutation, recorded in the append-only scene mutation log. */
export interface SceneMutationEvent {
  /** 1-based monotonic sequence number within the engine's lifetime. */
  seq: number;
  /** Engine tick number at which the mutation was applied (tick boundary). */
  tick: number;
  type: SceneMutationType;
  payload: SceneMutationPayload;
  source: SceneMutationSource;
}

// ── Validation errors (Req 3) ────────────────────────────────────────────────

/**
 * Thrown by the engine's mutation validation and surfaced to proposers with
 * an actionable, human-readable message naming the offending IDs and the
 * violated rule (spec 030, Req 3 / AC-5).
 */
export class SceneMutationError extends Error {
  /** Machine-readable identifier of the violated validation rule. */
  readonly rule: string;
  /** The IDs involved in the violation (object/room/agent IDs). */
  readonly offendingIds: string[];

  constructor(rule: string, message: string, offendingIds: string[] = []) {
    super(message);
    this.name = 'SceneMutationError';
    this.rule = rule;
    this.offendingIds = offendingIds;
  }
}

// ── Port bridge (engine implements, cognition consumes) ─────────────────────

/** The result of proposing a mutation through the {@link SceneMutationPort}. */
export interface SceneMutationResult {
  /** `true` when the proposal passed validation and was queued. */
  accepted: boolean;
  /** The assigned sequence number, when accepted (assigned at apply time). */
  seq?: number;
  /** The actionable validation error message, when rejected. */
  error?: string;
}

/**
 * Bridge interface (defined in `shared` per ADR-0001) for runtime scene
 * mutation. The engine implements it (`SceneMutationServiceImpl`); the
 * cognition layer calls it from the `modify_scene` cognitive tool. Proposals
 * are validated and queued — they are applied at the next tick boundary.
 */
export interface SceneMutationPort {
  /** Validate and enqueue a mutation proposal. Returns the rejection message on failure. */
  propose(mutation: SceneMutationProposal): SceneMutationResult;
  /** The applied-mutation log from `sinceSeq` (exclusive) onward — all events when omitted. */
  getMutations(sinceSeq?: number): SceneMutationEvent[];
}

// ── Dormancy (Req 7/8) ───────────────────────────────────────────────────────

/**
 * The exported full state of a despawned agent (spec 030, Req 7): profile,
 * internal state (drives, goal, plan, location), and memory nodes. Stored in
 * the engine's `DormantAgentStore` and persisted inside `SaveState.dynamic`
 * so dormancy survives save/load (Req 11).
 */
export interface DormantAgentSnapshot {
  profile: AgentProfile;
  state: AgentInternalState;
  memories: MemoryNode[];
  /**
   * The evolved identity self-model (spec 033, R14) — respawned dormant
   * agents come back changed by their last session. Optional for backward
   * compat with pre-033 dormant snapshots.
   */
  selfModel?: SelfModel;
}

/**
 * The dynamic-world extension to `SaveState` (spec 030, Req 11): the applied
 * mutation log (for event-sourcing continuity and the visualizer) and the
 * dormant agent snapshots. Absent (`undefined`) for scenes that never
 * mutated, keeping static-scene saves byte-identical (AC-11).
 */
export interface DynamicWorldSnapshot {
  mutationLog: SceneMutationEvent[];
  dormantAgents: DormantAgentSnapshot[];
  /**
   * Live conversation objects (spec 033, R10) — open, active, and closed
   * (closed conversations are resumable next session). Optional for backward
   * compat with v2 saves and static scenes.
   */
  conversations?: ConversationObject[];
}

// ── Topology guard (Req 10) ──────────────────────────────────────────────────

/**
 * Bridge interface (defined in `shared` per ADR-0001) for topology-aware plan
 * validation (spec 030, Req 10). The engine implements it (via the scene
 * manager); the cognition guardrails consume it to reject movement through
 * closed connections (§10 mechanism 3 → reflection tick).
 */
export interface TopologyGuard {
  /**
   * `true` when `action` (e.g. `go_to_lab`) is a movement affordance whose
   * destination is not reachable from `fromRoom` through open connections.
   */
  isMovementBlocked(agentId: string, action: string, fromRoom: string): boolean;
}

/**
 * Bridge interface (defined in `shared` per ADR-0001) for affordance
 * co-location plan validation (spec 031, Req 5). The engine implements it
 * (backed by `SmartObjectRegistry.getByRoom`); the cognition guardrails
 * consume it via `PlanValidationContext` to reject plan steps whose target
 * affordance is no longer available in the agent's room (§10 mechanism 3 →
 * reflection tick). Mirrors the `TopologyGuard` pattern (spec 030, Req 10).
 */
export interface AffordanceGuard {
  /**
   * `true` when at least one smart object currently in `roomId` defines
   * `affordanceId` (live registry read — no caching across ticks).
   */
  isAffordanceAvailableInRoom(affordanceId: string, roomId: string): boolean;
}

// ── modify_scene cognitive tool (Req 13) ─────────────────────────────────────

/**
 * Tool feedback for `modify_scene` (spec 030, Req 13). On rejection,
 * `error` carries the actionable validation message so the LLM can
 * self-correct.
 */
export interface ModifySceneToolResult {
  success: boolean;
  /** The queued proposal's sequence number, when accepted. */
  seq?: number;
  /** The actionable rejection reason (validation or rate limit). */
  error?: string;
}
