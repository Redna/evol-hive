import { describe, it, expect, beforeEach } from 'vitest';
import type { SmartObject, Affordance } from '@evol-hive/shared';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';

function makeAffordance(id: string, label = id): Affordance {
  return {
    id,
    label,
    engineEffect: id,
    preconditions: [],
    effects: {},
  };
}

function makeObject(id: string, roomId: string, affordances: Affordance[] = []): SmartObject {
  return {
    id,
    name: id.replace(/-/g, ' '),
    type: 'appliance',
    state: { water_level: 'low', bean_count: 12 },
    affordances,
    roomId,
  };
}

describe('SmartObjectRegistry.getObjectsInRoom (AC-1)', () => {
  let registry: SmartObjectRegistryImpl;

  beforeEach(() => {
    registry = new SmartObjectRegistryImpl();
  });

  it('returns { id, name, type } for every object whose roomId matches', () => {
    registry.register(makeObject('coffee-1', 'kitchen', [makeAffordance('brew_coffee')]));
    registry.register(makeObject('couch-1', 'lounge'));
    registry.register(makeObject('kettle-1', 'kitchen'));

    const objects = registry.getObjectsInRoom('kitchen');
    expect(objects).toHaveLength(2);
    const ids = objects.map((o) => o.id).sort();
    expect(ids).toEqual(['coffee-1', 'kettle-1']);
  });

  it('excludes the state and affordances fields', () => {
    registry.register(makeObject('coffee-1', 'kitchen', [makeAffordance('brew_coffee')]));
    const objects = registry.getObjectsInRoom('kitchen');
    expect(objects).toHaveLength(1);
    const obj = objects[0]!;
    expect(obj).not.toHaveProperty('state');
    expect(obj).not.toHaveProperty('affordances');
    expect(obj).toEqual({ id: 'coffee-1', name: 'coffee 1', type: 'appliance' });
  });

  it('returns an empty array when the room has no objects', () => {
    registry.register(makeObject('coffee-1', 'kitchen'));
    expect(registry.getObjectsInRoom('lounge')).toEqual([]);
  });
});

describe('SmartObjectRegistry.getAffordancesInRoom (AC-2)', () => {
  let registry: SmartObjectRegistryImpl;

  beforeEach(() => {
    registry = new SmartObjectRegistryImpl();
  });

  it('aggregates all affordances from all objects in the room into a flat list', () => {
    registry.register(
      makeObject('coffee-1', 'kitchen', [
        makeAffordance('brew_coffee'),
        makeAffordance('refill_water'),
      ]),
    );
    registry.register(makeObject('kettle-1', 'kitchen', [makeAffordance('boil_water')]));

    const affordances = registry.getAffordancesInRoom('kitchen');
    expect(affordances).toHaveLength(3);
    expect(affordances.map((a) => a.id).sort()).toEqual([
      'boil_water',
      'brew_coffee',
      'refill_water',
    ]);
  });

  it('returns an empty array if the room has no objects', () => {
    registry.register(makeObject('coffee-1', 'kitchen'));
    expect(registry.getAffordancesInRoom('lounge')).toEqual([]);
  });

  it('returns an empty array if the room has objects with no affordances', () => {
    registry.register(makeObject('couch-1', 'lounge'));
    expect(registry.getAffordancesInRoom('lounge')).toEqual([]);
  });
});
