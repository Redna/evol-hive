/**
 * Agent Internal State Schema
 * ───────────────────────────
 * Section 3: Each agent maintains a strict internal state object in the
 * TypeScript engine. This state dictates their immediate needs and informs
 * the System 0 Classifier.
 */

/** Primary drives that motivate agent behavior. Values are 0-100. */
export interface AgentDrives {
  energy: number;
  hunger: number;
  social: number;
  comfort: number;
  curiosity: number;
}

/** The agent's current active plan (output of formulate_plan cognitive tool). */
export interface AgentPlan {
  id: string;
  description: string;
  steps: PlanStep[];
  currentStepIndex: number;
  createdAt: number; // simulation time
}

/** A single actionable step within a plan. */
export interface PlanStep {
  description: string;
  completed: boolean;
  /** The affordance this step maps to, if known. */
  targetAffordance?: string;
}

/** The full internal state of an agent at any point in time. */
export interface AgentInternalState {
  agentId: string;
  drives: AgentDrives;
  currentGoal: string;
  currentPlan: AgentPlan | null;
  /** True when the agent is awaiting an LLM response. */
  isThinking: boolean;
  /** The agent's current location in the world. */
  location: string; // room/scene ID
  /** Timestamp of last perception tick (spatial debouncing). */
  lastPerceptionTick: number;
}

/** Metadata describing an agent's identity and personality. */
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  /** Personality traits that influence LLM system prompts. */
  traits: string[];
  /** Initial drive values at spawn. */
  initialDrives: Partial<AgentDrives>;
}
