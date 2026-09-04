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
  PlanValidationContext,
  PlanValidationResult,
  TopologyGuard,
} from '@evol-hive/shared';
import { GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE } from '@evol-hive/shared';
import type { GuardrailEngine } from '../index.js';

/** Cognitive tool names that are always valid regardless of plan state. */
const COGNITIVE_TOOL_NAMES = new Set([
  'formulate_plan',
  'query_memory',
  'update_internal_state',
  'talk_to',
  'observe_agent',
  'help',
  'ignore',
  'modify_scene',
]);

/** Constructor options for {@link GuardrailEngineImpl}. */
export interface GuardrailEngineOptions {
  config: GuardrailConfig;
  /**
   * Optional topology guard for movement validation (spec 030, Req 10).
   * Implemented by the engine (scene manager); when present, plan validation
   * rejects movement through closed connections (§10 mechanism 3 →
   * reflection tick).
   */
  topologyGuard?: TopologyGuard;
}

/**
 * Concrete guardrail engine — affordance masking, contextual forcing flags,
 * and plan validation (spec 016, Req 5).
 */
export class GuardrailEngineImpl implements GuardrailEngine {
  readonly config: GuardrailConfig;
  /** Optional topology guard (spec 030, Req 10). `undefined` when not wired. */
  private readonly topologyGuard: TopologyGuard | undefined;

  constructor(config: GuardrailConfig, topologyGuard?: TopologyGuard);
  constructor(options: GuardrailEngineOptions);
  constructor(
    configOrOptions: GuardrailConfig | GuardrailEngineOptions,
    topologyGuard?: TopologyGuard,
  ) {
    if (typeof configOrOptions === 'object' && 'config' in configOrOptions) {
      this.config = configOrOptions.config;
      this.topologyGuard = configOrOptions.topologyGuard;
    } else {
      this.config = configOrOptions;
      this.topologyGuard = topologyGuard;
    }
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
   * - Cognitive tool names are always valid (including `modify_scene`, spec 030 Req 14c).
   * - When a topology guard is wired and the optional context carries the
   *   agent's room, movement through a closed connection is rejected with an
   *   actionable reason (spec 030, Req 10 / AC-4).
   * - Returns `{ valid: true }` when the action matches the current step's `targetAffordance`.
   * - Returns `{ valid: false, reason }` when the action deviates from the plan.
   */
  validateAction(
    action: string,
    plan: AgentPlan | null,
    context?: PlanValidationContext,
  ): PlanValidationResult {
    // Cognitive tools are never rejected (Req 7; spec 030 masks modify_scene
    // exactly like other cognitive tools — plan-validation parity, Req 14c).
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

    // Topology-aware validation (spec 030, Req 10): a movement action toward
    // a room unreachable through open connections is rejected as a blocked
    // step — this triggers a reflection tick via the Execute phase.
    if (this.topologyGuard !== undefined && context?.fromRoom !== undefined) {
      if (this.topologyGuard.isMovementBlocked(context.agentId, action, context.fromRoom)) {
        return {
          valid: false,
          reason: `Movement '${action}' from room '${context.fromRoom}' is blocked: the connection is closed. Reflect and choose a different action.`,
        };
      }
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
