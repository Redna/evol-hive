/**
 * Integration test for the Reflect phase — wires up the engine's
 * ReflectDataProviderImpl with the memory layer's MemoryStoreImpl to verify
 * the full end-to-end flow works across package boundaries (engine → memory).
 *
 * This is the new cross-package dependency introduced in this PR (engine now
 * depends on @evol-hive/memory per ADR-0001). The cognition layer's
 * ReflectServiceImpl is already tested in isolation in packages/cognition/tests/
 * — this test focuses on the engine ↔ memory integration.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { MemoryEntryInput, MemoryNode, ExecuteResult } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { PlanManagerImpl } from '../src/agents/plans/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { ReflectDataProviderImpl } from '../src/agents/reflect/index.js';
import type { EmbeddingProvider, VectorStore } from '@evol-hive/memory';
import { MemoryStoreImpl } from '@evol-hive/memory';

const AGENT_ID = 'a1';

// ─── Fakes ───────────────────────────────────────────────────────────────────

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  embedCalls: string[] = [];

  async embed(text: string): Promise<number[]> {
    this.embedCalls.push(text);
    // Return a deterministic embedding based on text length.
    return [text.length, 0.5, 0.3, 0.8];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      this.embedCalls.push(t);
      return [t.length, 0.5, 0.3, 0.8];
    });
  }
}

class FakeVectorStore implements VectorStore {
  stored: MemoryNode[] = [];

  async store(node: MemoryNode): Promise<void> {
    this.stored.push(node);
  }
  async get(id: string): Promise<MemoryNode | null> {
    return this.stored.find((n) => n.id === id) ?? null;
  }
  async queryByEmbedding(): Promise<MemoryNode[]> {
    return [];
  }
  async delete(): Promise<void> {}
  async countRecent(): Promise<number> {
    return 0;
  }
}

// ─── Setup ───────────────────────────────────────────────────────────────────

function setup(clockReturn: number = 1000) {
  const agentManager = new AgentManagerImpl();
  const planManager = new PlanManagerImpl(agentManager, () => clockReturn);
  const driveSystem = new DriveSystemImpl(agentManager);
  const vectorStore = new FakeVectorStore();
  const embeddingProvider = new FakeEmbeddingProvider();
  const memoryStore = new MemoryStoreImpl({ vectorStore, embeddingProvider });
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

  return {
    agentManager,
    planManager,
    driveSystem,
    vectorStore,
    embeddingProvider,
    memoryStore,
    clock,
    provider,
  };
}

// ─── Integration Tests ───────────────────────────────────────────────────────

describe('Reflect phase integration: engine ReflectDataProviderImpl + memory MemoryStoreImpl', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('storeMemory generates embedding via EmbeddingProvider and persists to VectorStore', async () => {
    const entry: MemoryEntryInput = {
      content: 'Ate snacks from the fridge',
      importance: 7,
      type: 'action',
      location: 'kitchen',
    };

    await ctx.provider.storeMemory(AGENT_ID, entry);

    // Embedding provider was called with the content.
    expect(ctx.embeddingProvider.embedCalls).toEqual(['Ate snacks from the fridge']);

    // VectorStore received the MemoryNode with embedding.
    expect(ctx.vectorStore.stored).toHaveLength(1);
    const node = ctx.vectorStore.stored[0]!;
    expect(node.agentId).toBe(AGENT_ID);
    expect(node.content).toBe('Ate snacks from the fridge');
    expect(node.embedding).toEqual([26, 0.5, 0.3, 0.8]); // 26 = 'Ate snacks from the fridge'.length
    expect(node.importance).toBe(7);
    expect(node.type).toBe('action');
    expect(node.location).toBe('kitchen');
    expect(node.timestamp).toBe(1000);
    expect(node.id).toContain(AGENT_ID);
    expect(node.id).toContain('1000');
  });

  it('storeMemory generates unique IDs across multiple calls', async () => {
    const entry: MemoryEntryInput = {
      content: 'Same content',
      importance: 5,
      type: 'observation',
    };

    await ctx.provider.storeMemory(AGENT_ID, entry);
    await ctx.provider.storeMemory(AGENT_ID, entry);

    expect(ctx.vectorStore.stored).toHaveLength(2);
    expect(ctx.vectorStore.stored[0]!.id).not.toBe(ctx.vectorStore.stored[1]!.id);
  });

  it('applyDriveChanges clamps via real DriveSystem and updates AgentManager state', () => {
    ctx.provider.applyDriveChanges(AGENT_ID, { energy: 60 });
    const state = ctx.agentManager.getState(AGENT_ID);
    expect(state?.drives.energy).toBe(100); // 50 + 60 = 110, clamped to 100

    ctx.provider.applyDriveChanges(AGENT_ID, { energy: -200 });
    expect(ctx.agentManager.getState(AGENT_ID)?.drives.energy).toBe(0);
  });

  it('updateGoal updates AgentManager state', () => {
    ctx.provider.updateGoal(AGENT_ID, 'Find food');
    expect(ctx.agentManager.getState(AGENT_ID)?.currentGoal).toBe('Find food');
  });

  it('setThinking updates AgentManager state', () => {
    ctx.provider.setThinking(AGENT_ID, true);
    expect(ctx.agentManager.getState(AGENT_ID)?.isThinking).toBe(true);
    ctx.provider.setThinking(AGENT_ID, false);
    expect(ctx.agentManager.getState(AGENT_ID)?.isThinking).toBe(false);
  });

  it('clearPlanIfComplete clears plan via real PlanManager when plan is done', () => {
    ctx.planManager.createPlan(AGENT_ID, {
      description: 'Test plan',
      steps: [{ description: 'Step 1' }],
    });
    ctx.planManager.advanceStep(AGENT_ID);

    const result = ctx.provider.clearPlanIfComplete(AGENT_ID);
    expect(result).toBe(true);
    expect(ctx.agentManager.getState(AGENT_ID)?.currentPlan).toBeNull();
  });

  it('clearPlanIfComplete does not clear when plan is not done', () => {
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

  it('getAgentState returns real AgentManager state', () => {
    const state = ctx.provider.getAgentState(AGENT_ID);
    expect(state).not.toBeNull();
    expect(state?.agentId).toBe(AGENT_ID);
    expect(state?.drives.energy).toBe(50);
    expect(state?.drives.hunger).toBe(50);
  });

  it('getAgentState returns null for unknown agent', () => {
    expect(ctx.provider.getAgentState('nonexistent')).toBeNull();
  });

  it('full reflect data flow: drives, goal, memory, plan clearing all work together', async () => {
    // 1. Apply drive changes.
    ctx.provider.applyDriveChanges(AGENT_ID, { hunger: 30 });
    expect(ctx.agentManager.getState(AGENT_ID)?.drives.hunger).toBe(80);

    // 2. Update goal.
    ctx.provider.updateGoal(AGENT_ID, 'Survive');
    expect(ctx.agentManager.getState(AGENT_ID)?.currentGoal).toBe('Survive');

    // 3. Store memory via real MemoryStoreImpl.
    const entry: MemoryEntryInput = {
      content: 'Found food in the pantry',
      importance: 8,
      type: 'observation',
      location: 'pantry',
    };
    await ctx.provider.storeMemory(AGENT_ID, entry);
    expect(ctx.vectorStore.stored).toHaveLength(1);
    expect(ctx.embeddingProvider.embedCalls).toEqual(['Found food in the pantry']);

    // 4. Clear plan if complete (no plan → isComplete returns true).
    const cleared = ctx.provider.clearPlanIfComplete(AGENT_ID);
    expect(cleared).toBe(true);

    // 5. Set thinking off.
    ctx.provider.setThinking(AGENT_ID, false);
    expect(ctx.agentManager.getState(AGENT_ID)?.isThinking).toBe(false);

    // 6. Verify final state is consistent.
    const finalState = ctx.agentManager.getState(AGENT_ID);
    expect(finalState?.drives.hunger).toBe(80);
    expect(finalState?.currentGoal).toBe('Survive');
    expect(finalState?.isThinking).toBe(false);
    expect(finalState?.currentPlan).toBeNull();
  });
});
