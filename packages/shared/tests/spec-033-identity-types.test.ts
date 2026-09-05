/**
 * Tests for spec 033 — Identity Evolution & Cross-Session Self-Model (issue #128)
 * — shared layer: self-model data types, bounded delta application, and
 * persistence format v3.
 *
 * Covers:
 * - AC-8 (R11, R12, R13): self-model delta validation and bounded application;
 *   deltas are typed and auditable.
 * - AC-11 (R12, R13): the application helper is bounded (max-N per call) and
 *   produces the data needed for an `identity_change` audit event.
 * - AC-9/AC-12 (R10, R16): SAVE_FORMAT_VERSION is 3, MIN_SUPPORTED stays 1,
 *   DynamicWorldSnapshot carries conversations, and DormantAgentSnapshot /
 *   AgentSnapshot carry an optional evolved self-model.
 * - AC-13 (R14): the self-model renders to prompt text and seeds from the
 *   immutable spawn profile (persona stays the fallback).
 */
import { describe, it, expect } from 'vitest';
import type { AgentProfile, SelfModel, IdentityChangeDelta } from '@evol-hive/shared';
import {
  SAVE_FORMAT_VERSION,
  MIN_SUPPORTED_SAVE_FORMAT_VERSION,
  IDENTITY_MAX_DELTAS_PER_UPDATE,
  IDENTITY_MAX_DELTAS_PER_SESSION,
  applySelfModelDeltas,
  validateSelfModelDeltas,
  selfModelToPromptText,
  selfModelFromProfile,
} from '@evol-hive/shared';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSelfModel(overrides: Partial<SelfModel> = {}): SelfModel {
  return {
    agentId: 'agent-a',
    traits: ['curious', 'methodical'],
    selfNarrative: 'I am a careful gardener who loves rare plants.',
    longTermGoals: ['grow a rare orchid', 'make friends with the barista'],
    revision: 1,
    updatedAt: 100,
    ...overrides,
  };
}

const SPAWN_PROFILE: AgentProfile = {
  id: 'agent-a',
  name: 'Fern',
  description: 'A gardener.',
  traits: ['curious'],
  initialDrives: { energy: 90 },
  backstory: 'Tends the community garden.',
  longTermGoals: ['grow a rare orchid'],
};

// ── AC-8 — delta validation (typed, bounded) ────────────────────────────────

describe('validateSelfModelDeltas (AC-8, R12)', () => {
  it('keeps well-formed deltas', () => {
    const deltas: IdentityChangeDelta[] = [
      { type: 'trait_add', value: 'patient' },
      { type: 'narrative_edit', value: 'I am becoming more patient.' },
      { type: 'goal_add', value: 'learn propagation' },
      { type: 'trait_remove', value: 'curious' },
      { type: 'goal_remove', value: 'make friends' },
    ];
    expect(validateSelfModelDeltas(deltas)).toHaveLength(5);
  });

  it('drops malformed deltas (unknown type, empty value)', () => {
    const deltas = [
      { type: 'trait_add', value: 'patient' },
      { type: 'explode_identity', value: 'evil' }, // unknown type — rejected
      { type: 'goal_add', value: '' }, // empty value — rejected
      { type: 'narrative_edit', value: 42 }, // non-string value — rejected
    ] as unknown as IdentityChangeDelta[];
    const valid = validateSelfModelDeltas(deltas);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.type).toBe('trait_add');
  });
});

// ── AC-8 / AC-11 — bounded application ──────────────────────────────────────

describe('applySelfModelDeltas (AC-8, AC-11, R12/R13)', () => {
  it('applies trait_add / trait_remove', () => {
    const result = applySelfModelDeltas(makeSelfModel(), [
      { type: 'trait_add', value: 'patient' },
      { type: 'trait_remove', value: 'curious' },
    ], IDENTITY_MAX_DELTAS_PER_UPDATE);
    expect(result.applied).toHaveLength(2);
    expect(result.model.traits).toContain('patient');
    expect(result.model.traits).not.toContain('curious');
    expect(result.model.revision).toBe(2);
  });

  it('applies narrative_edit, goal_add, goal_remove', () => {
    const result = applySelfModelDeltas(makeSelfModel(), [
      { type: 'narrative_edit', value: 'I am a gardener learning patience.' },
      { type: 'goal_add', value: 'learn propagation' },
      { type: 'goal_remove', value: 'make friends with the barista' },
    ], IDENTITY_MAX_DELTAS_PER_UPDATE);
    expect(result.model.selfNarrative).toBe('I am a gardener learning patience.');
    expect(result.model.longTermGoals).toContain('learn propagation');
    expect(result.model.longTermGoals).not.toContain('make friends with the barista');
  });

  it('is bounded: applies at most maxDeltas per call and reports the rejected count', () => {
    const deltas: IdentityChangeDelta[] = [
      { type: 'trait_add', value: 'a' },
      { type: 'trait_add', value: 'b' },
      { type: 'trait_add', value: 'c' },
      { type: 'trait_add', value: 'd' },
      { type: 'trait_add', value: 'e' },
    ];
    const result = applySelfModelDeltas(makeSelfModel(), deltas, IDENTITY_MAX_DELTAS_PER_UPDATE);
    expect(IDENTITY_MAX_DELTAS_PER_UPDATE).toBe(3);
    expect(result.applied).toHaveLength(3);
    expect(result.rejected).toBe(2);
  });

  it('does not mutate the input model (pure function)', () => {
    const original = makeSelfModel();
    const snapshot = JSON.stringify(original);
    applySelfModelDeltas(original, [{ type: 'trait_add', value: 'patient' }], 3);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('exposes the session cap constant (max-N per session)', () => {
    expect(IDENTITY_MAX_DELTAS_PER_SESSION).toBeGreaterThan(0);
    expect(IDENTITY_MAX_DELTAS_PER_SESSION).toBeLessThan(50);
  });
});

// ── AC-13 — prompt rendering + spawn-seed fallback ──────────────────────────

describe('selfModelToPromptText (AC-13, R11)', () => {
  it('renders traits, narrative, and goals into prompt text', () => {
    const text = selfModelToPromptText(makeSelfModel());
    expect(text).toContain('curious');
    expect(text).toContain('careful gardener');
    expect(text).toContain('rare orchid');
  });

  it('is stable for the same model (deterministic prompt injection)', () => {
    expect(selfModelToPromptText(makeSelfModel())).toBe(selfModelToPromptText(makeSelfModel()));
  });
});

describe('selfModelFromProfile (R11 — profile is the immutable spawn seed)', () => {
  it('seeds the self-model from the profile', () => {
    const model = selfModelFromProfile(SPAWN_PROFILE, 0);
    expect(model.agentId).toBe('agent-a');
    expect(model.traits).toEqual(['curious']);
    expect(model.selfNarrative).toContain('Tends the community garden');
    expect(model.longTermGoals).toEqual(['grow a rare orchid']);
    expect(model.revision).toBe(0);
  });
});

// ── AC-9 / AC-12 — persistence format v3 ────────────────────────────────────

describe('save format version (AC-9, AC-12, R10/R16)', () => {
  it('bumps SAVE_FORMAT_VERSION to 3', () => {
    expect(SAVE_FORMAT_VERSION).toBe(3);
  });

  it('keeps MIN_SUPPORTED_SAVE_FORMAT_VERSION at 1 so v1/v2 saves still load', () => {
    expect(MIN_SUPPORTED_SAVE_FORMAT_VERSION).toBe(1);
  });
});