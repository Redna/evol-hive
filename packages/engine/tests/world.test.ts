import { describe, it, expect, beforeEach } from 'vitest';
import type { SmartObject, Affordance, SmartObjectProjection } from '@evol-hive/shared';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';

// AC-1: SmartObjectRegistry.getObjectsInRoom returns { id, name, type }[] without state/affordances.
// AC-2: SmartObjectRegistry.getAffordancesInRoom returns a flat Affordance[] from all objects in the room.

function makeAffordance(id: string, label: string): Affordance {
  return {
    id,
    label,
    engineEffect: `effect_${id}`,
    preconditions: [],
    effects: {},
  };
}

function makeObject(
  id: string,
  name: string,
  type: string,
  roomId: string,
  affordances: Affordance[] = [],
): SmartObject {
  return {
    id,
    name,
    type,
    state: { some_deep_state: 'secret' },
    affordances,
    roomId,
  };
}

describe('SmartObjectRegistryImpl', () => {
  let registry: SmartObjectRegistryImpl;

  beforeEach(() => {
    registry = new SmartObjectRegistryImpl();
  });

  describe('getObjectsInRoom (AC-1)', () => {
    it('returns projected { id, name, type } for each object in the room', () => {
      registry.register(
        makeObject('coffee-machine', 'Coffee Machine', 'appliance', 'kitchen', [
          makeAffordance('brew_coffee', 'Brew coffee'),
        ]),
      );
      registry.register(makeObject('table', 'Table', 'furniture', 'kitchen'));
      registry.register(makeObject('couch', 'Couch', 'furniture', 'lounge'));

      const objects = registry.getObjectsInRoom('kitchen');

      expect(objects).toHaveLength(2);
      const ids = objects.map((o) => o.id);
      expect(ids).toContain('coffee-machine');
      expect(ids).toContain('table');
    });

    it('excludes state and affordances fields from the projection', () => {
      registry.register(
        makeObject('coffee-machine', 'Coffee Machine', 'appliance', 'kitchen', [
          makeAffordance('brew_coffee', 'Brew coffee'),
        ]),
      );

      const objects = registry.getObjectsInRoom('kitchen');
      const obj = objects[0]!;

      expect('state' in obj).toBe(false);
      expect('affordances' in obj).toBe(false);
      expect('roomId' in obj).toBe(false);
    });

    it('returns empty array for a room with no objects', () => {
      const objects = registry.getObjectsInRoom('empty-room');
      expect(objects).toEqual([]);
    });
  });

  describe('getAffordancesInRoom (AC-2)', () => {
    it('returns a flat Affordance[] aggregating all affordances from all objects in the room', () => {
      registry.register(
        makeObject('coffee-machine', 'Coffee Machine', 'appliance', 'kitchen', [
          makeAffordance('brew_coffee', 'Brew coffee'),
          makeAffordance('clean_machine', 'Clean the machine'),
        ]),
      );
      registry.register(
        makeObject('fridge', 'Fridge', 'appliance', 'kitchen', [
          makeAffordance('get_food', 'Get food from fridge'),
        ]),
      );
      registry.register(
        makeObject('couch', 'Couch', 'furniture', 'lounge', [
          makeAffordance('sit_down', 'Sit down on the couch'),
        ]),
      );

      const affordances = registry.getAffordancesInRoom('kitchen');

      expect(affordances).toHaveLength(3);
      const ids = affordances.map((a) => a.id);
      expect(ids).toContain('brew_coffee');
      expect(ids).toContain('clean_machine');
      expect(ids).toContain('get_food');
    });

    it('returns empty array if the room has no objects', () => {
      const affordances = registry.getAffordancesInRoom('empty-room');
      expect(affordances).toEqual([]);
    });

    it('returns empty array if objects in the room have no affordances', () => {
      registry.register(makeObject('table', 'Table', 'furniture', 'kitchen'));

      const affordances = registry.getAffordancesInRoom('kitchen');
      expect(affordances).toEqual([]);
    });
  });
});
