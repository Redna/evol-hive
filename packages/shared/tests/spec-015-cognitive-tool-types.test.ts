/**
 * Tests for spec 015 — Full Cognitive Tools shared-layer types & tool defs.
 * Covers AC-1 through AC-8 (shared package slice).
 */
import { describe, it, expect } from 'vitest';
import {
  queryMemorySchema,
  updateInternalStateSchema,
  queryMemoryTool,
  updateInternalStateTool,
  type CognitiveToolExecutor,
  type CognitiveToolDataProvider,
  type QueryMemoryToolResult,
  type UpdateStateToolResult,
  type MemorySnippet,
  type ToolDefinition,
} from '../src/index.js';

// ─── AC-1: CognitiveToolExecutor interface ──────────────────────────────────

describe('CognitiveToolExecutor interface (AC-1)', () => {
  it('can be implemented with executeQueryMemory and executeUpdateInternalState', async () => {
    const impl: CognitiveToolExecutor = {
      async executeQueryMemory(_agentId, _query, _topK): Promise<QueryMemoryToolResult> {
        return { memories: [] };
      },
      async executeUpdateInternalState(
        _agentId,
        _newGoal?,
        _driveOverrides?,
      ): Promise<UpdateStateToolResult> {
        return { success: true, goalUpdated: false, drivesUpdated: false, message: 'ok' };
      },
    };
    const qm = await impl.executeQueryMemory('a1', 'q', 5);
    expect(Array.isArray(qm.memories)).toBe(true);
    const us = await impl.executeUpdateInternalState('a1');
    expect(typeof us.success).toBe('boolean');
    expect(typeof us.goalUpdated).toBe('boolean');
    expect(typeof us.drivesUpdated).toBe('boolean');
    expect(typeof us.message).toBe('string');
  });

  it('executeQueryMemory signature: (agentId: string, query: string, topK: number) => Promise<QueryMemoryToolResult>', () => {
    const impl: CognitiveToolExecutor = {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      executeQueryMemory: (agentId, query, topK) =>
        Promise.resolve({ memories: [] }) as Promise<QueryMemoryToolResult>,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      executeUpdateInternalState: (agentId, newGoal?, driveOverrides?) =>
        Promise.resolve({ success: true, goalUpdated: false, drivesUpdated: false, message: '' }),
    };
    expect(typeof impl.executeQueryMemory).toBe('function');
    expect(impl.executeQueryMemory.length).toBe(3);
  });
});

// ─── AC-2: CognitiveToolDataProvider interface ──────────────────────────────

describe('CognitiveToolDataProvider interface (AC-2)', () => {
  it('can be implemented with updateGoal and applyDriveChanges', () => {
    const dp: CognitiveToolDataProvider = {
      updateGoal: (_agentId, _goal) => {},
      applyDriveChanges: (_agentId, _changes) => {},
    };
    expect(typeof dp.updateGoal).toBe('function');
    expect(typeof dp.applyDriveChanges).toBe('function');
  });

  it('updateGoal signature: (agentId: string, goal: string) => void', () => {
    const dp: CognitiveToolDataProvider = {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      updateGoal: (agentId, goal) => {},
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      applyDriveChanges: (agentId, changes) => {},
    };
    expect(dp.updateGoal.length).toBe(2);
    expect(dp.applyDriveChanges.length).toBe(2);
  });
});

// ─── AC-3: QueryMemoryToolResult ────────────────────────────────────────────

describe('QueryMemoryToolResult (AC-3)', () => {
  it('has memories: MemorySnippet[]', () => {
    const result: QueryMemoryToolResult = { memories: [] };
    expect(Array.isArray(result.memories)).toBe(true);
  });

  it('memories can contain MemorySnippet objects', () => {
    const snippet: MemorySnippet = {
      id: 'mem-1',
      content: 'I brewed coffee yesterday.',
      importance: 5,
      timestamp: 1000,
    };
    const result: QueryMemoryToolResult = { memories: [snippet] };
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.id).toBe('mem-1');
  });
});

// ─── AC-4: UpdateStateToolResult ────────────────────────────────────────────

describe('UpdateStateToolResult (AC-4)', () => {
  it('has success, goalUpdated, drivesUpdated, message', () => {
    const result: UpdateStateToolResult = {
      success: true,
      goalUpdated: true,
      drivesUpdated: false,
      message: 'Goal updated to: find coffee.',
    };
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.goalUpdated).toBe('boolean');
    expect(typeof result.drivesUpdated).toBe('boolean');
    expect(typeof result.message).toBe('string');
  });
});

// ─── AC-6: queryMemorySchema with topK ──────────────────────────────────────

describe('queryMemorySchema with topK (AC-6)', () => {
  it('includes topK in properties with type integer, minimum 1, maximum 20', () => {
    const props = queryMemorySchema.properties as Record<string, unknown>;
    expect(props['topK']).toBeDefined();
    const topK = props['topK'] as Record<string, unknown>;
    expect(topK['type']).toBe('integer');
    expect(topK['minimum']).toBe(1);
    expect(topK['maximum']).toBe(20);
  });

  it('query is still required; topK is NOT required', () => {
    expect(queryMemorySchema.required).toEqual(['query']);
  });

  it('additionalProperties is false', () => {
    expect(queryMemorySchema.additionalProperties).toBe(false);
  });
});

// ─── AC-7: queryMemoryTool constant ─────────────────────────────────────────

describe('queryMemoryTool (AC-7)', () => {
  it('is a ToolDefinition with function.name === "query_memory"', () => {
    const td = queryMemoryTool as ToolDefinition;
    expect(td.type).toBe('function');
    expect(td.function.name).toBe('query_memory');
    expect(typeof td.function.description).toBe('string');
    expect(td.function.description.length).toBeGreaterThan(0);
  });

  it('function.parameters === queryMemorySchema (the updated schema with topK)', () => {
    expect(queryMemoryTool.function.parameters).toBe(queryMemorySchema);
    const params = queryMemoryTool.function.parameters as Record<string, unknown>;
    const props = params['properties'] as Record<string, unknown>;
    expect(props['topK']).toBeDefined();
  });
});

// ─── AC-8: updateInternalStateTool constant ─────────────────────────────────

describe('updateInternalStateTool (AC-8)', () => {
  it('is a ToolDefinition with function.name === "update_internal_state"', () => {
    const td = updateInternalStateTool as ToolDefinition;
    expect(td.type).toBe('function');
    expect(td.function.name).toBe('update_internal_state');
    expect(typeof td.function.description).toBe('string');
    expect(td.function.description.length).toBeGreaterThan(0);
  });

  it('function.parameters === updateInternalStateSchema', () => {
    expect(updateInternalStateTool.function.parameters).toBe(updateInternalStateSchema);
  });
});
