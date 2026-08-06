/**
 * plans/ — Plan creation, progression, validation, and data-provider bridge
 * ──────────────────────────────────────────────────────────────────────────
 * Section 3 (AgentPlan, PlanStep), Section 6 (Plan phase), Section 9 (isThinking).
 *
 * PlanManagerImpl owns plan lifecycle: create, advance, query, complete, clear.
 * PlanDataProviderImpl is the bridge that the cognition layer uses (via the
 * PlanDataProvider interface in shared) without coupling cognition → engine.
 */

import type {
  AgentInternalState,
  AgentPlan,
  FormulatePlanResult,
  PlanDataProvider,
  PlanStep,
} from '@evol-hive/shared';
import type { AgentManager, PlanManager } from '../index.js';

// ─── PlanManagerImpl ─────────────────────────────────────────────────────────

/** Concrete PlanManager backed by AgentManager for state storage. */
export class PlanManagerImpl implements PlanManager {
  constructor(private readonly agentManager: AgentManager) {}

  createPlan(agentId: string, result: FormulatePlanResult): AgentPlan {
    const simTime = this.getSimulationTime(agentId);
    const plan: AgentPlan = {
      id: `plan_${agentId}_${Date.now()}`,
      description: result.description,
      steps: result.steps.map((s) => ({
        description: s.description,
        completed: false,
        ...(s.targetAffordance !== undefined ? { targetAffordance: s.targetAffordance } : {}),
      })),
      currentStepIndex: 0,
      createdAt: simTime,
    };

    this.agentManager.updateState(agentId, { currentPlan: plan });
    return plan;
  }

  advanceStep(agentId: string): void {
    const state = this.agentManager.getState(agentId);
    if (!state || !state.currentPlan) return;

    const plan = state.currentPlan;
    if (plan.currentStepIndex >= plan.steps.length) return; // no-op if complete

    // Mark the current step as completed and advance the index.
    const updatedSteps = plan.steps.map((step, idx) =>
      idx === plan.currentStepIndex ? { ...step, completed: true } : step,
    );
    const updatedPlan: AgentPlan = {
      ...plan,
      steps: updatedSteps,
      currentStepIndex: plan.currentStepIndex + 1,
    };
    this.agentManager.updateState(agentId, { currentPlan: updatedPlan });
  }

  getCurrentStep(agentId: string): PlanStep | null {
    const state = this.agentManager.getState(agentId);
    if (!state || !state.currentPlan) return null;
    const plan = state.currentPlan;
    if (plan.currentStepIndex >= plan.steps.length) return null;
    return plan.steps[plan.currentStepIndex] ?? null;
  }

  isComplete(agentId: string): boolean {
    const state = this.agentManager.getState(agentId);
    if (!state || !state.currentPlan) return true;
    return state.currentPlan.currentStepIndex >= state.currentPlan.steps.length;
  }

  clearPlan(agentId: string): void {
    this.agentManager.updateState(agentId, { currentPlan: null });
  }

  /** Get the current simulation time for plan createdAt timestamps. */
  private getSimulationTime(_agentId: string): number {
    // The AgentManager does not track a global simulation clock directly.
    // We use Date.now() as a monotonic time source for plan timestamps.
    // A dedicated clock dependency can replace this in future iterations.
    return Date.now();
  }
}

// ─── PlanDataProviderImpl ────────────────────────────────────────────────────

/**
 * Bridge between cognition and engine (per ADR-0001). Implements the
 * PlanDataProvider interface defined in @evol-hive/shared so the cognition
 * layer can store plans and manage isThinking without importing from engine.
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
