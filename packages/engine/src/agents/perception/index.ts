/**
 * perception/ — PerceptionDataProviderImpl bridge (spec 001 bridge, wired in spec 005)
 * ─────────────────────────────────────────────────────────────────────────────
 * Concrete `PerceptionDataProvider` (defined in `@evol-hive/shared`) that lets
 * the cognition layer read passive world/agent data from the engine without
 * coupling the two packages (per ADR-0001). Delegates to `AgentManager`,
 * `SmartObjectRegistry`, `DriveSystem`, and the shared `SystemFeedbackStore`.
 */

import type {
  Affordance,
  AgentProfile,
  AgentInternalState,
  AgentSummary,
  CompoundAction,
  ObjectDependency,
  Relationship,
  SmartObject,
  SmartObjectSummary,
  SelfModel,
  SocialMessage,
  PerceptionDataProvider,
} from '@evol-hive/shared';
import type { AgentManager, DriveSystem } from '../index.js';
import type { SmartObjectRegistry } from '../../world/index.js';
import type { SystemFeedbackStore } from '../feedback/index.js';
import type { SocialManager } from '../../social/social-manager.js';
import type { ConversationManagerImpl } from '../../social/conversation-manager.js';
import type { SelfModelManager } from '../state/self-model-manager.js';

/**
 * Narrow reachability port (spec 065, R4) — the spatial authority's ONE
 * notion of "passable" this cycle. Implemented by the navigation system and
 * injected at assembly; the perception provider never routes on its own.
 */
export interface AreaReachabilityPort {
  /** True when `areaId` (a room id or an object anchor) has an open route. */
  canReachArea(agentId: string, areaId: string): boolean;
}

/** Constructor options for {@link PerceptionDataProviderImpl}. */
export interface PerceptionDataProviderOptions {
  agentManager: AgentManager;
  smartObjectRegistry: SmartObjectRegistry;
  driveSystem: DriveSystem;
  feedbackStore: SystemFeedbackStore;
  /**
   * Spec 065, R4 — optional. When absent, door-derived areas are offered
   * exactly as before (degrade to pre-065 behaviour).
   */
  reachability?: AreaReachabilityPort;
}

/**
 * Structural view of the `spatialMemory` fields the provider reads. Mirrors
 * `AgentInternalState['spatialMemory']` without importing the shared type
 * into the `fog()` signature.
 */
interface SpatialMemoryView {
  visitedRooms: string[];
  knownDoors: string[];
  discoveredAt: Record<string, number>;
  observedObjects?: Record<string, string>;
  exploredCells?: Record<string, string[]>;
}

/**
 * Bridge between the cognition layer and the engine for the Perceive phase.
 * Implements `PerceptionDataProvider` (defined in `@evol-hive/shared`).
 */
export class PerceptionDataProviderImpl implements PerceptionDataProvider {
  private readonly agentManager: AgentManager;
  private readonly smartObjectRegistry: SmartObjectRegistry;
  private readonly driveSystem: DriveSystem;
  private readonly feedbackStore: SystemFeedbackStore;
  private socialManager: SocialManager | undefined;
  /** Conversation lifecycle engine (spec 033) — affordance eligibility filtering. */
  private conversationManager: ConversationManagerImpl | undefined;
  /** Guarded identity self-model store (spec 033) — prompt injection source. */
  private selfModelManager: SelfModelManager | undefined;
  /** Tick source (spec 044) — scene-novelty input for the social urge model. */
  private tickSource: (() => number | undefined) | undefined;
  /** Reachability port (spec 065, R4) — absent until wired (degrade). */
  private reachability: AreaReachabilityPort | undefined;

  constructor(
    agentManager: AgentManager,
    smartObjectRegistry: SmartObjectRegistry,
    driveSystem: DriveSystem,
    feedbackStore: SystemFeedbackStore,
    reachability?: AreaReachabilityPort,
  ) {
    this.agentManager = agentManager;
    this.smartObjectRegistry = smartObjectRegistry;
    this.driveSystem = driveSystem;
    this.feedbackStore = feedbackStore;
    this.reachability = reachability;
  }

  /**
   * Wire the spatial authority's reachability port (spec 065, R4). Optional:
   * without it the provider degrades to the pre-065 projection, so existing
   * construction sites and tests keep working unchanged.
   */
  setReachabilityPort(port: AreaReachabilityPort): void {
    this.reachability = port;
  }

  getAgentLocation(agentId: string): string {
    const state = this.agentManager.getState(agentId);
    return state?.location ?? '';
  }

  getObjectsInRoom(roomId: string): SmartObjectSummary[] {
    return this.smartObjectRegistry.getObjectsInRoom(roomId);
  }

  // ── Fog-filtered perception (spec 039, R3/R4) ─────────────────────────
  //
  // The fog gate is a filter over perception output at the provider choke
  // point: objects/affordances outside the agent's explored area never reach
  // cognition, and `go_to_<room>` movement affordances only surface when the
  // agent knows the destination (door seen or room visited). Legacy agents
  // without `spatialMemory` perceive everything (backward compat).

  /** The agent's spatial memory, or `null` when fog is not wired (legacy). */
  private fog(agentId: string): SpatialMemoryView | null {
    const state = this.agentManager.getState(agentId);
    return state?.spatialMemory ?? null;
  }

  /** Rooms behind doors the agent has SEEN but never crossed (R4). */
  private doorAdjacentRooms(agentId: string): Set<string> {
    const mem = this.fog(agentId);
    if (mem === null) return new Set();
    const rooms = new Set<string>();
    for (const pair of mem.knownDoors) {
      const [a, b] = pair.split('|');
      if (a !== undefined && a.length > 0) rooms.add(a);
      if (b !== undefined && b.length > 0) rooms.add(b);
    }
    return rooms;
  }

  /**
   * Fog-filtered objects in the agent's CURRENT room (R3): empty while the
   * room is unexplored; every object currently present once it is explored
   * (the observation is refreshed at perception time, so dynamically spawned
   * objects are picked up on the next tick). Also records the observed
   * anchors into spatial memory — perception and the targetArea enum pick
   * them up automatically.
   */
  getVisibleObjectsInRoom(agentId: string, roomId: string): SmartObjectSummary[] {
    const all = this.smartObjectRegistry.getObjectsInRoom(roomId);
    const mem = this.fog(agentId);
    if (mem === null) return all; // legacy: no fog
    // Spec 052 live-run finding (issue #183): the room the agent physically
    // occupies is self-evidently known — fog models knowledge of the world,
    // and an agent perceives its surroundings passively. The `go_to_*`
    // teleport handler moves the agent WITHOUT recording the visit, so a
    // fogged occupied room left the agent perceiving EMPTY surroundings
    // forever (`inRoom=0 … enum=[] … chosen=[wait]` while drives decayed to
    // zero — the #183 headline symptom through a new path). Occupancy
    // overrides the unexplored-room gate.
    const occupied = this.agentManager.getState(agentId)?.location === roomId;
    if (!mem.visitedRooms.includes(roomId) && !occupied) return []; // unexplored room
    // Room explored → the agent observes everything currently in it (fresh
    // sightings update the remembered anchor set).
    const observed = { ...(mem.observedObjects ?? {}) };
    for (const o of all) {
      observed[o.id] = roomId;
    }
    this.agentManager.updateState(agentId, {
      spatialMemory: { ...mem, observedObjects: observed },
    });
    return all;
  }

  /**
   * Fog-filtered eligible affordances in the agent's CURRENT room (R3, spec
   * 058 R1): composes the conversation-eligibility projection with the
   * explored-area gate and the door-sighting gate — `go_to_<room>` movement
   * affordances surface only when the destination is known (door seen or room
   * visited). Unknown doors do not leak into prunedAffordances, and an
   * affordance ineligible for this agent at this moment is not a valid plan
   * value either. The two filters are orthogonal and both applied.
   */
  getVisibleAffordancesInRoom(agentId: string, roomId: string): Affordance[] {
    const mem = this.fog(agentId);
    const base = this.eligibleAffordances(roomId, agentId);
    if (mem === null) return base; // legacy: no fog
    // Occupancy overrides the unexplored-room gate (spec 052 finding, #183 —
    // same rationale as getVisibleObjectsInRoom above).
    const occupied = this.agentManager.getState(agentId)?.location === roomId;
    if (!mem.visitedRooms.includes(roomId) && !occupied) return []; // unexplored room
    const visited = new Set(mem.visitedRooms);
    const doors = this.doorAdjacentRooms(agentId);
    return base.filter((affordance) => {
      if (!affordance.engineEffect.startsWith('go_to_')) return true;
      const destination = affordance.engineEffect.slice('go_to_'.length);
      // Known destination: the door was seen, or the room already visited.
      return visited.has(destination) || doors.has(destination);
    });
  }

  /**
   * The agent's KNOWN areas (spec 039, R1): visited rooms, door-adjacent
   * rooms, and observed object anchors — the exact targetArea enum value
   * space. Deterministic order: visited rooms (arrival order), then
   * door-adjacent rooms, then observed anchors (insertion order).
   *
   * Spec 065: knowledge ≠ offer. This projection is the OFFER, so it is
   * narrowed to destinations executable this cycle — a room known ONLY
   * through a currently-unroutable door is withheld, while `knownDoors`
   * keeps the memory (R3). A personally visited room stays offered
   * regardless of door state (AC-2), and a live anchor's room is not the
   * anchor's own area id. Stale anchors are corrected first (R2).
   */
  getKnownAreas(agentId: string): string[] {
    const mem = this.fog(agentId);
    if (mem === null) return [];
    const seen = new Set<string>();
    const areas: string[] = [];
    const add = (id: string): void => {
      if (id.length > 0 && !seen.has(id)) {
        seen.add(id);
        areas.push(id);
      }
    };
    const visited = new Set(mem.visitedRooms);
    // R2: correct false anchors BEFORE folding them in — a removed object is
    // neither offered nor remembered; a relocated one routes to its room.
    const anchors = this.reconcileObservedAnchors(agentId, mem);
    for (const room of mem.visitedRooms) add(room);
    for (const pair of mem.knownDoors) {
      const [a, b] = pair.split('|');
      for (const room of [a, b]) {
        if (room === undefined) continue;
        // R3: door knowledge is preserved. Only the OFFER is gated, and only
        // for a room known solely through a door — a visited room outlives
        // any door state (AC-2). No port → today's behaviour (degrade).
        if (visited.has(room)) {
          add(room);
          continue;
        }
        if (this.reachability === undefined || this.reachability.canReachArea(agentId, room)) {
          add(room);
        }
      }
    }
    for (const anchor of Object.keys(anchors)) add(anchor);
    return areas;
  }

  /**
   * R2 (spec 065): the anchor map is memory, and memory may assert something
   * false after spec-030 world mutation. Prune anchors for objects that no
   * longer exist and re-point anchors whose object moved to its current
   * room, so the enum never offers a dead destination and `navigateToArea`
   * routes an object anchor to the room it is actually in. Returns the
   * corrected map (insertion order preserved). Idempotent once corrected.
   */
  private reconcileObservedAnchors(
    agentId: string,
    mem: SpatialMemoryView,
  ): Record<string, string> {
    const observed = mem.observedObjects ?? {};
    const corrected: Record<string, string> = {};
    let changed = false;
    for (const [objectId, seenRoom] of Object.entries(observed)) {
      const object = this.smartObjectRegistry.get(objectId);
      if (object === null) {
        changed = true; // removed from the world — the anchor is false memory
        continue;
      }
      if (object.roomId !== seenRoom) {
        changed = true; // relocated — re-point at its current room
      }
      corrected[objectId] = object.roomId;
    }
    if (changed) {
      this.agentManager.updateState(agentId, {
        spatialMemory: { ...mem, observedObjects: corrected },
      });
    }
    return corrected;
  }

  /**
   * Known-but-unexplored areas (spec 039, R4): rooms behind doors the agent
   * has seen but never crossed — the unknown markers' data source.
   */
  getUnexploredAreas(agentId: string): string[] {
    const mem = this.fog(agentId);
    if (mem === null) return [];
    const visited = new Set(mem.visitedRooms);
    const unexplored: string[] = [];
    for (const room of this.doorAdjacentRooms(agentId)) {
      if (!visited.has(room)) unexplored.push(room);
    }
    return unexplored;
  }

  getAffordancesInRoom(roomId: string): Affordance[] {
    return this.smartObjectRegistry.getAffordancesInRoom(roomId);
  }

  // ── Object interaction methods (spec 018, Req 22) ─────────────────────────

  /** Only affordances whose conditions are currently met (spec 018, Req 22). */
  getAvailableAffordancesInRoom(roomId: string): Affordance[] {
    return this.smartObjectRegistry.getAvailableAffordancesInRoom(roomId);
  }

  /** All compound actions in a room (spec 018, Req 22). */
  getCompoundActionsInRoom(roomId: string): CompoundAction[] {
    return this.smartObjectRegistry.getCompoundActionsInRoom(roomId);
  }

  /** All object dependencies in a room (spec 018, Req 22). */
  getObjectDependenciesInRoom(roomId: string): ObjectDependency[] {
    return this.smartObjectRegistry.getObjectDependenciesInRoom(roomId);
  }

  getAgentDrives(agentId: string): Record<string, number> {
    const state = this.agentManager.getState(agentId);
    if (!state) return {};
    return { ...state.drives };
  }

  getPrimaryDriveLabel(agentId: string): string {
    const state = this.agentManager.getState(agentId);
    if (!state) return '';
    return this.driveSystem.getPrimaryDriveLabel(state);
  }

  getSystemFeedback(agentId: string): string | undefined {
    return this.feedbackStore.getSystemFeedback(agentId);
  }

  getAgentProfile(agentId: string): AgentProfile | null {
    return this.agentManager.getProfile(agentId);
  }

  getAgentState(agentId: string): AgentInternalState | null {
    return this.agentManager.getState(agentId);
  }

  // ── Social perception methods (spec 018, Req 21) ───────────────────────────

  /** Inject the SocialManager for social perception queries (spec 018, Req 21). */
  setSocialManager(socialManager: SocialManager): void {
    this.socialManager = socialManager;
  }

  getAgentsInRoom(roomId: string, excludingAgentId: string): AgentSummary[] {
    return this.socialManager?.getAgentsInRoom(roomId, excludingAgentId) ?? [];
  }

  dequeueSocialMessages(agentId: string): SocialMessage[] {
    return this.socialManager?.dequeueSocialMessages(agentId) ?? [];
  }

  getRelationships(agentId: string): Record<string, Relationship> {
    return this.socialManager?.getRelationships(agentId) ?? {};
  }

  // ── Conversation + self-model perception (spec 033) ─────────────────────

  /** Wire the conversation manager for affordance eligibility filtering (R3/R8). */
  setConversationManager(conversationManager: ConversationManagerImpl): void {
    this.conversationManager = conversationManager;
  }

  /** Wire the self-model store (R11/AC-13). */
  setSelfModelManager(selfModelManager: SelfModelManager): void {
    this.selfModelManager = selfModelManager;
  }

  /**
   * Available affordances in a room with conversation-eligibility applied
   * (spec 033 AC-2, spec 058 R1/R2): conversation objects expose join/observe
   * to co-located non-participants and contribute/leave to participants;
   * non-conversation objects pass through unchanged.
   *
   * Spec 058 R2: ownership is resolved per OBJECT — each available affordance
   * is paired with the object that DECLARES it (reference identity), never by
   * scanning the room's flat list for a matching id. `observe` is declared on
   * nearly every smart object, so a flat-id lookup would misattribute a
   * conversation's affordance to a non-conversation owner (and vice versa).
   */
  getEligibleAffordancesInRoom(roomId: string, agentId: string): Affordance[] {
    return this.eligibleAffordances(roomId, agentId);
  }

  /**
   * The shared eligibility predicate (spec 058 R1/R2): the room's available
   * affordances (conditions + movement filter already applied) filtered by
   * the owning conversation's per-agent role projection. Non-conversation
   * affordances — including a duplicate id on an unrelated object — pass
   * through unchanged. Legacy unwired managers return the available set
   * byte-identically.
   */
  private eligibleAffordances(roomId: string, agentId: string): Affordance[] {
    const base = this.smartObjectRegistry.getAvailableAffordancesInRoom(roomId);
    const manager = this.conversationManager;
    if (manager === undefined) return base;
    // Pair each available affordance with its declaring object. Reference
    // identity is unambiguous even when ids collide across objects.
    const owners = new Map<Affordance, SmartObject>();
    for (const object of this.smartObjectRegistry.getByRoom(roomId)) {
      for (const affordance of object.affordances) {
        owners.set(affordance, object);
      }
    }
    return base.filter((affordance) => {
      const owner = owners.get(affordance);
      if (owner === undefined || owner.type !== 'conversation') return true;
      return manager.getEligibleAffordances(owner.id, agentId).includes(affordance.id);
    });
  }

  /** The agent's evolved self-model, or `null` (persona fallback) — R11/AC-13. */
  getSelfModel(agentId: string): SelfModel | null {
    return this.selfModelManager?.getSelfModel(agentId) ?? null;
  }

  // ── Social urge perception (spec 044, R4a / Decision 4) ─────────────────

  /**
   * Conversations where the agent still owes a reply — the data behind the
   * pending-address perception line. Delegates to the conversation manager
   * via the SocialManager ConversationBridge.
   */
  getConversationsAwaitingAgentReply(
    agentId: string,
  ): import('@evol-hive/shared').ConversationObject[] {
    return this.socialManager?.getConversationsAwaitingAgentReply(agentId) ?? [];
  }

  /**
   * Open/active conversations in the agent's room the agent does NOT
   * participate in (spec 053, R1 — issue #192): the data behind the
   * `INFORMATION: Overheard` perception lines. Delegates to the conversation
   * manager via the SocialManager ConversationBridge — the same pass-through
   * shape as {@link getConversationsAwaitingAgentReply}. Empty when the
   * manager is unwired (legacy) — no lines, no failure.
   */
  getOverheardConversations(agentId: string): import('@evol-hive/shared').OverheardConversation[] {
    return this.socialManager?.getOverheardConversations(agentId) ?? [];
  }

  /** Wire the tick source (spec 044) — lazily captures the game loop. */
  setTickSource(tickSource: () => number | undefined): void {
    this.tickSource = tickSource;
  }

  /** The current engine tick, or `undefined` when no source is wired. */
  getCurrentTick(): number | undefined {
    return this.tickSource?.();
  }

  // ── Plan-memory perception (spec 055, Req 4 — issue #198) ────────────────

  /**
   * The agent's most recently completed-or-failed plan outcome, or
   * `undefined` (spec 055, Req 4). Reads the engine-stamped
   * `AgentInternalState.lastPlanOutcome` — the same state the Reflect phase's
   * data layer writes.
   */
  getLastPlanOutcome(agentId: string): import('@evol-hive/shared').LastPlanOutcome | undefined {
    return this.agentManager.getState(agentId)?.lastPlanOutcome;
  }
}

export {};
