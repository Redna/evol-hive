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
import { WAIT_AFFORDANCE } from '@evol-hive/shared';
import type { LLMClient, PlanBuilder, GuardrailEngine, LLMContextPayload } from '../index.js';
import { LLMResponseError } from '../llm/index.js';

/** Constructor options for {@link PlanServiceImpl}. */
export interface PlanServiceOptions {
  planBuilder: PlanBuilder;
  llmClient: LLMClient;
  dataProvider: PlanDataProvider;
  /** Optional guardrail engine for contextual forcing (spec 016, Req 9). */
  guardrail?: GuardrailEngine;
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
      // Determine guardrail flags for contextual forcing (spec 016, Req 9).
      const guardrail = this.options.guardrail;
      let builderOptions: import('./plan-builder.js').PlanBuilderGuardrailOptions | undefined;
      if (guardrail !== undefined) {
        const hasPlan =
          existingState?.currentPlan !== null && existingState?.currentPlan !== undefined;
        builderOptions = {
          hasPlan,
          forcingEnabled: guardrail.config.contextualForcing,
        };
      }

      const payload = planBuilder.build(perceptionResult, builderOptions);
      payload.agentId = agentId;

      // Spec 037, Req 1+4: the plan tool schema enum-binds targetAffordance to
      // the affordances available in the agent's current room. The validator
      // enforces presence + membership; on violation we retry ONCE with explicit
      // feedback before failing the cycle (no silent narrative advance).
      const availableIds = payload.availableAffordances.map((a) => a.id);

      let result = await llmClient.completePlan(payload);
      let verdict = checkPlanBinding(result, availableIds);
      console.error(
        `[plan-bind] agent=${agentId} steps=${result.steps.length} bound=${verdict.bound} ` +
          `violations=${JSON.stringify(verdict.violations)}`,
      );

      if (!verdict.valid) {
        // §7 shape failure (missing description/steps): hard fail, NO retry —
        // malformed responses are treated as a failure rather than repaired.
        if (!verdict.shapeValid) {
          return {
            success: false,
            error: 'LLM returned an invalid plan: missing description or steps',
          };
        }
        // Spec 037, Req 2: binding violation — one retry with feedback. The
        // correction is appended to the (already per-cycle) perception
        // context — KV-cache safe.
        const retryPayload: LLMContextPayload = {
          ...payload,
          perceptionContext: `${payload.perceptionContext}\n\nCORRECTION: ${verdict.feedback}`,
        };
        result = await llmClient.completePlan(retryPayload);
        verdict = checkPlanBinding(result, availableIds);
        console.error(
          `[plan-bind] agent=${agentId} retry steps=${result.steps.length} bound=${verdict.bound} ` +
            `violations=${JSON.stringify(verdict.violations)}`,
        );
        if (!verdict.valid) {
          return {
            success: false,
            error: `LLM plan violates the affordance enum after retry: ${verdict.feedback}`,
          };
        }
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
 * Verdict of the spec-037 affordance-binding check on a FormulatePlanResult.
 */
export interface PlanBindingVerdict {
  /** True when the plan may be stored. */
  valid: boolean;
  /** True when the plan passes the §7 shape check (description + steps). */
  shapeValid: boolean;
  /** Number of steps carrying a valid targetAffordance binding. */
  bound: number;
  /** Human-readable violations, one per offending step. */
  violations: string[];
  /** Feedback string for the retry-with-feedback prompt (spec 037, Req 2). */
  feedback: string;
}

/**
 * Validates a FormulatePlanResult against the room's available affordances
 * (spec 037, Req 2):
 *
 * 1. Shape check (§7): non-empty `description` + non-empty `steps` array with
 *    per-step descriptions. Shape-invalid plans fail immediately — malformed
 *    responses are treated as a failure rather than repaired, and do NOT
 *    trigger a retry.
 * 2. Binding check: every step MUST carry a non-empty `targetAffordance` that
 *    is one of `availableIds` or the {@link WAIT_AFFORDANCE} escape.
 *
 * When `availableIds` is empty (guardrail masking, spec 016 — the agent is
 * shown no affordances), the binding check is skipped: enforcing membership
 * against an invisible set would guarantee failure. Telemetry still records
 * the zero-affordance mode.
 */
export function checkPlanBinding(
  result: FormulatePlanResult,
  availableIds: string[],
): PlanBindingVerdict {
  // (1) Shape — hard fail, NO retry (§7 / Req 15): malformed responses are
  // treated as a failure rather than repaired.
  if (!isValidFormulatePlanResult(result)) {
    return {
      valid: false,
      shapeValid: false,
      bound: 0,
      violations: ['missing description or steps'],
      feedback:
        'Your response was not a valid plan: it needs a non-empty "description" and a non-empty "steps" array where every step has a description.',
    };
  }

  // (2) Binding.
  const allowed = new Set<string>(availableIds);
  allowed.add(WAIT_AFFORDANCE);
  const violations: string[] = [];
  let bound = 0;
  if (availableIds.length === 0) {
    // Masked / affordance-less context (spec 016): binding cannot be enforced.
    // Every step counts as bound; the enum contained only 'wait'.
    return {
      valid: true,
      shapeValid: true,
      bound: result.steps.length,
      violations: [],
      feedback: '',
    };
  }
  result.steps.forEach((step, i) => {
    const ta = step.targetAffordance;
    if (typeof ta === 'string' && ta.length > 0 && allowed.has(ta)) {
      bound += 1;
    } else {
      violations.push(
        `step ${i + 1} ("${step.description.slice(0, 50)}") ` +
          `targetAffordance=${ta === undefined ? 'missing' : `'${ta}'`}`,
      );
    }
  });
  if (violations.length > 0) {
    return {
      valid: false,
      shapeValid: true,
      bound,
      violations,
      feedback:
        `Your previous plan had unbound steps (${violations.join('; ')}). EVERY step MUST set ` +
        `targetAffordance to one of the enum values in the formulate_plan tool schema ` +
        `(the affordances available right now), or 'wait'. Resubmit the full corrected plan.`,
    };
  }
  return { valid: true, shapeValid: true, bound, violations: [], feedback: '' };
}

/**
 * Shape-only validation (§7 / Req 15): non-empty `description`, non-empty
 * `steps` array, per-step descriptions. Used by {@link checkPlanBinding} as
 * the hard-fail pre-check; malformed responses are treated as a failure
 * rather than repaired.
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
