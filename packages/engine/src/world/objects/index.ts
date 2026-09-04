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
  /**
   * Optional movement filter (spec 030, Req 10): when installed, room
   * affordance queries consult it to hide cross-door `go_to_*` affordances
   * whose destination is unreachable through closed connections. Returns
   * `true` to keep the affordance, `false` to filter it out.
   */
  private movementFilter: ((roomId: string, engineEffect: string) => boolean) | null = null;

  register(object: SmartObject): void {
    this.objects.set(object.id, object);
  }

  /**
   * Remove an object entirely (spec 030, Req 4). This unregisters the
   * object's affordances from tool availability (the room affordance queries
   * no longer see them) and drops any accumulated state patches — the whole
   * object record is gone. No-op when the object does not exist.
   */
  remove(objectId: string): void {
    this.objects.delete(objectId);
  }

  /**
   * Relocate an object to another room (spec 030, Req 4). Updates the
   * object's `roomId`. No-op when the object does not exist.
   */
  setRoom(objectId: string, roomId: string): void {
    const object = this.objects.get(objectId);
    if (object) {
      this.objects.set(objectId, { ...object, roomId });
    }
  }

  /**
   * Install (or clear with `null`) the movement affordance filter used by
   * room affordance queries (spec 030, Req 10). Typically wired by the
   * `SceneMutationService` so closed connections hide `go_to_<room>`
   * affordances in the closed direction.
   */
  setMovementFilter(filter: ((roomId: string, engineEffect: string) => boolean) | null): void {
    this.movementFilter = filter;
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
        if (this.movementFilter && !this.movementFilter(roomId, affordance.engineEffect)) {
          continue; // movement affordance filtered by connection state (spec 030, Req 10)
        }
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
        if (this.movementFilter && !this.movementFilter(roomId, affordance.engineEffect)) {
          continue; // movement affordance filtered by connection state (spec 030, Req 10)
        }
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
