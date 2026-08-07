/**
 * @evol-hive/agents — Agent Management
 * ────────────────────────────────────
 * Section 3: Agent internal state, drives, plans, and profiles.
 * Section 10: Cognitive guardrails integration.
 */

// ── Agent Manager ────────────────────────────────────────────────────────────

/** Manages all agents in the simulation. */
export interface AgentManager {
  /** Spawn a new agent from a profile. */
  spawn(
    profile: import('@evol-hive/shared').AgentProfile,
  ): import('@evol-hive/shared').AgentInternalState;
  /** Get an agent's current internal state. */
  getState(agentId: string): import('@evol-hive/shared').AgentInternalState | null;
  /** Update an agent's internal state (e.g., after update_internal_state tool). */
  updateState(
    agentId: string,
    updates: Partial<import('@evol-hive/shared').AgentInternalState>,
  ): void;
  /** Get all active agents. */
  getActiveAgents(): import('@evol-hive/shared').AgentInternalState[];
  /** Remove an agent from the simulation. */
  despawn(agentId: string): void;
}

// ── Drive System ──────────────────────────────────────────────────────────────

/** Manages agent drives (decay over time, modification via affordances). */
export interface DriveSystem {
  /** Apply natural drive decay over a time delta (simulated needs). */
  applyDecay(state: import('@evol-hive/shared').AgentInternalState, deltaSeconds: number): void;
  /** Apply drive changes from an affordance result. */
  applyChanges(agentId: string, changes: Partial<Record<string, number>>): void;
  /** Get the agent's primary drive (lowest value = most urgent, per §3). */
  getPrimaryDrive(state: import('@evol-hive/shared').AgentInternalState): {
    name: string;
    value: number;
  };
  /** Get the semantic label of the primary drive (e.g. "low energy, need to restore energy"). */
  getPrimaryDriveLabel(state: import('@evol-hive/shared').AgentInternalState): string;
}

// ── Plan Manager ─────────────────────────────────────────────────────────────

/** Manages agent plans (creation, progression, validation). */
export interface PlanManager {
  /** Create a new plan from formulate_plan tool output. */
  createPlan(
    agentId: string,
    result: import('@evol-hive/shared').FormulatePlanResult,
  ): import('@evol-hive/shared').AgentPlan;
  /** Advance to the next step in the plan. */
  advanceStep(agentId: string): void;
  /** Get the current step. */
  getCurrentStep(agentId: string): import('@evol-hive/shared').PlanStep | null;
  /** Check if the plan is complete. */
  isComplete(agentId: string): boolean;
  /** Clear the current plan (e.g., after reflection forces replanning). */
  clearPlan(agentId: string): void;
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export * from './state/index.js';
export * from './drives/index.js';
export * from './plans/index.js';
export * from './feedback/index.js';
export * from './execute/index.js';
