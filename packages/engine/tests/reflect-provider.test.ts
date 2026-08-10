/**
 * Tests for ReflectDataProviderImpl bridge (spec 004, Req 22-23).
 *
 * Covers AC-27 through AC-31, AC-32, AC-33, AC-34, AC-40.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MemoryEntryInput, MemoryNode } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { PlanManagerImpl } from '../src/agents/plans/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { ReflectDataProviderImpl } from '../src/agents/reflect/index.js';
import type { MemoryStore, EmbeddingProvider } from '@evol-hive/memory';

const AGENT_ID = 'a1';

// ─── Fake MemoryStore ────────────────────────────────────────────────────────

class FakeMemoryStore implements MemoryStore {
  storeCalls: { agentId: string; entry: MemoryEntryInput; timestamp: number }[] = [];

  async store(agentId: string, entry: MemoryEntryInput, timestamp: number): Promise<MemoryNode> {
    this.storeCalls.push({ agentId, entry, timestamp });
    return {
      id: 'mem_1',
      agentId,
      content: entry.content,
      embedding: [],
      timestamp,
      importance: entry.importance,
      type: entry.type,
    };
  }
  async get(): Promise<MemoryNode | null> {
    return null;
  }
}

// ─── Setup ───────────────────────────────────────────────────────────────────

function setup(clockReturn: number = 1000) {
  const agentManager = new AgentManagerImpl();
  const planManager = new PlanManagerImpl(agentManager, () => clockReturn);
  const driveSystem = new DriveSystemImpl(agentManager);
  const memoryStore = new FakeMemoryStore();
  const clock = () => clockReturn;

  const provider = new ReflectDataProviderImpl(
    agentManager,
    driveSystem,
    planManager,
    memoryStore,
    clock,
  );

  agentManager.spawn({
    id: AGENT_ID,
    name: 'Test Agent',
    description: '',
    traits: [],
    initialDrives: { energy: 50, hunger: 50 },
  });

  return { agentManager, planManager, driveSystem, memoryStore, clock, provider };
}

// ─── ReflectDataProviderImpl (AC-27, AC-40) ──────────────────────────────────

describe('ReflectDataProviderImpl (AC-27, AC-40)', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('accepts AgentManager, DriveSystem, PlanManager, MemoryStore, SimulationClock via constructor (AC-40)', () => {
    expect(ctx.provider).toBeDefined();
  });

  it('implements all 6 methods of ReflectDataProvider (AC-27)', () => {
    expect(typeof ctx.provider.getAgentState).toBe('function');
    expect(typeof ctx.provider.applyDriveChanges).toBe('function');
    expect(typeof ctx.provider.updateGoal).toBe('function');
    expect(typeof ctx.provider.storeMemory).toBe('function');
    expect(typeof ctx.provider.clearPlanIfComplete).toBe('function');
    expect(typeof ctx.provider.setThinking).toBe('function');
  });

  // getAgentState (AC-32)
  it('getAgentState delegates to AgentManager.getState (AC-32)', () => {
    const state = ctx.provider.getAgentState(AGENT_ID);
    expect(state).not.toBeNull();
    expect(state?.agentId).toBe(AGENT_ID);
  });

  it('getAgentState returns null for unknown agent (AC-32)', () => {
    expect(ctx.provider.getAgentState('nonexistent')).toBeNull();
  });

  // applyDriveChanges (AC-34)
  it('applyDriveChanges delegates to DriveSystem.applyChanges which clamps to 0-100 (AC-34)', () => {
    // Start with energy=50, apply +50 → should clamp to 100, not 100 (50+50=100 exactly)
    ctx.provider.applyDriveChanges(AGENT_ID, { energy: 60 });
    const state = ctx.agentManager.getState(AGENT_ID);
    expect(state?.drives.energy).toBe(100); // 50 + 60 = 110, clamped to 100
  });

  it('applyDriveChanges with large negative clamps to 0 (AC-34)', () => {
    ctx.provider.applyDriveChanges(AGENT_ID, { energy: -200 });
    const state = ctx.agentManager.getState(AGENT_ID);
    expect(state?.drives.energy).toBe(0);
  });

  // updateGoal (AC-30)
  it('updateGoal delegates to AgentManager.updateState with currentGoal (AC-30)', () => {
    ctx.provider.updateGoal(AGENT_ID, 'Find food');
    const state = ctx.agentManager.getState(AGENT_ID);
    expect(state?.currentGoal).toBe('Find food');
  });

  // storeMemory (AC-31)
  it('storeMemory delegates to MemoryStore.store with current sim time from clock (AC-31)', async () => {
    const entry: MemoryEntryInput = {
      content: 'Ate a snack',
      importance: 5,
      type: 'action',
      location: 'kitchen',
    };
    await ctx.provider.storeMemory(AGENT_ID, entry);
    expect(ctx.memoryStore.storeCalls).toHaveLength(1);
    expect(ctx.memoryStore.storeCalls[0]!.agentId).toBe(AGENT_ID);
    expect(ctx.memoryStore.storeCalls[0]!.entry).toEqual(entry);
    expect(ctx.memoryStore.storeCalls[0]!.timestamp).toBe(1000);
  });

  it('storeMemory uses the clock to get the current simulation time (AC-31)', async () => {
    const ctx2 = setup(5000);
    const entry: MemoryEntryInput = {
      content: 'test',
      importance: 3,
      type: 'observation',
    };
    await ctx2.provider.storeMemory(AGENT_ID, entry);
    expect(ctx2.memoryStore.storeCalls[0]!.timestamp).toBe(5000);
  });

  // clearPlanIfComplete (AC-28, AC-29)
  it('clearPlanIfComplete returns true and clears plan when plan is complete (AC-28)', () => {
    // No plan → isComplete returns true → should clear and return true
    const result = ctx.provider.clearPlanIfComplete(AGENT_ID);
    expect(result).toBe(true);
    expect(ctx.agentManager.getState(AGENT_ID)?.currentPlan).toBeNull();
  });

  it('clearPlanIfComplete returns false and does not clear when plan is not complete (AC-29)', () => {
    ctx.planManager.createPlan(AGENT_ID, {
      description: 'Test plan',
      steps: [
        { description: 'Step 1', targetAffordance: 'brew_coffee' },
        { description: 'Step 2' },
      ],
    });
    const result = ctx.provider.clearPlanIfComplete(AGENT_ID);
    expect(result).toBe(false);
    expect(ctx.agentManager.getState(AGENT_ID)?.currentPlan).not.toBeNull();
  });

  it('clearPlanIfComplete clears plan when all steps are done (AC-28)', () => {
    ctx.planManager.createPlan(AGENT_ID, {
      description: 'Test plan',
      steps: [{ description: 'Step 1' }],
    });
    // Advance past the last step.
    ctx.planManager.advanceStep(AGENT_ID);
    const result = ctx.provider.clearPlanIfComplete(AGENT_ID);
    expect(result).toBe(true);
    expect(ctx.agentManager.getState(AGENT_ID)?.currentPlan).toBeNull();
  });

  // setThinking (AC-33)
  it('setThinking delegates to AgentManager.updateState (AC-33)', () => {
    ctx.provider.setThinking(AGENT_ID, true);
    expect(ctx.agentManager.getState(AGENT_ID)?.isThinking).toBe(true);
    ctx.provider.setThinking(AGENT_ID, false);
    expect(ctx.agentManager.getState(AGENT_ID)?.isThinking).toBe(false);
  });
});
