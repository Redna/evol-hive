/**
 * pper/plan-service — Plan phase orchestration
 * ───────────────────────────────────────────
 * Section 6 (Plan): Orchestrates the Plan phase. Receives the PerceptionResult
 * from the Perceive phase, builds the LLM context, calls the LLM with
 * formulatePlanSchema as the grammar constraint, and stores the resulting plan.
 *
 * Safety guarantees (Req 16):
 *   - isThinking is set to true before the LLM call and ALWAYS set to false
 *     afterward (success, failure, or exception — via try/finally).
 *   - On failure, the agent's currentPlan is left unchanged so the PPER
 *     orchestrator can retry on the next tick.
 *   - If the agent already has a non-null currentPlan, the LLM is NOT called —
 *     the existing plan is returned immediately (Req 7).
 */

import type {
  PerceptionResult,
  PlanResult,
  FormulatePlanResult,
  PlanDataProvider,
} from '@evol-hive/shared';
import type { LLMClient, PlanBuilder, PlanService, PlanServiceOptions } from '../index.js';

/** Concrete PlanService orchestrating the Plan phase. */
export class PlanServiceImpl implements PlanService {
  private readonly planBuilder: PlanBuilder;
  private readonly llmClient: LLMClient;
  private readonly dataProvider: PlanDataProvider;

  constructor(options: PlanServiceOptions) {
    this.planBuilder = options.planBuilder;
    this.llmClient = options.llmClient;
    this.dataProvider = options.dataProvider;
  }

  async plan(agentId: string, perceptionResult: PerceptionResult): Promise<PlanResult> {
    // Req 7: If the agent already has a plan, return it without calling the LLM.
    const existingState = this.dataProvider.getAgentState(agentId);
    if (existingState && existingState.currentPlan !== null) {
      return { success: true, plan: existingState.currentPlan };
    }

    // Set isThinking = true before the LLM call (§9.1).
    this.dataProvider.setThinking(agentId, true);

    try {
      // Build the LLM context payload and invoke the LLM.
      const payload = this.planBuilder.build(perceptionResult);
      const result = await this.llmClient.completePlan(payload);

      // Req 15: Validate the response is a well-formed FormulatePlanResult.
      if (!isValidPlanResult(result)) {
        return {
          success: false,
          error: 'LLM returned an invalid plan response: missing description or steps',
        };
      }

      // Store the plan and reset isThinking.
      const plan = this.dataProvider.storePlan(agentId, result);
      return { success: true, plan };
    } catch (err) {
      // Req 6: Do not re-throw. Return a failure result so the orchestrator can retry.
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    } finally {
      // Req 16: ALWAYS reset isThinking, on both success and failure paths.
      this.dataProvider.setThinking(agentId, false);
    }
  }
}

/**
 * Validates that the LLM response is a well-formed FormulatePlanResult.
 * Missing `description` or `steps` (or empty `steps` array) is treated as invalid (Req 15).
 */
function isValidPlanResult(result: FormulatePlanResult): result is FormulatePlanResult {
  return (
    result !== null &&
    typeof result === 'object' &&
    typeof (result as FormulatePlanResult).description === 'string' &&
    Array.isArray((result as FormulatePlanResult).steps)
  );
}

export {};
