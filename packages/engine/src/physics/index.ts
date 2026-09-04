/**
 * physics/ — Deterministic physics execution
 * ──────────────────────────────────────────
 * Section 4 / spec 003: The `PhysicsSystemImpl` executes affordances by
 * dispatching to registered handlers. It checks preconditions, invokes the
 * handler, and updates object state on success. All execution is deterministic
 * (System 1 / engine) — no LLM calls, no random number generation (Req 21, 23).
 */

import type { Affordance, AffordanceResult, GameTick } from '@evol-hive/shared';
import type { PhysicsSystem } from '../index.js';
import type { SmartObjectRegistry } from '../world/index.js';
import type { AffordanceRegistryImpl } from '../world/affordances/index.js';

/**
 * Live agent-location resolver (spec 031, Req 1). Returns the agent's CURRENT
 * room at execution time — never a cached or perception-time snapshot. Wired
 * in `assembly.ts` from the live agent state.
 */
export type AgentLocationResolver = (agentId: string) => string | undefined;

/**
 * Concrete PhysicsSystem. Executes affordances by:
 * 1. Looking up the SmartObject via `SmartObjectRegistry.get`.
 * 2. Finding the Affordance on the object.
 * 3. Checking preconditions via `AffordanceRegistryImpl.checkPreconditions`.
 * 4. Invoking the registered `AffordanceHandler`.
 * 5. Updating object state on success.
 */
export class PhysicsSystemImpl implements PhysicsSystem {
  readonly name = 'physics';

  /**
   * Live agent-location resolver (spec 031, Req 1). `undefined` when not
   * wired (bare constructions) — the co-location guard is then inert,
   * preserving pre-031 behavior for existing constructions.
   */
  private readonly agentLocationResolver: AgentLocationResolver | undefined;

  constructor(
    private readonly smartObjectRegistry: SmartObjectRegistry,
    private readonly affordanceRegistry: AffordanceRegistryImpl,
    agentLocationResolver?: AgentLocationResolver,
  ) {
    this.agentLocationResolver = agentLocationResolver;
  }

  /** No-op tick update (physics is event-driven, not tick-driven). */
  update(_tick: GameTick): void {
    // No-op — affordance execution is on-demand, not per-tick.
  }

  /**
   * Execute an affordance's engine effect on the world.
   * Returns an `AffordanceResult` — never throws.
   */
  async executeAffordance(
    objectId: string,
    affordanceId: string,
    agentId: string,
  ): Promise<AffordanceResult> {
    // 1. Look up the SmartObject.
    const object = this.smartObjectRegistry.get(objectId);
    if (!object) {
      return { success: false, failureReason: 'Object not found' };
    }

    // 1.5 Execute-time co-location guard (spec 031, Req 1): the object's
    // CURRENT room must equal the agent's LIVE location — dynamic scenes
    // (spec 030 move_object) can relocate targets after plan formation, and
    // resolution source or perception-time validity cannot be trusted
    // (AC-13). On mismatch: graceful failure, handler never invoked, no
    // state mutation (AC-2). The check is O(1) — one live agent-state read.
    if (this.agentLocationResolver !== undefined) {
      const agentLocation = this.agentLocationResolver(agentId);
      if (agentLocation !== undefined && object.roomId !== agentLocation) {
        return {
          success: false,
          failureReason: `The ${object.name} (${objectId}) is no longer here — it moved to the ${object.roomId}.`,
        };
      }
    }

    // 2. Find the Affordance on the object.
    const affordance = object.affordances.find((a: Affordance) => a.id === affordanceId);
    if (!affordance) {
      return { success: false, failureReason: 'Affordance not available on this object' };
    }

    // 3. Check preconditions.
    const preconditionResult = this.affordanceRegistry.checkPreconditions(affordanceId, objectId);
    if (!preconditionResult.satisfied) {
      return {
        success: false,
        failureReason: `Preconditions not met: ${preconditionResult.failed.join(', ')}`,
      };
    }

    // 4. Invoke the registered handler.
    const handler = this.affordanceRegistry.getHandler(affordanceId);
    if (!handler) {
      return {
        success: false,
        failureReason: `No handler registered for affordance: ${affordanceId}`,
      };
    }

    const result = await handler(objectId, agentId, object.state);

    // 5. On success, update object state if newState is provided.
    if (result.success && result.newState !== undefined) {
      this.smartObjectRegistry.updateState(objectId, result.newState);
    }

    // 6. On success, apply cross-object state changes (spec 018, Req 19).
    if (result.success && result.crossObjectStateChanges) {
      for (const change of result.crossObjectStateChanges) {
        this.smartObjectRegistry.applyStatePatch(change.objectId, change.statePatch);
      }
    }

    return result;
  }
}

export {};
