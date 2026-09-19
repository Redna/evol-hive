/**
 * plans/ — Plan creation, progression, validation, and the cognition bridge
 * ──────────────────────────────────────────────────────────────────────────
 * Section 3 / spec 002: Manages agent plans (creation from formulate_plan
 * tool output, step progression, completion checks, and clearing). Also
 * provides the `PlanDataProviderImpl` bridge that lets the cognition layer
 * interact with agent state and plan storage without coupling packages
 * (per ADR-0001).
 */

import type {
  AgentInternalState,
  AgentPlan,
  FormulatePlanResult,
  PlanStep,
  PlanDataProvider,
} from '@evol-hive/shared';
import type { AgentManager, PlanManager, PlanManagerInvalidating } from '../index.js';

/** A clock function that returns the current simulation time. */
export type SimulationClock = () => number;

/**
 * Concrete PlanManager backed by an AgentManager. Plan ids are generated
 * as `plan_${agentId}_${clock()}` to guarantee uniqueness per creation
 * event (Req 18) — the constructor-injected `SimulationClock` is the only
 * time source (spec 056, Req 4: deterministic under fixed-clock tests,
 * consistent with sim time — the spec-054 epoch-stamp family).
 */
export class PlanManagerImpl implements PlanManagerInvalidating {
  /** Monotonic counter to guarantee unique plan ids within the same millisecond. */
  private static planCounter = 0;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly clock: SimulationClock,
  ) {}

  createPlan(agentId: string, result: FormulatePlanResult): AgentPlan {
    const id = `plan_${agentId}_${this.clock()}_${PlanManagerImpl.planCounter++}`;
    const createdAt = this.clock();

    this.stampSupersededOutcome(agentId);

    // Diagnostic (issue #130 arc): what did the LLM actually bind?
    console.error(
      `[plan-create] agent=${agentId} steps=` +
        JSON.stringify(
          result.steps.map((s) => ({
            t: s.targetAffordance ?? null,
            a: s.targetArea ?? null,
            d: s.description.slice(0, 40),
          })),
        ),
    );

    const steps: PlanStep[] = result.steps.map((step) => {
      const planStep: PlanStep = {
        description: step.description,
        completed: false,
      };
      if (step.targetAffordance !== undefined) {
        planStep.targetAffordance = step.targetAffordance;
      }
      // Spec 039, R1: the targetArea intent rides with the stored step so
      // Execute can navigate before executing on arrival.
      if (step.targetArea !== undefined) {
        planStep.targetArea = step.targetArea;
      }
      return planStep;
    });

    const plan: AgentPlan = {
      id,
      description: result.description,
      steps,
      currentStepIndex: 0,
      createdAt,
    };

    this.agentManager.updateState(agentId, { currentPlan: plan });
    return plan;
  }

  /**
   * Stamp a superseded outcome for a still in-flight plan BEFORE the new
   * plan replaces it (spec 056, Req 1 — issue #201). The dominant batch plan
   * path re-formulates every cycle and unconditionally overwrites
   * `currentPlan`, so multi-step plans die mid-flight — the Reflect-phase
   * stamp (`stampPlanOutcome`, spec 055 Req 4) only fires on plans that just
   * completed or failed, a condition the dominant path almost never reaches.
   * Stamping at the REPLACEMENT moment gives the next cycle's plan prompt the
   * abandonment self-visibility (the #191 repetition signature defense).
   *
   * Guard: only plans still in flight (`currentStepIndex < steps.length`) are
   * stamped — a replaced plan that already completed belongs to the Reflect
   * stamp (Req 6: no double-stamping with a misleading `success: false`).
   * Wrapped in try/catch (spec-049 discipline): a stamping or diagnostic
   * failure must never break plan creation.
   */
  private stampSupersededOutcome(agentId: string): void {
    try {
      const oldPlan = this.agentManager.getState(agentId)?.currentPlan ?? null;
      if (!oldPlan || oldPlan.currentStepIndex >= oldPlan.steps.length) return;

      this.agentManager.updateState(agentId, {
        lastPlanOutcome: {
          planDescription: oldPlan.description,
          // Per-step rendered identity, in plan order: the step's
          // `targetAffordance` when bound, else its description — the same
          // rendering `stampPlanOutcome` uses (spec 055 Req 4).
          steps: oldPlan.steps.map((step) => step.targetAffordance ?? step.description),
          success: false,
          superseded: true,
          stepsCompleted: oldPlan.currentStepIndex,
          stepsTotal: oldPlan.steps.length,
          reflected: false, // no reflection ever happened for the abandoned plan
        },
      });

      // Spec 056, Req 5: one zero-LLM stderr line per supersession.
      console.error(
        `[plan-superseded] agent=${agentId}: superseded after ` +
          `${oldPlan.currentStepIndex} of ${oldPlan.steps.length} steps ` +
          `("${oldPlan.description.slice(0, 40)}")`,
      );
    } catch {
      // Diagnostic-grade data: never break the cycle over it.
    }
  }

  advanceStep(agentId: string): void {
    const state = this.agentManager.getState(agentId);
    if (!state?.currentPlan) return;

    const plan = state.currentPlan;
    if (plan.currentStepIndex >= plan.steps.length) return;

    // Mark the current step as completed.
    plan.steps[plan.currentStepIndex]!.completed = true;

    // Increment the step index, capped at steps.length.
    const nextIndex = plan.currentStepIndex + 1;
    this.agentManager.updateState(agentId, {
      currentPlan: {
        ...plan,
        steps: [...plan.steps],
        currentStepIndex: nextIndex,
      },
    });
  }

  getCurrentStep(agentId: string): PlanStep | null {
    const state = this.agentManager.getState(agentId);
    if (!state?.currentPlan) return null;

    const { currentStepIndex, steps } = state.currentPlan;
    if (currentStepIndex < 0 || currentStepIndex >= steps.length) return null;
    return steps[currentStepIndex] ?? null;
  }

  isComplete(agentId: string): boolean {
    const state = this.agentManager.getState(agentId);
    if (!state?.currentPlan) return true;

    return state.currentPlan.currentStepIndex >= state.currentPlan.steps.length;
  }

  clearPlan(agentId: string): void {
    this.agentManager.updateState(agentId, { currentPlan: null });
  }

  /**
   * Invalidate the in-flight plan (spec 059, R3 — issue #210): stamp the
   * spec-056 `superseded` outcome for the plan being abandoned, then clear
   * `currentPlan` so the sticky Plan phase (spec 002) re-formulates from
   * fresh eligibility. The `superseded` stamp is the honest self-visibility
   * record (spec 057 vocabulary) because Reflect's `planAtEntry` is null
   * after the clear and can no longer stamp. A subsequent `createPlan` sees
   * no in-flight plan and therefore does not stamp a second outcome.
   */
  invalidatePlan(agentId: string): void {
    this.stampSupersededOutcome(agentId);
    this.clearPlan(agentId);
  }
}

/**
 * Bridge between the cognition layer and the engine (per ADR-0001).
 * Implements `PlanDataProvider` (defined in `@evol-hive/shared`) using
 * `AgentManager` and `PlanManager`.
 */
export class PlanDataProviderImpl implements PlanDataProvider {
  constructor(
    private readonly agentManager: AgentManager,
    private readonly planManager: PlanManager,
  ) {}

  getAgentState(agentId: string): AgentInternalState | null {
    return this.agentManager.getState(agentId);
  }

  storePlan(agentId: string, result: FormulatePlanResult): AgentPlan {
    return this.planManager.createPlan(agentId, result);
  }

  setThinking(agentId: string, isThinking: boolean): void {
    this.agentManager.updateState(agentId, { isThinking });
  }
}

export {};
