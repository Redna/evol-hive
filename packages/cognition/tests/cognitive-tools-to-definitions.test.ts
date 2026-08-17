/**
 * Tests for cognitiveToolsToToolDefinitions helper (spec 011, issue #40).
 * Covers AC-26.
 */
import { describe, it, expect } from 'vitest';
import type { CognitiveTool, ToolDefinition } from '@evol-hive/shared';
import { cognitiveToolsToToolDefinitions } from '../src/tools/index.js';
import { defaultCognitiveTools } from '../src/tools/index.js';

describe('cognitiveToolsToToolDefinitions (AC-26)', () => {
  it('converts CognitiveTool[] to ToolDefinition[]', () => {
    const result = cognitiveToolsToToolDefinitions(defaultCognitiveTools);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(defaultCognitiveTools.length);
  });

  it('each ToolDefinition has type "function"', () => {
    const result = cognitiveToolsToToolDefinitions(defaultCognitiveTools);
    for (const td of result) {
      expect(td.type).toBe('function');
    }
  });

  it('maps CognitiveTool.name to ToolDefinition.function.name', () => {
    const result = cognitiveToolsToToolDefinitions(defaultCognitiveTools);
    for (let i = 0; i < defaultCognitiveTools.length; i++) {
      expect(result[i]!.function.name).toBe(defaultCognitiveTools[i]!.name);
    }
  });

  it('maps CognitiveTool.description to ToolDefinition.function.description', () => {
    const result = cognitiveToolsToToolDefinitions(defaultCognitiveTools);
    for (let i = 0; i < defaultCognitiveTools.length; i++) {
      expect(result[i]!.function.description).toBe(defaultCognitiveTools[i]!.description);
    }
  });

  it('maps CognitiveTool.argsSchema to ToolDefinition.function.parameters', () => {
    const result = cognitiveToolsToToolDefinitions(defaultCognitiveTools);
    for (let i = 0; i < defaultCognitiveTools.length; i++) {
      expect(result[i]!.function.parameters).toEqual(defaultCognitiveTools[i]!.argsSchema);
    }
  });

  it('returns empty array for empty input', () => {
    expect(cognitiveToolsToToolDefinitions([])).toEqual([]);
  });

  it('works with a single custom tool', () => {
    const tool: CognitiveTool = {
      name: 'formulate_plan',
      description: 'Test tool',
      argsSchema: { type: 'object', properties: { x: { type: 'string' } } },
    };
    const result = cognitiveToolsToToolDefinitions([tool]);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('function');
    expect(result[0]!.function.name).toBe('formulate_plan');
    expect(result[0]!.function.description).toBe('Test tool');
    expect(result[0]!.function.parameters).toEqual(tool.argsSchema);
  });

  it('is exported from tools/index.ts', () => {
    expect(typeof cognitiveToolsToToolDefinitions).toBe('function');
  });
});
