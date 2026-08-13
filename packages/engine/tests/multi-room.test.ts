/**
 * Multi-room integration tests (spec 008, AC-6 through AC-10).
 *
 * Covers:
 *  - AC-6: Agent navigation between connected rooms
 *  - AC-7: Room-scoped object visibility
 *  - AC-8: Room-scoped affordance queries
 *  - AC-9: Multi-room SceneDefinition loading
 *  - AC-10: Spatial debounce on room boundary crossing via game-loop tick
 */
import { describe, it, expect } from 'vitest';
import type {
  Room,
  SmartObject,
  Affordance,
  AgentProfile,
  SceneDefinition,
  EngineConfig,
} from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { PerceptionDataProviderImpl } from '../src/agents/perception/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { SystemFeedbackStore } from '../src/agents/feedback/index.js';
import { createEngineCore, assembleGameLoop, loadScene } from '../src/assembly.js';
import type { PPEROrchestratorPort, PPERPhase } from '@evol-hive/shared';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return { fps: 60, spatialDebounceSeconds: 5, maxConcurrentLLM: 8, guardrailsEnabled: true };
}

function makeAgent(id: string): AgentProfile {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

/** A no-op orchestrator for assembling the game loop. */
class NoopOrchestrator implements PPEROrchestratorPort {
  async runCycle(agentId: string): Promise<void> {
    void agentId;
  }
  getPhase(agentId: string): PPERPhase {
    void agentId;
    return 'perceive';
  }
}

// ── Scene fixtures ───────────────────────────────────────────────────────────

const brewCoffee: Affordance = {
  id: 'brew_coffee',
  label: 'Brew coffee',
  engineEffect: 'brew_coffee',
  preconditions: [],
  effects: { energy: 20 },
};

const observe: Affordance = {
  id: 'observe',
  label: 'Observe',
  engineEffect: 'observe',
  preconditions: [],
  effects: {},
};

const sit: Affordance = {
  id: 'sit',
  label: 'Sit',
  engineEffect: 'sit',
  preconditions: [],
  effects: { comfort: 10 },
};

const kitchen: Room = {
  id: 'kitchen',
  name: 'Kitchen',
  description: 'A small kitchen',
  connections: ['lounge'],
  objectIds: ['coffee-1'],
};

const lounge: Room = {
  id: 'lounge',
  name: 'Lounge',
  description: 'A cozy lounge',
  connections: ['kitchen'],
  objectIds: ['sofa-1'],
};

const coffeeMachine: SmartObject = {
  id: 'coffee-1',
  name: 'Coffee Machine',
  type: 'appliance',
  state: { water_level: 5, bean_count: 12 },
  affordances: [brewCoffee, observe],
  roomId: 'kitchen',
};

const sofa: SmartObject = {
  id: 'sofa-1',
  name: 'Sofa',
  type: 'furniture',
  state: { cushion_wear: 0 },
  affordances: [sit, observe],
  roomId: 'lounge',
};

// ── AC-6: Agent navigation ───────────────────────────────────────────────────

describe('Multi-room — AC-6: agent navigation between connected rooms', () => {
  it('moveAgent updates agent location and getAgentRoom returns the new room', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.updateState('a1', { location: 'kitchen' });
    const scene = new SceneManagerImpl(
      agents,
      new Map<string, Room>([
        ['kitchen', kitchen],
        ['lounge', lounge],
      ]),
    );

    scene.moveAgent('a1', 'lounge');

    expect(agents.getState('a1')?.location).toBe('lounge');
    expect(scene.getAgentRoom('a1')).toEqual(lounge);
  });
});

// ── AC-7: Room-scoped object visibility ───────────────────────────────────────

describe('Multi-room — AC-7: room-scoped object visibility', () => {
  it('after moving to lounge, perception returns only the Sofa, not the CoffeeMachine', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.updateState('a1', { location: 'kitchen' });

    const smartRegistry = new SmartObjectRegistryImpl();
    smartRegistry.register(coffeeMachine);
    smartRegistry.register(sofa);

    const driveSystem = new DriveSystemImpl(agents);
    const feedbackStore = new SystemFeedbackStore();
    const perception = new PerceptionDataProviderImpl(
      agents,
      smartRegistry,
      driveSystem,
      feedbackStore,
    );

    // Before move: kitchen has the CoffeeMachine.
    const kitchenObjects = perception.getObjectsInRoom('kitchen');
    expect(kitchenObjects).toHaveLength(1);
    expect(kitchenObjects[0]?.id).toBe('coffee-1');

    // After move to lounge.
    const loungeObjects = perception.getObjectsInRoom('lounge');
    expect(loungeObjects).toHaveLength(1);
    expect(loungeObjects[0]?.id).toBe('sofa-1');
    // CoffeeMachine is NOT in the lounge perception.
    expect(loungeObjects.find((o) => o.id === 'coffee-1')).toBeUndefined();
  });
});

// ── AC-8: Room-scoped affordance queries ──────────────────────────────────────

describe('Multi-room — AC-8: room-scoped affordance queries', () => {
  it('kitchen returns brew_coffee + observe; lounge returns sit + observe', () => {
    const agents = new AgentManagerImpl();
    const smartRegistry = new SmartObjectRegistryImpl();
    smartRegistry.register(coffeeMachine);
    smartRegistry.register(sofa);

    const driveSystem = new DriveSystemImpl(agents);
    const feedbackStore = new SystemFeedbackStore();
    const perception = new PerceptionDataProviderImpl(
      agents,
      smartRegistry,
      driveSystem,
      feedbackStore,
    );

    const kitchenAffordances = perception.getAffordancesInRoom('kitchen');
    const kitchenIds = kitchenAffordances.map((a) => a.id);
    expect(kitchenIds).toContain('brew_coffee');
    expect(kitchenIds).toContain('observe');
    expect(kitchenIds).not.toContain('sit');

    const loungeAffordances = perception.getAffordancesInRoom('lounge');
    const loungeIds = loungeAffordances.map((a) => a.id);
    expect(loungeIds).toContain('sit');
    expect(loungeIds).toContain('observe');
    expect(loungeIds).not.toContain('brew_coffee');
  });
});

// ── AC-9: Multi-room SceneDefinition loading ──────────────────────────────────

describe('Multi-room — AC-9: loading a multi-room SceneDefinition', () => {
  it('populates sceneManager, smartObjectRegistry, and agentManager with all entities', () => {
    const core = createEngineCore(makeConfig());

    const roomA: Room = {
      id: 'roomA',
      name: 'Room A',
      description: 'First room',
      connections: ['roomB'],
      objectIds: ['obj-1', 'obj-2'],
    };

    const roomB: Room = {
      id: 'roomB',
      name: 'Room B',
      description: 'Second room',
      connections: ['roomA'],
      objectIds: ['obj-3'],
    };

    const obj1: SmartObject = {
      id: 'obj-1',
      name: 'Object 1',
      type: 'item',
      state: {},
      affordances: [observe],
      roomId: 'roomA',
    };

    const obj2: SmartObject = {
      id: 'obj-2',
      name: 'Object 2',
      type: 'item',
      state: {},
      affordances: [observe],
      roomId: 'roomA',
    };

    const obj3: SmartObject = {
      id: 'obj-3',
      name: 'Object 3',
      type: 'item',
      state: {},
      affordances: [observe],
      roomId: 'roomB',
    };

    const scene: SceneDefinition = {
      id: 'multi-room',
      name: 'Multi-Room Scene',
      rooms: [roomA, roomB],
      objects: [obj1, obj2, obj3],
      agents: [makeAgent('a1'), makeAgent('a2')],
    };

    loadScene(core, scene);

    // sceneManager has both rooms.
    expect(core.sceneManager.getRoom('roomA')).toEqual(roomA);
    expect(core.sceneManager.getRoom('roomB')).toEqual(roomB);

    // smartObjectRegistry contains all 3 objects.
    expect(core.smartObjectRegistry.get('obj-1')).not.toBeNull();
    expect(core.smartObjectRegistry.get('obj-2')).not.toBeNull();
    expect(core.smartObjectRegistry.get('obj-3')).not.toBeNull();

    // agentManager has 2 agents with correct starting locations (first room).
    const activeAgents = core.agentManager.getActiveAgents();
    expect(activeAgents).toHaveLength(2);
    expect(activeAgents[0]?.location).toBe('roomA');
    expect(activeAgents[1]?.location).toBe('roomA');
  });
});

// ── AC-10: Spatial debounce on room boundary crossing ─────────────────────────

describe('Multi-room — AC-10: spatial debounce after room boundary crossing', () => {
  it('shouldTriggerPerception returns true after moveAgent + game-loop tick', () => {
    const core = createEngineCore(makeConfig());

    const scene: SceneDefinition = {
      id: 'spatial-debounce',
      name: 'Spatial Debounce Scene',
      rooms: [kitchen, lounge],
      objects: [coffeeMachine],
      agents: [makeAgent('a1')],
    };

    loadScene(core, scene);
    assembleGameLoop(core, new NoopOrchestrator());

    // Establish baseline — first shouldTriggerPerception sets the last location.
    expect(core.spatial.shouldTriggerPerception('a1')).toBe(false);
    core.spatial.recordPerceptionTick('a1', 0);

    // Move agent to lounge (room boundary crossing).
    core.sceneManager.moveAgent('a1', 'lounge');

    // Tick the game loop once — spatial system updates currentSimTime.
    core.gameLoop.injectElapsed(1 / 60 + 0.0001);

    // Room boundary crossed → shouldTriggerPerception returns true.
    expect(core.spatial.shouldTriggerPerception('a1')).toBe(true);
  });
});