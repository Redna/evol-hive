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
  // ── Persona fields (spec 012, Req 1) — all optional for backward compat ──
  /** A short backstory for the agent, injected into the LLM system prompt. */
  backstory?: string;
  /** Long-term goals and aspirations beyond the current drive-based goal. */
  longTermGoals?: string[];
  /** Behavioral tendencies (e.g., "risk-averse", "curious", "social", "methodical"). */
  behavioralTendencies?: string[];
  /** Speech style / tone preferences (e.g., "formal and precise", "casual and witty"). */
  speechStyle?: string;
  /** Relationships with other agents, keyed by agent ID. */
  relationships?: Record<string, string>;
}

/** A formatted persona description string suitable for injection into LLM system prompts. */
export type PersonaText = string;

/**
 * Produces a natural-language persona description string by composing the
 * profile fields (spec 012, Req 3). The output is suitable for injection into
 * LLM system prompts.
 *
 * - If `backstory` is present: includes `"<name>: <backstory>"`.
 * - If `traits` is non-empty: includes `"Traits: <trait1>, <trait2>, ..."`.
 * - If `behavioralTendencies` is non-empty: includes `"Tendencies: <tendency1>, <tendency2>, ..."`.
 * - If `speechStyle` is present: includes `"Speech style: <speechStyle>"`.
 * - If `longTermGoals` is non-empty: includes `"Aspirations: <goal1>; <goal2>; ..."`.
 * - If `relationships` is non-empty: includes `"Relationships: <id1>: <desc1>; <id2>: <desc2>; ..."`.
 * - If none of the persona fields are present, returns the `description` (backward compat).
 * - Never returns an empty string — falls back to `name` if nothing else is set.
 *
 * If the output exceeds 500 characters, a warning is logged (Req 23).
 */
export function formatPersona(profile: AgentProfile): PersonaText {
  // Check if any NEW persona fields are present (spec 012, Req 3).
  // traits is an existing field — it is only included in the composed output
  // when at least one new persona field is also present.
  const hasNewPersonaFields =
    (profile.backstory !== undefined && profile.backstory.length > 0) ||
    (profile.behavioralTendencies !== undefined && profile.behavioralTendencies.length > 0) ||
    (profile.speechStyle !== undefined && profile.speechStyle.length > 0) ||
    (profile.longTermGoals !== undefined && profile.longTermGoals.length > 0) ||
    (profile.relationships !== undefined && Object.keys(profile.relationships).length > 0);

  if (!hasNewPersonaFields) {
    // No new persona fields — fall back to description, then name (backward compat).
    if (profile.description !== undefined && profile.description.length > 0) {
      return profile.description;
    }
    return profile.name;
  }

  const lines: string[] = [];

  if (profile.backstory !== undefined && profile.backstory.length > 0) {
    lines.push(`${profile.name}: ${profile.backstory}`);
  }
  if (profile.traits !== undefined && profile.traits.length > 0) {
    lines.push(`Traits: ${profile.traits.join(', ')}`);
  }
  if (profile.behavioralTendencies !== undefined && profile.behavioralTendencies.length > 0) {
    lines.push(`Tendencies: ${profile.behavioralTendencies.join(', ')}`);
  }
  if (profile.speechStyle !== undefined && profile.speechStyle.length > 0) {
    lines.push(`Speech style: ${profile.speechStyle}`);
  }
  if (profile.longTermGoals !== undefined && profile.longTermGoals.length > 0) {
    lines.push(`Aspirations: ${profile.longTermGoals.join('; ')}`);
  }
  if (profile.relationships !== undefined && Object.keys(profile.relationships).length > 0) {
    const relEntries = Object.entries(profile.relationships)
      .map(([id, desc]) => `${id}: ${desc}`)
      .join('; ');
    lines.push(`Relationships: ${relEntries}`);
  }

  const result = lines.join('\n');
  if (result.length > 500) {
    console.warn(
      `[formatPersona] Persona text exceeds 500 characters (${result.length}). Consider trimming persona fields.`,
    );
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drive Edge State Detection (spec 008, Req 6.1)
// ─────────────────────────────────────────────────────────────────────────────

/** The five primary drives, in canonical order. */
const DRIVE_KEYS = ['energy', 'hunger', 'social', 'comfort', 'curiosity'] as const;

/**
 * Detects whether all drives are at an extreme (0 or 100). Returns `'all-zero'`
 * when all five drives are 0, `'all-full'` when all are 100, and `null` otherwise
 * (spec 008, Req 6.1, AC-18).
 */
export function detectDriveEdgeState(drives: AgentDrives): 'all-zero' | 'all-full' | null {
  const allZero = DRIVE_KEYS.every((key) => drives[key] === 0);
  if (allZero) return 'all-zero';
  const allFull = DRIVE_KEYS.every((key) => drives[key] === 100);
  if (allFull) return 'all-full';
  return null;
}
