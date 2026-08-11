/**
 * Tests for the PPERScheduler engine system.
 * Covers AC-4, AC-5, AC-6, AC-23.
 */
import { describe, it, expect, vi } from 'vitest';
import type { GameTick, PPEROrchestratorPort, PPERSchedulerConfig } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { PPERScheduler } from '../src/systems/pper-scheduler.js';
import type { AgentProfile } from '@evol-hive/shared';

const TICK: GameTick = { tickNumber: 1, simulationTime: 0.0167, deltaSeconds: 0.0167 };

function makeAgent(id = 'a1', energy = 50): AgentProfile {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

/** A fake orchestrator that records runCycle calls and optionally controls resolution. */
class FakeOrchestrator implements PPEROrchestratorPort {
  runCycleCalls: string[] = [];
  /** Resolves the cycle promise immediately (true) or hangs forever (false). */
  autoResolve = true;
  /** Throw inside runCycle to simulate uncaught rejection. */
  shouldThrow = false;

  async runCycle(agentId: string): Promise<void> {
    this.runCycleCalls.push(agentId);
    if (this.shouldThrow) {
      throw new Error('orchestrator boom');
    }
    if (!this.autoResolve) {
      // Never resolve — keeps the concurrency slot occupied.
      return new Promise<void>(() => {});
    }
  }

  getPhase(_agentId: string) {
    return 'perceive' as const;
  }
}

describe('PPERScheduler — async fire-and-forget (AC-4, AC-21)', () => {
  it('calls runCycle for agents where isThinking === false, synchronously returning', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    // update() must return synchronously even though runCycle is async.
    scheduler.update(TICK);

    // The orchestrator was invoked.
    expect(orch.runCycleCalls).toEqual(['a1']);
  });

  it('does not block the update() call — returns before the promise resolves', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.autoResolve = false; // never resolves
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    let returned = false;
    scheduler.update(TICK);
    returned = true;

    expect(returned).toBe(true);
    expect(orch.runCycleCalls).toEqual(['a1']);
  });
});

describe('PPERScheduler — isThinking gate (AC-5)', () => {
  it('does not start a new cycle for an agent already thinking', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.updateState('a1', { isThinking: true });
    const orch = new FakeOrchestrator();
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    scheduler.update(TICK);
    expect(orch.runCycleCalls).toHaveLength(0);
  });

  it('starts a cycle for an idle agent', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    scheduler.update(TICK);
    expect(orch.runCycleCalls).toEqual(['a1']);
  });
});

describe('PPERScheduler — error resilience (AC-6)', () => {
  it('catches a rejecting cycle, logs, and sets isThinking = false', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.shouldThrow = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    // Agent is idle → scheduler starts a cycle that rejects.
    scheduler.update(TICK);
    // The scheduler sets isThinking=true synchronously when starting.
    expect(agents.getState('a1')?.isThinking).toBe(true);

    // Flush the rejected promise's .catch/.finally handlers.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(agents.getState('a1')?.isThinking).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does not crash the game loop when a cycle rejects', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.shouldThrow = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    expect(() => scheduler.update(TICK)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('PPERScheduler — concurrency control (AC-23)', () => {
  it('when maxConcurrentCycles is 1, only one cycle starts per tick', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));
    const orch = new FakeOrchestrator();
    orch.autoResolve = false; // never resolves → slot never frees
    const config: PPERSchedulerConfig = { maxConcurrentCycles: 1 };
    const scheduler = new PPERScheduler(agents, orch, config);

    scheduler.update(TICK);
    // Only one of the two idle agents should have started.
    expect(orch.runCycleCalls).toHaveLength(1);
  });

  it('the second agent starts only after the first completes (slot frees)', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));
    const orch = new FakeOrchestrator();
    orch.autoResolve = true; // resolves immediately
    const config: PPERSchedulerConfig = { maxConcurrentCycles: 1 };
    const scheduler = new PPERScheduler(agents, orch, config);

    scheduler.update(TICK);
    expect(orch.runCycleCalls).toEqual(['a1']);

    // Flush the resolved promise so the slot frees (activeCycles → 0).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Prevent a1 from grabbing the slot again — simulate a1 now being busy.
    agents.updateState('a1', { isThinking: true });

    scheduler.update(TICK);
    expect(orch.runCycleCalls).toEqual(['a1', 'a2']);
  });
});
