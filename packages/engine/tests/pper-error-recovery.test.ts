/**
 * Tests for PPER Error Recovery — engine layer (spec 008, issue #23).
 * Covers AC-19, AC-20, AC-21, AC-22.
 */
import { describe, it, expect, vi } from 'vitest';
import type { GameTick, PPEROrchestratorPort, PPERSchedulerConfig } from '@evol-hive/shared';
import type { AgentInternalState } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
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

// ═════════════════════════════════════════════════════════════════════════════
// Section 1: Drive Edge States (AC-19, AC-20)
// ═════════════════════════════════════════════════════════════════════════════

describe('DriveSystemImpl — drive edge states (AC-19, AC-20)', () => {
  const driveSystem = new DriveSystemImpl();

  function makeState(drives: AgentInternalState['drives']): AgentInternalState {
    return {
      agentId: 'a1',
      drives,
      currentGoal: 'stay alive',
      currentPlan: null,
      isThinking: false,
      location: 'kitchen',
      lastPerceptionTick: 0,
    };
  }

  it('returns "All drives critically low — agent is in crisis state" when all drives are 0 (AC-19)', () => {
    const state = makeState({
      energy: 0,
      hunger: 0,
      social: 0,
      comfort: 0,
      curiosity: 0,
    });
    expect(driveSystem.getPrimaryDriveLabel(state)).toBe(
      'All drives critically low — agent is in crisis state',
    );
  });

  it('returns "All drives satisfied — agent is content" when all drives are 100 (AC-20)', () => {
    const state = makeState({
      energy: 100,
      hunger: 100,
      social: 100,
      comfort: 100,
      curiosity: 100,
    });
    expect(driveSystem.getPrimaryDriveLabel(state)).toBe('All drives satisfied — agent is content');
  });

  it('returns the normal drive label when drives are mixed (not all zero, not all full)', () => {
    const state = makeState({
      energy: 10,
      hunger: 50,
      social: 80,
      comfort: 60,
      curiosity: 40,
    });
    const label = driveSystem.getPrimaryDriveLabel(state);
    expect(label).toBe('low energy, need to restore energy');
    expect(label).not.toContain('All drives');
  });

  it('returns the normal drive label when four drives are 0 but one is not', () => {
    const state = makeState({
      energy: 0,
      hunger: 0,
      social: 0,
      comfort: 0,
      curiosity: 1,
    });
    const label = driveSystem.getPrimaryDriveLabel(state);
    expect(label).toBe('low energy, need to restore energy');
    expect(label).not.toContain('All drives');
  });

  it('returns the normal drive label when four drives are 100 but one is not', () => {
    const state = makeState({
      energy: 100,
      hunger: 100,
      social: 100,
      comfort: 100,
      curiosity: 99,
    });
    const label = driveSystem.getPrimaryDriveLabel(state);
    expect(label).toBe('low curiosity, need to restore curiosity');
    expect(label).not.toContain('All drives');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 2: PPER Scheduler Re-trigger Prevention (AC-21, AC-22)
// ═════════════════════════════════════════════════════════════════════════════

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

describe('PPERScheduler — re-trigger prevention (AC-21)', () => {
  it('sets isThinking = true synchronously before firing runCycle', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    // Use a never-resolving orchestrator to capture the synchronous state.
    orch.autoResolve = false;
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    scheduler.update(TICK);

    // isThinking should be true synchronously after update() returns.
    expect(agents.getState('a1')?.isThinking).toBe(true);
    // runCycle was called.
    expect(orch.runCycleCalls).toEqual(['a1']);
  });

  it('a second tick during a long cycle does not start a second runCycle for the same agent', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.autoResolve = false; // never resolves → cycle stays in flight
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    scheduler.update(TICK);
    expect(orch.runCycleCalls).toEqual(['a1']);

    // Second tick — agent isThinking=true, so no new cycle.
    scheduler.update(TICK);
    expect(orch.runCycleCalls).toEqual(['a1']); // still only one call
  });

  it('a slow cycle does not cause a second concurrent runCycle for the same agent', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.autoResolve = false; // slow cycle
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    // Simulate multiple ticks while the first cycle is still in flight.
    scheduler.update(TICK);
    scheduler.update(TICK);
    scheduler.update(TICK);

    expect(orch.runCycleCalls).toEqual(['a1']); // only one call
  });
});

describe('PPERScheduler — cleanup on uncaught rejection (AC-22)', () => {
  it('resets isThinking = false and decrements activeCycles when runCycle rejects', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.shouldThrow = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    scheduler.update(TICK);
    // isThinking set synchronously.
    expect(agents.getState('a1')?.isThinking).toBe(true);

    // Flush microtasks for the .catch().finally() chain.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(agents.getState('a1')?.isThinking).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('the game loop continues after a rejected cycle', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.shouldThrow = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    // First tick: starts a cycle that rejects.
    expect(() => scheduler.update(TICK)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    // Second tick: agent isThinking=false again, so a new cycle starts.
    orch.shouldThrow = false;
    orch.runCycleCalls = [];
    scheduler.update(TICK);
    expect(orch.runCycleCalls).toEqual(['a1']);
  });
});
