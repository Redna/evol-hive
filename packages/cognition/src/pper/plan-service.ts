/**
 * pper/plan-service — Plan phase orchestration
 * ─────────────────────────────────────────────
 * Section 6.2 / §9.1 / spec 002: Orchestrates the Plan phase of the PPER
 * loop. Sets `isThinking` on the agent, builds the context payload, calls
 * the LLM, and stores the resulting plan. If the agent already has a
 * non-null `currentPlan`, no LLM call is made (prevents redundant calls).
 *
 * The `isThinking` flag is always reset to `false` — on success, on
 * failure, and on any exception path. The method never re-throws; it
 * returns a `PlanResult` with `success: false` on error so the PPER
 * orchestrator can retry on the next tick.
 */

import type {
  PerceptionResult,
  PlanResult,
  PlanDataProvider,
  FormulatePlanResult,
} from '@evol-hive/shared';
import type { LLMClient, PlanBuilder } from '../index.js';
import { LLMResponseError } from '../llm/index.js';

/** Constructor options for {@link PlanServiceImpl}. */
export interface PlanServiceOptions {
  planBuilder: PlanBuilder;
  llmClient: LLMClient;
  dataProvider: PlanDataProvider;
}

/** Concrete PlanService that orchestrates plan formulation via the LLM. */
export class PlanServiceImpl {
  constructor(private readonly options: PlanServiceOptions) {}

  async plan(agentId: string, perceptionResult: PerceptionResult): Promise<PlanResult> {
    const { planBuilder, llmClient, dataProvider } = this.options;

    // If the agent already has an active plan, return it without calling the LLM.
    const existingState = dataProvider.getAgentState(agentId);
    if (existingState?.currentPlan) {
      return { success: true, plan: existingState.currentPlan };
    }

    // Set isThinking = true before the LLM call (§9.1).
    dataProvider.setThinking(agentId, true);

    try {
      const payload = planBuilder.build(perceptionResult);
      const result = await llmClient.completePlan(payload);

      // Validate the LLM response before storing (§7 / Req 15).
      if (!isValidFormulatePlanResult(result)) {
        return {
          success: false,
          error: 'LLM returned an invalid plan: missing description or steps',
        };
      }

      const plan = dataProvider.storePlan(agentId, result);
      return { success: true, plan };
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      // Distinguish LLM response (parse) errors from transient errors (spec 008, Req 3.2, AC-10).
      if (err instanceof LLMResponseError) {
        message = `LLM response error: ${message}`;
      }
      return { success: false, error: message };
    } finally {
      // Always reset isThinking — on success, failure, and exception paths (§9.1).
      dataProvider.setThinking(agentId, false);
    }
  }
}

/**
 * Validates that a FormulatePlanResult has the required `description` (string)
 * and `steps` (non-empty array) fields. Per §7, malformed responses are treated
 * as a failure rather than repaired.
 */
function isValidFormulatePlanResult(result: FormulatePlanResult): boolean {
  if (typeof result.description !== 'string' || result.description.length === 0) {
    return false;
  }
  if (!Array.isArray(result.steps) || result.steps.length === 0) {
    return false;
  }
  for (const step of result.steps) {
    if (typeof step.description !== 'string' || step.description.length === 0) {
      return false;
    }
  }
  return true;
}

export {};
