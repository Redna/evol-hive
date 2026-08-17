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

import type { ExecuteResult, ExecuteDataProvider } from '@evol-hive/shared';

/** Constructor options for {@link ExecuteServiceImpl}. */
export interface ExecuteServiceOptions {
  dataProvider: ExecuteDataProvider;
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

      // Resolve the affordance to a specific object in the agent's room.
      const resolved = dataProvider.resolveAffordance(agentState.location, step.targetAffordance);
      if (!resolved) {
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
}

export {};
