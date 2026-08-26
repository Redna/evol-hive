/**
 * visualizer/ — Engine-side adapter that composes a VisualizerState snapshot
 * ────────────────────────────────────────────────────────────────────────────
 * Spec 023, Req 8. Implements `VisualizerInterface` (defined in `shared`) by
 * composing the existing engine query surfaces (`GameLoopImpl`,
 * `AgentManagerImpl`, `SmartObjectRegistryImpl`, `SceneManagerImpl`,
 * `PPEROrchestratorPort`) into a single serializable `VisualizerState`. The
 * adapter also dispatches `VisualizerCommand`s to the appropriate engine
 * methods (play/pause/speed/save/load/selectScene).
 *
 * Package boundaries (per ADR-0001): imports only from `@evol-hive/shared`
 * (types) and its own internal subsystems. It never imports from the
 * visualizer package — the visualizer package imports `shared`, the engine
 * adapter imports `shared`, preserving the acyclic graph.
 */

import type {
  VisualizerState,
  VisualizerRoom,
  VisualizerObject,
  VisualizerAgent,
  VisualizerCommand,
  VisualizerInterface,
  AgentDrives,
  AgentProfile,
  SceneDefinition,
  PPEROrchestratorPort,
} from '@evol-hive/shared';
import type { GameLoopImpl } from '../loop/index.js';
import type { AgentManagerImpl } from '../agents/state/index.js';
import type { SmartObjectRegistryImpl } from '../world/objects/index.js';
import type { SceneManagerImpl } from '../world/scenes/index.js';
import type { EnginePersistence } from '../index.js';

/** Constructor dependencies for {@link VisualizerDataAdapter} (spec 023, Req 8). */
export interface VisualizerDataAdapterOptions {
  gameLoop: GameLoopImpl;
  agentManager: AgentManagerImpl;
  smartObjectRegistry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  orchestrator: PPEROrchestratorPort;
  /** Optional persistence interface (spec 017) for save/load commands. */
  persistence?: EnginePersistence;
  /** Agent profiles keyed by agent ID (for name lookup). Falls back to `agentManager.getProfile()`. */
  agentProfiles?: Map<string, AgentProfile>;
  /** Built-in scenes available for the `selectScene` command. */
  scenes?: Map<string, SceneDefinition>;
}

/**
 * Composes existing engine query surfaces into a single `VisualizerState`
 * snapshot and dispatches `VisualizerCommand`s to the engine. The engine
 * package itself is not modified to depend on the visualizer — this adapter
 * is a thin read-only composition layer (spec 023, Req 8).
 */
export class VisualizerDataAdapter implements VisualizerInterface {
  private readonly gameLoop: GameLoopImpl;
  private readonly agentManager: AgentManagerImpl;
  private readonly smartObjectRegistry: SmartObjectRegistryImpl;
  private readonly sceneManager: SceneManagerImpl;
  private readonly orchestrator: PPEROrchestratorPort;
  private readonly persistence: EnginePersistence | undefined;
  private readonly agentProfiles: Map<string, AgentProfile> | undefined;
  private readonly scenes: Map<string, SceneDefinition> | undefined;

  constructor(options: VisualizerDataAdapterOptions) {
    this.gameLoop = options.gameLoop;
    this.agentManager = options.agentManager;
    this.smartObjectRegistry = options.smartObjectRegistry;
    this.sceneManager = options.sceneManager;
    this.orchestrator = options.orchestrator;
    this.persistence = options.persistence;
    this.agentProfiles = options.agentProfiles;
    this.scenes = options.scenes;
  }

  /** Compose a full `VisualizerState` snapshot from the engine (spec 023, Req 8). */
  getSnapshot(): VisualizerState {
    const tick = this.gameLoop.currentTick();

    // Rooms — flatten each room with its full object list.
    const rooms: VisualizerRoom[] = this.sceneManager.getAllRooms().map((room) => {
      const objects: VisualizerObject[] = this.smartObjectRegistry
        .getByRoom(room.id)
        .map((obj) => ({
          id: obj.id,
          name: obj.name,
          type: obj.type,
          state: obj.state,
          affordances: obj.affordances.map((a) => ({ id: a.id, label: a.label })),
          ...(obj.compoundActions
            ? {
                compoundActions: obj.compoundActions.map((ca) => ({
                  id: ca.id,
                  label: ca.label,
                  stepCount: ca.steps.length,
                })),
              }
            : {}),
        }));

      return {
        id: room.id,
        name: room.name,
        description: room.description,
        connections: room.connections,
        objects,
      };
    });

    // Agents — map each active agent to a VisualizerAgent.
    const agents: VisualizerAgent[] = this.agentManager.getActiveAgents().map((state) => {
      const name = this.resolveName(state.agentId);
      const drives: AgentDrives = { ...state.drives };
      const currentPlan =
        state.currentPlan !== null
          ? {
              description: state.currentPlan.description,
              currentStepIndex: state.currentPlan.currentStepIndex,
              totalSteps: state.currentPlan.steps.length,
            }
          : null;

      const relationships = state.relationships
        ? Object.entries(state.relationships).map(([agentId, rel]) => ({
            agentId,
            trust: rel.trust,
            familiarity: rel.familiarity,
          }))
        : [];

      return {
        agentId: state.agentId,
        name,
        location: state.location,
        drives,
        currentGoal: state.currentGoal,
        currentPlan,
        pperPhase: this.orchestrator.getPhase(state.agentId),
        isThinking: state.isThinking,
        relationships,
      };
    });

    return {
      tickNumber: tick.tickNumber,
      simulationTime: tick.simulationTime,
      isRunning: this.gameLoop.isRunning(),
      timeScale: this.gameLoop.getTimeScale(),
      rooms,
      agents,
    };
  }

  /** Dispatch a `VisualizerCommand` to the appropriate engine method (spec 023, Req 8). */
  async handleCommand(command: VisualizerCommand): Promise<void> {
    switch (command.type) {
      case 'play':
        this.gameLoop.start();
        return;
      case 'pause':
        this.gameLoop.stop();
        return;
      case 'setSpeed':
        this.gameLoop.setTimeScale(command.timeScale);
        return;
      case 'save':
        await this.persistence?.saveToString();
        return;
      case 'load':
        await this.persistence?.loadFromString(command.stateJson);
        return;
      case 'selectScene':
        this.reloadScene(command.sceneId);
        return;
    }
  }

  /** Resolve an agent's display name from the profiles map or the agent manager. */
  private resolveName(agentId: string): string {
    const fromMap = this.agentProfiles?.get(agentId);
    if (fromMap) return fromMap.name;
    const fromManager = this.agentManager.getProfile(agentId);
    return fromManager?.name ?? agentId;
  }

  /**
   * Reload a scene into the existing engine core (spec 023, Req 8). Stops the
   * loop, clears all agents and objects, restores rooms, registers objects,
   * spawns agents at their start rooms, and restarts the loop. This mirrors
   * the `loadScene` factory flow without requiring a fresh `EngineCore`.
   */
  private reloadScene(sceneId: string): void {
    const scene = this.scenes?.get(sceneId);
    if (!scene) {
      console.warn(`[VisualizerDataAdapter] selectScene: unknown sceneId "${sceneId}"`);
      return;
    }

    this.gameLoop.stop();

    // Clear existing agents and objects.
    for (const agent of this.agentManager.getActiveAgents()) {
      this.agentManager.despawn(agent.agentId);
    }
    this.smartObjectRegistry.clear();

    // Restore rooms.
    const roomMap = new Map<string, (typeof scene.rooms)[number]>();
    for (const room of scene.rooms) {
      roomMap.set(room.id, room);
    }
    this.sceneManager.restoreRooms(roomMap);

    // Register objects.
    for (const object of scene.objects) {
      this.smartObjectRegistry.register(object);
    }

    // Spawn agents at their start rooms (or the first room as default).
    const defaultStartRoom = scene.rooms[0]?.id ?? '';
    for (const profile of scene.agents) {
      this.agentManager.spawn(profile);
      const startRoom = profile.startRoomId ?? defaultStartRoom;
      this.agentManager.updateState(profile.id, {
        location: startRoom,
        lastPerceptionTick: 0,
      });
    }
  }
}
