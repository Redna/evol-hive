/**
 * persistence/ — Engine save/load implementation (spec 017, Req 14)
 * ─────────────────────────────────────────────────────────────────────────────
 * Composes each subsystem's export/import methods into a single `SaveState`
 * object and restores it on load. File I/O is a thin wrapper over Node.js
 * `fs/promises`. No new dependencies.
 *
 * Imports from `@evol-hive/shared` (types) and `@evol-hive/memory` (VectorStore)
 * only — never from `@evol-hive/cognition` (per ADR-0001, Req 20).
 */

import { promises as fs } from 'node:fs';
import type { SaveState, GameLoopSnapshot, AgentSnapshot, WorldSnapshot } from '@evol-hive/shared';
import { SAVE_FORMAT_VERSION, SaveFormatVersionError } from '@evol-hive/shared';
import type { VectorStore } from '@evol-hive/memory';
import type { GameLoopImpl } from '../loop/index.js';
import type { AgentManagerImpl } from '../agents/state/index.js';
import type { SmartObjectRegistryImpl } from '../world/objects/index.js';
import type { SceneManagerImpl } from '../world/scenes/index.js';
import type { EnginePersistence } from '../index.js';

/** Constructor options for {@link EnginePersistenceImpl}. */
export interface EnginePersistenceOptions {
  gameLoop: GameLoopImpl;
  agentManager: AgentManagerImpl;
  smartObjectRegistry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  vectorStore: VectorStore;
}

/**
 * Concrete save/load implementation. Serializes the full game state to a
 * `SaveState` object (structured), a JSON string, or a file on disk, and
 * restores it on load. All methods are `async` because `VectorStore` methods
 * are async.
 */
export class EnginePersistenceImpl implements EnginePersistence {
  private readonly gameLoop: GameLoopImpl;
  private readonly agentManager: AgentManagerImpl;
  private readonly smartObjectRegistry: SmartObjectRegistryImpl;
  private readonly sceneManager: SceneManagerImpl;
  private readonly vectorStore: VectorStore;

  constructor(options: EnginePersistenceOptions) {
    this.gameLoop = options.gameLoop;
    this.agentManager = options.agentManager;
    this.smartObjectRegistry = options.smartObjectRegistry;
    this.sceneManager = options.sceneManager;
    this.vectorStore = options.vectorStore;
  }

  /** Serialize the full game state to a `SaveState` object. */
  async save(): Promise<SaveState> {
    // Game loop snapshot.
    const tick = this.gameLoop.currentTick();
    const gameLoop: GameLoopSnapshot = {
      tickNumber: tick.tickNumber,
      simulationTime: tick.simulationTime,
      deltaSeconds: tick.deltaSeconds,
    };

    // Agents — each snapshot bundles profile + state.
    const agents: AgentSnapshot[] = [];
    for (const agent of this.agentManager.getActiveAgents()) {
      const profile = this.agentManager.getProfile(agent.agentId);
      if (profile === null) continue; // defensive — skip agents without a profile
      agents.push({ profile, state: agent });
    }

    // World snapshot.
    const world: WorldSnapshot = {
      rooms: this.sceneManager.getAllRooms(),
      objects: this.smartObjectRegistry.getAllObjects(),
    };

    // Memories.
    const memories = await this.vectorStore.exportAll();

    return {
      formatVersion: SAVE_FORMAT_VERSION,
      savedAt: Date.now(),
      gameLoop,
      agents,
      world,
      memories,
    };
  }

  /** Restore the full game state from a `SaveState` object (destructive). */
  async load(state: SaveState): Promise<void> {
    // Version check — fatal, no partial loading.
    if (state.formatVersion !== SAVE_FORMAT_VERSION) {
      throw new SaveFormatVersionError(SAVE_FORMAT_VERSION, state.formatVersion);
    }

    // Stop the game loop (caller decides whether to restart).
    this.gameLoop.stop();

    // Restore game loop state (tickNumber + simulationTime).
    this.gameLoop.restoreState(state.gameLoop.tickNumber, state.gameLoop.simulationTime);

    // Clear and rebuild agents. isThinking is forced to false (Req 28).
    this.agentManager.clear();
    for (const snapshot of state.agents) {
      this.agentManager.spawn(snapshot.profile);
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
    this.smartObjectRegistry.clear();
    for (const object of state.world.objects) {
      this.smartObjectRegistry.register(object);
    }

    // Clear and rebuild memory (embeddings preserved as-is).
    await this.vectorStore.importAll(state.memories);
  }

  /** Serialize the full game state to a pretty-printed JSON string. */
  async saveToString(): Promise<string> {
    const state = await this.save();
    return JSON.stringify(state, null, 2);
  }

  /** Restore the full game state from a JSON string. */
  async loadFromString(json: string): Promise<void> {
    const state = JSON.parse(json) as SaveState;
    await this.load(state);
  }

  /** Serialize the full game state to a file on disk. */
  async saveToFile(path: string): Promise<void> {
    const json = await this.saveToString();
    await fs.writeFile(path, json, 'utf8');
  }

  /** Restore the full game state from a file on disk. */
  async loadFromFile(path: string): Promise<void> {
    const content = await fs.readFile(path, 'utf8');
    await this.loadFromString(content);
  }
}

export {};
