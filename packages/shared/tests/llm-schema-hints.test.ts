/**
 * Tests for the four schema hint constants exported from
 * `@evol-hive/shared` (spec 010, issue #37).
 *
 * Covers acceptance criteria AC-2, AC-3, AC-4, AC-5.
 */
import { describe, it, expect } from 'vitest';
import {
  PLAN_SCHEMA_HINT,
  ACTION_RESPONSE_SCHEMA_HINT,
  REFLECT_SCHEMA_HINT,
  MEMORY_CONSOLIDATION_SCHEMA_HINT,
} from '../src/schemas/llm-schemas.js';

describe('Schema hint constants (spec 010, AC-2..AC-5)', () => {
  it('PLAN_SCHEMA_HINT has the exact value specified in the spec (AC-2)', () => {
    const expected =
      'Respond with JSON in this exact format: {"description": "<plan description>", "steps": [{"description": "<step description>", "targetAffordance": "<affordance id or null>"}]}';
    expect(PLAN_SCHEMA_HINT).toBe(expected);
  });

  it('ACTION_RESPONSE_SCHEMA_HINT has the exact value specified in the spec (AC-3)', () => {
    const expected =
      'Respond with JSON in this exact format: {"reasoning": "<your reasoning>", "action": "<affordance id or cognitive tool name>", "actionArgs": {}, "observeTarget": "<object id or null>", "updatedGoal": "<new goal or null>"}';
    expect(ACTION_RESPONSE_SCHEMA_HINT).toBe(expected);
  });

  it('REFLECT_SCHEMA_HINT has the exact value specified in the spec (AC-4)', () => {
    const expected =
      'Respond with JSON in this exact format: {"newGoal": "<new goal or null>", "driveOverrides": {"<driveName>": <value>}, "memoryEntry": {"content": "<description>", "importance": 1, "type": "observation", "location": "<room or null>"}}';
    expect(REFLECT_SCHEMA_HINT).toBe(expected);
  });

  it('MEMORY_CONSOLIDATION_SCHEMA_HINT has the exact value specified in the spec (AC-5)', () => {
    const expected =
      'Respond with JSON in this exact format: {"consolidatedMemories": [{"content": "<description>", "importance": 1, "type": "observation"}], "consolidatedNodeIds": ["<nodeId>"]}';
    expect(MEMORY_CONSOLIDATION_SCHEMA_HINT).toBe(expected);
  });

  it('all four constants are strings', () => {
    expect(typeof PLAN_SCHEMA_HINT).toBe('string');
    expect(typeof ACTION_RESPONSE_SCHEMA_HINT).toBe('string');
    expect(typeof REFLECT_SCHEMA_HINT).toBe('string');
    expect(typeof MEMORY_CONSOLIDATION_SCHEMA_HINT).toBe('string');
  });

  it('all four constants are non-empty', () => {
    expect(PLAN_SCHEMA_HINT.length).toBeGreaterThan(0);
    expect(ACTION_RESPONSE_SCHEMA_HINT.length).toBeGreaterThan(0);
    expect(REFLECT_SCHEMA_HINT.length).toBeGreaterThan(0);
    expect(MEMORY_CONSOLIDATION_SCHEMA_HINT.length).toBeGreaterThan(0);
  });
});
