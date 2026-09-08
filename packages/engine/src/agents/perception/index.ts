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

/** Constructor options for {@link PerceptionDataProviderImpl}. */
export interface PerceptionDataProviderOptions {
  agentManager: AgentManager;
  smartObjectRegistry: SmartObjectRegistry;
  driveSystem: DriveSystem;
  feedbackStore: SystemFeedbackStore;
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

  constructor(
    agentManager: AgentManager,
    smartObjectRegistry: SmartObjectRegistry,
    driveSystem: DriveSystem,
    feedbackStore: SystemFeedbackStore,
  ) {
    this.agentManager = agentManager;
    this.smartObjectRegistry = smartObjectRegistry;
    this.driveSystem = driveSystem;
    this.feedbackStore = feedbackStore;
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
  private fog(agentId: string): {
    visitedRooms: string[];
    knownDoors: string[];
    discoveredAt: Record<string, number>;
    observedObjects?: Record<string, string>;
    exploredCells?: Record<string, string[]>;
  } | null {
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
    if (!mem.visitedRooms.includes(roomId)) return []; // unexplored room
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
   * Fog-filtered available affordances in the agent's CURRENT room (R3):
   * the explored-area gate plus the door-sighting gate — `go_to_<room>`
   * movement affordances surface only when the destination is known (door
   * seen or room visited). Unknown doors do not leak into prunedAffordances.
   */
  getVisibleAffordancesInRoom(agentId: string, roomId: string): Affordance[] {
    const mem = this.fog(agentId);
    const base = this.getAvailableAffordancesInRoom(roomId);
    if (mem === null) return base; // legacy: no fog
    if (!mem.visitedRooms.includes(roomId)) return []; // unexplored room
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
    for (const room of mem.visitedRooms) add(room);
    for (const pair of mem.knownDoors) {
      const [a, b] = pair.split('|');
      if (a !== undefined) add(a);
      if (b !== undefined) add(b);
    }
    for (const anchor of Object.keys(mem.observedObjects ?? {})) add(anchor);
    return areas;
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
   * (AC-2): conversation objects expose join/observe to co-located
   * non-participants and contribute/leave to participants. Non-conversation
   * objects pass through unchanged.
   */
  getEligibleAffordancesInRoom(roomId: string, agentId: string): Affordance[] {
    const base = this.smartObjectRegistry.getAvailableAffordancesInRoom(roomId);
    if (this.conversationManager === undefined) return base;
    return base.filter((affordance) => {
      const objects = this.smartObjectRegistry.getByRoom(roomId);
      const owner = objects.find((o) => o.affordances.some((a) => a.id === affordance.id));
      if (owner === undefined || owner.type !== 'conversation') return true;
      return this.conversationManager!.getEligibleAffordances(owner.id, agentId).includes(
        affordance.id,
      );
    });
  }

  /** The agent's evolved self-model, or `null` (persona fallback) — R11/AC-13. */
  getSelfModel(agentId: string): SelfModel | null {
    return this.selfModelManager?.getSelfModel(agentId) ?? null;
  }
}

export {};
