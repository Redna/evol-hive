/**
 * @evol-hive/world — Smart Objects, Affordances & Scenes
 * ──────────────────────────────────────────────────────
 * Section 4: Smart objects expose discrete affordances. The LLM only sees
 * the semantic representation; the engine cross-references with engineEffect.
 */

// ── Smart Object Registry ────────────────────────────────────────────────────

/** Manages all smart objects in the world. */
export interface SmartObjectRegistry {
  /** Register a new smart object. */
  register(object: import('@evol-hive/shared').SmartObject): void;
  /** Get an object by ID. */
  get(objectId: string): import('@evol-hive/shared').SmartObject | null;
  /** Get all objects in a room (full SmartObject[] — engine-internal, includes deep state). */
  getByRoom(roomId: string): import('@evol-hive/shared').SmartObject[];
  /** Get objects in a room projected to { id, name, type } (no deep state, no affordances). */
  getObjectsInRoom(roomId: string): import('@evol-hive/shared').SmartObjectSummary[];
  /** Get all affordances available in a room (for classifier pruning). */
  getAffordancesInRoom(roomId: string): import('@evol-hive/shared').Affordance[];
  /** Affordances whose `conditions` (if present) are currently satisfied (spec 018, Req 14). */
  getAvailableAffordancesInRoom(roomId: string): import('@evol-hive/shared').Affordance[];
  /** All compound actions defined on objects in a room (spec 018, Req 15). */
  getCompoundActionsInRoom(roomId: string): import('@evol-hive/shared').CompoundAction[];
  /** All dependencies declared by objects in a room (spec 018, Req 16). */
  getObjectDependenciesInRoom(roomId: string): import('@evol-hive/shared').ObjectDependency[];
  /** Returns all registered smart objects (spec 018, Req 21). */
  getAll(): import('@evol-hive/shared').SmartObject[];
  /** Update an object's state (after affordance execution). */
  updateState(objectId: string, newState: Record<string, unknown>): void;
  /** Shallow-merge a state patch into an object's state (spec 018, Req 17). No-op if object doesn't exist. */
  applyStatePatch(objectId: string, patch: Record<string, unknown>): void;
}

// ── Affordance Registry ───────────────────────────────────────────────────────

/** Maps affordance IDs to their deterministic engine effect handlers. */
export interface AffordanceRegistry {
  /** Register an engine effect handler for an affordance. */
  registerHandler(affordanceId: string, handler: AffordanceHandler): void;
  /** Get the handler for an affordance. */
  getHandler(affordanceId: string): AffordanceHandler | null;
  /** Check all preconditions for an affordance on a specific object. */
  checkPreconditions(
    affordanceId: string,
    objectId: string,
  ): { satisfied: boolean; failed: string[] };
}

/** A deterministic handler that runs physics code for an affordance. */
export type AffordanceHandler = (
  objectId: string,
  agentId: string,
  objectState: Record<string, unknown>,
) => Promise<import('@evol-hive/shared').AffordanceResult>;

// ── Scenes / Rooms ────────────────────────────────────────────────────────────

/** Manages the spatial world layout. */
export interface SceneManager {
  /** Get a room by ID. */
  getRoom(roomId: string): import('@evol-hive/shared').Room | null;
  /** Get all rooms connected to a room. */
  getConnectedRooms(roomId: string): import('@evol-hive/shared').Room[];
  /** Move an agent to a new room (triggers spatial debouncing check). */
  moveAgent(agentId: string, toRoomId: string): void;
  /** Get the room an agent is currently in. */
  getAgentRoom(agentId: string): import('@evol-hive/shared').Room | null;
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export * from './objects/index.js';
export * from './affordances/index.js';
export * from './affordances/cache.js';
export * from './scenes/index.js';
