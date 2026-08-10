/**
 * affordances/ — Affordance registry, precondition checkers & engine effect handlers
 * ──────────────────────────────────────────────────────────────────────────────
 * Section 4 / spec 003: Maps affordance IDs to their deterministic engine effect
 * handlers and precondition checkers. The registry is the single source of
 * physics logic dispatch — no random number generation, no LLM calls, no
 * external I/O inside handlers (Req 23).
 */

import type { Affordance } from '@evol-hive/shared';
import type { AffordanceRegistry, AffordanceHandler } from '../index.js';
import type { SmartObjectRegistry } from '../index.js';

/** A deterministic precondition checker that evaluates against a smart object's `state`. */
export type PreconditionChecker = (objectState: Record<string, unknown>) => boolean;

/**
 * Concrete AffordanceRegistry backed by in-memory maps for handlers and
 * precondition checkers. Precondition checkers are keyed by their name string
 * (e.g., `"has_water"`) and evaluate against the smart object's `state` field.
 */
export class AffordanceRegistryImpl implements AffordanceRegistry {
  private readonly handlers = new Map<string, AffordanceHandler>();
  private readonly preconditionCheckers = new Map<string, PreconditionChecker>();
  private readonly smartObjectRegistry: SmartObjectRegistry;

  constructor(smartObjectRegistry: SmartObjectRegistry) {
    this.smartObjectRegistry = smartObjectRegistry;
  }

  /** Register an engine effect handler for an affordance. */
  registerHandler(affordanceId: string, handler: AffordanceHandler): void {
    this.handlers.set(affordanceId, handler);
  }

  /** Get the handler for an affordance, or `null` if none is registered. */
  getHandler(affordanceId: string): AffordanceHandler | null {
    return this.handlers.get(affordanceId) ?? null;
  }

  /** Register a precondition checker keyed by its name (e.g., `"has_water"`). */
  registerPreconditionChecker(name: string, checker: PreconditionChecker): void {
    this.preconditionCheckers.set(name, checker);
  }

  /**
   * Check all preconditions for an affordance on a specific object.
   * For each string in `affordance.preconditions`, invoke the corresponding
   * registered `PreconditionChecker` with the object's `state`. If any checker
   * returns `false` (or is not registered), add it to the `failed` array.
   * Returns `{ satisfied: true, failed: [] }` only if all preconditions pass.
   */
  checkPreconditions(
    affordanceId: string,
    objectId: string,
  ): { satisfied: boolean; failed: string[] } {
    const object = this.smartObjectRegistry.get(objectId);
    if (!object) {
      return { satisfied: false, failed: ['object_not_found'] };
    }

    const affordance = object.affordances.find((a: Affordance) => a.id === affordanceId);
    if (!affordance) {
      return { satisfied: false, failed: ['affordance_not_available'] };
    }

    const failed: string[] = [];
    for (const precondition of affordance.preconditions) {
      const checker = this.preconditionCheckers.get(precondition);
      if (!checker) {
        // Fail-safe: unregistered precondition = failed (Req 5).
        failed.push(precondition);
        continue;
      }
      if (!checker(object.state)) {
        failed.push(precondition);
      }
    }

    return { satisfied: failed.length === 0, failed };
  }
}

export {};
