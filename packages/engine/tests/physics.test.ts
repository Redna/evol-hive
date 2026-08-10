/**
 * Tests for PhysicsSystemImpl.executeAffordance — the deterministic physics
 * execution of affordances.
 *
 * Covers AC-9, AC-10, AC-11, AC-12, AC-13, AC-36.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Affordance, AffordanceResult, SmartObject } from '@evol-hive/shared';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { AffordanceRegistryImpl } from '../src/world/affordances/index.js';
import { PhysicsSystemImpl } from '../src/physics/index.js';

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
  state: { water_level: 5 },
  affordances: [brewCoffee],
  roomId: 'kitchen',
};

const AGENT_ID = 'a1';

describe('PhysicsSystemImpl.executeAffordance (AC-9 through AC-13, AC-36)', () => {
  let smartRegistry: SmartObjectRegistryImpl;
  let affordanceRegistry: AffordanceRegistryImpl;
  let physics: PhysicsSystemImpl;

  beforeEach(() => {
    smartRegistry = new SmartObjectRegistryImpl();
    affordanceRegistry = new AffordanceRegistryImpl(smartRegistry);
    physics = new PhysicsSystemImpl(smartRegistry, affordanceRegistry);
    affordanceRegistry.registerPreconditionChecker('has_water', (state) => {
      return (state['water_level'] as number) > 0;
    });
  });

  it('returns { success: false, failureReason: "Object not found" } when object does not exist (AC-9)', async () => {
    const result = await physics.executeAffordance('nonexistent', 'brew_coffee', AGENT_ID);
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('Object not found');
  });

  it('returns { success: false, failureReason: "Affordance not available on this object" } when object has no matching affordance (AC-10)', async () => {
    smartRegistry.register({
      ...coffeeMachine,
      affordances: [],
    });
    const result = await physics.executeAffordance('coffee-1', 'brew_coffee', AGENT_ID);
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('Affordance not available on this object');
  });

  it('returns { success: false, failureReason: "Preconditions not met: has_water" } when preconditions fail (AC-12)', async () => {
    smartRegistry.register({
      ...coffeeMachine,
      state: { water_level: 0 },
    });
    const result = await physics.executeAffordance('coffee-1', 'brew_coffee', AGENT_ID);
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('Preconditions not met: has_water');
  });

  it('returns { success: false, failureReason: "No handler registered for affordance: brew_coffee" } when no handler is registered (AC-11)', async () => {
    smartRegistry.register({ ...coffeeMachine, state: { water_level: 5 } });
    const result = await physics.executeAffordance('coffee-1', 'brew_coffee', AGENT_ID);
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('No handler registered for affordance: brew_coffee');
  });

  it('on handler success: updates object state via SmartObjectRegistry.updateState and returns the handler result (AC-13)', async () => {
    smartRegistry.register({ ...coffeeMachine, state: { water_level: 5 } });
    const handlerResult: AffordanceResult = {
      success: true,
      newState: { water_level: 0 },
      driveChanges: { energy: 20 },
    };
    affordanceRegistry.registerHandler('brew_coffee', vi.fn().mockResolvedValue(handlerResult));

    const result = await physics.executeAffordance('coffee-1', 'brew_coffee', AGENT_ID);
    expect(result.success).toBe(true);
    expect(result.newState).toEqual({ water_level: 0 });
    expect(result.driveChanges).toEqual({ energy: 20 });

    // Verify the object state was updated.
    const updated = smartRegistry.get('coffee-1');
    expect(updated?.state).toEqual({ water_level: 0 });
  });

  it('on handler failure: returns the handler result without updating state', async () => {
    smartRegistry.register({ ...coffeeMachine, state: { water_level: 5 } });
    const handlerResult: AffordanceResult = {
      success: false,
      failureReason: 'Machine broken',
    };
    affordanceRegistry.registerHandler('brew_coffee', vi.fn().mockResolvedValue(handlerResult));

    const result = await physics.executeAffordance('coffee-1', 'brew_coffee', AGENT_ID);
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('Machine broken');

    // State should not have been updated.
    const obj = smartRegistry.get('coffee-1');
    expect(obj?.state).toEqual({ water_level: 5 });
  });

  it('does not call updateState when handler result has no newState', async () => {
    smartRegistry.register({ ...coffeeMachine, state: { water_level: 5 } });
    const handlerResult: AffordanceResult = {
      success: true,
      driveChanges: { energy: 20 },
    };
    affordanceRegistry.registerHandler('brew_coffee', vi.fn().mockResolvedValue(handlerResult));

    await physics.executeAffordance('coffee-1', 'brew_coffee', AGENT_ID);
    // State should remain unchanged.
    const obj = smartRegistry.get('coffee-1');
    expect(obj?.state).toEqual({ water_level: 5 });
  });

  it('produces identical results when called twice with the same state (AC-36)', async () => {
    smartRegistry.register({ ...coffeeMachine, state: { water_level: 5 } });
    const handler = vi
      .fn()
      .mockImplementation(
        async (
          _objectId: string,
          _agentId: string,
          objectState: Record<string, unknown>,
        ): Promise<AffordanceResult> => {
          return {
            success: true,
            newState: { water_level: 0 },
            driveChanges: { energy: 20 },
          };
        },
      );
    affordanceRegistry.registerHandler('brew_coffee', handler);

    // First execution.
    const result1 = await physics.executeAffordance('coffee-1', 'brew_coffee', AGENT_ID);

    // Reset state to the same initial state for the second call.
    smartRegistry.updateState('coffee-1', { water_level: 5 });

    const result2 = await physics.executeAffordance('coffee-1', 'brew_coffee', AGENT_ID);

    expect(result1).toEqual(result2);
    expect(result1.success).toBe(result2.success);
    expect(result1.newState).toEqual(result2.newState);
    expect(result1.driveChanges).toEqual(result2.driveChanges);
  });
});
