import { describe, it, expect } from 'vitest';
import type {
  PerceptionResult,
  PassivePerception,
  Affordance,
  SmartObjectProjection,
  PassivePerceptionInput,
  PerceptionCompileInput,
} from '@evol-hive/shared';

// AC-17: PerceptionResult is defined in shared with the correct fields.
describe('PerceptionResult type (AC-17)', () => {
  it('PerceptionResult has fields passive, prunedAffordances, primaryDriveLabel', () => {
    const passive: PassivePerception = {
      roomId: 'kitchen',
      objectsPresent: [{ objectId: 'coffee-machine', name: 'Coffee Machine', type: 'appliance' }],
      drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    };
    const affordances: Affordance[] = [
      {
        id: 'brew_coffee',
        label: 'Brew a cup of coffee',
        engineEffect: 'brewCoffee',
        preconditions: ['has_water'],
        effects: { energy: 20 },
      },
    ];
    const result: PerceptionResult = {
      passive,
      prunedAffordances: affordances,
      primaryDriveLabel: 'low energy, need to restore energy',
    };

    expect(result.passive).toBe(passive);
    expect(result.prunedAffordances).toBe(affordances);
    expect(result.primaryDriveLabel).toBe('low energy, need to restore energy');
  });

  it('SmartObjectProjection has id, name, type only', () => {
    const projection: SmartObjectProjection = {
      id: 'obj-1',
      name: 'Test Object',
      type: 'test',
    };

    expect(projection.id).toBe('obj-1');
    expect(projection.name).toBe('Test Object');
    expect(projection.type).toBe('test');
    // Must NOT have state or affordances fields
    expect('state' in projection).toBe(false);
    expect('affordances' in projection).toBe(false);
  });

  it('PassivePerceptionInput has the correct shape', () => {
    const input: PassivePerceptionInput = {
      roomId: 'kitchen',
      objectsInRoom: [{ id: 'obj-1', name: 'Table', type: 'furniture' }],
      drives: { energy: 10 },
    };

    expect(input.roomId).toBe('kitchen');
    expect(input.objectsInRoom).toHaveLength(1);
    expect(input.drives.energy).toBe(10);
  });

  it('PerceptionCompileInput has the correct shape', () => {
    const input: PerceptionCompileInput = {
      roomId: 'kitchen',
      objectsInRoom: [{ id: 'obj-1', name: 'Table', type: 'furniture' }],
      drives: { energy: 10 },
      primaryDriveLabel: 'low energy, need to restore energy',
      roomAffordances: [],
    };

    expect(input.primaryDriveLabel).toBe('low energy, need to restore energy');
    expect(input.roomAffordances).toEqual([]);
  });
});
