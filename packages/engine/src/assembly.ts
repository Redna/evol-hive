/**
 * assembly/ — Engine assembly factory (spec 005, Req 7)
 * ────────────────────────────────────────────────────────────────────────────
 * Wires together all engine subsystems: AgentManager, DriveSystem, PlanManager,
 * SmartObjectRegistry, AffordanceRegistry, PhysicsSystem, SpatialSystem,
 * SceneManager, SystemFeedbackStore, and the four data-provider bridges
 * (Perception, Plan, Execute, Reflect). Registers `EngineSystem`s with the
 * `GameLoopImpl` in the order: (1) SpatialSystem, (2) DriveDecaySystem,
 * (3) PPERScheduler.
 *
 * The `engine` and `cognition` packages must not import from each other
 * (ADR-0001). The `PPEROrchestrator` is therefore received as a construction
 * parameter via the shared `PPEROrchestratorPort` interface. The entry point
 * builds the orchestrator from the engine's data-provider bridges (which are
 * returned by the factory) using the cognition-layer factory.
 */

import type {
  AutoSaveConfig,
  EngineConfig,
  MemoryDecayConfig,
  PPEROrchestratorPort,
  PPERSchedulerConfig,
  Room,
  SceneDefinition,
} from '@evol-hive/shared';
import { defaultPPERSchedulerConfig, defaultMemoryDecayConfig } from '@evol-hive/shared';
import type {
  MemoryStore,
  MemoryDecayService,
  ReflectionLoop,
  VectorStore,
} from '@evol-hive/memory';
import type { MemoryNode, MemoryEntryInput } from '@evol-hive/shared';
import { AgentManagerImpl } from './agents/state/index.js';
import { DriveSystemImpl } from './agents/drives/index.js';
import { PlanManagerImpl, PlanDataProviderImpl } from './agents/plans/index.js';
import { ExecuteDataProviderImpl } from './agents/execute/index.js';
import { ReflectDataProviderImpl } from './agents/reflect/index.js';
import { PerceptionDataProviderImpl } from './agents/perception/index.js';
import { SystemFeedbackStore } from './agents/feedback/index.js';
import { SmartObjectRegistryImpl } from './world/objects/index.js';
import { AffordanceRegistryImpl } from './world/affordances/index.js';
import { PhysicsSystemImpl } from './physics/index.js';
import { SpatialSystemImpl } from './spatial/index.js';
import { SceneManagerImpl } from './world/scenes/index.js';
import { GameLoopImpl } from './loop/index.js';
import { DriveDecaySystem } from './systems/drive-decay.js';
import { PPERScheduler } from './systems/pper-scheduler.js';
import { MemoryMaintenanceSystem } from './systems/memory-maintenance.js';
import { AutoSaveSystem } from './systems/auto-save.js';
import { EnginePersistenceImpl } from './persistence/engine-persistence.js';
import type { GameLoop } from './index.js';

/** A no-op MemoryStore used when no real memory subsystem is wired. */
class NullMemoryStore implements MemoryStore {
  async store(_agentId: string, _entry: MemoryEntryInput, _timestamp: number): Promise<MemoryNode> {
    return {
      id: `mem_null_${Date.now()}`,
      agentId: _agentId,
      content: _entry.content,
      embedding: [],
      timestamp: _timestamp,
      importance: _entry.importance,
      type: _entry.type,
    };
  }
  async get(_id: string): Promise<MemoryNode | null> {
    return null;
  }
}

/** A simulation clock that reads the game loop's latest simulationTime. */
class GameLoopClock {
  private loop: GameLoopImpl | null = null;
  bind(loop: GameLoopImpl): void {
    this.loop = loop;
  }
  get(): number {
    return this.loop ? this.loop.currentTick().simulationTime : 0;
  }
}

/** The built engine core: subsystems + bridges, before systems are registered. */
export interface EngineCore {
  gameLoop: GameLoopImpl;
  agentManager: AgentManagerImpl;
  driveSystem: DriveSystemImpl;
  planManager: PlanManagerImpl;
  smartObjectRegistry: SmartObjectRegistryImpl;
  affordanceRegistry: AffordanceRegistryImpl;
  physics: PhysicsSystemImpl;
  spatial: SpatialSystemImpl;
  sceneManager: SceneManagerImpl;
  feedbackStore: SystemFeedbackStore;
  bridges: {
    perception: PerceptionDataProviderImpl;
    plan: PlanDataProviderImpl;
    execute: ExecuteDataProviderImpl;
    reflect: ReflectDataProviderImpl;
  };
  clock: GameLoopClock;
  /** Optional memory decay service (spec 014, Req 18). */
  memoryDecayService?: MemoryDecayService;
  /** Optional reflection loop (spec 014, Req 18). */
  reflectionLoop?: ReflectionLoop;
  /** Optional memory decay config (spec 014, Req 18). */
  memoryMaintenanceConfig?: MemoryDecayConfig;
  /** Optional persistence (save/load) facade (spec 017, Req 17). Set when a `VectorStore` is provided. */
  persistence?: EnginePersistenceImpl;
  /** Optional auto-save config (spec 017, Req 17). */
  autoSaveConfig?: AutoSaveConfig;
}

/** Build all engine subsystems and bridges (no spec-mandated systems registered yet). */
export function createEngineCore(
  config: EngineConfig,
  memoryStore: MemoryStore = new NullMemoryStore(),
  vectorStore?: VectorStore,
): EngineCore {
  const agentManager = new AgentManagerImpl();
  const driveSystem = new DriveSystemImpl(agentManager);
  const clock = new GameLoopClock();
  const clockFn = (): number => clock.get();
  const planManager = new PlanManagerImpl(agentManager, clockFn);
  const smartObjectRegistry = new SmartObjectRegistryImpl();
  const affordanceRegistry = new AffordanceRegistryImpl(smartObjectRegistry);
  const physics = new PhysicsSystemImpl(smartObjectRegistry, affordanceRegistry);
  const spatial = new SpatialSystemImpl({
    agentManager,
    registry: smartObjectRegistry,
    spatialDebounceSeconds: config.spatialDebounceSeconds,
  });
  const sceneManager = new SceneManagerImpl(agentManager, new Map());
  const feedbackStore = new SystemFeedbackStore();

  const bridges = {
    perception: new PerceptionDataProviderImpl(
      agentManager,
      smartObjectRegistry,
      driveSystem,
      feedbackStore,
    ),
    plan: new PlanDataProviderImpl(agentManager, planManager),
    execute: new ExecuteDataProviderImpl({
      agentManager,
      planManager,
      driveSystem,
      smartRegistry: smartObjectRegistry,
      affordanceRegistry,
      physics,
      feedbackStore,
    }),
    reflect: new ReflectDataProviderImpl(
      agentManager,
      driveSystem,
      planManager,
      memoryStore,
      clockFn,
    ),
  };

  const gameLoop = new GameLoopImpl(config);
  clock.bind(gameLoop);

  // Persistence facade — only constructed when a VectorStore is available
  // (spec 017, Req 17). Without a VectorStore, save/load is unavailable.
  const persistence =
    vectorStore !== undefined
      ? new EnginePersistenceImpl({
          gameLoop,
          agentManager,
          smartObjectRegistry,
          sceneManager,
          vectorStore,
        })
      : undefined;

  return {
    gameLoop,
    agentManager,
    driveSystem,
    planManager,
    smartObjectRegistry,
    affordanceRegistry,
    physics,
    spatial,
    sceneManager,
    feedbackStore,
    bridges,
    clock: clock,
    ...(persistence !== undefined ? { persistence } : {}),
  };
}

/** Register the spec-mandated EngineSystems in order and return the loop. */
export function assembleGameLoop(
  core: EngineCore,
  orchestrator: PPEROrchestratorPort,
  memoryMaintenance?: {
    memoryDecayService: MemoryDecayService;
    reflectionLoop?: ReflectionLoop;
    decayConfig?: MemoryDecayConfig;
  },
  autoSave?: { config: AutoSaveConfig },
): GameLoop {
  const schedulerConfig: PPERSchedulerConfig = defaultPPERSchedulerConfig();
  core.gameLoop.registerSystem(core.spatial); // (1) SpatialSystem
  core.gameLoop.registerSystem(new DriveDecaySystem(core.agentManager, core.driveSystem)); // (2) DriveDecaySystem
  core.gameLoop.registerSystem(new PPERScheduler(core.agentManager, orchestrator, schedulerConfig)); // (3) PPERScheduler

  // (4) MemoryMaintenanceSystem — only when a decay service is provided (spec 014, Req 17/18).
  if (memoryMaintenance?.memoryDecayService) {
    const decayConfig = memoryMaintenance.decayConfig ?? defaultMemoryDecayConfig;
    core.gameLoop.registerSystem(
      new MemoryMaintenanceSystem({
        agentManager: core.agentManager,
        memoryDecayService: memoryMaintenance.memoryDecayService,
        ...(memoryMaintenance.reflectionLoop
          ? { reflectionLoop: memoryMaintenance.reflectionLoop }
          : {}),
        decayConfig,
      }),
    );
  }

  // (last) AutoSaveSystem — only when enabled AND a persistence facade exists
  // (spec 017, Req 18). When auto-save is enabled but persistence is missing,
  // log a warning and skip registration.
  if (autoSave?.config.enabled) {
    if (core.persistence) {
      core.gameLoop.registerSystem(
        new AutoSaveSystem({ persistence: core.persistence, config: autoSave.config }),
      );
    } else {
      console.warn(
        '[assembleGameLoop] auto-save is enabled but no VectorStore/persistence is available — auto-save will not run.',
      );
    }
  }
  return core.gameLoop;
}

/** The full engine assembly: subsystems + bridges + systems registered. */
export interface AssembledEngine {
  gameLoop: GameLoop;
  agentManager: AgentManagerImpl;
  sceneManager: SceneManagerImpl;
  smartObjectRegistry: SmartObjectRegistryImpl;
  affordanceRegistry: AffordanceRegistryImpl;
  bridges: EngineCore['bridges'];
  /** Optional persistence facade (spec 017, Req 19). Set when a `VectorStore` is provided. */
  persistence?: EnginePersistenceImpl;
}

/** Build the full engine (core + registered systems) in one call. */
export function createEngine(
  config: EngineConfig,
  orchestrator: PPEROrchestratorPort,
  memoryStore?: MemoryStore,
  vectorStore?: VectorStore,
): AssembledEngine {
  const core = createEngineCore(config, memoryStore, vectorStore);
  assembleGameLoop(core, orchestrator);
  return {
    gameLoop: core.gameLoop,
    agentManager: core.agentManager,
    sceneManager: core.sceneManager,
    smartObjectRegistry: core.smartObjectRegistry,
    affordanceRegistry: core.affordanceRegistry,
    bridges: core.bridges,
    ...(core.persistence !== undefined ? { persistence: core.persistence } : {}),
  };
}

/** Load a SceneDefinition into an engine core (rooms, objects, agents). */
export function loadScene(core: EngineCore, scene: SceneDefinition): void {
  // Rooms.
  const roomMap = new Map<string, Room>();
  for (const room of scene.rooms) {
    roomMap.set(room.id, room);
  }
  core.sceneManager = new SceneManagerImpl(core.agentManager, roomMap);

  // Objects.
  for (const object of scene.objects) {
    core.smartObjectRegistry.register(object);
  }

  // Agents — spawn at their startRoomId when present, else the first room (spec 013, Req 2).
  const defaultStartRoom = scene.rooms[0]?.id ?? '';
  for (const profile of scene.agents) {
    core.agentManager.spawn(profile);
    const startRoom = profile.startRoomId ?? defaultStartRoom;
    core.agentManager.updateState(profile.id, {
      location: startRoom,
      lastPerceptionTick: 0,
    });
  }
}

export {};
