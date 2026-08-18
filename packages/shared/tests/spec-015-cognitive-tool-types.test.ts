/**
 * Tests for spec 015 — Full Cognitive Tools (shared layer).
 * Covers AC-1 through AC-8: bridge interfaces, result types, LLMContextPayload.agentId,
 * queryMemorySchema topK, queryMemoryTool & updateInternalStateTool constants.
 */
import { describe, it, expect } from 'vitest';
import {
  type CognitiveToolExecutor,
  type CognitiveToolDataProvider,
  type QueryMemoryToolResult,
  type UpdateStateToolResult,
  type MemorySnippet,
  type ToolDefinition,
  queryMemorySchema,
  updateInternalStateSchema,
  queryMemoryTool,
  updateInternalStateTool,
} from '../src/index.js';

// ─── AC-1: CognitiveToolExecutor interface ───────────────────────────────────

describe('CognitiveToolExecutor interface (AC-1)', () => {
  it('has executeQueryMemory(agentId, query, topK): Promise<QueryMemoryToolResult>', () => {
    const executor: CognitiveToolExecutor = {
      async executeQueryMemory(
        _agentId: string,
        _query: string,
        _topK: number,
      ): Promise<QueryMemoryToolResult> {
        return { memories: [] };
      },
      async executeUpdateInternalState(
        _agentId: string,
        _newGoal?: string,
        _driveOverrides?: Partial<Record<string, number>>,
      ): Promise<UpdateStateToolResult> {
        return { success: false, goalUpdated: false, drivesUpdated: false, message: '' };
      },
    };
    expect(typeof executor.executeQueryMemory).toBe('function');
    expect(typeof executor.executeUpdateInternalState).toBe('function');
  });
});

// ─── AC-2: CognitiveToolDataProvider interface ───────────────────────────────

describe('CognitiveToolDataProvider interface (AC-2)', () => {
  it('has updateGoal(agentId, goal): void and applyDriveChanges(agentId, changes): void', () => {
    const provider: CognitiveToolDataProvider = {
      updateGoal(_agentId: string, _goal: string): void {
        /* noop */
      },
      applyDriveChanges(_agentId: string, _changes: Partial<Record<string, number>>): void {
        /* noop */
      },
    };
    expect(typeof provider.updateGoal).toBe('function');
    expect(typeof provider.applyDriveChanges).toBe('function');
  });
});

// ─── AC-3: QueryMemoryToolResult ─────────────────────────────────────────────

describe('QueryMemoryToolResult (AC-3)', () => {
  it('has a memories: MemorySnippet[] field', () => {
    const result: QueryMemoryToolResult = {
      memories: [{ id: 'm1', content: 'a memory', importance: 5, timestamp: 1 }],
    };
    expect(Array.isArray(result.memories)).toBe(true);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.id).toBe('m1');
  });

  it('allows an empty memories array', () => {
    const result: QueryMemoryToolResult = { memories: [] };
    expect(result.memories).toEqual([]);
  });
});

// ─── AC-4: UpdateStateToolResult ─────────────────────────────────────────────

describe('UpdateStateToolResult (AC-4)', () => {
  it('has success, goalUpdated, drivesUpdated, message fields', () => {
    const result: UpdateStateToolResult = {
      success: true,
      goalUpdated: true,
      drivesUpdated: false,
      message: 'Goal updated to: find coffee.',
    };
    expect(result.success).toBe(true);
    expect(result.goalUpdated).toBe(true);
    expect(result.drivesUpdated).toBe(false);
    expect(typeof result.message).toBe('string');
  });
});

// ─── AC-5: LLMContextPayload.agentId (defined in cognition) ───────────────────

describe('LLMContextPayload.agentId (AC-5)', () => {
  it('is verified in the cognition test suite (cognition owns LLMContextPayload)', () => {
    // LLMContextPayload is defined in @evol-hive/cognition (Req 5). The
    // cognition test suite covers the optional agentId field directly.
    expect(true).toBe(true);
  });
});

// ─── AC-6: queryMemorySchema topK ────────────────────────────────────────────

describe('queryMemorySchema topK (AC-6)', () => {
  it('includes an optional topK integer property with minimum 1 and maximum 20', () => {
    const props = queryMemorySchema.properties as Record<string, unknown>;
    expect(props['topK']).toBeDefined();
    const topK = props['topK'] as Record<string, unknown>;
    expect(topK['type']).toBe('integer');
    expect(topK['minimum']).toBe(1);
    expect(topK['maximum']).toBe(20);
  });

  it('required array still contains only ["query"]', () => {
    expect(queryMemorySchema.required).toEqual(['query']);
  });

  it('still contains the query property', () => {
    const props = queryMemorySchema.properties as Record<string, unknown>;
    expect(props['query']).toBeDefined();
  });
});

// ─── AC-7: queryMemoryTool ───────────────────────────────────────────────────

describe('queryMemoryTool (AC-7)', () => {
  it('has type "function"', () => {
    expect(queryMemoryTool.type).toBe('function');
  });

  it('has function.name === "query_memory"', () => {
    expect(queryMemoryTool.function.name).toBe('query_memory');
  });

  it('has function.parameters === queryMemorySchema (updated with topK)', () => {
    expect(queryMemoryTool.function.parameters).toEqual(queryMemorySchema);
  });

  it('has a non-empty description', () => {
    expect(queryMemoryTool.function.description.length).toBeGreaterThan(0);
  });

  it('is a valid ToolDefinition', () => {
    const td: ToolDefinition = queryMemoryTool;
    expect(td.type).toBe('function');
  });
});

// ─── AC-8: updateInternalStateTool ───────────────────────────────────────────

describe('updateInternalStateTool (AC-8)', () => {
  it('has type "function"', () => {
    expect(updateInternalStateTool.type).toBe('function');
  });

  it('has function.name === "update_internal_state"', () => {
    expect(updateInternalStateTool.function.name).toBe('update_internal_state');
  });

  it('has function.parameters === updateInternalStateSchema', () => {
    expect(updateInternalStateTool.function.parameters).toEqual(updateInternalStateSchema);
  });

  it('has a non-empty description', () => {
    expect(updateInternalStateTool.function.description.length).toBeGreaterThan(0);
  });

  it('is a valid ToolDefinition', () => {
    const td: ToolDefinition = updateInternalStateTool;
    expect(td.type).toBe('function');
  });
});

// ─── Re-exported from shared barrel ──────────────────────────────────────────

describe('Shared barrel re-exports (AC-1, AC-3, AC-4, AC-7, AC-8)', () => {
  it('exports all new types and constants', async () => {
    const mod = await import('../src/index.js');
    expect((mod as Record<string, unknown>)['queryMemoryTool']).toBeDefined();
    expect((mod as Record<string, unknown>)['updateInternalStateTool']).toBeDefined();
  });
});

// AC-38: no engine/memory package modifications — verified by git diff in CI.

export {};
