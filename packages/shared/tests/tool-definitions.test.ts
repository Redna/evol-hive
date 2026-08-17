/**
 * Tests for tool definition constants and ToolDefinition type (spec 011, issue #40).
 *
 * Covers AC-1, AC-3, AC-4, AC-5, AC-6, AC-7.
 */
import { describe, it, expect } from 'vitest';
import {
  formulatePlanTool,
  chooseActionTool,
  reflectTool,
  memoryConsolidationTool,
  formulatePlanSchema,
  llmActionResponseSchema,
  reflectSchema,
  memoryConsolidationSchema,
  type ToolDefinition,
} from '../src/index.js';

// ─── AC-1: ToolDefinition type ───────────────────────────────────────────────

describe('ToolDefinition type (AC-1)', () => {
  it('has type "function" and function.name, function.description, function.parameters', () => {
    const td: ToolDefinition = {
      type: 'function',
      function: {
        name: 'test_tool',
        description: 'A test tool',
        parameters: { type: 'object', properties: {} },
      },
    };
    expect(td.type).toBe('function');
    expect(td.function.name).toBe('test_tool');
    expect(typeof td.function.description).toBe('string');
    expect(typeof td.function.parameters).toBe('object');
  });
});

// ─── AC-3: formulatePlanTool ─────────────────────────────────────────────────

describe('formulatePlanTool (AC-3)', () => {
  it('has type "function"', () => {
    expect(formulatePlanTool.type).toBe('function');
  });

  it('has function.name === "formulate_plan"', () => {
    expect(formulatePlanTool.function.name).toBe('formulate_plan');
  });

  it('has function.parameters === formulatePlanSchema', () => {
    expect(formulatePlanTool.function.parameters).toEqual(formulatePlanSchema);
  });

  it('has a non-empty description', () => {
    expect(formulatePlanTool.function.description.length).toBeGreaterThan(0);
  });
});

// ─── AC-4: chooseActionTool ──────────────────────────────────────────────────

describe('chooseActionTool (AC-4)', () => {
  it('has type "function"', () => {
    expect(chooseActionTool.type).toBe('function');
  });

  it('has function.name === "choose_action"', () => {
    expect(chooseActionTool.function.name).toBe('choose_action');
  });

  it('has function.parameters === llmActionResponseSchema', () => {
    expect(chooseActionTool.function.parameters).toEqual(llmActionResponseSchema);
  });

  it('has a non-empty description', () => {
    expect(chooseActionTool.function.description.length).toBeGreaterThan(0);
  });
});

// ─── AC-5: reflectTool ───────────────────────────────────────────────────────

describe('reflectTool (AC-5)', () => {
  it('has type "function"', () => {
    expect(reflectTool.type).toBe('function');
  });

  it('has function.name === "reflect"', () => {
    expect(reflectTool.function.name).toBe('reflect');
  });

  it('has function.parameters === reflectSchema', () => {
    expect(reflectTool.function.parameters).toEqual(reflectSchema);
  });

  it('has a non-empty description', () => {
    expect(reflectTool.function.description.length).toBeGreaterThan(0);
  });
});

// ─── AC-6: memoryConsolidationTool ───────────────────────────────────────────

describe('memoryConsolidationTool (AC-6)', () => {
  it('has type "function"', () => {
    expect(memoryConsolidationTool.type).toBe('function');
  });

  it('has function.name === "consolidate_memories"', () => {
    expect(memoryConsolidationTool.function.name).toBe('consolidate_memories');
  });

  it('has function.parameters === memoryConsolidationSchema', () => {
    expect(memoryConsolidationTool.function.parameters).toEqual(memoryConsolidationSchema);
  });

  it('has a non-empty description', () => {
    expect(memoryConsolidationTool.function.description.length).toBeGreaterThan(0);
  });
});

// ─── AC-7: Removed constants ─────────────────────────────────────────────────

describe('Removed superseded constants (AC-7)', () => {
  // We import the barrel and check that these constants are not present.
  // In ESM, we can't use require, so we check the module exports.
  it('JSON_INSTRUCTION_SUFFIX is no longer exported from shared barrel', async () => {
    const mod = await import('../src/index.js');
    expect((mod as Record<string, unknown>)['JSON_INSTRUCTION_SUFFIX']).toBeUndefined();
  });

  it('PLAN_SCHEMA_HINT is no longer exported from shared barrel', async () => {
    const mod = await import('../src/index.js');
    expect((mod as Record<string, unknown>)['PLAN_SCHEMA_HINT']).toBeUndefined();
  });

  it('ACTION_RESPONSE_SCHEMA_HINT is no longer exported from shared barrel', async () => {
    const mod = await import('../src/index.js');
    expect((mod as Record<string, unknown>)['ACTION_RESPONSE_SCHEMA_HINT']).toBeUndefined();
  });

  it('REFLECT_SCHEMA_HINT is no longer exported from shared barrel', async () => {
    const mod = await import('../src/index.js');
    expect((mod as Record<string, unknown>)['REFLECT_SCHEMA_HINT']).toBeUndefined();
  });

  it('MEMORY_CONSOLIDATION_SCHEMA_HINT is no longer exported from shared barrel', async () => {
    const mod = await import('../src/index.js');
    expect((mod as Record<string, unknown>)['MEMORY_CONSOLIDATION_SCHEMA_HINT']).toBeUndefined();
  });
});
