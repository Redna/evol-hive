/**
 * Spec 018 — Shared type definitions for Object Interactions.
 * Covers AC-1 through AC-10.
 */
import { describe, it, expect } from 'vitest';
import type {
  Affordance,
  AffordanceCondition,
  AffordanceResult,
  CompoundAction,
  CrossObjectStateChange,
  ObjectDependency,
  ObjectStateRule,
  PerceptionDataProvider,
  PerceptionResult,
  SmartObject,
} from '../src/index.js';

// ─── AC-1: AffordanceCondition ────────────────────────────────────────────────

describe('AffordanceCondition (AC-1)', () => {
  it('is defined with field, operator, and value fields', () => {
    const condition: AffordanceCondition = {
      field: 'water_level',
      operator: '>',
      value: 0,
    };
    expect(condition.field).toBe('water_level');
    expect(condition.operator).toBe('>');
    expect(condition.value).toBe(0);
  });

  it('accepts all six comparison operators', () => {
    const operators: AffordanceCondition['operator'][] = ['>', '<', '>=', '<=', '==', '!='];
    for (const op of operators) {
      const condition: AffordanceCondition = { field: 'x', operator: op, value: 1 };
      expect(condition.operator).toBe(op);
    }
  });

  it('accepts string and boolean values', () => {
    const strCondition: AffordanceCondition = { field: 'mode', operator: '==', value: 'on' };
    const boolCondition: AffordanceCondition = { field: 'powered', operator: '==', value: true };
    expect(strCondition.value).toBe('on');
    expect(boolCondition.value).toBe(true);
  });
});

// ─── AC-2: Affordance optional fields ─────────────────────────────────────────

describe('Affordance optional fields (AC-2)', () => {
  it('includes optional stepGroup, stepOrder, and conditions', () => {
    const affordance: Affordance = {
      id: 'brew_coffee',
      label: 'Brew Coffee',
      engineEffect: 'brew_coffee',
      preconditions: [],
      effects: { energy: 20 },
      stepGroup: 'brew_coffee_sequence',
      stepOrder: 3,
      conditions: [
        { field: 'water_level', operator: '>', value: 0 },
        { field: 'bean_count', operator: '>', value: 0 },
      ],
    };
    expect(affordance.stepGroup).toBe('brew_coffee_sequence');
    expect(affordance.stepOrder).toBe(3);
    expect(affordance.conditions).toHaveLength(2);
  });

  it('compiles without stepGroup, stepOrder, or conditions (backward compatible)', () => {
    const affordance: Affordance = {
      id: 'brew_coffee',
      label: 'Brew Coffee',
      engineEffect: 'brew_coffee',
      preconditions: [],
      effects: { energy: 20 },
    };
    expect(affordance.stepGroup).toBeUndefined();
    expect(affordance.stepOrder).toBeUndefined();
    expect(affordance.conditions).toBeUndefined();
  });
});

// ─── AC-3: CompoundAction ────────────────────────────────────────────────────

describe('CompoundAction (AC-3)', () => {
  it('is defined with id, label, and steps fields', () => {
    const action: CompoundAction = {
      id: 'brew_coffee',
      label: 'Brew Coffee',
      steps: [
        { affordanceId: 'add_water', description: 'Add water to the machine' },
        { affordanceId: 'add_beans', description: 'Add beans to the machine' },
        { affordanceId: 'press_brew', description: 'Press the brew button' },
      ],
    };
    expect(action.id).toBe('brew_coffee');
    expect(action.label).toBe('Brew Coffee');
    expect(action.steps).toHaveLength(3);
    expect(action.steps[0]?.affordanceId).toBe('add_water');
    expect(action.steps[0]?.description).toBe('Add water to the machine');
  });
});

// ─── AC-4: ObjectDependency ───────────────────────────────────────────────────

describe('ObjectDependency (AC-4)', () => {
  it('is defined with affordanceId, requiresObjectId, requiresAffordance, description', () => {
    const dep: ObjectDependency = {
      affordanceId: 'brew_coffee',
      requiresObjectId: 'sink-1',
      requiresAffordance: 'refill_water',
      description: 'Coffee Machine needs water from the Sink before brewing',
    };
    expect(dep.affordanceId).toBe('brew_coffee');
    expect(dep.requiresObjectId).toBe('sink-1');
    expect(dep.requiresAffordance).toBe('refill_water');
    expect(dep.description).toBe('Coffee Machine needs water from the Sink before brewing');
  });
});

// ─── AC-5: ObjectStateRule ───────────────────────────────────────────────────

describe('ObjectStateRule (AC-5)', () => {
  it('is defined with field, operation, rate, target?, interval', () => {
    const decayRule: ObjectStateRule = {
      field: 'temperature',
      operation: 'decay',
      rate: 1,
      interval: 0,
    };
    expect(decayRule.field).toBe('temperature');
    expect(decayRule.operation).toBe('decay');
    expect(decayRule.rate).toBe(1);
    expect(decayRule.interval).toBe(0);
    expect(decayRule.target).toBeUndefined();
  });

  it('supports the approach operation with a target', () => {
    const approachRule: ObjectStateRule = {
      field: 'temperature',
      operation: 'approach',
      rate: 2,
      target: 20,
      interval: 0,
    };
    expect(approachRule.operation).toBe('approach');
    expect(approachRule.target).toBe(20);
  });
});

// ─── AC-6: SmartObject optional fields ────────────────────────────────────────

describe('SmartObject optional fields (AC-6)', () => {
  it('includes optional stateRules, compoundActions, and dependencies', () => {
    const obj: SmartObject = {
      id: 'coffee-1',
      name: 'Coffee Machine',
      type: 'appliance',
      state: { water_level: 5 },
      affordances: [],
      roomId: 'kitchen',
      stateRules: [{ field: 'temperature', operation: 'decay', rate: 1, interval: 0 }],
      compoundActions: [{ id: 'brew_coffee', label: 'Brew Coffee', steps: [] }],
      dependencies: [
        {
          affordanceId: 'brew_coffee',
          requiresObjectId: 'sink-1',
          requiresAffordance: 'refill_water',
          description: 'Needs water from sink',
        },
      ],
    };
    expect(obj.stateRules).toHaveLength(1);
    expect(obj.compoundActions).toHaveLength(1);
    expect(obj.dependencies).toHaveLength(1);
  });

  it('compiles without stateRules, compoundActions, or dependencies (backward compatible)', () => {
    const obj: SmartObject = {
      id: 'coffee-1',
      name: 'Coffee Machine',
      type: 'appliance',
      state: { water_level: 5 },
      affordances: [],
      roomId: 'kitchen',
    };
    expect(obj.stateRules).toBeUndefined();
    expect(obj.compoundActions).toBeUndefined();
    expect(obj.dependencies).toBeUndefined();
  });
});

// ─── AC-7: CrossObjectStateChange ────────────────────────────────────────────

describe('CrossObjectStateChange (AC-7)', () => {
  it('is defined with objectId and statePatch fields', () => {
    const change: CrossObjectStateChange = {
      objectId: 'coffee-1',
      statePatch: { water_level: 5 },
    };
    expect(change.objectId).toBe('coffee-1');
    expect(change.statePatch).toEqual({ water_level: 5 });
  });
});

// ─── AC-8: AffordanceResult optional crossObjectStateChanges ──────────────────

describe('AffordanceResult optional crossObjectStateChanges (AC-8)', () => {
  it('includes optional crossObjectStateChanges', () => {
    const result: AffordanceResult = {
      success: true,
      crossObjectStateChanges: [{ objectId: 'coffee-1', statePatch: { water_level: 5 } }],
    };
    expect(result.crossObjectStateChanges).toHaveLength(1);
    expect(result.crossObjectStateChanges?.[0]?.objectId).toBe('coffee-1');
  });

  it('compiles without crossObjectStateChanges (backward compatible)', () => {
    const result: AffordanceResult = {
      success: true,
    };
    expect(result.crossObjectStateChanges).toBeUndefined();
  });
});

// ─── AC-9: PerceptionResult optional fields ──────────────────────────────────

describe('PerceptionResult optional fields (AC-9)', () => {
  it('includes optional compoundActions and objectDependencies', () => {
    const result: PerceptionResult = {
      passive: { roomId: 'kitchen', objectsPresent: [], drives: {} },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
      compoundActions: [{ id: 'brew_coffee', label: 'Brew Coffee', steps: [] }],
      objectDependencies: [
        {
          affordanceId: 'brew_coffee',
          requiresObjectId: 'sink-1',
          requiresAffordance: 'refill_water',
          description: 'Needs water',
        },
      ],
    };
    expect(result.compoundActions).toHaveLength(1);
    expect(result.objectDependencies).toHaveLength(1);
  });

  it('compiles without compoundActions or objectDependencies (backward compatible)', () => {
    const result: PerceptionResult = {
      passive: { roomId: 'kitchen', objectsPresent: [], drives: {} },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
    };
    expect(result.compoundActions).toBeUndefined();
    expect(result.objectDependencies).toBeUndefined();
  });
});

// ─── AC-10: PerceptionDataProvider new methods ───────────────────────────────

describe('PerceptionDataProvider new methods (AC-10)', () => {
  it('includes getAvailableAffordancesInRoom, getCompoundActionsInRoom, getObjectDependenciesInRoom', () => {
    const provider: PerceptionDataProvider = {
      getAgentLocation: () => 'kitchen',
      getObjectsInRoom: () => [],
      getAffordancesInRoom: () => [],
      getAvailableAffordancesInRoom: () => [],
      getCompoundActionsInRoom: () => [],
      getObjectDependenciesInRoom: () => [],
      getAgentDrives: () => ({}),
      getPrimaryDriveLabel: () => '',
      getSystemFeedback: () => undefined,
    };
    expect(typeof provider.getAvailableAffordancesInRoom).toBe('function');
    expect(typeof provider.getCompoundActionsInRoom).toBe('function');
    expect(typeof provider.getObjectDependenciesInRoom).toBe('function');
  });
});
