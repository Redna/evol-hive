/**
 * Identity Types — Self-Model & Identity Evolution (spec 033, Scope B)
 * ────────────────────────────────────────────────────────────────────
 * The persona's *live* self-model is a structured, agent-maintained record
 * (traits, self-narrative, long-term goals) living in the memory store and
 * injected into prompts like other memories (spec 033, R11). `AgentProfile`
 * remains the immutable spawn seed — the profile is the fallback when no
 * self-model exists yet (backward compat with all existing agents).
 *
 * Identity deltas are LLM-proposed, guarded, bounded, and audited — never
 * direct writes from message text (spec 033, R13): prompt injection via
 * `talk_to` cannot instantly rewrite identity.
 */

import type { AgentProfile } from './agent.js';
import type { MemoryNode } from './memory.js';
import type { MemorySnippet } from './cognition.js';

/** The agent's structured, evolvable self-model (spec 033, R11). */
export interface SelfModel {
  agentId: string;
  /** Evolved traits (seeded from the profile, then drifted by consolidation). */
  traits: string[];
  /** First-person self-narrative (evolved from the spawn backstory). */
  selfNarrative: string;
  /** Evolved long-term goals / aspirations. */
  longTermGoals: string[];
  /** Monotonic revision counter — bumped on every applied delta batch. */
  revision: number;
  /** Simulation tick of the last evolution. */
  updatedAt: number;
}

/**
 * A bounded, typed identity delta (spec 033, R12/R13). Deltas are proposed by
 * the LLM (`update_self_model` tool or session-end consolidation), validated,
 * and applied by deterministic engine code.
 */
export type IdentityChangeType =
  | 'trait_add'
  | 'trait_remove'
  | 'narrative_edit'
  | 'goal_add'
  | 'goal_remove';

export interface IdentityChangeDelta {
  type: IdentityChangeType;
  value: string;
  /** Why the delta was proposed (audit trail). */
  reason?: string;
}

/**
 * An auditable `identity_change` event (spec 033, R13): every applied delta is
 * recorded with before/after snapshots so the evolution is measurable and
 * reversible.
 */
export interface IdentityChangeAudit {
  agentId: string;
  /** Simulation tick at which the deltas were applied. */
  appliedAt: number;
  deltas: IdentityChangeDelta[];
  before: SelfModel;
  after: SelfModel;
  /** The self-model revision after this batch. */
  revision: number;
}

/** Max deltas the `update_self_model` tool may apply per call (spec 033, R12). */
export const IDENTITY_MAX_DELTAS_PER_UPDATE = 3;

/** Max identity deltas per session across all guarded passes (spec 033, R13). */
export const IDENTITY_MAX_DELTAS_PER_SESSION = 10;

const VALID_TYPES = new Set<string>([
  'trait_add',
  'trait_remove',
  'narrative_edit',
  'goal_add',
  'goal_remove',
]);

/**
 * Filter malformed deltas (unknown types, empty/non-string values) — the
 * deterministic first guard before any LLM-proposed delta touches identity.
 */
export function validateSelfModelDeltas(deltas: unknown[]): IdentityChangeDelta[] {
  const valid: IdentityChangeDelta[] = [];
  for (const delta of deltas) {
    if (typeof delta !== 'object' || delta === null) continue;
    const candidate = delta as Record<string, unknown>;
    if (typeof candidate['type'] !== 'string' || !VALID_TYPES.has(candidate['type'])) continue;
    if (typeof candidate['value'] !== 'string' || candidate['value'].length === 0) continue;
    valid.push({
      type: candidate['type'] as IdentityChangeType,
      value: candidate['value'],
      ...(typeof candidate['reason'] === 'string' ? { reason: candidate['reason'] } : {}),
    });
  }
  return valid;
}

/** Result of a bounded {@link applySelfModelDeltas} application. */
export interface SelfModelApplyOutcome {
  model: SelfModel;
  /** The deltas that were applied (≤ maxDeltas). */
  applied: IdentityChangeDelta[];
  /** How many proposals were dropped by the bound. */
  rejected: number;
}

/**
 * Apply at most `maxDeltas` deltas to a self-model (pure — returns a new
 * model). Bumps `revision` and `updatedAt` when anything was applied.
 * This is the deterministic application path — the LLM never writes identity
 * directly (spec 033, R13).
 */
export function applySelfModelDeltas(
  model: SelfModel,
  deltas: IdentityChangeDelta[],
  maxDeltas: number,
): SelfModelApplyOutcome {
  const bounded = deltas.slice(0, Math.max(0, maxDeltas));
  if (bounded.length === 0) {
    return { model, applied: [], rejected: deltas.length };
  }

  const traits = [...model.traits];
  const goals = [...model.longTermGoals];
  let narrative = model.selfNarrative;

  for (const delta of bounded) {
    switch (delta.type) {
      case 'trait_add':
        if (!traits.includes(delta.value)) traits.push(delta.value);
        break;
      case 'trait_remove': {
        const index = traits.indexOf(delta.value);
        if (index >= 0) traits.splice(index, 1);
        break;
      }
      case 'narrative_edit':
        narrative = delta.value;
        break;
      case 'goal_add':
        if (!goals.includes(delta.value)) goals.push(delta.value);
        break;
      case 'goal_remove': {
        const index = goals.indexOf(delta.value);
        if (index >= 0) goals.splice(index, 1);
        break;
      }
    }
  }

  return {
    model: {
      ...model,
      traits,
      selfNarrative: narrative,
      longTermGoals: goals,
      revision: model.revision + 1,
      updatedAt: model.updatedAt,
    },
    applied: bounded,
    rejected: deltas.length - bounded.length,
  };
}

/**
 * Render the self-model as prompt text (spec 033, R11/AC-13). Deterministic
 * for the same model (KV-cache friendliness, spec 021).
 */
export function selfModelToPromptText(model: SelfModel): string {
  const parts: string[] = [];
  if (model.traits.length > 0) parts.push(`Traits: ${model.traits.join(', ')}`);
  if (model.selfNarrative.length > 0) parts.push(`Self-narrative: ${model.selfNarrative}`);
  if (model.longTermGoals.length > 0) {
    parts.push(`Aspirations: ${model.longTermGoals.join('; ')}`);
  }
  return parts.join('\n');
}

/**
 * Seed a self-model from the immutable spawn profile (spec 033, R11 — the
 * profile is the fallback seed; the self-model then evolves independently).
 */
export function selfModelFromProfile(profile: AgentProfile, tick: number): SelfModel {
  return {
    agentId: profile.id,
    traits: [...profile.traits],
    selfNarrative:
      profile.backstory !== undefined && profile.backstory.length > 0
        ? profile.backstory
        : profile.description,
    longTermGoals: [...(profile.longTermGoals ?? [])],
    revision: 0,
    updatedAt: tick,
  };
}

// ── Memory-store residency (R11 — the self-model lives in the memory store) ─

/**
 * Content marker prefix for identity self-model memory nodes (spec 033, R11).
 * The self-model is stored as a memory node (type `'reflection'` — the LLM
 * never generates this node; the system does at consolidation time) so it
 * round-trips through the existing memory persistence for free.
 */
export const SELF_MODEL_MEMORY_MARKER = 'self-model:';

/**
 * `true` when the memory node is the agent's identity self-model record
 * (detected via the content marker — no new MemoryType, so the reflect
 * schema's LLM-facing enum is untouched).
 */
export function isSelfModelNode(node: MemoryNode | MemorySnippet): boolean {
  return node.content.startsWith(SELF_MODEL_MEMORY_MARKER);
}

/**
 * Serialize a self-model into its memory-node content form (marker +
 * structured JSON) so it is retrievable/injectable like other memories.
 */
export function selfModelToMemoryContent(model: SelfModel): string {
  return `${SELF_MODEL_MEMORY_MARKER}${JSON.stringify(model)}`;
}

/**
 * Parse a self-model from its memory-node content form, or `null` when the
 * node is not a self-model record or the payload is corrupt.
 */
export function selfModelFromMemoryContent(content: string): SelfModel | null {
  if (!content.startsWith(SELF_MODEL_MEMORY_MARKER)) return null;
  try {
    const parsed = JSON.parse(content.slice(SELF_MODEL_MEMORY_MARKER.length)) as SelfModel;
    if (typeof parsed['agentId'] !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}