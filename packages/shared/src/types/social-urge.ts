/**
 * Social Urge Model — Influence, Not Force (spec 044, issue #160)
 * ───────────────────────────────────────────────────────────────
 * A pure, deterministic per-(agent, target) urge-to-talk computation:
 *
 *   urge(target) = personaSeed × socialDriveFactor × noveltyFactor(target) × reciprocityFactor(target)
 *
 * All factors are pure functions of plain state (persona seed, drive value,
 * per-pair reciprocity counters, trust/familiarity, spawn tick) — no LLM
 * calls, no randomness, no scheduler involvement, no engine or cognition
 * imports (Decision 1: `shared` is the dependency sink; both `engine` and
 * `cognition` consume the same formula per ADR-0001).
 *
 * The urge never forces anything: it renders as a perception hint and shifts
 * the `talk_to` tool's position in the per-agent tool list. The LLM keeps the
 * decision — including staying quiet (R5).
 *
 * Spec 035 hook: the reciprocity factor is deterministic v1. Its arithmetic
 * lives behind {@link computeReciprocityFactor} so a trained System 1 head can
 * later replace it behind the same inputs → same output type signature.
 *
 * The social-drive factor mirrors spec 034's DRIVE_URGENCY_THRESHOLD pattern
 * (low drive value on the 0–100 scale → high urgency → higher factor) without
 * touching `matchDrivesToAffordances`, which deliberately excludes `social`
 * (Decision 2 — the spec-018/024 social-hint system owns that drive).
 */

import type { AgentProfile } from './agent.js';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Urge at or above this value (per present target) renders the "you feel like
 * talking to" hint and moves `talk_to` to the front of the tool list
 * (Decision 5). A default-seed (0.5) agent with a mid social drive and fresh
 * novelty lands near 0.5; the threshold sits just below that so persona and
 * drive differentiation decides surfacing.
 */
export const SOCIAL_URGE_SURFACE_THRESHOLD = 0.45;

/**
 * A reciprocity factor below this value (with at least one message sent)
 * renders the "«name» rarely answers — maybe let them be" decay hint instead
 * of the approach hint (R4b).
 */
export const SOCIAL_URGE_RECIPROCITY_DECAYED = 0.7;

/**
 * Neutral persona seed: no talkativeness signals anywhere (R1, AC-6). Also
 * the neutral urge factor baseline — all factors equal 1 when their inputs
 * carry no signal.
 */
export const DEFAULT_SOCIAL_TALKATIVENESS = 0.5;

/** Seeds assigned to talkative-trait matches ("energetic", …). */
const TALKATIVENESS_HIGH = 0.8;
/** Seeds assigned to reserved-trait matches ("reserved", …). */
const TALKATIVENESS_LOW = 0.25;

/**
 * Keywords that signal a talkative persona (seed → high), matched
 * case-insensitively as substrings against traits, then backstory.
 */
const TALKATIVE_KEYWORDS: readonly string[] = [
  'energetic',
  'outgoing',
  'chatty',
  'chat',
  'talkative',
  'sociable',
  'social',
  'friendly',
  'exuberant',
  'boisterous',
  'gregarious',
];

/**
 * Keywords that signal a reserved persona (seed → low), matched
 * case-insensitively as substrings against traits, then backstory.
 * Reserved signals win over talkative ones anywhere in the profile —
 * personality caution is sticky (deterministic, documented).
 */
const RESERVED_KEYWORDS: readonly string[] = [
  'reserved',
  'shy',
  'quiet',
  'introverted',
  'withdrawn',
  'taciturn',
  'solitary',
  'aloof',
  'recluse',
  'reticent',
];

/** Ticks after which a freshly spawned agent is no longer scene-novel. */
const SCENE_NOVELTY_HORIZON = 600;
/** Scene-novelty boost at spawn (decays linearly to 1 at the horizon). */
const SCENE_NOVELTY_BOOST = 0.15;
/** Total exchanges after which a target is no longer pair-novel. */
const PAIR_NOVELTY_CAP = 5;
/** Pair-novelty boost for a brand-new pair (decays linearly to 1 at the cap). */
const PAIR_NOVELTY_BOOST = 0.15;

/** Reciprocity floor — the urge toward a target never fully reaches zero. */
const RECIPROCITY_FLOOR = 0.2;
/** Reciprocity decay per unanswered message. */
const RECIPROCITY_DECAY_PER_UNANSWERED = 0.2;
/** Reciprocity boost per reply received (capped at {@link RECIPROCITY_BOOST_CAP} replies). */
const RECIPROCITY_BOOST_PER_REPLY = 0.1;
/** Replies counted toward the boost (beyond this, more replies add nothing). */
const RECIPROCITY_BOOST_CAP = 5;
/** Hard clamp bounds for the reciprocity factor. */
const RECIPROCITY_MIN = 0.1;
const RECIPROCITY_MAX = 1.5;

// ── Types ────────────────────────────────────────────────────────────────────

/** The per-pair relationship slice the urge computation consumes (R3). */
export interface SocialUrgeRelationshipSnapshot {
  /** Messages this agent sent to the target (spec 044 R2). */
  sentCount?: number;
  /** Replies this agent received from the target (spec 044 R2). */
  receivedCount?: number;
  /** 0–100 trust (spec 033) — modulates the reciprocity factor. */
  trust: number;
  /** 0–100 familiarity (spec 033) — modulates the reciprocity factor. */
  familiarity: number;
}

/** Inputs to the pure urge computation (R3) — plain data only. */
export interface SocialUrgeInput {
  /** Persona seed 0–1 (spec 044 R1 — {@link deriveSocialTalkativenessSeed}). */
  personaSeed: number;
  /** The agent's `social` drive value on the 0–100 scale (0 = most urgent). */
  socialDrive?: number;
  /** The agent's spawn tick (Decision 6); `undefined` → scene-novelty neutral. */
  spawnTick?: number;
  /** The current engine tick; `undefined` → scene-novelty neutral. */
  currentTick?: number;
  /** The agent's relationship toward the target; `undefined` → reciprocity neutral. */
  relationship?: SocialUrgeRelationshipSnapshot;
}

/** The per-factor breakdown (tests + debugging; Decision 1). */
export interface SocialUrgeFactors {
  personaSeed: number;
  socialDriveFactor: number;
  noveltyFactor: number;
  reciprocityFactor: number;
}

/** The urge computation output: final value + factor breakdown (R3). */
export interface SocialUrgeResult {
  /** urge ∈ [0, 1] for the (agent, target) pair. */
  urge: number;
  factors: SocialUrgeFactors;
}

/**
 * A pending-address item (R4a): another participant made the last turn of an
 * open/active conversation, so this agent owes the reply. Rendered as an
 * INFORMATION line — never a trigger, never a forced cycle (R5).
 */
export interface PendingAddressInfo {
  conversationId: string;
  /** The agent who addressed this agent (made the last turn). */
  fromAgentId: string;
  /** The actual message text quoted in the perception line. */
  content: string;
}

/** Per-present-agent urge assessment carried on `PerceptionResult` (R4b/R4c). */
export interface SocialUrgeAssessment {
  targetAgentId: string;
  /** The full urge computation output for this pair. */
  result: SocialUrgeResult;
  /** Counters consumed (0 when the relationship carried none) — the decay-hint gate. */
  sentCount: number;
  receivedCount: number;
}

// ── Persona seed (R1) ────────────────────────────────────────────────────────

/** Clamp a value into [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Case-insensitive substring match against a keyword list. */
function matchesAnyKeyword(text: string, keywords: readonly string[]): boolean {
  const lowered = text.toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword));
}

/**
 * Derive the persona seed for the urge model from an `AgentProfile` (R1).
 *
 * - An explicit `socialTalkativeness` (0–1) wins over all inference
 *   (clamped to [0, 1]; non-finite values fall back to inference).
 * - Otherwise traits are scanned for reserved/talkative keywords
 *   ("reserved" → low, "energetic" → high), then the backstory.
 * - Reserved signals win over talkative ones (deterministic; documented).
 * - No signal anywhere → the neutral default.
 */
export function deriveSocialTalkativenessSeed(profile: AgentProfile): number {
  const explicit = profile.socialTalkativeness;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return clamp01(explicit);
  }

  const traits = profile.traits ?? [];
  const backstory = profile.backstory ?? '';

  for (const trait of traits) {
    if (matchesAnyKeyword(trait, RESERVED_KEYWORDS)) return TALKATIVENESS_LOW;
  }
  for (const trait of traits) {
    if (matchesAnyKeyword(trait, TALKATIVE_KEYWORDS)) return TALKATIVENESS_HIGH;
  }
  if (backstory.length > 0) {
    if (matchesAnyKeyword(backstory, RESERVED_KEYWORDS)) return TALKATIVENESS_LOW;
    if (matchesAnyKeyword(backstory, TALKATIVE_KEYWORDS)) return TALKATIVENESS_HIGH;
  }
  return DEFAULT_SOCIAL_TALKATIVENESS;
}

// ── Factors (R3) ─────────────────────────────────────────────────────────────

/**
 * Social-drive factor (Decision 2): a LOW social drive value (0 = most urgent
 * on the 0–100 scale) raises the urge. Mirrors spec 034's urgency-threshold
 * pattern: at the DRIVE_URGENCY_THRESHOLD value (40) the factor is 0.8, and
 * everything below the threshold lives in the urgent 0.8–1.0 band. A fully
 * satisfied drive (100) still contributes 0.5 — conversation remains possible,
 * just less urged. `undefined` (drive not reported) is neutral 1.0.
 */
export function socialDriveFactor(socialDrive?: number): number {
  if (socialDrive === undefined || !Number.isFinite(socialDrive)) return 1;
  const clamped = Math.min(100, Math.max(0, socialDrive));
  return 1 - 0.5 * (clamped / 100);
}

/**
 * Novelty factor (Decision 6 — dual source, optional-field based):
 * `max(sceneNovelty, pairNovelty)`.
 *
 * - Scene novelty: a recently spawned agent ("new to the city") feels a
 *   higher urge; `spawnTick`/`currentTick` missing (legacy saves) → neutral.
 * - Pair novelty: few total exchanges with that target → higher urge;
 *   no relationship → the pair is brand new (full pair boost).
 */
export function noveltyFactor(
  spawnTick?: number,
  currentTick?: number,
  relationship?: SocialUrgeRelationshipSnapshot,
): number {
  let sceneNovelty = 1;
  if (spawnTick !== undefined && currentTick !== undefined) {
    const age = Math.max(0, currentTick - spawnTick);
    sceneNovelty = 1 + SCENE_NOVELTY_BOOST * Math.max(0, 1 - age / SCENE_NOVELTY_HORIZON);
  }

  let pairNovelty = 1;
  const sent = relationship?.sentCount;
  const received = relationship?.receivedCount;
  if (sent !== undefined || received !== undefined) {
    // Pair novelty needs interaction EVIDENCE (counters) — "few interactions
    // with that target" is judged from the reciprocity history, never guessed
    // from an untracked relationship (pre-044 relationships stay neutral).
    const total = (sent ?? 0) + (received ?? 0);
    pairNovelty = 1 + PAIR_NOVELTY_BOOST * Math.max(0, 1 - total / PAIR_NOVELTY_CAP);
  }

  return Math.max(sceneNovelty, pairNovelty);
}

/**
 * Reciprocity factor (R2 — learned, per target; Decision 3).
 *
 * Per-relationship counters: messages sent vs replies received.
 * - Each unanswered message (sent − received, floored at 0) decays the urge
 *   toward THAT target ("learned they don't like to talk") — greet 3× with no
 *   reply and the factor drops well below the 1-unreplied value.
 * - Each reply received (up to 5) raises the factor.
 * - Trust/familiarity (spec 033) modulate the whole factor multiplicatively
 *   (neutral at trust 50 / familiarity 0 — the spawn defaults).
 *
 * Deterministic counters for v1. The arithmetic lives in this named function
 * so a trained System 1 head (spec 035) can replace it behind the same
 * inputs → same output type signature (Constraints: future head).
 *
 * No counters at all → neutral 1.0 (pre-spec-044 relationships stay neutral).
 */
export function computeReciprocityFactor(
  relationship?: SocialUrgeRelationshipSnapshot,
): number {
  if (relationship === undefined) return 1;
  const sent = relationship.sentCount;
  const received = relationship.receivedCount;
  if (sent === undefined && received === undefined) return 1;

  const sentCount = Math.max(0, sent ?? 0);
  const receivedCount = Math.max(0, received ?? 0);
  const unanswered = Math.max(0, sentCount - receivedCount);

  const penalty = Math.max(RECIPROCITY_FLOOR, 1 - RECIPROCITY_DECAY_PER_UNANSWERED * unanswered);
  const boost = 1 + RECIPROCITY_BOOST_PER_REPLY * Math.min(receivedCount, RECIPROCITY_BOOST_CAP);

  const trustModulation = 0.75 + 0.5 * clamp01(relationship.trust / 100);
  const familiarityModulation = 0.9 + 0.2 * clamp01(relationship.familiarity / 100);

  const raw = penalty * boost * trustModulation * familiarityModulation;
  return Math.min(RECIPROCITY_MAX, Math.max(RECIPROCITY_MIN, raw));
}

// ── The urge computation (R3, Decision 1) ────────────────────────────────────

/**
 * The pure deterministic urge computation (R3):
 *
 *   urge(target) = personaSeed × socialDriveFactor × noveltyFactor × reciprocityFactor
 *
 * - Consumes only plain data; no LLM calls, no async work, no clock beyond the
 *   passed-in tick values, no engine or cognition imports.
 * - Returns the clamped urge (∈ [0, 1]) plus the factor breakdown for tests
 *   and debugging.
 * - Pure: same input → same output; never mutates its input.
 */
export function computeSocialUrge(input: SocialUrgeInput): SocialUrgeResult {
  const personaSeed = clamp01(input.personaSeed);
  const drive = socialDriveFactor(input.socialDrive);
  const novelty = noveltyFactor(input.spawnTick, input.currentTick, input.relationship);
  const reciprocity = computeReciprocityFactor(input.relationship);

  const urge = clamp01(personaSeed * drive * novelty * reciprocity);
  return {
    urge,
    factors: {
      personaSeed,
      socialDriveFactor: drive,
      noveltyFactor: novelty,
      reciprocityFactor: reciprocity,
    },
  };
}