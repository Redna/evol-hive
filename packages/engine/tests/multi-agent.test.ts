/**
 * Multi-Agent Integration Tests (spec 008)
 * ───────────────────────────────────────
 * Exercises concurrent PPER cycles, affordance contention, state isolation,
 * and independent drive decay across multiple agents sharing a single engine
 * instance. All tests use FakeOrchestrator — no real LLM calls.
 *
 * Covers: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  GameTick,
  AgentProfile,
  PPEROrchestratorPort,
  PPERSchedulerConfig,
  SmartObject,
  Affordance,
  AffordanceResult,
} from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { DriveDecaySystem } from '../src/systems/drive-decay.js';
import { PPERScheduler } from '../src/systems/pper-scheduler.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { AffordanceRegistryImpl } from '../src/world/affordances/index.js';
import { PhysicsSystemImpl } from '../src/physics/index.js';
import { SystemFeedbackStore } from '../src/agents/feedback/index.js';
import { ExecuteDataProviderImpl } from '../src/agents/execute/index.js';
import { PerceptionDataProviderImpl } from '../src/agents/perception/index.js';

const TICK: GameTick = { tickNumber: 1, simulationTime: 0.0167, deltaSeconds: 0.0167 };

function makeAgent(id: string, energy = 50): AgentProfile {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

// ─── Fake Orchestrator ────────────────────────────────────────────────────────

/** A fake orchestrator that records runCycle calls and optionally controls resolution. */
class FakeOrchestrator implements PPEROrchestratorPort {
  runCycleCalls: string[] = [];
  /** Resolves the cycle promise immediately (true) or hangs forever (false). */
  autoResolve = true;
  /** Throw inside runCycle to simulate uncaught rejection. */
  shouldThrow = false;
  /** Callback invoked inside runCycle, allowing the test to mutate agent state. */
  onRunCycle?: (agentId: string) => void;

  async runCycle(agentId: string): Promise<void> {
    this.runCycleCalls.push(agentId);
    if (this.onRunCycle) this.onRunCycle(agentId);
    if (this.shouldThrow) throw new Error('orchestrator boom');
    if (!this.autoResolve) return new Promise<void>(() => {});
  }

  getPhase(_agentId: string) {
    return 'perceive' as const;
  }
}

// ─── AC-1: Two idle agents, maxConcurrentCycles >= 2 → both start cycles ──────

describe('Multi-Agent — concurrent PPER cycles (AC-1)', () => {
  it('starts PPER cycles for both agents when maxConcurrentCycles >= 2', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));
    const orch = new FakeOrchestrator();
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 2 });

    scheduler.update(TICK);

    // Both agents should have runCycle called.
    expect(orch.runCycleCalls).toHaveLength(2);
    expect(orch.runCycleCalls).toContain('a1');
    expect(orch.runCycleCalls).toContain('a2');
    // Both agents should have isThinking = true.
    expect(agents.getState('a1')?.isThinking).toBe(true);
    expect(agents.getState('a2')?.isThinking).toBe(true);
  });
});

// ─── AC-2: Three idle agents, maxConcurrentCycles: 2 → exactly 2 start ────────

describe('Multi-Agent — maxConcurrentCycles enforcement (AC-2)', () => {
  it('starts cycles for exactly 2 agents when maxConcurrentCycles: 2 and 3 are idle', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));
    agents.spawn(makeAgent('a3'));
    const orch = new FakeOrchestrator();
    orch.autoResolve = false; // never resolves → slots stay occupied
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 2 });

    scheduler.update(TICK);

    // Exactly 2 agents should have started.
    expect(orch.runCycleCalls).toHaveLength(2);
    // The third agent should not have been called.
    const waitingAgent = ['a1', 'a2', 'a3'].find((id) => !orch.runCycleCalls.includes(id));
    expect(waitingAgent).toBeDefined();
    // The waiting agent's isThinking should still be false.
    expect(agents.getState(waitingAgent!)?.isThinking).toBe(false);
  });
});

// ─── AC-3: After one cycle resolves, next update starts the waiting agent ─────

describe('Multi-Agent — slot frees after cycle resolves (AC-3)', () => {
  it('starts a cycle for the third agent after one in-flight cycle resolves', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));
    agents.spawn(makeAgent('a3'));
    const orch = new FakeOrchestrator();
    orch.autoResolve = true; // resolves immediately
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 2 });

    // First tick: starts 2 of 3 agents (deterministic order: a1, a2).
    scheduler.update(TICK);
    expect(orch.runCycleCalls).toHaveLength(2);

    // Flush the resolved promises so activeCycles decrements (slot frees).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // After flush, isThinking is reset to false by .finally().
    // Mark a1 and a2 as thinking so they won't be re-picked on the next tick.
    agents.updateState('a1', { isThinking: true });
    agents.updateState('a2', { isThinking: true });

    // Second tick: a3 should now get a slot (a1 & a2 are thinking, slots are free).
    scheduler.update(TICK);
    expect(orch.runCycleCalls).toContain('a3');
  });
});

// ─── AC-4: Affordance contention — one succeeds, one fails ────────────────────

describe('Multi-Agent — affordance contention (AC-4)', () => {
  it('yields one success and one failure when two agents target the same affordance', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));

    const registry = new SmartObjectRegistryImpl();
    const affordanceRegistry = new AffordanceRegistryImpl(registry);
    const physics = new PhysicsSystemImpl(registry, affordanceRegistry);

    // Register a smart object with a precondition that fails once "in use".
    const coffeeMachine: SmartObject = {
      id: 'coffee-1',
      name: 'Coffee Machine',
      type: 'appliance',
      state: { water_level: 'high', in_use: false },
      affordances: [
        {
          id: 'brew_coffee',
          label: 'Brew Coffee',
          engineEffect: 'brew_coffee',
          preconditions: ['not_in_use'],
          effects: { energy: 20 },
        },
      ],
      roomId: 'kitchen',
    };
    registry.register(coffeeMachine);

    // Precondition checker: passes when in_use is false.
    affordanceRegistry.registerPreconditionChecker('not_in_use', (state) => {
      return state['in_use'] !== true;
    });

    // Handler: marks object as in_use on success.
    affordanceRegistry.registerHandler('brew_coffee', async (_objId, _agentId, state) => {
      const result: AffordanceResult = {
        success: true,
        newState: { ...state, in_use: true },
        driveChanges: { energy: 20 },
      };
      return result;
    });

    // Agent a1 executes first → succeeds, object marked in_use.
    const result1 = await physics.executeAffordance('coffee-1', 'brew_coffee', 'a1');
    expect(result1.success).toBe(true);

    // Agent a2 executes second → precondition fails (object in use).
    const result2 = await physics.executeAffordance('coffee-1', 'brew_coffee', 'a2');
    expect(result2.success).toBe(false);
    expect(result2.failureReason).toBeDefined();
    expect(result2.failureReason).toContain('not_in_use');
  });
});

// ─── AC-5: Failed affordance → SystemFeedbackStore has feedback ───────────────

describe('Multi-Agent — system feedback on contention failure (AC-5)', () => {
  it('stores feedback in SystemFeedbackStore after a failed affordance execution', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));

    const registry = new SmartObjectRegistryImpl();
    const affordanceRegistry = new AffordanceRegistryImpl(registry);
    const physics = new PhysicsSystemImpl(registry, affordanceRegistry);
    const feedbackStore = new SystemFeedbackStore();
    const driveSystem = new DriveSystemImpl(agents);

    const executeProvider = new ExecuteDataProviderImpl({
      agentManager: agents,
      planManager: {
        getCurrentStep: () => ({ description: 'brew coffee', targetAffordance: 'brew_coffee' }),
        isComplete: () => false,
        advanceStep: () => {},
      } as never,
      driveSystem,
      smartRegistry: registry,
      affordanceRegistry,
      physics,
      feedbackStore,
    });

    const perceptionProvider = new PerceptionDataProviderImpl(
      agents,
      registry,
      driveSystem,
      feedbackStore,
    );

    // Register object with failing precondition.
    const obj: SmartObject = {
      id: 'coffee-1',
      name: 'Coffee Machine',
      type: 'appliance',
      state: { in_use: true },
      affordances: [
        {
          id: 'brew_coffee',
          label: 'Brew Coffee',
          engineEffect: 'brew_coffee',
          preconditions: ['not_in_use'],
          effects: {},
        },
      ],
      roomId: 'kitchen',
    };
    registry.register(obj);
    affordanceRegistry.registerPreconditionChecker(
      'not_in_use',
      (state) => state['in_use'] !== true,
    );

    // Execute → fails because object is in use.
    const result = await executeProvider.executeAffordance('coffee-1', 'brew_coffee', 'a1');
    expect(result.success).toBe(false);

    // Simulate what the Execute phase does on failure: inject feedback.
    executeProvider.setSystemFeedback('a1', `Affordance failed: ${result.failureReason}`);

    // Verify the feedback store contains the entry.
    expect(feedbackStore.getSystemFeedback('a1')).toBeDefined();
    expect(feedbackStore.getSystemFeedback('a1')).toContain('failed');

    // Verify the perception provider can read it.
    expect(perceptionProvider.getSystemFeedback('a1')).toBeDefined();
    expect(perceptionProvider.getSystemFeedback('a1')).toContain('failed');
  });
});

// ─── AC-6: No cross-contamination between agents ──────────────────────────────

describe('Multi-Agent — state isolation (AC-6)', () => {
  it("each agent's drives, plan, and location reflect only its own actions", async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1', 50));
    agents.spawn(makeAgent('a2', 70));
    agents.updateState('a1', { location: 'kitchen' });
    agents.updateState('a2', { location: 'lounge' });

    const orch = new FakeOrchestrator();
    // On each cycle, mutate the agent's state in isolation.
    orch.onRunCycle = (agentId) => {
      const state = agents.getState(agentId);
      if (!state) return;
      // Modify drives.
      const newEnergy = state.drives.energy + 10;
      agents.updateState(agentId, { drives: { ...state.drives, energy: newEnergy } });
      // Set a unique plan.
      agents.updateState(agentId, {
        currentPlan: {
          id: `plan_${agentId}`,
          description: `plan for ${agentId}`,
          steps: [{ description: 'step', completed: false }],
          currentStepIndex: 0,
          createdAt: 0,
        },
      });
    };

    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 2 });
    scheduler.update(TICK);

    // Flush the cycle promises.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Agent a1: energy 50 + 10 = 60, plan id plan_a1, location kitchen.
    const s1 = agents.getState('a1');
    expect(s1?.drives.energy).toBe(60);
    expect(s1?.currentPlan?.id).toBe('plan_a1');
    expect(s1?.location).toBe('kitchen');

    // Agent a2: energy 70 + 10 = 80, plan id plan_a2, location lounge.
    const s2 = agents.getState('a2');
    expect(s2?.drives.energy).toBe(80);
    expect(s2?.currentPlan?.id).toBe('plan_a2');
    expect(s2?.location).toBe('lounge');

    // No cross-contamination: a1's plan is not a2's plan.
    expect(s1?.currentPlan?.id).not.toBe(s2?.currentPlan?.id);
    // a1's energy differs from a2's (different starting values).
    expect(s1?.drives.energy).not.toBe(s2?.drives.energy);
  });
});

// ─── AC-7: Independent drive decay per agent ──────────────────────────────────

describe('Multi-Agent — independent drive decay (AC-7)', () => {
  it("each agent's drives decay independently based on simulation time", () => {
    const agents = new AgentManagerImpl();
    // Two agents with different initial drives.
    agents.spawn(makeAgent('a1', 50));
    agents.spawn(makeAgent('a2', 80));
    const driveSystem = new DriveSystemImpl(agents);
    const decaySystem = new DriveDecaySystem(agents, driveSystem);

    // Tick 1: deltaSeconds = 5.
    decaySystem.update({ tickNumber: 1, simulationTime: 5, deltaSeconds: 5 });

    const e1Tick1 = agents.getState('a1')!.drives.energy;
    const e2Tick1 = agents.getState('a2')!.drives.energy;

    // a1: 50 - 5 = 45, a2: 80 - 5 = 75.
    expect(e1Tick1).toBe(45);
    expect(e2Tick1).toBe(75);

    // Tick 2: deltaSeconds = 3.
    decaySystem.update({ tickNumber: 2, simulationTime: 8, deltaSeconds: 3 });

    const e1Tick2 = agents.getState('a1')!.drives.energy;
    const e2Tick2 = agents.getState('a2')!.drives.energy;

    // a1: 45 - 3 = 42, a2: 75 - 3 = 72.
    expect(e1Tick2).toBe(42);
    expect(e2Tick2).toBe(72);

    // Drives are independent — they don't match because initial values differ.
    expect(e1Tick2).not.toBe(e2Tick2);

    // Other drives also decayed independently (e.g., hunger).
    const h1 = agents.getState('a1')!.drives.hunger;
    const h2 = agents.getState('a2')!.drives.hunger;
    // Both started with hunger 50, decayed by 5 + 3 = 8 → 42. They match because
    // their initial hunger and actions were identical (AC-7 caveat: "unless
    // their initial drives and actions were identical").
    expect(h1).toBe(42);
    expect(h2).toBe(42);
  });

  it('agents with identical initial drives and actions have matching decayed values', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1', 60));
    agents.spawn(makeAgent('a2', 60));
    const driveSystem = new DriveSystemImpl(agents);
    const decaySystem = new DriveDecaySystem(agents, driveSystem);

    decaySystem.update({ tickNumber: 1, simulationTime: 2, deltaSeconds: 2 });

    // Both agents started identically → drives match.
    expect(agents.getState('a1')!.drives.energy).toBe(agents.getState('a2')!.drives.energy);
    expect(agents.getState('a1')!.drives.energy).toBe(58);
  });
});
