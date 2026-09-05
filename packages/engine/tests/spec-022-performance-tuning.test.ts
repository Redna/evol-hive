/**
 * Spec 022 — Performance Tuning: engine assembly & affordance cache.
 * Covers AC-1 (loadScene concurrency), AC-2 (createEngine/assembleGameLoop
 * schedulerConfig), AC-15 (AffordanceResolutionCache).
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  EngineConfig,
  PPEROrchestratorPort,
  PPERPhase,
  AgentProfile,
  Affordance,
  SceneDefinition,
} from '@evol-hive/shared';
import { createEngine, createEngineCore, assembleGameLoop, loadScene } from '../src/assembly.js';
import { AffordanceResolutionCache } from '../src/world/affordances/cache.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { affordancesToToolDefinitions } from '@evol-hive/shared';
import type { EngineCore } from '../src/assembly.js';

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
  };
}

function makeProfile(id = 'a1', room = 'kitchen'): AgentProfile {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    startRoomId: room,
  };
}

class FakeOrchestrator implements PPEROrchestratorPort {
  async runCycle(_agentId: string): Promise<void> {}
  getPhase(_agentId: string): PPERPhase {
    return 'perceive';
  }
}

function makeRoom(id = 'kitchen') {
  return {
    id,
    name: id,
    description: 'a room',
    connections: [],
    objectIds: [],
  };
}

// ─── AC-1: loadScene propagates scene-level concurrency ──────────────────────

describe('AC-1: loadScene maxConcurrentCycles (Req 1, Req 2)', () => {
  it('when a scene defines maxConcurrentCycles: 3, the PPERScheduler uses 3', () => {
    const core = createEngineCore(makeConfig());
    const scene: SceneDefinition = {
      id: 's1',
      name: 'Scene',
      rooms: [makeRoom('kitchen')],
      objects: [],
      agents: [makeProfile('a1', 'kitchen')],
      maxConcurrentCycles: 3,
    };
    loadScene(core, scene);
    assembleGameLoop(core, new FakeOrchestrator());
    expect(core.scheduler?.maxConcurrentCycles).toBe(3);
  });

  it('scene maxConcurrentCycles overrides ENGINE_MAX_CONCURRENT_LLM env var', () => {
    const orig = process.env['ENGINE_MAX_CONCURRENT_LLM'];
    process.env['ENGINE_MAX_CONCURRENT_LLM'] = '8';
    try {
      const core = createEngineCore(makeConfig());
      const scene: SceneDefinition = {
        id: 's1',
        name: 'Scene',
        rooms: [makeRoom('kitchen')],
        objects: [],
        agents: [],
        maxConcurrentCycles: 2,
      };
      loadScene(core, scene);
      assembleGameLoop(core, new FakeOrchestrator());
      expect(core.scheduler?.maxConcurrentCycles).toBe(2);
    } finally {
      if (orig === undefined) delete process.env['ENGINE_MAX_CONCURRENT_LLM'];
      else process.env['ENGINE_MAX_CONCURRENT_LLM'] = orig;
    }
  });

  it('when scene has no maxConcurrentCycles, the default (1) is used', () => {
    delete process.env['ENGINE_MAX_CONCURRENT_LLM'];
    const core = createEngineCore(makeConfig());
    const scene: SceneDefinition = {
      id: 's1',
      name: 'Scene',
      rooms: [makeRoom('kitchen')],
      objects: [],
      agents: [],
    };
    loadScene(core, scene);
    assembleGameLoop(core, new FakeOrchestrator());
    expect(core.scheduler?.maxConcurrentCycles).toBe(1);
  });
});

// ─── AC-2: createEngine / assembleGameLoop schedulerConfig ───────────────────

describe('AC-2: createEngine & assembleGameLoop schedulerConfig (Req 2, Req 3)', () => {
  it('createEngine forwards schedulerConfig to the PPERScheduler', () => {
    const engine = createEngine(makeConfig(), new FakeOrchestrator(), undefined, undefined, {
      maxConcurrentCycles: 5,
    });
    expect(engine.scheduler?.maxConcurrentCycles).toBe(5);
  });

  it('createEngine uses defaultPPERSchedulerConfig (1) when schedulerConfig omitted', () => {
    delete process.env['ENGINE_MAX_CONCURRENT_LLM'];
    const engine = createEngine(makeConfig(), new FakeOrchestrator());
    expect(engine.scheduler?.maxConcurrentCycles).toBe(1);
  });

  it('assembleGameLoop uses an explicit schedulerConfig override', () => {
    const core = createEngineCore(makeConfig());
    assembleGameLoop(core, new FakeOrchestrator(), undefined, undefined, {
      maxConcurrentCycles: 7,
    });
    expect(core.scheduler?.maxConcurrentCycles).toBe(7);
  });

  it('assembleGameLoop schedulerConfig overrides scene-level config', () => {
    const core = createEngineCore(makeConfig());
    const scene: SceneDefinition = {
      id: 's1',
      name: 'Scene',
      rooms: [makeRoom()],
      objects: [],
      agents: [],
      maxConcurrentCycles: 3,
    };
    loadScene(core, scene);
    assembleGameLoop(core, new FakeOrchestrator(), undefined, undefined, {
      maxConcurrentCycles: 6,
    });
    expect(core.scheduler?.maxConcurrentCycles).toBe(6);
  });

  it('createEngine without schedulerConfig still registers systems in order', () => {
    const engine = createEngine(makeConfig(), new FakeOrchestrator());
    expect(engine.gameLoop.systemNames()).toEqual([
      'scene-mutations',
      'spatial',
      'drive-decay',
      'object-state',
      'conversation-lifecycle',
      'pper-scheduler',
    ]);
  });
});

// ─── AC-15: AffordanceResolutionCache ────────────────────────────────────────

const sampleAffordances: Affordance[] = [
  { id: 'brew_coffee', label: 'Brew coffee', effects: [] },
  { id: 'pour_water', label: 'Pour water', effects: [] },
];

describe('AC-15: AffordanceResolutionCache (Req 15)', () => {
  it('getAffordanceTools returns cached tool definitions for a room', () => {
    let computeCalls = 0;
    const compute = (roomId: string) => {
      computeCalls++;
      return affordancesToToolDefinitions(sampleAffordances);
    };
    const cache = new AffordanceResolutionCache(compute);
    const first = cache.getAffordanceTools('kitchen');
    const second = cache.getAffordanceTools('kitchen');
    expect(second).toBe(first); // same reference (cached)
    expect(computeCalls).toBe(1);
  });

  it('different rooms are cached separately', () => {
    let computeCalls = 0;
    const compute = (_roomId: string) => {
      computeCalls++;
      return affordancesToToolDefinitions(sampleAffordances);
    };
    const cache = new AffordanceResolutionCache(compute);
    cache.getAffordanceTools('kitchen');
    cache.getAffordanceTools('bedroom');
    expect(computeCalls).toBe(2);
    // Second call to each is cached.
    cache.getAffordanceTools('kitchen');
    cache.getAffordanceTools('bedroom');
    expect(computeCalls).toBe(2);
  });

  it('invalidate(roomId) evicts the cache entry so the next call recomputes', () => {
    let computeCalls = 0;
    const compute = (_roomId: string) => {
      computeCalls++;
      return affordancesToToolDefinitions(sampleAffordances);
    };
    const cache = new AffordanceResolutionCache(compute);
    cache.getAffordanceTools('kitchen');
    expect(computeCalls).toBe(1);
    cache.invalidate('kitchen');
    cache.getAffordanceTools('kitchen');
    expect(computeCalls).toBe(2);
  });

  it('invalidateAll evicts every cache entry', () => {
    let computeCalls = 0;
    const compute = (_roomId: string) => {
      computeCalls++;
      return affordancesToToolDefinitions(sampleAffordances);
    };
    const cache = new AffordanceResolutionCache(compute);
    cache.getAffordanceTools('kitchen');
    cache.getAffordanceTools('bedroom');
    cache.invalidateAll();
    cache.getAffordanceTools('kitchen');
    cache.getAffordanceTools('bedroom');
    expect(computeCalls).toBe(4);
  });

  it('can be wired to a SmartObjectRegistry and invalidated on state change', () => {
    const registry = new SmartObjectRegistryImpl();
    registry.register({
      id: 'coffee-1',
      name: 'Coffee Machine',
      type: 'appliance',
      state: { water_level: 5 },
      affordances: sampleAffordances,
      roomId: 'kitchen',
    });
    const compute = (roomId: string) =>
      affordancesToToolDefinitions(registry.getAffordancesInRoom(roomId));
    const cache = new AffordanceResolutionCache(compute);
    const first = cache.getAffordanceTools('kitchen');
    expect(first).toHaveLength(2);
    // Simulate a state change → invalidate the room.
    cache.invalidate('kitchen');
    const second = cache.getAffordanceTools('kitchen');
    expect(second).toHaveLength(2);
  });
});
