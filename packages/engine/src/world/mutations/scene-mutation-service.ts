/**
 * world/mutations/scene-mutation-service — The single entry point for runtime
 * structural changes (spec 030, Req 1)
 * ──────────────────────────────────────────────────────────────────────────────
 * All structural mutations (AddObject / RemoveObject / MoveObject / SpawnAgent
 * / DespawnAgent / SetConnectionState) funnel through this service. The flow
 * is always: **propose → validate → queue → apply at tick boundary**.
 *
 * - `propose()` validates every operation against the live world and rejects
 *   invalid ones with an actionable `SceneMutationError` (names the offending
 *   IDs and the violated rule — Req 3). Agent-initiated changes enter via the
 *   Execute service (spec 028 pattern); LLM-proposed changes via the
 *   `modify_scene` cognitive tool through the shared `SceneMutationPort`
 *   bridge — both end at the same validated queue (design note D1).
 * - `applyPending(tick)` is called by the `SceneMutationSystem` each engine
 *   tick. Applications are synchronous, ordered, and assigned monotonic `seq`
 *   numbers — the deterministic core is never mutated mid-phase (Req 1).
 * - Every applied mutation is appended to the in-memory log exposed via
 *   `getMutations(sinceSeq?)` (Req 2). Replaying the log over the base scene
 *   reproduces the live scene exactly (AC-8).
 *
 * Object mutations invalidate the per-room affordance cache (Req 5) so the
 * next Perception tick reflects the new object distribution immediately.
 *
 * Package boundaries (per ADR-0001): imports only from `@evol-hive/shared`
 * and engine-internal modules — never from `@evol-hive/cognition`.
 */

import type {
  AffordanceResult,
  SceneMutationEvent,
  SceneMutationProposal,
  SceneMutationResult,
  SceneMutationPort,
  SmartObject,
} from '@evol-hive/shared';
import { SceneMutationError } from '@evol-hive/shared';
import type { MemoryNode } from '@evol-hive/shared';
import type { AgentManagerImpl } from '../../agents/state/index.js';
import type { SmartObjectRegistryImpl } from '../objects/index.js';
import type { SceneManagerImpl } from '../scenes/index.js';
import type { AffordanceResolutionCache } from '../affordances/cache.js';
import type { AffordanceHandler } from '../index.js';
import { DormantAgentStore } from './dormant-agent-store.js';
import { YaamEventLog, agentMemoryLabel, agentStateLabel } from './yaam-event-log.js';

/**
 * Synchronous memory adapter for dormancy (design note D4): exports the
 * memories scoped to an agent at despawn time and re-imports them at
 * (re-)spawn time. The application wires this to the vector store / memory
 * pipeline; keeping it synchronous preserves the deterministic tick-boundary
 * apply.
 */
export interface DormancyMemoryPort {
  /** Memories scoped to `agentId` (sync snapshot of the vector store). */
  exportMemories(agentId: string): MemoryNode[];
  /** Re-import memories for bootstrap on (re-)spawn. */
  importMemories(nodes: MemoryNode[]): void;
}

/** Constructor dependencies for the {@link SceneMutationServiceImpl}. */
export interface SceneMutationServiceOptions {
  registry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  agentManager: AgentManagerImpl;
  dormantStore: DormantAgentStore;
  /** Optional per-room affordance cache — invalidated on object mutations (Req 5). */
  affordanceCache?: AffordanceResolutionCache;
  /** Optional synchronous memory adapter for dormancy (Req 6/7/8). */
  memoryPort?: DormancyMemoryPort;
  /** Optional YAAM event log — despawn/respawn write agent-scoped events (Req 12). */
  yaamLog?: YaamEventLog;
  /** Optional guarded self-model store (spec 033, R14) — dormancy carries the evolved identity. */
  selfModelManager?: import('../../agents/state/self-model-manager.js').SelfModelManager;
  /** Optional conversation manager (spec 033) — despawned agents leave conversations. */
  conversationManager?: import('../../social/conversation-manager.js').ConversationManagerImpl;
}

/** The engine-internal mutation funnel (spec 030, Req 1). */
export class SceneMutationServiceImpl implements SceneMutationPort {
  private readonly registry: SmartObjectRegistryImpl;
  private sceneManager: SceneManagerImpl;
  private readonly agentManager: AgentManagerImpl;
  private readonly dormantStore: DormantAgentStore;
  private readonly affordanceCache: AffordanceResolutionCache | undefined;
  private readonly memoryPort: DormancyMemoryPort | undefined;
  private readonly yaamLog: YaamEventLog | undefined;
  private readonly selfModelManager: import('../../agents/state/self-model-manager.js').SelfModelManager | undefined;
  private readonly conversationManager: import('../../social/conversation-manager.js').ConversationManagerImpl | undefined;

  /** Queued proposals awaiting the next tick boundary. */
  private readonly pending: SceneMutationProposal[] = [];
  /** Append-only log of applied mutations (Req 2). */
  private readonly log: SceneMutationEvent[] = [];
  /** Monotonic sequence counter for the log. */
  private nextSeq = 1;

  constructor(options: SceneMutationServiceOptions) {
    this.registry = options.registry;
    this.sceneManager = options.sceneManager;
    this.agentManager = options.agentManager;
    this.dormantStore = options.dormantStore;
    this.affordanceCache = options.affordanceCache;
    this.memoryPort = options.memoryPort;
    this.yaamLog = options.yaamLog;
    this.selfModelManager = options.selfModelManager;
    this.conversationManager = options.conversationManager;

    // Topology-aware perception (Req 10): cross-door `go_to_<room>` affordances
    // are only offered when the destination is reachable through an open
    // (direct) connection. Unknown destinations (e.g. `go_outside`) are exempt.
    this.registry.setMovementFilter((roomId, engineEffect) => {
      if (!engineEffect.startsWith('go_to_')) return true;
      const destination = engineEffect.slice('go_to_'.length);
      if (this.sceneManager.getRoom(destination) === null) return true;
      return this.sceneManager.hasConnection(roomId, destination);
    });
  }

  // ── Port surface (SceneMutationPort) ─────────────────────────────────────

  /** Validate a proposal and enqueue it for the next tick boundary (Req 1/3). */
  propose(mutation: SceneMutationProposal): SceneMutationResult {
    try {
      this.validate(mutation);
    } catch (err) {
      if (err instanceof SceneMutationError) {
        return { accepted: false, error: err.message };
      }
      throw err;
    }
    this.pending.push(mutation);
    return { accepted: true };
  }

  /** The applied-mutation log from `sinceSeq` (exclusive) onward (Req 2). */
  getMutations(sinceSeq?: number): SceneMutationEvent[] {
    if (sinceSeq === undefined) return [...this.log];
    return this.log.filter((event) => event.seq > sinceSeq);
  }

  // ── Engine-internal surface ──────────────────────────────────────────────

  /**
   * Rebind the scene manager — used by `loadScene`, which replaces the
   * core's scene manager with a fresh instance when a scene is loaded. The
   * movement filter reads the field, so rebinding updates topology filtering
   * too.
   */
  setSceneManager(sceneManager: SceneManagerImpl): void {
    this.sceneManager = sceneManager;
  }

  /**
   * Apply every queued mutation, in queue order, assigning monotonic seq
   * numbers and recording tick-boundary events in the log. Called by the
   * `SceneMutationSystem` each engine tick.
   */
  applyPending(tick: number): void {
    while (this.pending.length > 0) {
      const mutation = this.pending.shift()!;
      const event: SceneMutationEvent = {
        seq: this.nextSeq,
        tick,
        type: mutation.type,
        payload: mutation.payload,
        source: mutation.source ?? 'engine',
      };
      this.apply(event);
      this.log.push(event);
      this.nextSeq += 1;
    }
  }

  /** Number of queued proposals (useful for tests). */
  pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Validate a mutation against the live world (Req 3). Throws
   * `SceneMutationError` with an actionable, human-readable message naming
   * the offending IDs and the violated rule.
   */
  validate(mutation: SceneMutationProposal): void {
    const { type } = mutation;
    switch (type) {
      case 'add_object': {
        const object = (mutation.payload as import('@evol-hive/shared').AddObjectPayload).object;
        if (this.registry.get(object.id) !== null) {
          throw new SceneMutationError(
            'duplicate_object_id',
            `Cannot add object '${object.id}': an object with ID '${object.id}' already exists.`,
            [object.id],
          );
        }
        if (this.sceneManager.getRoom(object.roomId) === null) {
          throw new SceneMutationError(
            'unknown_room',
            `Cannot add object '${object.id}': target room '${object.roomId}' does not exist.`,
            [object.id, object.roomId],
          );
        }
        break;
      }
      case 'remove_object': {
        const removeId = (mutation.payload as import('@evol-hive/shared').RemoveObjectPayload)
          .objectId;
        if (this.registry.get(removeId) === null) {
          throw new SceneMutationError(
            'unknown_object',
            `Cannot remove object '${removeId}': no object with ID '${removeId}' exists.`,
            [removeId],
          );
        }
        break;
      }
      case 'move_object': {
        const move = mutation.payload as import('@evol-hive/shared').MoveObjectPayload;
        if (this.registry.get(move.objectId) === null) {
          throw new SceneMutationError(
            'unknown_object',
            `Cannot move object '${move.objectId}': no object with ID '${move.objectId}' exists.`,
            [move.objectId],
          );
        }
        if (this.sceneManager.getRoom(move.toRoomId) === null) {
          throw new SceneMutationError(
            'unknown_room',
            `Cannot move object '${move.objectId}': target room '${move.toRoomId}' does not exist.`,
            [move.objectId, move.toRoomId],
          );
        }
        break;
      }
      case 'spawn_agent': {
        const spawn = mutation.payload as import('@evol-hive/shared').SpawnAgentPayload;
        if (spawn.dormantAgentId !== undefined) {
          if (this.agentManager.getState(spawn.dormantAgentId) !== null) {
            throw new SceneMutationError(
              'duplicate_agent_id',
              `Cannot spawn agent '${spawn.dormantAgentId}': an agent with ID '${spawn.dormantAgentId}' is already active.`,
              [spawn.dormantAgentId],
            );
          }
          if (!this.dormantStore.has(spawn.dormantAgentId)) {
            throw new SceneMutationError(
              'unknown_dormant_agent',
              `Cannot spawn agent '${spawn.dormantAgentId}': no dormant state exists for this ID.`,
              [spawn.dormantAgentId],
            );
          }
          break;
        }
        const profile = spawn.profile;
        if (!profile) {
          throw new SceneMutationError(
            'invalid_payload',
            'Cannot spawn agent: provide either a profile or a dormantAgentId.',
            [],
          );
        }
        if (this.agentManager.getState(profile.id) !== null) {
          throw new SceneMutationError(
            'duplicate_agent_id',
            `Cannot spawn agent '${profile.id}': an agent with ID '${profile.id}' already exists.`,
            [profile.id],
          );
        }
        // Drive values must be within 0–100 (Req 3 / AC-5).
        for (const [drive, value] of Object.entries(profile.initialDrives)) {
          if (value !== undefined && (value < 0 || value > 100)) {
            throw new SceneMutationError(
              'invalid_drive_value',
              `Cannot spawn agent '${profile.id}': drive '${drive}' has value ${value}, which is outside the valid range 0–100.`,
              [profile.id, drive],
            );
          }
        }
        if (
          profile.startRoomId !== undefined &&
          this.sceneManager.getRoom(profile.startRoomId) === null
        ) {
          throw new SceneMutationError(
            'unknown_room',
            `Cannot spawn agent '${profile.id}': start room '${profile.startRoomId}' does not exist.`,
            [profile.id, profile.startRoomId],
          );
        }
        break;
      }
      case 'despawn_agent': {
        const despawnId = (mutation.payload as import('@evol-hive/shared').DespawnAgentPayload)
          .agentId;
        if (this.agentManager.getState(despawnId) === null) {
          throw new SceneMutationError(
            'unknown_agent',
            `Cannot despawn agent '${despawnId}': no active agent with ID '${despawnId}' exists.`,
            [despawnId],
          );
        }
        break;
      }
      case 'set_connection_state': {
        const { roomA, roomB, action } =
          mutation.payload as import('@evol-hive/shared').SetConnectionStatePayload;
        if (
          this.sceneManager.getRoom(roomA) === null ||
          this.sceneManager.getRoom(roomB) === null
        ) {
          const missing = this.sceneManager.getRoom(roomA) === null ? roomA : roomB;
          throw new SceneMutationError(
            'unknown_room',
            `Cannot ${action} connection between '${roomA}' and '${roomB}': room '${missing}' does not exist.`,
            [roomA, roomB],
          );
        }
        const connected = this.sceneManager.hasConnection(roomA, roomB);
        const closed = this.sceneManager.isPairClosed(roomA, roomB);
        if (action === 'insert' && (connected || closed)) {
          throw new SceneMutationError(
            'duplicate_connection',
            `Cannot insert connection between '${roomA}' and '${roomB}': the rooms are already connected.`,
            [roomA, roomB],
          );
        }
        if ((action === 'open' || action === 'close') && !connected && !closed) {
          throw new SceneMutationError(
            'no_connection',
            `Cannot ${action} connection between '${roomA}' and '${roomB}': the rooms are not connected.`,
            [roomA, roomB],
          );
        }
        if (action === 'remove' && !connected && !closed) {
          throw new SceneMutationError(
            'no_connection',
            `Cannot remove connection between '${roomA}' and '${roomB}': the rooms are not connected.`,
            [roomA, roomB],
          );
        }
        if (action === 'remove') {
          // No room may be left with zero connections (Req 3). A closed pair
          // still counts as a connection for this purpose — after removal the
          // room must retain at least one remaining connection.
          for (const roomId of [roomA, roomB]) {
            const room = this.sceneManager.getRoom(roomId);
            const effective = (room?.connections.length ?? 0) + (!connected && closed ? 1 : 0);
            if (room && effective - 1 < 1) {
              throw new SceneMutationError(
                'zero_connections',
                `Cannot remove connection between '${roomA}' and '${roomB}': room '${roomId}' would be left with zero connections.`,
                [roomId],
              );
            }
          }
        }
        break;
      }
    }
  }

  /**
   * Build an `AffordanceHandler` for a doorway object's `open_door` /
   * `close_door` engine effects (spec 030, Req 9). The handler derives the
   * room pair from the doorway object's `go_to_*` affordances and enqueues a
   * `set_connection_state` proposal through this service — the LLM never
   * mutates topology directly.
   */
  createDoorwayEffect(objectId: string, effect: 'open_door' | 'close_door'): AffordanceHandler {
    return async (_handledObjectId: string, _agentId: string): Promise<AffordanceResult> => {
      const object = this.registry.get(objectId);
      if (object === null) {
        return { success: false, failureReason: `Doorway object '${objectId}' does not exist.` };
      }
      const action = effect === 'open_door' ? 'open' : 'close';
      const remote = this.doorwayRemoteRoom(object);
      if (remote === null) {
        return {
          success: false,
          failureReason: `Doorway object '${objectId}' exposes no go_to affordance to derive the connected room.`,
        };
      }
      const result = this.propose({
        type: 'set_connection_state',
        payload: { roomA: object.roomId, roomB: remote, action },
        source: 'agent',
      });
      if (!result.accepted) {
        return { success: false, failureReason: result.error ?? 'Connection change rejected.' };
      }
      return { success: true, newState: { ...object.state, open: action === 'open' } };
    };
  }

  // ── Persistence support (Req 11) ─────────────────────────────────────────

  /** Serializable copy of the full mutation log (for `SaveState.dynamic`). */
  exportLog(): SceneMutationEvent[] {
    return this.log.map((event) => structuredCloneSafe(event));
  }

  /** Serializable copy of the dormant-agent snapshots (for `SaveState.dynamic`). */
  exportDormant(): Record<string, import('@evol-hive/shared').DormantAgentSnapshot> {
    return this.dormantStore.snapshot();
  }

  /** Whether the world has any dynamic state (drives the `dynamic` field). */
  hasDynamicState(): boolean {
    return this.log.length > 0 || this.dormantStore.size() > 0;
  }

  /**
   * Restore dynamic state after a load (Req 11): the mutation log (for
   * event-sourcing continuity and the visualizer) and dormant agents. The
   * live world itself is restored by the persistence layer from the world
   * snapshot (the derived-snapshot approach — equivalent to replaying).
   */
  restoreDynamic(
    log: SceneMutationEvent[],
    dormant: Record<string, import('@evol-hive/shared').DormantAgentSnapshot>,
  ): void {
    this.pending.length = 0;
    this.log.length = 0;
    for (const event of log) {
      this.log.push(event);
    }
    this.nextSeq = log.length > 0 ? log[log.length - 1]!.seq + 1 : 1;
    this.dormantStore.restore(dormant);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Apply one validated mutation (synchronous, deterministic). */
  private apply(event: SceneMutationEvent): void {
    const payload = event.payload;
    switch (event.type) {
      case 'add_object': {
        const object = (payload as import('@evol-hive/shared').AddObjectPayload).object;
        this.registry.register(object);
        this.addObjectReference(object.roomId, object.id);
        this.invalidateRoom(object.roomId);
        break;
      }
      case 'remove_object': {
        const objectId = (payload as import('@evol-hive/shared').RemoveObjectPayload).objectId;
        const object = this.registry.get(objectId);
        if (object !== null) {
          this.removeObjectReference(object.roomId, objectId);
          this.invalidateRoom(object.roomId);
        }
        this.registry.remove(objectId);
        break;
      }
      case 'move_object': {
        const move = payload as import('@evol-hive/shared').MoveObjectPayload;
        const object = this.registry.get(move.objectId);
        if (object !== null) {
          const fromRoom = object.roomId;
          this.registry.setRoom(move.objectId, move.toRoomId);
          this.removeObjectReference(fromRoom, move.objectId);
          this.addObjectReference(move.toRoomId, move.objectId);
          this.invalidateRoom(fromRoom);
          this.invalidateRoom(move.toRoomId);
        }
        break;
      }
      case 'spawn_agent': {
        this.applySpawn(payload as import('@evol-hive/shared').SpawnAgentPayload);
        break;
      }
      case 'despawn_agent': {
        const agentId = (payload as import('@evol-hive/shared').DespawnAgentPayload).agentId;
        this.applyDespawn(agentId);
        break;
      }
      case 'set_connection_state': {
        const conn = payload as import('@evol-hive/shared').SetConnectionStatePayload;
        this.applyConnectionState(conn.roomA, conn.roomB, conn.action);
        break;
      }
    }
  }

  /** Spawn from a fresh profile or from dormancy (Req 6 / Req 8). */
  private applySpawn(payload: import('@evol-hive/shared').SpawnAgentPayload): void {
    // Dormant restore path (Req 8): drives, goal, plan, location, and memory
    // bootstrap come from the DormantAgentStore instead of defaults.
    if (payload.dormantAgentId !== undefined) {
      const dormant = this.dormantStore.take(payload.dormantAgentId);
      if (dormant === null) return; // unreachable — validated at propose
      const state = this.agentManager.spawn(dormant.profile);
      // Overwrite the fresh-spawn defaults with the dormant state; never
      // restore a stale isThinking flag.
      this.agentManager.updateState(dormant.profile.id, {
        ...dormant.state,
        isThinking: false,
      });
      // Memory bootstrap from the dormant snapshot (Req 8).
      this.memoryPort?.importMemories(dormant.memories);
      // Evolved identity self-model (spec 033, R14/AC-9/AC-13): respawned
      // dormant agents come back changed by their last session.
      if (dormant.selfModel !== undefined) {
        this.selfModelManager?.restore(dormant.profile.id, dormant.selfModel);
      } else {
        this.selfModelManager?.seedFromProfile(dormant.profile, 0);
      }
      // Claim the dormant state in the YAAM log (Req 12).
      for (const node of dormant.memories) {
        this.yaamLog?.append({
          type: 'DELETE_NODE',
          label: agentMemoryLabel(dormant.profile.id, node.id),
          agentId: dormant.profile.id,
        });
      }
      this.yaamLog?.append({
        type: 'DELETE_NODE',
        label: agentStateLabel(dormant.profile.id),
        agentId: dormant.profile.id,
      });
      void state;
      return;
    }

    const profile = payload.profile;
    if (!profile) return; // unreachable — validated at propose
    this.agentManager.spawn(profile);
    // Seed location: profile.startRoomId, default: the first valid room (Req 6).
    const startRoom = profile.startRoomId ?? this.sceneManager.getAllRooms()[0]?.id ?? '';
    this.agentManager.updateState(profile.id, {
      location: startRoom,
      lastPerceptionTick: 0,
    });
    // Seed the identity self-model from the spawn profile (spec 033, R11).
    this.selfModelManager?.seedFromProfile(profile, 0);
    // Memory bootstrap: prior memories scoped to this agentId (e.g. from a
    // previous session via the YAAM pipeline) flow through the memory port.
    const prior = this.memoryPort?.exportMemories(profile.id) ?? [];
    if (prior.length > 0) {
      this.memoryPort?.importMemories(prior);
    }
  }

  /** Despawn with state export into dormancy + YAAM (Req 7 / Req 12). */
  private applyDespawn(agentId: string): void {
    const state = this.agentManager.getState(agentId);
    const profile = this.agentManager.getProfile(agentId);
    if (state === null || profile === null) return; // unreachable — validated

    const memories = this.memoryPort?.exportMemories(agentId) ?? [];
    const selfModel = this.selfModelManager?.exportForDespawn(agentId) ?? undefined;
    this.dormantStore.put(agentId, {
      profile: structuredCloneSafe(profile),
      state: structuredCloneSafe(state),
      memories: memories.map((node) => structuredCloneSafe(node)),
      ...(selfModel !== undefined ? { selfModel: structuredCloneSafe(selfModel) } : {}),
    });

    // Spec 033 (R7): a despawned agent leaves every conversation it was in;
    // its conversation(s) close when the last participant is gone.
    this.conversationManager?.removeAgentEverywhere(agentId);

    // YAAM persistence (Req 12): state summary + key memories as agent-scoped
    // UPSERT_NODE events. Coarse-grained — only despawn/spawn boundaries write.
    this.yaamLog?.append({
      type: 'UPSERT_NODE',
      label: agentStateLabel(agentId),
      content: this.agentStateSummary(state),
      agentId,
      timestamp: state.lastPerceptionTick,
    });
    for (const node of memories) {
      this.yaamLog?.append(YaamEventLog.memoryUpsert(node));
    }

    // Remove from the agent manager — the PPER scheduler and social/perception
    // surfaces iterate getActiveAgents(), so exclusion is immediate (Req 7).
    this.agentManager.despawn(agentId);
  }

  /** Human-readable state summary for the YAAM state node. */
  private agentStateSummary(state: {
    drives: { energy: number; hunger: number; social: number; comfort: number; curiosity: number };
    currentGoal: string;
    location: string;
  }): string {
    const drives = Object.entries(state.drives)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    return `agent state — drives: ${drives}; goal: ${state.currentGoal || '(none)'}; location: ${state.location}`;
  }

  /** Apply connection state changes, mirroring doorway object state (Req 9). */
  private applyConnectionState(
    roomA: string,
    roomB: string,
    action: 'open' | 'close' | 'insert' | 'remove',
  ): void {
    switch (action) {
      case 'open':
        this.sceneManager.setConnectionOpen(roomA, roomB, true);
        this.patchDoorways(roomA, roomB, true);
        break;
      case 'close':
        this.sceneManager.setConnectionOpen(roomA, roomB, false);
        this.patchDoorways(roomA, roomB, false);
        break;
      case 'insert':
        this.sceneManager.addConnection(roomA, roomB);
        break;
      case 'remove':
        // Fully delete the connection (final — re-insert via addConnection).
        this.sceneManager.removeConnection(roomA, roomB);
        this.patchDoorways(roomA, roomB, false);
        break;
    }
  }

  /** Mirror connection state onto the pair's doorway smart objects (Req 9). */
  private patchDoorways(roomA: string, roomB: string, open: boolean): void {
    for (const object of this.registry.getAll()) {
      if (object.type !== 'doorway') continue;
      const touchesPair =
        (object.roomId === roomA && this.doorwayTargets(object).includes(roomB)) ||
        (object.roomId === roomB && this.doorwayTargets(object).includes(roomA));
      if (touchesPair) {
        this.registry.applyStatePatch(object.id, { open });
        this.invalidateRoom(object.roomId);
      }
    }
  }

  /** Rooms a doorway object's `go_to_*` affordances point at (excluding its own room). */
  private doorwayTargets(object: SmartObject): string[] {
    return object.affordances
      .filter((a) => a.engineEffect.startsWith('go_to_'))
      .map((a) => a.engineEffect.slice('go_to_'.length))
      .filter((roomId) => roomId !== object.roomId);
  }

  /** The first remote room a doorway connects to, or `null`. */
  private doorwayRemoteRoom(object: SmartObject): string | null {
    return this.doorwayTargets(object)[0] ?? null;
  }

  /** Keep `room.objectIds` consistent: add an id if missing (no duplicates). */
  private addObjectReference(roomId: string, objectId: string): void {
    const room = this.sceneManager.getRoom(roomId);
    if (room && !room.objectIds.includes(objectId)) {
      room.objectIds.push(objectId);
    }
  }

  /** Keep `room.objectIds` consistent: drop an id if present. */
  private removeObjectReference(roomId: string, objectId: string): void {
    const room = this.sceneManager.getRoom(roomId);
    if (room) {
      room.objectIds = room.objectIds.filter((id) => id !== objectId);
    }
  }

  /** Invalidate the per-room affordance cache for one room (Req 5). */
  private invalidateRoom(roomId: string): void {
    this.affordanceCache?.invalidate(roomId);
  }
}

/** JSON-safe deep copy for plain data (profiles, states, memories, events). */
function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export {};
