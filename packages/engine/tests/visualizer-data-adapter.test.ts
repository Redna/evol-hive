/**
 * Spec 023 — Visual Output Canvas Renderer
 * VisualizerDataAdapter (AC-4, AC-5, AC-6).
 *
 * Uses real engine components (GameLoopImpl, AgentManagerImpl,
 * SmartObjectRegistryImpl, SceneManagerImpl) plus a mock orchestrator and mock
 * persistence to verify the adapter composes a correct VisualizerState and
 * dispatches commands.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  EngineConfig,
  PPEROrchestratorPort,
  PPERPhase,
  AgentProfile,
  Room,
  SmartObject,
  Affordance,
  SceneDefinition,
} from '@evol-hive/shared';
import { GameLoopImpl } from '../src/loop/index.js';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { VisualizerDataAdapter } from '../src/visualizer/data-adapter.js';
import type { EnginePersistence } from '../src/index.js';

function makeConfig(fps = 60): EngineConfig {
  return {
    fps,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
  };
}

function makeOrchestrator(phaseMap: Map<string, PPERPhase>): PPEROrchestratorPort {
  return {
    runCycle: async () => {},
    getPhase: (agentId: string) => phaseMap.get(agentId) ?? 'perceive',
  };
}

function makePersistence(): EnginePersistence & {
  saveToString: ReturnType<typeof vi.fn>;
  loadFromString: ReturnType<typeof vi.fn>;
} {
  return {
    save: vi.fn(async () => ({
      formatVersion: 1,
      savedAt: 0,
      gameLoop: { tickNumber: 0, simulationTime: 0, deltaSeconds: 0 },
      agents: [],
      world: { rooms: [], objects: [] },
      memories: [],
    })) as never,
    load: vi.fn(async () => {}) as never,
    saveToString: vi.fn(async () => '{"formatVersion":1}') as never,
    loadFromString: vi.fn(async () => {}) as never,
    saveToFile: vi.fn(async () => {}) as never,
    loadFromFile: vi.fn(async () => {}) as never,
  } as never;
}

const brew: Affordance = {
  id: 'brew_coffee',
  label: 'Brew coffee',
  engineEffect: 'brew_coffee',
  preconditions: [],
  effects: { energy: 20 },
};

const coffeeMachine: SmartObject = {
  id: 'coffee-1',
  name: 'Coffee Machine',
  type: 'appliance',
  state: { water_level: 5, bean_count: 12 },
  affordances: [brew],
  roomId: 'kitchen',
};

const kitchen: Room = {
  id: 'kitchen',
  name: 'Kitchen',
  description: 'A small kitchen.',
  connections: [],
  objectIds: ['coffee-1'],
};

const alice: AgentProfile = {
  id: 'agent-1',
  name: 'Alice',
  description: 'Sleepy agent.',
  traits: [],
  initialDrives: { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
};

const bob: AgentProfile = {
  id: 'agent-2',
  name: 'Bob',
  description: 'Hungry agent.',
  traits: [],
  initialDrives: { energy: 50, hunger: 10, social: 50, comfort: 50, curiosity: 50 },
  relationships: { 'agent-1': 'colleague' },
};

function setup() {
  const gameLoop = new GameLoopImpl(makeConfig(60));
  const agentManager = new AgentManagerImpl();
  const smartObjectRegistry = new SmartObjectRegistryImpl();
  const sceneManager = new SceneManagerImpl(agentManager, new Map());
  const orchestrator = makeOrchestrator(
    new Map([
      ['agent-1', 'plan'],
      ['agent-2', 'execute'],
    ]),
  );

  // Load a scene manually.
  smartObjectRegistry.register(coffeeMachine);
  const roomMap = new Map<string, Room>();
  roomMap.set(kitchen.id, kitchen);
  sceneManager.restoreRooms(roomMap);
  agentManager.spawn(alice);
  agentManager.updateState('agent-1', { location: 'kitchen', lastPerceptionTick: 0 });
  agentManager.spawn(bob);
  agentManager.updateState('agent-2', { location: 'kitchen', lastPerceptionTick: 0 });

  const profiles = new Map<string, AgentProfile>();
  profiles.set('agent-1', alice);
  profiles.set('agent-2', bob);

  return { gameLoop, agentManager, smartObjectRegistry, sceneManager, orchestrator, profiles };
}

describe('VisualizerDataAdapter.getSnapshot (AC-4)', () => {
  it('returns a VisualizerState with all rooms and agents', () => {
    const s = setup();
    const adapter = new VisualizerDataAdapter({
      gameLoop: s.gameLoop,
      agentManager: s.agentManager,
      smartObjectRegistry: s.smartObjectRegistry,
      sceneManager: s.sceneManager,
      orchestrator: s.orchestrator,
      agentProfiles: s.profiles,
    });

    const snap = adapter.getSnapshot();
    expect(snap.rooms).toHaveLength(1);
    expect(snap.rooms[0]!.id).toBe('kitchen');
    expect(snap.rooms[0]!.name).toBe('Kitchen');
    expect(snap.rooms[0]!.objects).toHaveLength(1);
    expect(snap.rooms[0]!.objects[0]!.name).toBe('Coffee Machine');
    expect(snap.rooms[0]!.objects[0]!.state['water_level']).toBe(5);
    expect(snap.agents).toHaveLength(2);
  });

  it('reports correct PPER phase per agent', () => {
    const s = setup();
    const adapter = new VisualizerDataAdapter({
      gameLoop: s.gameLoop,
      agentManager: s.agentManager,
      smartObjectRegistry: s.smartObjectRegistry,
      sceneManager: s.sceneManager,
      orchestrator: s.orchestrator,
      agentProfiles: s.profiles,
    });
    const snap = adapter.getSnapshot();
    const aliceAgent = snap.agents.find((a) => a.agentId === 'agent-1');
    const bobAgent = snap.agents.find((a) => a.agentId === 'agent-2');
    expect(aliceAgent?.pperPhase).toBe('plan');
    expect(bobAgent?.pperPhase).toBe('execute');
  });

  it('reports isRunning and timeScale from the game loop', () => {
    const s = setup();
    const adapter = new VisualizerDataAdapter({
      gameLoop: s.gameLoop,
      agentManager: s.agentManager,
      smartObjectRegistry: s.smartObjectRegistry,
      sceneManager: s.sceneManager,
      orchestrator: s.orchestrator,
      agentProfiles: s.profiles,
    });
    s.gameLoop.setTimeScale(5);
    let snap = adapter.getSnapshot();
    expect(snap.isRunning).toBe(false);
    expect(snap.timeScale).toBe(5);
    s.gameLoop.start();
    snap = adapter.getSnapshot();
    expect(snap.isRunning).toBe(true);
    s.gameLoop.stop();
  });

  it('includes agent names from agentProfiles', () => {
    const s = setup();
    const adapter = new VisualizerDataAdapter({
      gameLoop: s.gameLoop,
      agentManager: s.agentManager,
      smartObjectRegistry: s.smartObjectRegistry,
      sceneManager: s.sceneManager,
      orchestrator: s.orchestrator,
      agentProfiles: s.profiles,
    });
    const snap = adapter.getSnapshot();
    expect(snap.agents[0]!.name).toBe('Alice');
    expect(snap.agents[1]!.name).toBe('Bob');
  });

  it('includes relationship data for agents', () => {
    const s = setup();
    const adapter = new VisualizerDataAdapter({
      gameLoop: s.gameLoop,
      agentManager: s.agentManager,
      smartObjectRegistry: s.smartObjectRegistry,
      sceneManager: s.sceneManager,
      orchestrator: s.orchestrator,
      agentProfiles: s.profiles,
    });
    const snap = adapter.getSnapshot();
    const bobAgent = snap.agents.find((a) => a.agentId === 'agent-2');
    expect(bobAgent?.relationships).toHaveLength(1);
    expect(bobAgent?.relationships[0]!.agentId).toBe('agent-1');
  });

  it('snapshot is JSON-serializable', () => {
    const s = setup();
    const adapter = new VisualizerDataAdapter({
      gameLoop: s.gameLoop,
      agentManager: s.agentManager,
      smartObjectRegistry: s.smartObjectRegistry,
      sceneManager: s.sceneManager,
      orchestrator: s.orchestrator,
      agentProfiles: s.profiles,
    });
    const snap = adapter.getSnapshot();
    expect(() => JSON.stringify(snap)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(snap));
    expect(parsed.rooms).toHaveLength(1);
  });
});

describe('VisualizerDataAdapter.handleCommand — play/pause/speed (AC-5)', () => {
  it('play calls gameLoop.start', async () => {
    const s = setup();
    const startSpy = vi.spyOn(s.gameLoop, 'start');
    const adapter = new VisualizerDataAdapter({
      gameLoop: s.gameLoop,
      agentManager: s.agentManager,
      smartObjectRegistry: s.smartObjectRegistry,
      sceneManager: s.sceneManager,
      orchestrator: s.orchestrator,
      agentProfiles: s.profiles,
    });
    await adapter.handleCommand({ type: 'play' });
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('pause calls gameLoop.stop', async () => {
    const s = setup();
    const stopSpy = vi.spyOn(s.gameLoop, 'stop');
    const adapter = new VisualizerDataAdapter({
      gameLoop: s.gameLoop,
      agentManager: s.agentManager,
      smartObjectRegistry: s.smartObjectRegistry,
      sceneManager: s.sceneManager,
      orchestrator: s.orchestrator,
      agentProfiles: s.profiles,
    });
    await adapter.handleCommand({ type: 'pause' });
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('setSpeed calls gameLoop.setTimeScale', async () => {
    const s = setup();
    const setSpy = vi.spyOn(s.gameLoop, 'setTimeScale');
    const adapter = new VisualizerDataAdapter({
      gameLoop: s.gameLoop,
      agentManager: s.agentManager,
      smartObjectRegistry: s.smartObjectRegistry,
      sceneManager: s.sceneManager,
      orchestrator: s.orchestrator,
      agentProfiles: s.profiles,
    });
    await adapter.handleCommand({ type: 'setSpeed', timeScale: 5 });
    expect(setSpy).toHaveBeenCalledWith(5);
  });
});

describe('VisualizerDataAdapter.handleCommand — save/load (AC-6)', () => {
  it('save calls persistence.saveToString', async () => {
    const s = setup();
    const persistence = makePersistence();
    const adapter = new VisualizerDataAdapter({
      gameLoop: s.gameLoop,
      agentManager: s.agentManager,
      smartObjectRegistry: s.smartObjectRegistry,
      sceneManager: s.sceneManager,
      orchestrator: s.orchestrator,
      agentProfiles: s.profiles,
      persistence,
    });
    await adapter.handleCommand({ type: 'save' });
    expect(persistence.saveToString).toHaveBeenCalledTimes(1);
  });

  it('load calls persistence.loadFromString with the provided json', async () => {
    const s = setup();
    const persistence = makePersistence();
    const adapter = new VisualizerDataAdapter({
      gameLoop: s.gameLoop,
      agentManager: s.agentManager,
      smartObjectRegistry: s.smartObjectRegistry,
      sceneManager: s.sceneManager,
      orchestrator: s.orchestrator,
      agentProfiles: s.profiles,
      persistence,
    });
    await adapter.handleCommand({ type: 'load', stateJson: '{"x":1}' });
    expect(persistence.loadFromString).toHaveBeenCalledWith('{"x":1}');
  });

  it('save/load without persistence do not throw', async () => {
    const s = setup();
    const adapter = new VisualizerDataAdapter({
      gameLoop: s.gameLoop,
      agentManager: s.agentManager,
      smartObjectRegistry: s.smartObjectRegistry,
      sceneManager: s.sceneManager,
      orchestrator: s.orchestrator,
      agentProfiles: s.profiles,
    });
    await expect(adapter.handleCommand({ type: 'save' })).resolves.toBeUndefined();
    await expect(adapter.handleCommand({ type: 'load', stateJson: '{}' })).resolves.toBeUndefined();
  });
});

describe('VisualizerDataAdapter.handleCommand — selectScene', () => {
  const newScene: SceneDefinition = {
    id: 'other',
    name: 'Other Scene',
    rooms: [
      {
        id: 'bedroom',
        name: 'Bedroom',
        description: 'A bedroom.',
        connections: [],
        objectIds: [],
      },
    ],
    objects: [],
    agents: [
      {
        id: 'agent-3',
        name: 'Carol',
        description: 'New agent.',
        traits: [],
        initialDrives: { energy: 80, hunger: 80, social: 80, comfort: 80, curiosity: 80 },
      },
    ],
  };

  it('selectScene reloads the resolved scene into the engine', async () => {
    const s = setup();
    const scenes = new Map<string, SceneDefinition>();
    scenes.set('other', newScene);
    const adapter = new VisualizerDataAdapter({
      gameLoop: s.gameLoop,
      agentManager: s.agentManager,
      smartObjectRegistry: s.smartObjectRegistry,
      sceneManager: s.sceneManager,
      orchestrator: s.orchestrator,
      agentProfiles: s.profiles,
      scenes,
    });
    await adapter.handleCommand({ type: 'selectScene', sceneId: 'other' });
    // After reload, the snapshot should reflect the new scene.
    const snap = adapter.getSnapshot();
    expect(snap.rooms[0]!.id).toBe('bedroom');
    expect(snap.agents[0]!.name).toBe('Carol');
  });
});
