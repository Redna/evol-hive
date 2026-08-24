/**
 * systems/object-state — Autonomous object state evolution (spec 018, Req 20)
 * ────────────────────────────────────────────────────────────────────────────
 * An `EngineSystem` that, on each tick, iterates all smart objects in the
 * registry and applies their declarative `ObjectStateRule`s. Follows the
 * `DriveDecaySystem` pattern (spec 005). Rules are deterministic functions of
 * `(state, deltaSeconds)` — no randomness, no LLM calls, no system clock.
 */

import type { GameTick } from '@evol-hive/shared';
import type { SmartObjectRegistryImpl } from '../world/objects/index.js';

/** EngineSystem that applies `ObjectStateRule`s to smart objects every tick. */
export class ObjectStateSystem {
  readonly name = 'object-state';

  private readonly registry: SmartObjectRegistryImpl;
  /** Tracks the last application time per rule, keyed by `${objectId}:${field}`. */
  private readonly lastApplied = new Map<string, number>();

  constructor(registry: SmartObjectRegistryImpl) {
    this.registry = registry;
  }

  /** Called every tick by the game loop. Applies all state rules. */
  update(tick: GameTick): void {
    const objects = this.registry.getAll();
    for (const object of objects) {
      if (!object.stateRules) continue;
      for (const rule of object.stateRules) {
        const currentValue = object.state[rule.field];
        // Skip non-numeric fields silently (spec 018, Req 20 / AC-29).
        if (typeof currentValue !== 'number') continue;

        const key = `${object.id}:${rule.field}`;
        const lastTime = this.lastApplied.get(key) ?? 0;
        // Throttle: skip if not enough time has passed (AC-28).
        if (tick.simulationTime - lastTime < rule.interval) continue;

        let newValue: number;
        if (rule.operation === 'decay') {
          newValue = currentValue - rule.rate * tick.deltaSeconds;
          // Clamp to ≥ 0 (AC-25).
          if (newValue < 0) newValue = 0;
        } else {
          // operation: 'approach'
          const target = rule.target ?? 0;
          if (currentValue > target) {
            newValue = currentValue - rule.rate * tick.deltaSeconds;
            // Clamp to not overshoot target (AC-26, AC-27).
            if (newValue < target) newValue = target;
          } else {
            newValue = currentValue + rule.rate * tick.deltaSeconds;
            // Clamp to not overshoot target.
            if (newValue > target) newValue = target;
          }
        }

        this.registry.applyStatePatch(object.id, { [rule.field]: newValue });
        // Update the object reference so subsequent rules in the same tick see the new value.
        object.state[rule.field] = newValue;
        this.lastApplied.set(key, tick.simulationTime);
      }
    }
  }
}

export {};
