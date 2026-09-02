/**
 * Type-level tests for Reflect phase types (ReflectResult, ReflectLLMResponse,
 * MemoryEntryInput, ReflectDataProvider) and the reflectSchema constant.
 *
 * Covers AC-1 through AC-5, AC-4 (schema).
 */
import { describe, it, expect } from 'vitest';
import type {
  ReflectResult,
  ReflectLLMResponse,
  MemoryEntryInput,
  ReflectDataProvider,
  AgentInternalState,
  MemoryType,
} from '../src/index.js';
import { reflectSchema } from '../src/index.js';

// ─── ReflectResult (AC-1) ────────────────────────────────────────────────────

describe('ReflectResult type (AC-1)', () => {
  it('allows a success result with all flags true', () => {
    const result: ReflectResult = {
      success: true,
      cycleComplete: true,
      memoryStored: true,
      goalUpdated: true,
      drivesUpdated: true,
    };
    expect(result.success).toBe(true);
    expect(result.cycleComplete).toBe(true);
    expect(result.memoryStored).toBe(true);
    expect(result.goalUpdated).toBe(true);
    expect(result.drivesUpdated).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('allows a failure result with error and all flags false', () => {
    const result: ReflectResult = {
      success: false,
      error: 'Agent not found',
      cycleComplete: false,
      memoryStored: false,
      goalUpdated: false,
      drivesUpdated: false,
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Agent not found');
    expect(result.cycleComplete).toBe(false);
    expect(result.memoryStored).toBe(false);
    expect(result.goalUpdated).toBe(false);
    expect(result.drivesUpdated).toBe(false);
  });

  it('allows a success result with no updates (empty LLM response)', () => {
    const result: ReflectResult = {
      success: true,
      cycleComplete: true,
      memoryStored: false,
      goalUpdated: false,
      drivesUpdated: false,
    };
    expect(result.success).toBe(true);
    expect(result.cycleComplete).toBe(true);
    expect(result.memoryStored).toBe(false);
  });
});

// ─── ReflectLLMResponse (AC-2) ───────────────────────────────────────────────

describe('ReflectLLMResponse type (AC-2)', () => {
  it('allows an empty object (no updates)', () => {
    const response: ReflectLLMResponse = {};
    expect(response.newGoal).toBeUndefined();
    expect(response.driveOverrides).toBeUndefined();
    expect(response.memoryEntry).toBeUndefined();
  });

  it('allows all three fields', () => {
    const response: ReflectLLMResponse = {
      newGoal: 'Find food',
      driveOverrides: { hunger: 30 },
      memoryEntry: {
        content: 'Ate snacks from the fridge',
        importance: 5,
        type: 'action',
      },
    };
    expect(response.newGoal).toBe('Find food');
    expect(response.driveOverrides).toEqual({ hunger: 30 });
    expect(response.memoryEntry?.content).toBe('Ate snacks from the fridge');
  });

  it('allows only newGoal', () => {
    const response: ReflectLLMResponse = { newGoal: 'Explore the house' };
    expect(response.newGoal).toBe('Explore the house');
    expect(response.driveOverrides).toBeUndefined();
    expect(response.memoryEntry).toBeUndefined();
  });
});

// ─── MemoryEntryInput (AC-3) ─────────────────────────────────────────────────

describe('MemoryEntryInput type (AC-3)', () => {
  it('allows a full entry with location', () => {
    const entry: MemoryEntryInput = {
      content: 'Found a key in the drawer',
      importance: 7,
      type: 'observation',
      location: 'bedroom',
    };
    expect(entry.content).toBe('Found a key in the drawer');
    expect(entry.importance).toBe(7);
    expect(entry.type).toBe('observation');
    expect(entry.location).toBe('bedroom');
  });

  it('allows an entry without location', () => {
    const entry: MemoryEntryInput = {
      content: 'Reflected on my goals',
      importance: 8,
      type: 'reflection',
    };
    expect(entry.content).toBe('Reflected on my goals');
    expect(entry.importance).toBe(8);
    expect(entry.type).toBe('reflection');
    expect(entry.location).toBeUndefined();
  });

  it('supports all MemoryType values', () => {
    const types: MemoryType[] = ['observation', 'reflection', 'action', 'interaction'];
    for (const t of types) {
      const entry: MemoryEntryInput = {
        content: `Did ${t}`,
        importance: 5,
        type: t,
      };
      expect(entry.type).toBe(t);
    }
  });
});

// ─── reflectSchema (AC-4) ─────────────────────────────────────────────────────

describe('reflectSchema constant (AC-4)', () => {
  it('is an object with type "object"', () => {
    expect(reflectSchema.type).toBe('object');
  });

  it('has newGoal as string|null', () => {
    expect(reflectSchema.properties.newGoal).toEqual({ type: ['string', 'null'] });
  });

  it('has driveOverrides as object with number additionalProperties', () => {
    expect(reflectSchema.properties.driveOverrides).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
    });
  });

  // Spec 025: memoryEntry replaced with flattened top-level fields
  it('has memoryContent as a top-level string property', () => {
    expect(reflectSchema.properties.memoryContent).toBeDefined();
    expect(reflectSchema.properties.memoryContent.type).toBe('string');
  });

  it('has memoryImportance as a top-level integer property with min 1, max 10', () => {
    const impSchema = reflectSchema.properties.memoryImportance;
    expect(impSchema.type).toBe('integer');
    expect(impSchema.minimum).toBe(1);
    expect(impSchema.maximum).toBe(10);
  });

  it('has memoryType as a top-level string enum', () => {
    const typeSchema = reflectSchema.properties.memoryType;
    expect(typeSchema.type).toBe('string');
    expect(typeSchema.enum).toEqual(['observation', 'reflection', 'action', 'interaction']);
  });

  it('has memoryLocation as a top-level string property', () => {
    expect(reflectSchema.properties.memoryLocation).toBeDefined();
    expect(reflectSchema.properties.memoryLocation.type).toBe('string');
  });

  it('does NOT have a nested memoryEntry property', () => {
    expect(reflectSchema.properties.memoryEntry).toBeUndefined();
  });

  it('has "memoryContent" in the required array (spec 025, AC-5)', () => {
    expect(reflectSchema.required).toContain('memoryContent');
  });

  it('does NOT include memoryImportance, memoryType, or memoryLocation in required', () => {
    expect(reflectSchema.required).not.toContain('memoryImportance');
    expect(reflectSchema.required).not.toContain('memoryType');
    expect(reflectSchema.required).not.toContain('memoryLocation');
  });

  it('has additionalProperties: false at the top level', () => {
    expect(reflectSchema.additionalProperties).toBe(false);
  });
});

// ─── ReflectDataProvider (AC-5) ──────────────────────────────────────────────

describe('ReflectDataProvider interface (AC-5)', () => {
  it('can be implemented with all 6 required methods', () => {
    const provider: ReflectDataProvider = {
      getAgentState(_agentId: string): AgentInternalState | null {
        return null;
      },
      applyDriveChanges(_agentId: string, _changes: Partial<Record<string, number>>): void {
        // no-op
      },
      updateGoal(_agentId: string, _goal: string): void {
        // no-op
      },
      async storeMemory(_agentId: string, _entry: MemoryEntryInput): Promise<void> {
        // no-op
      },
      clearPlanIfComplete(_agentId: string): boolean {
        return false;
      },
      setThinking(_agentId: string, _isThinking: boolean): void {
        // no-op
      },
    };

    expect(provider.getAgentState('a1')).toBeNull();
    expect(() => provider.applyDriveChanges('a1', { hunger: 20 })).not.toThrow();
    expect(() => provider.updateGoal('a1', 'new goal')).not.toThrow();
    expect(() =>
      provider.storeMemory('a1', {
        content: 'test',
        importance: 5,
        type: 'action',
      }),
    ).not.toThrow();
    expect(provider.clearPlanIfComplete('a1')).toBe(false);
    expect(() => provider.setThinking('a1', true)).not.toThrow();
  });
});
