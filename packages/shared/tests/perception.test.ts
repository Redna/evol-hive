import { describe, it, expect } from 'vitest';
import type {
  PerceptionResult,
  PassivePerception,
  Affordance,
  MemorySnippet,
  SmartObjectSummary,
  PerceptionDataProvider,
} from '../src/index.js';

describe('PerceptionResult (AC-17)', () => {
  it('is defined with passive, prunedAffordances, and primaryDriveLabel fields', () => {
    const passive: PassivePerception = {
      roomId: 'kitchen',
      objectsPresent: [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
      drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    };
    const prunedAffordances: Affordance[] = [
      {
        id: 'brew_coffee',
        label: 'Brew a cup of coffee',
        engineEffect: 'brew_coffee',
        preconditions: ['has_water'],
        effects: { energy: 20 },
      },
    ];
    const result: PerceptionResult = {
      passive,
      prunedAffordances,
      primaryDriveLabel: 'low energy, need to restore energy',
    };

    expect(result.passive).toBe(passive);
    expect(result.prunedAffordances).toBe(prunedAffordances);
    expect(result.primaryDriveLabel).toBe('low energy, need to restore energy');
  });
});

describe('PassivePerception.associativeMemories (AC-20)', () => {
  it('may be undefined when no memory subsystem is wired', () => {
    const passive: PassivePerception = {
      roomId: 'kitchen',
      objectsPresent: [],
      drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    };
    expect(passive.associativeMemories).toBeUndefined();
  });

  it('allows MemorySnippet[] when a memory subsystem is wired', () => {
    const memories: MemorySnippet[] = [
      { id: 'm1', content: 'I brewed coffee here before', importance: 7, timestamp: 100 },
    ];
    const passive: PassivePerception = {
      roomId: 'kitchen',
      objectsPresent: [],
      drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      associativeMemories: memories,
    };
    expect(passive.associativeMemories).toHaveLength(1);
    expect(passive.associativeMemories?.[0]?.id).toBe('m1');
  });
});

describe('SmartObjectSummary', () => {
  it('carries only id, name, type (no state or affordances)', () => {
    const summary: SmartObjectSummary = {
      id: 'coffee-1',
      name: 'Coffee Machine',
      type: 'appliance',
    };
    expect(summary).not.toHaveProperty('state');
    expect(summary).not.toHaveProperty('affordances');
  });
});

describe('PerceptionDataProvider', () => {
  it('defines the cross-package bridge surface', () => {
    const provider: PerceptionDataProvider = {
      getAgentLocation: () => 'kitchen',
      getObjectsInRoom: () => [{ id: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
      getAffordancesInRoom: () => [],
      getAgentDrives: () => ({ energy: 10 }),
      getPrimaryDriveLabel: () => 'low energy, need to restore energy',
      getSystemFeedback: () => undefined,
    };
    expect(provider.getAgentLocation('a1')).toBe('kitchen');
    expect(provider.getObjectsInRoom('kitchen')).toHaveLength(1);
    expect(provider.getPrimaryDriveLabel('a1')).toBe('low energy, need to restore energy');
  });
});
