/**
 * Tests for spec 019 — Affordance-as-Tools (shared layer).
 * Covers AC-1 through AC-5: affordanceToToolDefinition, affordancesToToolDefinitions,
 * formatAffordanceEffects, AFFORDANCE_TOOL_PARAMETERS, chooseActionTool deprecation.
 */
import { describe, it, expect } from 'vitest';
import {
  affordanceToToolDefinition,
  affordancesToToolDefinitions,
  formatAffordanceEffects,
  AFFORDANCE_TOOL_PARAMETERS,
  chooseActionTool,
  type Affordance,
  type ToolDefinition,
} from '../src/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAffordance(overrides: Partial<Affordance> = {}): Affordance {
  return {
    id: 'brew_coffee',
    label: 'Brew coffee',
    engineEffect: 'brew_coffee',
    preconditions: [],
    effects: { energy: 20 },
    ...overrides,
  };
}

// ─── AC-3: formatAffordanceEffects ──────────────────────────────────────────

describe('formatAffordanceEffects (AC-3)', () => {
  it('formats a single positive effect', () => {
    expect(formatAffordanceEffects({ energy: 20 })).toBe('energy +20');
  });

  it('formats a single negative effect', () => {
    expect(formatAffordanceEffects({ comfort: -5 })).toBe('comfort -5');
  });

  it('formats multiple effects', () => {
    expect(formatAffordanceEffects({ comfort: -5, energy: 10 })).toBe('comfort -5, energy +10');
  });

  it('returns "none" for an empty effects object', () => {
    expect(formatAffordanceEffects({})).toBe('none');
  });

  it('formats a zero effect', () => {
    expect(formatAffordanceEffects({ energy: 0 })).toBe('energy +0');
  });
});

// ─── AC-5: AFFORDANCE_TOOL_PARAMETERS ───────────────────────────────────────

describe('AFFORDANCE_TOOL_PARAMETERS (AC-5)', () => {
  it('equals { type: "object", properties: {}, additionalProperties: false }', () => {
    expect(AFFORDANCE_TOOL_PARAMETERS).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });
});

// ─── AC-1: affordanceToToolDefinition ───────────────────────────────────────

describe('affordanceToToolDefinition (AC-1)', () => {
  it('returns a ToolDefinition with function.name === affordance.id', () => {
    const aff = makeAffordance();
    const tool = affordanceToToolDefinition(aff);
    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe('brew_coffee');
  });

  it('function.description contains the affordance label', () => {
    const aff = makeAffordance({ label: 'Brew coffee' });
    const tool = affordanceToToolDefinition(aff);
    expect(tool.function.description).toContain('Brew coffee');
  });

  it('function.description contains formatted effects', () => {
    const aff = makeAffordance({ effects: { energy: 20 } });
    const tool = affordanceToToolDefinition(aff);
    expect(tool.function.description).toContain('energy +20');
  });

  it('function.description contains "Effects:" prefix', () => {
    const aff = makeAffordance({ effects: { energy: 20 } });
    const tool = affordanceToToolDefinition(aff);
    expect(tool.function.description).toContain('Effects:');
  });

  it('function.description says "none" when effects are empty', () => {
    const aff = makeAffordance({ effects: {} });
    const tool = affordanceToToolDefinition(aff);
    expect(tool.function.description).toContain('none');
  });

  it('function.parameters is the empty object schema', () => {
    const aff = makeAffordance();
    const tool = affordanceToToolDefinition(aff);
    expect(tool.function.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('function.parameters equals AFFORDANCE_TOOL_PARAMETERS', () => {
    const aff = makeAffordance();
    const tool = affordanceToToolDefinition(aff);
    expect(tool.function.parameters).toBe(AFFORDANCE_TOOL_PARAMETERS);
  });

  it('produces a valid ToolDefinition type', () => {
    const aff = makeAffordance();
    const tool: ToolDefinition = affordanceToToolDefinition(aff);
    expect(tool.type).toBe('function');
    expect(typeof tool.function.name).toBe('string');
    expect(typeof tool.function.description).toBe('string');
    expect(typeof tool.function.parameters).toBe('object');
  });
});

// ─── AC-2: affordancesToToolDefinitions ─────────────────────────────────────

describe('affordancesToToolDefinitions (AC-2)', () => {
  it('maps an array of Affordances to ToolDefinitions', () => {
    const affs = [
      makeAffordance({ id: 'brew_coffee', label: 'Brew coffee', effects: { energy: 20 } }),
      makeAffordance({ id: 'observe', label: 'Observe', effects: {} }),
    ];
    const tools = affordancesToToolDefinitions(affs);
    expect(tools).toHaveLength(2);
    expect(tools[0]!.function.name).toBe('brew_coffee');
    expect(tools[1]!.function.name).toBe('observe');
  });

  it('returns an empty array for empty input', () => {
    expect(affordancesToToolDefinitions([])).toEqual([]);
  });

  it('preserves order of input affordances', () => {
    const affs = [
      makeAffordance({ id: 'zzz' }),
      makeAffordance({ id: 'aaa' }),
      makeAffordance({ id: 'mmm' }),
    ];
    const tools = affordancesToToolDefinitions(affs);
    expect(tools.map((t) => t.function.name)).toEqual(['zzz', 'aaa', 'mmm']);
  });
});

// ─── AC-4: chooseActionTool deprecation ─────────────────────────────────────

describe('chooseActionTool deprecation (AC-4)', () => {
  it('is still exported from @evol-hive/shared', () => {
    expect(chooseActionTool).toBeDefined();
    expect(chooseActionTool.function.name).toBe('choose_action');
  });

  it('existing imports compile without errors (typecheck)', () => {
    // If this file compiles and runs, the import works.
    const tool = chooseActionTool;
    expect(tool.type).toBe('function');
  });
});
