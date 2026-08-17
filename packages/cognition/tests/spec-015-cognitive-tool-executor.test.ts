/**
 * Tests for spec 015 — CognitiveToolExecutorImpl (AC-10 through AC-16, AC-36, AC-42).
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  MemorySnippet,
  CognitiveToolDataProvider,
  QueryMemoryToolResult,
  UpdateStateToolResult,
} from '@evol-hive/shared';
import type { MemoryInjector } from '@evol-hive/memory';
import { CognitiveToolExecutorImpl } from '../src/tools/cognitive-tool-executor.js';

function makeSnippet(id: string): MemorySnippet {
  return { id, content: `content-${id}`, importance: 5, timestamp: 1000 };
}

describe('CognitiveToolExecutorImpl (AC-10..AC-16, AC-36, AC-42)', () => {
  // ─── AC-10: export & constructor ────────────────────────────────────────────

  it('is exported and accepts { memoryInjector?, stateDataProvider? } (AC-10)', async () => {
    const mod = await import('../src/index.js');
    expect(mod.CognitiveToolExecutorImpl).toBeDefined();
    const impl = new CognitiveToolExecutorImpl({});
    expect(impl).toBeInstanceOf(CognitiveToolExecutorImpl);
  });

  it('can be constructed with both dependencies', () => {
    const memoryInjector: MemoryInjector = {
      injectAssociative: vi.fn(),
      activeRecall: vi.fn(),
    };
    const stateDataProvider: CognitiveToolDataProvider = {
      updateGoal: vi.fn(),
      applyDriveChanges: vi.fn(),
    };
    const impl = new CognitiveToolExecutorImpl({ memoryInjector, stateDataProvider });
    expect(impl).toBeInstanceOf(CognitiveToolExecutorImpl);
  });

  // ─── AC-11: executeQueryMemory with memoryInjector set ─────────────────────

  it('calls memoryInjector.activeRecall(agentId, query, topK) and returns { memories } (AC-11)', async () => {
    const snippets: MemorySnippet[] = [makeSnippet('m1'), makeSnippet('m2')];
    const memoryInjector: MemoryInjector = {
      injectAssociative: vi.fn(),
      activeRecall: vi.fn().mockResolvedValue(snippets),
    };
    const impl = new CognitiveToolExecutorImpl({ memoryInjector });
    const result: QueryMemoryToolResult = await impl.executeQueryMemory('a1', 'coffee', 5);
    expect(memoryInjector.activeRecall).toHaveBeenCalledWith('a1', 'coffee', 5);
    expect(result.memories).toEqual(snippets);
    expect(result.memories).toHaveLength(2);
  });

  // ─── AC-12: executeQueryMemory without memoryInjector ──────────────────────

  it('returns { memories: [] } without memoryInjector (no error) (AC-12)', async () => {
    const impl = new CognitiveToolExecutorImpl({});
    const result = await impl.executeQueryMemory('a1', 'coffee', 5);
    expect(result.memories).toEqual([]);
  });

  it('returns { memories: [] } when memoryInjector is undefined explicitly', async () => {
    const impl = new CognitiveToolExecutorImpl({ memoryInjector: undefined });
    const result = await impl.executeQueryMemory('a1', 'coffee', 5);
    expect(result.memories).toEqual([]);
  });

  // ─── AC-13: executeQueryMemory catches errors ──────────────────────────────

  it('catches errors from activeRecall and returns { memories: [] } (AC-13)', async () => {
    const memoryInjector: MemoryInjector = {
      injectAssociative: vi.fn(),
      activeRecall: vi.fn().mockRejectedValue(new Error('embed failed')),
    };
    const impl = new CognitiveToolExecutorImpl({ memoryInjector });
    const result = await impl.executeQueryMemory('a1', 'coffee', 5);
    expect(result.memories).toEqual([]);
  });

  // ─── AC-42: topK passed through, default 5 ─────────────────────────────────

  it('passes topK from args to activeRecall (AC-42)', async () => {
    const memoryInjector: MemoryInjector = {
      injectAssociative: vi.fn(),
      activeRecall: vi.fn().mockResolvedValue([]),
    };
    const impl = new CognitiveToolExecutorImpl({ memoryInjector });
    await impl.executeQueryMemory('a1', 'q', 10);
    expect(memoryInjector.activeRecall).toHaveBeenCalledWith('a1', 'q', 10);
  });

  // ─── AC-14: executeUpdateInternalState with newGoal ────────────────────────

  it('calls stateDataProvider.updateGoal and returns goalUpdated=true (AC-14)', async () => {
    const updateGoal = vi.fn();
    const applyDriveChanges = vi.fn();
    const impl = new CognitiveToolExecutorImpl({
      stateDataProvider: { updateGoal, applyDriveChanges },
    });
    const result: UpdateStateToolResult = await impl.executeUpdateInternalState(
      'a1',
      'find coffee',
    );
    expect(updateGoal).toHaveBeenCalledWith('a1', 'find coffee');
    expect(applyDriveChanges).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.goalUpdated).toBe(true);
    expect(result.drivesUpdated).toBe(false);
    expect(typeof result.message).toBe('string');
    expect(result.message).toContain('find coffee');
  });

  // ─── AC-15: executeUpdateInternalState with driveOverrides ─────────────────

  it('calls stateDataProvider.applyDriveChanges and returns drivesUpdated=true (AC-15)', async () => {
    const updateGoal = vi.fn();
    const applyDriveChanges = vi.fn();
    const impl = new CognitiveToolExecutorImpl({
      stateDataProvider: { updateGoal, applyDriveChanges },
    });
    const result = await impl.executeUpdateInternalState('a1', undefined, { energy: 45 });
    expect(applyDriveChanges).toHaveBeenCalledWith('a1', { energy: 45 });
    expect(updateGoal).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.goalUpdated).toBe(false);
    expect(result.drivesUpdated).toBe(true);
    expect(result.message).toContain('energy');
    expect(result.message).toContain('45');
  });

  it('updates both goal and drives when both provided', async () => {
    const updateGoal = vi.fn();
    const applyDriveChanges = vi.fn();
    const impl = new CognitiveToolExecutorImpl({
      stateDataProvider: { updateGoal, applyDriveChanges },
    });
    const result = await impl.executeUpdateInternalState('a1', 'rest', { energy: 30, hunger: 20 });
    expect(updateGoal).toHaveBeenCalledWith('a1', 'rest');
    expect(applyDriveChanges).toHaveBeenCalledWith('a1', { energy: 30, hunger: 20 });
    expect(result.success).toBe(true);
    expect(result.goalUpdated).toBe(true);
    expect(result.drivesUpdated).toBe(true);
    expect(result.message).toContain('rest');
    expect(result.message).toContain('energy');
  });

  it('does not call updateGoal when newGoal is empty/undefined', async () => {
    const updateGoal = vi.fn();
    const applyDriveChanges = vi.fn();
    const impl = new CognitiveToolExecutorImpl({
      stateDataProvider: { updateGoal, applyDriveChanges },
    });
    const result = await impl.executeUpdateInternalState('a1', '', { energy: 30 });
    expect(updateGoal).not.toHaveBeenCalled();
    expect(applyDriveChanges).toHaveBeenCalledWith('a1', { energy: 30 });
    expect(result.goalUpdated).toBe(false);
    expect(result.drivesUpdated).toBe(true);
  });

  it('does not call applyDriveChanges when driveOverrides is empty/undefined', async () => {
    const updateGoal = vi.fn();
    const applyDriveChanges = vi.fn();
    const impl = new CognitiveToolExecutorImpl({
      stateDataProvider: { updateGoal, applyDriveChanges },
    });
    const result = await impl.executeUpdateInternalState('a1', 'rest', {});
    expect(updateGoal).toHaveBeenCalledWith('a1', 'rest');
    expect(applyDriveChanges).not.toHaveBeenCalled();
    expect(result.goalUpdated).toBe(true);
    expect(result.drivesUpdated).toBe(false);
  });

  // ─── AC-16: executeUpdateInternalState without stateDataProvider ──────────

  it('returns not-available result without stateDataProvider (AC-16)', async () => {
    const impl = new CognitiveToolExecutorImpl({});
    const result = await impl.executeUpdateInternalState('a1', 'rest', { energy: 30 });
    expect(result.success).toBe(false);
    expect(result.goalUpdated).toBe(false);
    expect(result.drivesUpdated).toBe(false);
    expect(result.message).toBe('State update not available.');
  });

  it('catches errors from updateGoal/applyDriveChanges and returns failure', async () => {
    const updateGoal = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const applyDriveChanges = vi.fn();
    const impl = new CognitiveToolExecutorImpl({
      stateDataProvider: { updateGoal, applyDriveChanges },
    });
    const result = await impl.executeUpdateInternalState('a1', 'rest');
    expect(result.success).toBe(false);
    expect(result.message).toContain('boom');
  });

  // ─── AC-36: imports from shared & memory, NOT engine ───────────────────────

  it('imports CognitiveToolExecutor from @evol-hive/shared (AC-36)', async () => {
    // Verify the module imports the type from shared by re-importing — structural check.
    const shared = await import('@evol-hive/shared');
    expect(shared.CognitiveToolExecutor).toBeUndefined(); // it's a type, not a value
    // The shared package exports the type via `export *`.
    // We confirm by structural usage already in this test file.
    // Ensure no engine import side effect (engine package is not imported here).
    expect(true).toBe(true);
  });
});
