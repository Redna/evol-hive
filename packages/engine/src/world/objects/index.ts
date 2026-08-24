/**
 * objects/ — Smart object registry & state management
 * ──────────────────────────────────────────────────
 * Section 4: Smart objects expose discrete affordances. The registry owns
 * object CRUD, room queries, and affordance aggregation for the Perceive phase.
 */

import type {
  Affordance,
  CompoundAction,
  ObjectDependency,
  SmartObject,
  SmartObjectSummary,
} from '@evol-hive/shared';
import type { SmartObjectRegistry } from '../index.js';
import { evaluateConditions } from '../affordances/index.js';

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

  /**
   * Returns only affordances whose `conditions` (if present) are currently
   * satisfied by the owning object's state (spec 018, Req 14). Affordances
   * without `conditions` are always included.
   */
  getAvailableAffordancesInRoom(roomId: string): Affordance[] {
    const result: Affordance[] = [];
    for (const object of this.getByRoom(roomId)) {
      for (const affordance of object.affordances) {
        if (!affordance.conditions || affordance.conditions.length === 0) {
          result.push(affordance);
        } else if (evaluateConditions(object.state, affordance.conditions)) {
          result.push(affordance);
        }
      }
    }
    return result;
  }

  /** Collects all `compoundActions` from objects in a room, flattened (spec 018, Req 15). */
  getCompoundActionsInRoom(roomId: string): CompoundAction[] {
    const result: CompoundAction[] = [];
    for (const object of this.getByRoom(roomId)) {
      if (object.compoundActions) {
        result.push(...object.compoundActions);
      }
    }
    return result;
  }

  /** Collects all `dependencies` from objects in a room, flattened (spec 018, Req 16). */
  getObjectDependenciesInRoom(roomId: string): ObjectDependency[] {
    const result: ObjectDependency[] = [];
    for (const object of this.getByRoom(roomId)) {
      if (object.dependencies) {
        result.push(...object.dependencies);
      }
    }
    return result;
  }

  /** Returns all registered smart objects (spec 018, Req 21). */
  getAll(): SmartObject[] {
    return Array.from(this.objects.values());
  }

  /**
   * Performs a shallow merge of `patch` into the object's existing `state`
   * (spec 018, Req 17). No-op if the object does not exist.
   */
  applyStatePatch(objectId: string, patch: Record<string, unknown>): void {
    const object = this.objects.get(objectId);
    if (object) {
      this.objects.set(objectId, {
        ...object,
        state: { ...object.state, ...patch },
      });
    }
  }

  updateState(objectId: string, newState: Record<string, unknown>): void {
    const object = this.objects.get(objectId);
    if (object) {
      this.objects.set(objectId, { ...object, state: newState });
    }
  }
}

export {};
