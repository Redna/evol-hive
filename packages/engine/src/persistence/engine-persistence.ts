/**
 * persistence/ — Engine save/load implementation (spec 017, Reqs 13–15)
 * ─────────────────────────────────────────────────────────────────────
 * Serializes the full game state (agents, world, memory) into a single
 * `SaveState` JSON object and restores it on load. File I/O is a thin wrapper
 * over Node.js `fs/promises` — no new dependencies.
 *
 * Package boundaries (per ADR-0001 / spec 017, Req 20): imports only from
 * `@evol-hive/shared` (types) and `@evol-hive/memory` (`VectorStore`). It does
 * NOT import from `@evol-hive/cognition`.
 */

import type { AgentSnapshot, SaveState, WorldSnapshot } from '@evol-hive/shared';
import {
  SAVE_FORMAT_VERSION,
  MIN_SUPPORTED_SAVE_FORMAT_VERSION,
  SaveFormatVersionError,
} from '@evol-hive/shared';
import type { VectorStore } from '@evol-hive/memory';
import { promises as fs } from 'node:fs';
import type { GameLoopImpl } from '../loop/index.js';
import type { AgentManagerImpl } from '../agents/state/index.js';
import type { SmartObjectRegistryImpl } from '../world/objects/index.js';
import type { SceneManagerImpl } from '../world/scenes/index.js';
import type { SceneMutationServiceImpl } from '../world/mutations/scene-mutation-service.js';

/** Constructor dependencies for {@link EnginePersistenceImpl} (spec 017, Req 14). */
export interface EnginePersistenceOptions {
  gameLoop: GameLoopImpl;
  agentManager: AgentManagerImpl;
  smartObjectRegistry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  vectorStore: VectorStore;
  /** Optional mutation service — persists the dynamic world (spec 030, Req 11). */
  mutationService?: SceneMutationServiceImpl;
}

/**
 * Concrete save/load implementation. Composes each subsystem's export/import
 * surface into a single `SaveState` (save) and rebuilds every subsystem from a
 * `SaveState` (load).
 */
export class EnginePersistenceImpl {
  private readonly gameLoop: GameLoopImpl;
  private readonly agentManager: AgentManagerImpl;
  private readonly smartObjectRegistry: SmartObjectRegistryImpl;
  private readonly sceneManager: SceneManagerImpl;
  private readonly vectorStore: VectorStore;
  private readonly mutationService: SceneMutationServiceImpl | undefined;

  constructor(options: EnginePersistenceOptions) {
    this.gameLoop = options.gameLoop;
    this.agentManager = options.agentManager;
    this.smartObjectRegistry = options.smartObjectRegistry;
    this.sceneManager = options.sceneManager;
    this.vectorStore = options.vectorStore;
    this.mutationService = options.mutationService;
  }

  /** Serialize the full game state to a `SaveState` object (spec 017, Req 14). */
  async save(): Promise<SaveState> {
    const tick = this.gameLoop.currentTick();

    // Agents — profile + state for each active agent.
    const agents: AgentSnapshot[] = [];
    for (const agent of this.agentManager.getActiveAgents()) {
      const profile = this.agentManager.getProfile(agent.agentId);
      if (profile === null) continue; // defensive: skip agents without a profile
      agents.push({ profile, state: agent });
    }

    // World — rooms + objects (with current runtime state).
    const world: WorldSnapshot = {
      rooms: this.sceneManager.getAllRooms(),
      objects: this.smartObjectRegistry.getAllObjects(),
    };

    // Memories — all nodes, embeddings preserved as-is.
    const memories = await this.vectorStore.exportAll();

    const state: SaveState = {
      formatVersion: SAVE_FORMAT_VERSION,
      savedAt: Date.now(),
      gameLoop: {
        tickNumber: tick.tickNumber,
        simulationTime: tick.simulationTime,
        deltaSeconds: tick.deltaSeconds,
      },
      agents,
      world,
      memories,
    };

    // Dynamic world (spec 030, Req 11): mutation log + dormant agents. Only
    // included when the world actually mutated — static scenes produce
    // byte-identical saves (spec 030, AC-11).
    if (this.mutationService?.hasDynamicState()) {
      state.dynamic = {
        mutationLog: this.mutationService.exportLog(),
        dormantAgents: Object.values(this.mutationService.exportDormant()),
      };
    }

    return state;
  }

  /** Restore the full game state from a `SaveState` (spec 017, Req 14, Req 28). */
  async load(state: SaveState): Promise<void> {
    // Spec 030, Req 11: the format version was bumped (1 → 2) for the
    // optional `dynamic` field. Old (v1) saves still load — absence of
    // dynamic data is equivalent to zero mutations replayed.
    if (
      state.formatVersion !== SAVE_FORMAT_VERSION &&
      state.formatVersion !== MIN_SUPPORTED_SAVE_FORMAT_VERSION
    ) {
      throw new SaveFormatVersionError(SAVE_FORMAT_VERSION, state.formatVersion);
    }

    // Stop the loop if it is running. The caller decides whether to restart.
    this.gameLoop.stop();

    // Restore the deterministic loop state.
    this.gameLoop.restoreState(state.gameLoop.tickNumber, state.gameLoop.simulationTime);

    // Clear and rebuild agents. `load` is destructive — we must drop any
    // pre-existing agents first. AgentManagerImpl has no public "clear all", so
    // we despawn every currently-active agent before re-spawning from the save.
    for (const agent of this.agentManager.getActiveAgents()) {
      this.agentManager.despawn(agent.agentId);
    }
    for (const snapshot of state.agents) {
      this.agentManager.spawn(snapshot.profile);
      // Overwrite the spawn-initialized state with the saved state, and clear
      // any stale `isThinking` flag from the previous session (Req 28).
      this.agentManager.updateState(snapshot.profile.id, {
        ...snapshot.state,
        isThinking: false,
      });
    }

    // Clear and rebuild the world.
    const roomMap = new Map<string, (typeof state.world.rooms)[number]>();
    for (const room of state.world.rooms) {
      roomMap.set(room.id, room);
    }
    this.sceneManager.restoreRooms(roomMap);

    // Clear existing objects then register the saved ones — load is a full
    // snapshot replacement (spec 017, Req 21 / AC-46).
    this.smartObjectRegistry.clear();
    for (const object of state.world.objects) {
      this.smartObjectRegistry.register(object);
    }

    // Clear and rebuild memory. Embeddings are preserved as-is.
    await this.vectorStore.importAll(state.memories);

    // Dynamic world (spec 030, Req 11): restore the mutation log (for
    // event-sourcing continuity and the visualizer) and dormant agents. The
    // live world itself was restored above from the world snapshot — the
    // derived-snapshot approach, equivalent to rebuilding the base scene and
    // replaying the log.
    if (state.dynamic !== undefined) {
      const dormantMap: Record<string, import('@evol-hive/shared').DormantAgentSnapshot> = {};
      for (const snapshot of state.dynamic.dormantAgents) {
        dormantMap[snapshot.profile.id] = snapshot;
      }
      this.mutationService?.restoreDynamic(state.dynamic.mutationLog, dormantMap);
    }
  }

  /** Pretty-printed JSON serialization (spec 017, Req 14). */
  async saveToString(): Promise<string> {
    const state = await this.save();
    return JSON.stringify(state, null, 2);
  }

  /** Restore from a JSON string (spec 017, Req 14). `JSON.parse` errors propagate. */
  async loadFromString(json: string): Promise<void> {
    const state = JSON.parse(json) as SaveState;
    await this.load(state);
  }

  /** Write the save state to a file on disk (spec 017, Req 14). `fs` errors propagate. */
  async saveToFile(path: string): Promise<void> {
    const json = await this.saveToString();
    await fs.writeFile(path, json, 'utf8');
  }

  /** Restore from a file on disk (spec 017, Req 14). `fs` errors propagate. */
  async loadFromFile(path: string): Promise<void> {
    const content = await fs.readFile(path, 'utf8');
    await this.loadFromString(content);
  }
}

export {};
