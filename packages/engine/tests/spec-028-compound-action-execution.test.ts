/**
 * Tests for Compound Action Execution (spec 028, issue #108) — engine layer.
 *
 * Covers AC-1: `ExecuteDataProviderImpl.resolveCompoundAction` resolves a
 * compound action ID to the smart object in a room that defines it, using the
 * coffee-shop scene (`examples/coffee-shop.ts`), and returns `null` for an
 * unknown ID. Plain-affordance resolution via `resolveAffordance` is
 * unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { EngineConfig, SmartObject } from '@evol-hive/shared';
import { createEngineCore, loadScene } from '../src/assembly.js';
import type { EngineCore } from '../src/assembly.js';
import { ExecuteDataProviderImpl } from '../src/agents/execute/index.js';
import { COFFEE_SHOP_SCENE } from '../../../examples/coffee-shop.ts';

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: false,
    guardrails: { affordanceMasking: false, contextualForcing: false, planValidation: false },
  };
}

/** Register a minimal object with a compound action in a custom room. */
const teaMaker: SmartObject = {
  id: 'tea-1',
  name: 'Tea Maker',
  type: 'appliance',
  state: {},
  affordances: [
    {
      id: 'boil_water',
      label: 'Boil water',
      engineEffect: 'boil_water',
      preconditions: [],
      effects: {},
    },
  ],
  roomId: 'tea_room',
  compoundActions: [
    {
      id: 'make_tea_sequence',
      label: 'Make a cup of tea',
      steps: [
        { affordanceId: 'boil_water', description: 'Boil the water' },
        { affordanceId: 'steep_tea', description: 'Steep the tea' },
      ],
    },
  ],
};

describe('ExecuteDataProviderImpl.resolveCompoundAction (spec 028, AC-1)', () => {
  let core: EngineCore;
  let provider: ExecuteDataProviderImpl;

  beforeEach(() => {
    core = createEngineCore(makeConfig());
    loadScene(core, COFFEE_SHOP_SCENE);
    provider = core.bridges.execute;
  });

  it('resolves brew_coffee_sequence on the coffee-shop scene to the coffee machine with 3 steps (AC-1)', () => {
    const result = provider.resolveCompoundAction('kitchen', 'brew_coffee_sequence');

    expect(result).not.toBeNull();
    expect(result?.objectId).toBe('coffee-1');
    expect(result?.compoundAction.id).toBe('brew_coffee_sequence');
    expect(result?.compoundAction.steps.length).toBe(3);
    expect(result?.compoundAction.steps.map((s) => s.affordanceId)).toEqual([
      'add_water',
      'brew_coffee',
      'pour_cup',
    ]);
  });

  it('returns null for an unknown compound action ID on the coffee-shop scene (AC-1)', () => {
    expect(provider.resolveCompoundAction('kitchen', 'unknown_compound')).toBeNull();
  });

  it('returns null when the room has no compound actions', () => {
    // living_room has objects but none defines compoundActions.
    expect(provider.resolveCompoundAction('living_room', 'brew_coffee_sequence')).toBeNull();
  });

  it('returns null for an empty/unknown room', () => {
    expect(provider.resolveCompoundAction('nonexistent_room', 'brew_coffee_sequence')).toBeNull();
  });

  it('resolves a compound action registered on a custom scene object', () => {
    core.smartObjectRegistry.register(teaMaker);
    const result = provider.resolveCompoundAction('tea_room', 'make_tea_sequence');

    expect(result).not.toBeNull();
    expect(result?.objectId).toBe('tea-1');
    expect(result?.compoundAction.id).toBe('make_tea_sequence');
    expect(result?.compoundAction.steps).toHaveLength(2);
  });

  it('returns the first matching object when several objects define the same compound ID', () => {
    const first: SmartObject = {
      ...teaMaker,
      id: 'tea-1',
      roomId: 'tea_room',
    };
    const second: SmartObject = {
      ...teaMaker,
      id: 'tea-2',
      roomId: 'tea_room',
    };
    core.smartObjectRegistry.register(first);
    core.smartObjectRegistry.register(second);

    const result = provider.resolveCompoundAction('tea_room', 'make_tea_sequence');
    expect(result?.objectId).toBe('tea-1');
  });

  it('does not resolve a compound action from a different room', () => {
    core.smartObjectRegistry.register(teaMaker);
    expect(provider.resolveCompoundAction('kitchen', 'make_tea_sequence')).toBeNull();
  });

  it('leaves plain-affordance resolution unchanged — resolveAffordance still works for regular affordances', () => {
    const resolved = provider.resolveAffordance('kitchen', 'brew_coffee');
    expect(resolved).not.toBeNull();
    expect(resolved?.objectId).toBe('coffee-1');
    expect(resolved?.affordance.id).toBe('brew_coffee');
  });

  it('does not resolve a compound action ID through resolveAffordance (plain path is unchanged)', () => {
    // The compound ID is not a plain affordance — plain resolution must not
    // be modified to resolve it (spec 028, Design Rationale / Decision 3).
    expect(provider.resolveAffordance('kitchen', 'brew_coffee_sequence')).toBeNull();
  });
});
