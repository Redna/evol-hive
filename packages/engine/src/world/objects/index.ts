// objects/ — Smart object registry & state management
// ────────────────────────────────────────────────────
// Section 4: Smart objects expose discrete affordances. The registry
// manages object CRUD, state updates, and room queries.

import type { SmartObject, Affordance, SmartObjectProjection } from '@evol-hive/shared';
import type { SmartObjectRegistry } from '../index.js';

/**
 * In-memory implementation of `SmartObjectRegistry`.
 * Stores smart objects in a Map keyed by object ID.
 */
export class SmartObjectRegistryImpl implements SmartObjectRegistry {
  private objects = new Map<string, SmartObject>();

  register(object: SmartObject): void {
    this.objects.set(object.id, object);
  }

  get(objectId: string): SmartObject | null {
    return this.objects.get(objectId) ?? null;
  }

  getByRoom(roomId: string): SmartObject[] {
    const result: SmartObject[] = [];
    for (const obj of this.objects.values()) {
      if (obj.roomId === roomId) {
        result.push(obj);
      }
    }
    return result;
  }

  /**
   * Get projected objects ({ id, name, type }) in a room — no deep state.
   * (AC-1) Excludes `state`, `affordances`, and `roomId` fields.
   */
  getObjectsInRoom(roomId: string): SmartObjectProjection[] {
    return this.getByRoom(roomId).map((obj) => ({
      id: obj.id,
      name: obj.name,
      type: obj.type,
    }));
  }

  /**
   * Get all affordances available in a room (flat list for classifier pruning).
   * (AC-2) Returns an empty array if the room has no objects.
   */
  getAffordancesInRoom(roomId: string): Affordance[] {
    const result: Affordance[] = [];
    for (const obj of this.getByRoom(roomId)) {
      for (const affordance of obj.affordances) {
        result.push(affordance);
      }
    }
    return result;
  }

  updateState(objectId: string, newState: Record<string, unknown>): void {
    const obj = this.objects.get(objectId);
    if (obj) {
      this.objects.set(objectId, { ...obj, state: newState });
    }
  }
}
