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
  EngineConfig,
  MemoryDecayConfig,
  AutoSaveConfig,
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
import { ObjectStateSystem } from './systems/object-state.js';
import { AutoSaveSystem } from './systems/auto-save.js';
import { EnginePersistenceImpl } from './persistence/index.js';
import { SocialManager } from './social/social-manager.js';
import {
  SceneMutationServiceImpl,
  SceneMutationSystem,
  DormantAgentStore,
  YaamEventLog,
} from './world/mutations/index.js';
import type { GameLoop, EnginePersistence } from './index.js';

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
  /** Optional persistence implementation (spec 017, Req 17). Set when a VectorStore is provided. */
  persistence?: EnginePersistenceImpl;
  /** Optional auto-save configuration (spec 017, Req 17). */
  autoSaveConfig?: AutoSaveConfig;
  /** Social manager — always created (spec 019, Req 3). */
  socialManager: SocialManager;
  /**
   * Optional per-scene PPER scheduler config override (spec 022, Req 1, AC-1).
   * Populated by {@link loadScene} from `SceneDefinition.maxConcurrentCycles`
   * when present. Consumed by {@link assembleGameLoop} unless an explicit
   * `schedulerConfig` argument is passed.
   */
  sceneSchedulerConfig?: PPERSchedulerConfig;
  /**
   * The `PPERScheduler` instance constructed by {@link assembleGameLoop}
   * (spec 022, AC-1). `undefined` until the scheduler system is registered.
   */
  scheduler?: import('./systems/pper-scheduler.js').PPERScheduler;
  /** Runtime scene mutation funnel (spec 030, Req 1). Always created. */
  mutationService: SceneMutationServiceImpl;
  /** Dormant-agent store backing despawn/respawn (spec 030, Req 7/8). Always created. */
  dormantStore: DormantAgentStore;
  /** YAAM event log for agent-scoped persistence (spec 030, Req 12). Always created. */
  yaamEventLog: YaamEventLog;
}

/** Build all engine subsystems and bridges (no spec-mandated systems registered yet). */
export function createEngineCore(
  config: EngineConfig,
  memoryStore: MemoryStore = new NullMemoryStore(),
  vectorStore?: VectorStore,
): EngineCore {
  const agentManager = new AgentManagerImpl();
  const driveSystem = new DriveSystemImpl(agentManager, config.driveDecayRate ?? 0.1);
  const clock = new GameLoopClock();
  const clockFn = (): number => clock.get();
  const planManager = new PlanManagerImpl(agentManager, clockFn);
  const smartObjectRegistry = new SmartObjectRegistryImpl();
  const affordanceRegistry = new AffordanceRegistryImpl(smartObjectRegistry);
  // Execute-time co-location guard (spec 031, Req 1): the resolver reads the
  // LIVE agent state at execution time — never a cached or perception-time
  // location, which is exactly what goes stale under dynamic scenes (spec 030).
  const physics = new PhysicsSystemImpl(
    smartObjectRegistry,
    affordanceRegistry,
    (agentId) => agentManager.getState(agentId)?.location,
  );
  const spatial = new SpatialSystemImpl({
    agentManager,
    registry: smartObjectRegistry,
    spatialDebounceSeconds: config.spatialDebounceSeconds,
  });
  const sceneManager = new SceneManagerImpl(agentManager, new Map());
  const feedbackStore = new SystemFeedbackStore();

  // SocialManager (spec 019, Req 1) — always created; depends only on AgentManager.
  const socialManager = new SocialManager(agentManager);

  // Dynamic world (spec 030, Req 1): the single mutation funnel + dormancy.
  const dormantStore = new DormantAgentStore();
  const yaamEventLog = new YaamEventLog();
  const mutationService = new SceneMutationServiceImpl({
    registry: smartObjectRegistry,
    sceneManager,
    agentManager,
    dormantStore,
    yaamLog: yaamEventLog,
  });

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

  // Wire the SocialManager into the perception provider (spec 019, Req 2) so
  // getAgentsInRoom / dequeueSocialMessages / getRelationships delegate to it.
  bridges.perception.setSocialManager(socialManager);

  const gameLoop = new GameLoopImpl(config);
  clock.bind(gameLoop);

  // Persistence (spec 017, Req 17) — constructed when a VectorStore is provided.
  const persistence =
    vectorStore !== undefined
      ? new EnginePersistenceImpl({
          gameLoop,
          agentManager,
          smartObjectRegistry,
          sceneManager,
          vectorStore,
          mutationService,
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
    socialManager,
    mutationService,
    dormantStore,
    yaamEventLog,
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
  autoSave?: {
    config: AutoSaveConfig;
  },
  /**
   * Optional PPER scheduler config override (spec 022, Req 2, AC-2). When
   * provided, this takes precedence over any per-scene config stored on
   * `core` (via {@link loadScene}) and the env-var default.
   */
  schedulerConfig?: PPERSchedulerConfig,
): GameLoop {
  // Precedence (spec 022, Req 2/4): explicit arg > scene-level config > default.
  const resolvedSchedulerConfig: PPERSchedulerConfig =
    schedulerConfig ?? core.sceneSchedulerConfig ?? defaultPPERSchedulerConfig();
  // (0) SceneMutations — FIRST, so queued mutations land at the tick boundary
  // before any other system observes the world (spec 030, Req 1).
  core.gameLoop.registerSystem(new SceneMutationSystem(core.mutationService));
  core.gameLoop.registerSystem(core.spatial); // (1) SpatialSystem
  core.gameLoop.registerSystem(new DriveDecaySystem(core.agentManager, core.driveSystem)); // (2) DriveDecaySystem
  core.gameLoop.registerSystem(new ObjectStateSystem(core.smartObjectRegistry)); // (3) ObjectStateSystem (spec 018)
  const scheduler = new PPERScheduler(core.agentManager, orchestrator, resolvedSchedulerConfig); // (4) PPERScheduler
  core.scheduler = scheduler;
  core.gameLoop.registerSystem(scheduler);

  // (5) MemoryMaintenanceSystem — only when a decay service is provided (spec 014, Req 17/18).
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

  // (6) AutoSaveSystem — last priority, only when enabled and persistence is available (spec 017, Req 18).
  if (autoSave?.config.enabled) {
    if (core.persistence) {
      core.gameLoop.registerSystem(
        new AutoSaveSystem({ persistence: core.persistence, config: autoSave.config }),
      );
    } else {
      console.warn(
        '[assembleGameLoop] auto-save enabled but no persistence (VectorStore) available — auto-save not registered.',
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
  /** Optional persistence (spec 017, Req 19). */
  persistence?: EnginePersistence;
  /** Social manager (spec 019, Req 5). */
  socialManager: SocialManager;
  /** Runtime scene mutation funnel (spec 030, Req 1). */
  mutationService: SceneMutationServiceImpl;
  /** Dormant-agent store (spec 030, Req 7/8). */
  dormantStore: DormantAgentStore;
  /** YAAM event log (spec 030, Req 12). */
  yaamEventLog: YaamEventLog;
  /** The PPER scheduler (spec 022, AC-1/AC-2). */
  scheduler?: import('./systems/pper-scheduler.js').PPERScheduler;
}

/** Build the full engine (core + registered systems) in one call. */
export function createEngine(
  config: EngineConfig,
  orchestrator: PPEROrchestratorPort,
  memoryStore?: MemoryStore,
  vectorStore?: VectorStore,
  /**
   * Optional PPER scheduler config override (spec 022, Req 3, AC-2). When
   * provided, forwarded to {@link assembleGameLoop}. When omitted, the
   * per-scene config (if any) or the env-var default is used.
   */
  schedulerConfig?: PPERSchedulerConfig,
): AssembledEngine {
  const core = createEngineCore(config, memoryStore, vectorStore);
  assembleGameLoop(core, orchestrator, undefined, undefined, schedulerConfig);
  return {
    gameLoop: core.gameLoop,
    agentManager: core.agentManager,
    sceneManager: core.sceneManager,
    smartObjectRegistry: core.smartObjectRegistry,
    affordanceRegistry: core.affordanceRegistry,
    bridges: core.bridges,
    ...(core.persistence !== undefined ? { persistence: core.persistence } : {}),
    socialManager: core.socialManager,
    ...(core.scheduler !== undefined ? { scheduler: core.scheduler } : {}),
    mutationService: core.mutationService,
    dormantStore: core.dormantStore,
    yaamEventLog: core.yaamEventLog,
  };
}

/** Load a SceneDefinition into an engine core (rooms, objects, agents). */
export function loadScene(core: EngineCore, scene: SceneDefinition): void {
  // Per-scene PPER scheduler concurrency override (spec 022, Req 1, AC-1).
  if (scene.maxConcurrentCycles !== undefined) {
    core.sceneSchedulerConfig = { maxConcurrentCycles: scene.maxConcurrentCycles };
  }

  // Rooms — deep-copied so runtime mutations (spec 030) never touch the
  // authoring artifact: SceneDefinition objects are immutable.
  const roomMap = new Map<string, Room>();
  for (const room of scene.rooms) {
    roomMap.set(room.id, {
      ...room,
      connections: [...room.connections],
      objectIds: [...room.objectIds],
    });
  }
  core.sceneManager = new SceneManagerImpl(core.agentManager, roomMap);
  // Rebind the mutation funnel to the fresh scene manager (spec 030, Req 1) —
  // the service must operate on the rooms the engine actually uses.
  core.mutationService.setSceneManager(core.sceneManager);

  // Objects — deep-copied for the same reason: runtime room moves and state
  // patches must not leak into the SceneDefinition (spec 030 constraint).
  for (const object of scene.objects) {
    core.smartObjectRegistry.register({
      ...object,
      state: { ...object.state },
      affordances: object.affordances.map((a) => ({ ...a })),
      ...(object.compoundActions
        ? {
            compoundActions: object.compoundActions.map((ca) => ({
              ...ca,
              steps: ca.steps.map((s) => ({ ...s })),
            })),
          }
        : {}),
    });
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
