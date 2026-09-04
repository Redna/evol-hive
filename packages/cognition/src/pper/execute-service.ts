/**
 * pper/execute-service — Execute phase orchestration
 * ─────────────────────────────────────────────────────
 * Section 6 / §9.1 / spec 003: Orchestrates the Execute phase of the PPER
 * loop. The Execute phase is deterministic (System 1 / engine) — it does
 * NOT invoke the heavy LLM. It reads the current plan step, resolves the
 * target affordance to a smart object, checks preconditions, executes the
 * affordance, applies drive changes, and advances the plan step.
 *
 * On every failure path (affordance not found, preconditions failed,
 * execution failed, or any thrown exception), `isThinking` is set to `false`
 * to ensure the agent is not permanently frozen in the game loop (§9.1).
 * On success, `isThinking` is not modified — it should already be `false`
 * from the Plan phase's `finally` block.
 *
 * The method never re-throws; it returns an `ExecuteResult` with
 * `success: false` on error so the PPER orchestrator can retry on the
 * next tick.
 */

import type {
  AffordanceResult,
  CompoundAction,
  ExecuteResult,
  ExecuteDataProvider,
} from '@evol-hive/shared';
import type { GuardrailEngine } from '../index.js';

/** Constructor options for {@link ExecuteServiceImpl}. */
export interface ExecuteServiceOptions {
  dataProvider: ExecuteDataProvider;
  /** Optional guardrail engine for plan validation (spec 016, Req 11). */
  guardrail?: GuardrailEngine;
}

/** Concrete ExecuteService that orchestrates deterministic affordance execution. */
export class ExecuteServiceImpl {
  constructor(private readonly options: ExecuteServiceOptions) {}

  async execute(agentId: string): Promise<ExecuteResult> {
    const { dataProvider } = this.options;

    try {
      // Retrieve the agent's state.
      const agentState = dataProvider.getAgentState(agentId);
      if (!agentState) {
        return { success: false, error: 'Agent not found', planComplete: true };
      }

      // If there is no active plan, return failure.
      if (agentState.currentPlan === null) {
        return { success: false, error: 'No active plan', planComplete: true };
      }

      // If the plan is already complete, return success without executing.
      if (dataProvider.isPlanComplete(agentId)) {
        return { success: true, planComplete: true };
      }

      // Get the current step.
      const step = dataProvider.getCurrentStep(agentId);
      if (!step) {
        return { success: false, error: 'No current step in plan', planComplete: true };
      }

      // Handle steps without targetAffordance (non-physical steps).
      if (step.targetAffordance === undefined) {
        dataProvider.advanceStep(agentId);
        const planComplete = dataProvider.isPlanComplete(agentId);
        return { success: true, planComplete, stepSkipped: true };
      }

      // Plan validation (spec 016, Req 11): before executing, validate that the
      // action aligns with the current plan. If the guardrail rejects it, set
      // system feedback, stop thinking, and return a deviation result.
      const guardrail = this.options.guardrail;
      if (guardrail !== undefined) {
        const validation = guardrail.validateAction(step.targetAffordance, agentState.currentPlan);
        if (!validation.valid) {
          const reason = validation.reason ?? 'Action deviates from plan';
          dataProvider.setSystemFeedback(agentId, reason);
          dataProvider.setThinking(agentId, false);
          return {
            success: false,
            error: reason,
            planComplete: false,
            deviationRejected: true,
          };
        }
      }

      // Resolve the affordance to a specific object in the agent's room.
      const resolved = dataProvider.resolveAffordance(agentState.location, step.targetAffordance);
      if (!resolved) {
        // Compound fallback (spec 028, Req 3): when plain resolution fails, the
        // step target may be a compound action planned by the LLM. Attempt
        // compound resolution — when the provider implements it and resolves
        // the ID, run the compound's sub-steps sequentially. Otherwise the
        // pre-change skip behavior below is preserved unchanged.
        const compound =
          dataProvider.resolveCompoundAction?.(agentState.location, step.targetAffordance) ?? null;
        if (compound) {
          return await this.executeCompoundAction(agentId, agentState.location, compound);
        }

        // Skip steps with unresolvable affordances (LLM may plan actions that
        // don't map to real affordances). Advance to the next step and continue.
        dataProvider.advanceStep(agentId);
        const planComplete = dataProvider.isPlanComplete(agentId);
        const feedback = `Skipped step: affordance '${step.targetAffordance}' not found in room '${agentState.location}'.`;
        dataProvider.setSystemFeedback(agentId, feedback);
        return { success: true, planComplete, stepSkipped: true };
      }

      // Check preconditions.
      const preconditionResult = dataProvider.checkPreconditions(
        step.targetAffordance,
        resolved.objectId,
      );
      if (!preconditionResult.satisfied) {
        const failedList = preconditionResult.failed.join(', ');
        const feedback = `Preconditions not met for '${step.targetAffordance}': ${failedList}.`;
        dataProvider.setSystemFeedback(agentId, feedback);
        dataProvider.setThinking(agentId, false);
        return {
          success: false,
          error: `Preconditions not met: ${failedList}`,
          planComplete: false,
        };
      }

      // Execute the affordance.
      const result = await dataProvider.executeAffordance(
        resolved.objectId,
        step.targetAffordance,
        agentId,
      );

      if (!result.success) {
        const feedback = result.failureReason ?? 'Affordance execution failed.';
        dataProvider.setSystemFeedback(agentId, feedback);
        dataProvider.setThinking(agentId, false);
        return {
          success: false,
          error: result.failureReason ?? 'Affordance execution failed',
          planComplete: false,
        };
      }

      // Apply drive changes on success (if present and non-empty).
      if (result.driveChanges !== undefined && Object.keys(result.driveChanges).length > 0) {
        dataProvider.applyDriveChanges(agentId, result.driveChanges);
      }

      // Advance the plan step.
      dataProvider.advanceStep(agentId);

      // Report plan completion.
      const planComplete = dataProvider.isPlanComplete(agentId);
      return { success: true, result, planComplete };
    } catch (err) {
      // Guarantee isThinking is set to false on any exception (§9.1).
      dataProvider.setThinking(agentId, false);
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message, planComplete: false };
    }
  }

  /**
   * Execute a compound action's sub-steps sequentially (spec 028, Req 4–7).
   *
   * Each sub-step runs through the existing single-affordance path — resolve,
   * check preconditions, execute. On full success the merged drive changes
   * (numeric sum of the sub-steps' drive changes) are applied once and the
   * plan advances exactly once (Req 5). On any sub-step failure the compound
   * aborts immediately: remaining sub-steps are not attempted, drive changes
   * are not applied, the plan step is not advanced, and system feedback names
   * the compound action and the failed sub-step (Req 6/7). Nested compound
   * actions are not supported (Req 4) — a sub-step that only resolves as a
   * compound action is treated as an execution failure with no recursion.
   */
  private async executeCompoundAction(
    agentId: string,
    roomId: string,
    compound: { objectId: string; compoundAction: CompoundAction },
  ): Promise<ExecuteResult> {
    const { dataProvider } = this.options;
    const { compoundAction } = compound;
    const steps = compoundAction.steps;
    const mergedDrives: Partial<Record<string, number>> = {};

    for (let i = 0; i < steps.length; i++) {
      const subStep = steps[i]!;

      /** Failure message naming the compound action and the failed sub-step. */
      const abortMessage = (reason: string): string =>
        `Compound action '${compoundAction.id}' aborted at step ${i + 1}/${steps.length} ('${subStep.affordanceId}'): ${reason}.`;

      /** Abort: no remaining sub-steps, no drive changes, no plan advance (Req 6/7). */
      const abort = (reason: string): ExecuteResult => {
        const message = abortMessage(reason);
        dataProvider.setSystemFeedback(agentId, message);
        dataProvider.setThinking(agentId, false);
        return { success: false, error: message, planComplete: false };
      };

      // Resolve the sub-step to a plain affordance on the compound's owning
      // object (it lives in the same room). Sub-steps must map to plain
      // affordances — nested compound actions are not supported (Req 4).
      const subResolved = dataProvider.resolveAffordance(roomId, subStep.affordanceId);
      if (!subResolved) {
        const nested = dataProvider.resolveCompoundAction?.(roomId, subStep.affordanceId);
        if (nested) {
          return abort('nested compound actions are not supported');
        }
        return abort(`affordance '${subStep.affordanceId}' not found in room '${roomId}'`);
      }

      // Check preconditions for the sub-step.
      const preconditionResult = dataProvider.checkPreconditions(
        subStep.affordanceId,
        subResolved.objectId,
      );
      if (!preconditionResult.satisfied) {
        const failedList = preconditionResult.failed.join(', ');
        return abort(`preconditions not met: ${failedList}`);
      }

      // Execute the sub-step.
      const result = await dataProvider.executeAffordance(
        subResolved.objectId,
        subStep.affordanceId,
        agentId,
      );
      if (!result.success) {
        return abort(result.failureReason ?? 'Affordance execution failed.');
      }

      // Accumulate drive changes — applied once on full compound success (Req 5).
      for (const [drive, delta] of Object.entries(result.driveChanges ?? {})) {
        mergedDrives[drive] = (mergedDrives[drive] ?? 0) + (delta ?? 0);
      }
    }

    // Full success: apply the merged drive changes once (if non-empty),
    // advance the plan step exactly once, and report completion (Req 5).
    if (Object.keys(mergedDrives).length > 0) {
      dataProvider.applyDriveChanges(agentId, mergedDrives);
    }

    dataProvider.advanceStep(agentId);

    const planComplete = dataProvider.isPlanComplete(agentId);
    const aggregate: AffordanceResult =
      Object.keys(mergedDrives).length > 0
        ? { success: true, driveChanges: mergedDrives }
        : { success: true };
    return { success: true, result: aggregate, planComplete };
  }
}

export {};
