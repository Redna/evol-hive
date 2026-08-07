/**
 * Tests for AffordanceRegistryImpl — handler registration, precondition
 * checker registration, and checkPreconditions.
 *
 * Covers AC-4, AC-5, AC-6, AC-7, AC-8.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Affordance, SmartObject } from '@evol-hive/shared';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { AffordanceRegistryImpl } from '../src/world/affordances/index.js';

const brewCoffee: Affordance = {
  id: 'brew_coffee',
  label: 'Brew coffee',
  engineEffect: 'brew_coffee',
  preconditions: ['has_water'],
  effects: { energy: 20 },
};

const coffeeMachine: SmartObject = {
  id: 'coffee-1',
  name: 'Coffee Machine',
  type: 'appliance',
  state: { water_level: 0 },
  affordances: [brewCoffee],
  roomId: 'kitchen',
};

describe('AffordanceRegistryImpl — handler registration (AC-4)', () => {
  let registry: AffordanceRegistryImpl;

  beforeEach(() => {
    registry = new AffordanceRegistryImpl(new SmartObjectRegistryImpl());
  });

  it('registerHandler stores a handler and getHandler retrieves it', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true });
    registry.registerHandler('brew_coffee', handler);

    const retrieved = registry.getHandler('brew_coffee');
    expect(retrieved).toBe(handler);
  });

  it('getHandler returns null for an unregistered affordance ID', () => {
    expect(registry.getHandler('nonexistent')).toBeNull();
  });
});

describe('AffordanceRegistryImpl — precondition checker registration (AC-5)', () => {
  let registry: AffordanceRegistryImpl;

  beforeEach(() => {
    registry = new AffordanceRegistryImpl(new SmartObjectRegistryImpl());
  });

  it('registerPreconditionChecker stores a checker', () => {
    const checker = (state: Record<string, unknown>) => (state['water_level'] as number) > 0;
    registry.registerPreconditionChecker('has_water', checker);

    // Verify by running checkPreconditions with a matching object.
    const smartRegistry = new SmartObjectRegistryImpl();
    smartRegistry.register({
      ...coffeeMachine,
      state: { water_level: 5 },
      affordances: [brewCoffee],
    });
    const regWithSmart = new AffordanceRegistryImpl(smartRegistry);
    regWithSmart.registerPreconditionChecker('has_water', checker);
    const result = regWithSmart.checkPreconditions('brew_coffee', 'coffee-1');
    expect(result.satisfied).toBe(true);
  });
});

describe('AffordanceRegistryImpl.checkPreconditions (AC-6, AC-7, AC-8)', () => {
  let smartRegistry: SmartObjectRegistryImpl;
  let registry: AffordanceRegistryImpl;

  beforeEach(() => {
    smartRegistry = new SmartObjectRegistryImpl();
    registry = new AffordanceRegistryImpl(smartRegistry);
    registry.registerPreconditionChecker('has_water', (state) => {
      return (state['water_level'] as number) > 0;
    });
  });

  it('returns { satisfied: false, failed: ["has_water"] } when water_level is 0 (AC-6)', () => {
    smartRegistry.register({ ...coffeeMachine, state: { water_level: 0 } });
    const result = registry.checkPreconditions('brew_coffee', 'coffee-1');
    expect(result.satisfied).toBe(false);
    expect(result.failed).toEqual(['has_water']);
  });

  it('returns { satisfied: true, failed: [] } when water_level is 5 (AC-7)', () => {
    smartRegistry.register({ ...coffeeMachine, state: { water_level: 5 } });
    const result = registry.checkPreconditions('brew_coffee', 'coffee-1');
    expect(result.satisfied).toBe(true);
    expect(result.failed).toEqual([]);
  });

  it('returns { satisfied: false, failed: ["<preconditionName>"] } when checker is not registered (AC-8)', () => {
    smartRegistry.register({
      ...coffeeMachine,
      affordances: [
        {
          ...brewCoffee,
          preconditions: ['unknown_precondition'],
        },
      ],
    });
    const result = registry.checkPreconditions('brew_coffee', 'coffee-1');
    expect(result.satisfied).toBe(false);
    expect(result.failed).toEqual(['unknown_precondition']);
  });
});
