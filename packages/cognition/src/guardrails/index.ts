/**
 * guardrails/ — Cognitive guardrails implementation (spec 016, §10)
 * ────────────────────────────────────────────────────────────────────────────
 * Concrete `GuardrailEngineImpl` implementing the `GuardrailEngine` interface.
 * Constructed with a `GuardrailConfig` and exposes:
 *   - `maskAffordances(affordances, hasPlan)` — hides physical affordances when
 *     the agent has no plan and `affordanceMasking` is enabled.
 *   - `validateAction(action, plan)` — checks that a physical action aligns
 *     with the current plan step's `targetAffordance` when `planValidation` is
 *     enabled. Cognitive tool names are always valid.
 */

import type {
  Affordance,
  AgentPlan,
  GuardrailConfig,
  PlanValidationResult,
} from '@evol-hive/shared';
import { GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE } from '@evol-hive/shared';
import type { GuardrailEngine } from '../index.js';

/** Cognitive tool names that are always valid regardless of plan state. */
const COGNITIVE_TOOL_NAMES = new Set(['formulate_plan', 'query_memory', 'update_internal_state']);

/**
 * Concrete guardrail engine — affordance masking, contextual forcing flags,
 * and plan validation (spec 016, Req 5).
 */
export class GuardrailEngineImpl implements GuardrailEngine {
  readonly config: GuardrailConfig;

  constructor(config: GuardrailConfig) {
    this.config = config;
  }

  /**
   * Apply affordance masking (spec 016, Req 6).
   *
   * - Returns `affordances` unchanged when `affordanceMasking === false` OR `hasPlan === true`.
   * - Returns `[]` when `affordanceMasking === true` AND `hasPlan === false`.
   */
  maskAffordances(affordances: Affordance[], hasPlan: boolean): Affordance[] {
    if (!this.config.affordanceMasking || hasPlan) {
      return affordances;
    }
    return [];
  }

  /**
   * Validate a physical action against the current plan (spec 016, Req 7).
   *
   * - Returns `{ valid: true }` when `planValidation === false` OR `plan === null`.
   * - Cognitive tool names are always valid.
   * - Returns `{ valid: true }` when the action matches the current step's `targetAffordance`.
   * - Returns `{ valid: false, reason }` when the action deviates from the plan.
   */
  validateAction(action: string, plan: AgentPlan | null): PlanValidationResult {
    // Cognitive tools are never rejected (Req 7).
    if (COGNITIVE_TOOL_NAMES.has(action)) {
      return { valid: true };
    }

    // No plan to validate against — the guardrail does not block (Req 7).
    if (plan === null) {
      return { valid: true };
    }

    // Plan validation disabled — do not block (Req 7).
    if (!this.config.planValidation) {
      return { valid: true };
    }

    // Determine the current step's targetAffordance.
    const currentStep = plan.steps[plan.currentStepIndex];
    const stepTarget = currentStep?.targetAffordance;

    // If the current step has a target and the action matches → valid.
    if (stepTarget !== undefined && stepTarget === action) {
      return { valid: true };
    }

    // Deviation — the action does not match the plan's current step target.
    return {
      valid: false,
      reason: GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE.replace('{action}', action),
    };
  }
}

export {};
