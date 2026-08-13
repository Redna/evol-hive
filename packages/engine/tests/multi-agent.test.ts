/**
 * Multi-agent integration tests (spec 008, AC-1 through AC-5).
 *
 * Covers:
 *  - AC-1: 2+ agents completing concurrent PPER cycles via the real engine assembly
 *  - AC-2: Affordance competition — resource depletion on shared SmartObject
 *  - AC-3: maxConcurrentCycles enforcement with 3 idle agents
 *  - AC-4: isThinking per-agent gating
 *  - AC-5: Error isolation across agents
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  GameTick,
  PPEROrchestratorPort,
  PPERPhase,
  PPERSchedulerConfig,
  AgentProfile,
  Room,
  SmartObject,
  Affordance,
  SceneDefinition,
  EngineConfig,
} from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { AffordanceRegistryImpl } from '../src/world/affordances/index.js';
import { PhysicsSystemImpl } from '../src/physics/index.js';
import { PPERScheduler } from '../src/systems/pper-scheduler.js';
import { createEngineCore, assembleGameLoop, loadScene } from '../src/assembly.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const TICK: GameTick = { tickNumber: 1, simulationTime: 0.0167, deltaSeconds: 0.0167 };

function makeConfig(): EngineConfig {
  return { fps: 60, spatialDebounceSeconds: 5, maxConcurrentLLM: 8, guardrailsEnabled: true };
}

function makeAgent(id: string, energy = 50): AgentProfile {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

/** Flush microtasks so .catch/.finally handlers settle. */
async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** A recording fake orchestrator that resolves immediately and records calls. */
class RecordingOrchestrator implements PPEROrchestratorPort {
  runCycleCalls: string[] = [];

  async runCycle(agentId: string): Promise<void> {
    this.runCycleCalls.push(agentId);
  }

  getPhase(agentId: string): PPERPhase {
    void agentId;
    return 'perceive';
  }
}

/** A controllable orchestrator that defers resolution until `resolvePending()` is called. */
class DeferredOrchestrator implements PPEROrchestratorPort {
  runCycleCalls: string[] = [];
  private resolvers: Array<() => void> = [];

  async runCycle(agentId: string): Promise<void> {
    this.runCycleCalls.push(agentId);
    return new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  getPhase(agentId: string): PPERPhase {
    void agentId;
    return 'perceive';
  }

  /** Resolve all pending cycle promises. */
  resolvePending(): void {
    const fns = this.resolvers;
    this.resolvers = [];
    for (const fn of fns) fn();
  }
}

/** An orchestrator that throws for specified agents and resolves for others. */
class ErrorOrchestrator implements PPEROrchestratorPort {
  runCycleCalls: string[] = [];
  private readonly throwFor: Set<string>;

  constructor(throwFor: string[]) {
    this.throwFor = new Set(throwFor);
  }

  async runCycle(agentId: string): Promise<void> {
    this.runCycleCalls.push(agentId);
    if (this.throwFor.has(agentId)) {
      throw new Error(`orchestrator boom for ${agentId}`);
    }
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

const kitchen: Room = {
  id: 'kitchen',
  name: 'Kitchen',
  description: 'A small kitchen',
  connections: [],
  objectIds: ['coffee-1'],
};

const coffeeMachine: SmartObject = {
  id: 'coffee-1',
  name: 'Coffee Machine',
  type: 'appliance',
  state: { water_level: 5, bean_count: 12 },
  affordances: [brewCoffee, observe],
  roomId: 'kitchen',
};

// ── AC-1: Concurrent PPER cycles ─────────────────────────────────────────────

describe('Multi-agent — AC-1: 2+ agents complete concurrent PPER cycles', () => {
  it('each agent runs at least one cycle and isThinking returns to false', async () => {
    const core = createEngineCore(makeConfig());

    const scene: SceneDefinition = {
      id: 'multi-agent',
      name: 'Multi-Agent Scene',
      rooms: [kitchen],
      objects: [coffeeMachine],
      agents: [makeAgent('a1'), makeAgent('a2')],
    };

    loadScene(core, scene);

    // Register affordance handlers so the engine is fully wired.
    core.affordanceRegistry.registerHandler('brew_coffee', async (_objId, _agentId, state) => {
      const newState = { ...state, water_level: ((state['water_level'] as number) ?? 0) - 1 };
      return { success: true, newState, driveChanges: { energy: 20 } };
    });
    core.affordanceRegistry.registerHandler('observe', async (_objId, _agentId, state) => {
      return { success: true, newState: state };
    });

    const orch = new RecordingOrchestrator();
    assembleGameLoop(core, orch);

    // Tick the game loop once — PPERScheduler fires runCycle for all idle agents.
    core.gameLoop.injectElapsed(1 / 60 + 0.0001); // 1 tick at 60 FPS

    // Both agents should have been scheduled for a PPER cycle.
    expect(orch.runCycleCalls).toContain('a1');
    expect(orch.runCycleCalls).toContain('a2');

    // isThinking is true while the cycle promise is pending.
    expect(core.agentManager.getState('a1')?.isThinking).toBe(true);
    expect(core.agentManager.getState('a2')?.isThinking).toBe(true);

    // Flush microtasks — the .finally handler resets isThinking to false.
    await flushPromises();

    expect(core.agentManager.getState('a1')?.isThinking).toBe(false);
    expect(core.agentManager.getState('a2')?.isThinking).toBe(false);
  });
});

// ── AC-2: Affordance competition ──────────────────────────────────────────────

describe('Multi-agent — AC-2: affordance competition on shared SmartObject', () => {
  it('first agent succeeds, second agent fails with depleted resource', async () => {
    const smartRegistry = new SmartObjectRegistryImpl();
    const affordanceRegistry = new AffordanceRegistryImpl(smartRegistry);
    const physics = new PhysicsSystemImpl(smartRegistry, affordanceRegistry);

    // CoffeeMachine with water_level: 1 and a precondition requiring water > 0.
    const brewWithPrecondition: Affordance = {
      ...brewCoffee,
      preconditions: ['has_water'],
    };

    smartRegistry.register({
      ...coffeeMachine,
      state: { water_level: 1, bean_count: 12 },
      affordances: [brewWithPrecondition, observe],
    });

    // Register precondition checker: water_level must be > 0.
    affordanceRegistry.registerPreconditionChecker('has_water', (state) => {
      return (state['water_level'] as number) > 0;
    });

    // Register handler that decrements water_level.
    affordanceRegistry.registerHandler('brew_coffee', async (_objId, _agentId, state) => {
      const newState = { ...state, water_level: ((state['water_level'] as number) ?? 0) - 1 };
      return { success: true, newState, driveChanges: { energy: 20 } };
    });

    // Agent A executes first — should succeed (water_level: 1 → 0).
    const resultA = await physics.executeAffordance('coffee-1', 'brew_coffee', 'a1');
    expect(resultA.success).toBe(true);
    expect(resultA.newState?.['water_level']).toBe(0);

    // Agent B executes second — should fail (water_level is 0, precondition fails).
    const resultB = await physics.executeAffordance('coffee-1', 'brew_coffee', 'a2');
    expect(resultB.success).toBe(false);
    expect(resultB.failureReason).toBeDefined();
    expect(resultB.failureReason).toContain('has_water');
  });
});

// ── AC-3: maxConcurrentCycles enforcement ─────────────────────────────────────

describe('Multi-agent — AC-3: maxConcurrentCycles = 1 with 3 idle agents', () => {
  it('only 1 runCycle call per tick; second agent starts after slot frees', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));
    agents.spawn(makeAgent('a3'));
    const orch = new DeferredOrchestrator();
    const config: PPERSchedulerConfig = { maxConcurrentCycles: 1 };
    const scheduler = new PPERScheduler(agents, orch, config);

    // Tick 1 — only 1 agent starts (slot occupied by deferred promise).
    scheduler.update(TICK);
    expect(orch.runCycleCalls).toHaveLength(1);

    // Resolve the pending cycle so the slot frees.
    orch.resolvePending();
    await flushPromises();

    // Prevent the first agent from grabbing the slot again.
    agents.updateState(orch.runCycleCalls[0]!, { isThinking: true });

    // Tick 2 — the next idle agent starts.
    scheduler.update(TICK);
    expect(orch.runCycleCalls).toHaveLength(2);
  });
});

// ── AC-4: isThinking per-agent gating ─────────────────────────────────────────

describe('Multi-agent — AC-4: isThinking gating skips thinking agents', () => {
  it('only agent B (isThinking=false) is scheduled; agent A (isThinking=true) is skipped', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));
    agents.updateState('a1', { isThinking: true });
    const orch = new RecordingOrchestrator();
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    scheduler.update(TICK);

    // Only agent B should have been scheduled.
    expect(orch.runCycleCalls).toEqual(['a2']);
  });
});

// ── AC-5: Error isolation ─────────────────────────────────────────────────────

describe('Multi-agent — AC-5: error isolation across agents', () => {
  it('agent A throws but agent B completes; both isThinking reset to false', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));
    const orch = new ErrorOrchestrator(['a1']);
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    vi.spyOn(console, 'error').mockImplementation(() => {});

    scheduler.update(TICK);

    // Both agents were scheduled.
    expect(orch.runCycleCalls).toContain('a1');
    expect(orch.runCycleCalls).toContain('a2');

    // isThinking is true for both while promises are pending.
    expect(agents.getState('a1')?.isThinking).toBe(true);
    expect(agents.getState('a2')?.isThinking).toBe(true);

    // Flush microtasks — a1's rejection .catch/.finally and a2's .finally settle.
    await flushPromises();

    // Agent A: isThinking reset to false despite the rejection.
    expect(agents.getState('a1')?.isThinking).toBe(false);
    // Agent B: isThinking reset to false after normal completion.
    expect(agents.getState('a2')?.isThinking).toBe(false);

    vi.restoreAllMocks();
  });
});