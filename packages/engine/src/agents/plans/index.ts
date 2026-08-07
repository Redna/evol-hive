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
import type { AgentManager, PlanManager } from '../index.js';

/** A clock function that returns the current simulation time. */
export type SimulationClock = () => number;

/**
 * Concrete PlanManager backed by an AgentManager. Plan ids are generated
 * as `plan_${agentId}_${Date.now()}` to guarantee uniqueness per creation
 * event (Req 18).
 */
export class PlanManagerImpl implements PlanManager {
  /** Monotonic counter to guarantee unique plan ids within the same millisecond. */
  private static planCounter = 0;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly clock: SimulationClock,
  ) {}

  createPlan(agentId: string, result: FormulatePlanResult): AgentPlan {
    const id = `plan_${agentId}_${Date.now()}_${PlanManagerImpl.planCounter++}`;
    const createdAt = this.clock();

    const steps: PlanStep[] = result.steps.map((step) => {
      const planStep: PlanStep = {
        description: step.description,
        completed: false,
      };
      if (step.targetAffordance !== undefined) {
        planStep.targetAffordance = step.targetAffordance;
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
