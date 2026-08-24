/**
 * objects/ — Smart object registry & state management
 * ──────────────────────────────────────────────────
 * Section 4: Smart objects expose discrete affordances. The registry owns
 * object CRUD, room queries, and affordance aggregation for the Perceive phase.
 */

import type { Affordance, SmartObject, SmartObjectSummary } from '@evol-hive/shared';
import type { SmartObjectRegistry } from '../index.js';

/** Concrete SmartObjectRegistry backed by an in-memory map. */
export class SmartObjectRegistryImpl implements SmartObjectRegistry {
  private readonly objects = new Map<string, SmartObject>();

  register(object: SmartObject): void {
    this.objects.set(object.id, object);
  }

  get(objectId: string): SmartObject | null {
    return this.objects.get(objectId) ?? null;
  }

  /** Full SmartObject[] for a room — deep state included (engine-internal only). */
  getByRoom(roomId: string): SmartObject[] {
    const result: SmartObject[] = [];
    for (const object of this.objects.values()) {
      if (object.roomId === roomId) result.push(object);
    }
    return result;
  }

  /** Projected { id, name, type } for a room — no deep state, no affordances. */
  getObjectsInRoom(roomId: string): SmartObjectSummary[] {
    return this.getByRoom(roomId).map((o) => ({ id: o.id, name: o.name, type: o.type }));
  }

  /** Flat Affordance[] aggregating every affordance across all objects in a room. */
  getAffordancesInRoom(roomId: string): Affordance[] {
    const result: Affordance[] = [];
    for (const object of this.getByRoom(roomId)) {
      for (const affordance of object.affordances) {
        result.push(affordance);
      }
    }
    return result;
  }

  updateState(objectId: string, newState: Record<string, unknown>): void {
    const object = this.objects.get(objectId);
    if (object) {
      this.objects.set(objectId, { ...object, state: newState });
    }
  }

  /** Return all objects as an array, including their current runtime state (spec 017, Req 15 / AC-28). */
  getAllObjects(): SmartObject[] {
    return [...this.objects.values()];
  }

  /**
   * Remove every registered object (spec 017). Used by `EnginePersistenceImpl.load()`
   * to make the restore destructive — a full snapshot replacement.
   */
  clear(): void {
    this.objects.clear();
  }
}

export {};
