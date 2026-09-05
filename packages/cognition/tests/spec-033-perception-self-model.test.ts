/**
 * Tests for spec 033 — Evolved self-model prompt injection (issue #128) —
 * cognition perception-builder layer.
 *
 * Covers:
 * - AC-13 (R14): a respawned dormant agent's prompt reflects the evolved
 *   self-model, not the spawn-time persona seed — when the self-model is
 *   present, its narrative/traits/goals appear in the system prompt.
 * - R11: the self-model is injected into prompts like other memories;
 *   absent self-model → persona fallback (backward compat, AC-14).
 */
import { describe, it, expect } from 'vitest';
import type { PassivePerception, PerceptionResult, SelfModel } from '@evol-hive/shared';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SPAWN_PERSONA = {
  id: 'agent-a',
  name: 'Fern',
  description: 'A gardener.',
  traits: ['curious'],
  initialDrives: {},
  backstory: 'Tends the community garden.',
  longTermGoals: ['grow a rare orchid'],
};

const EVOLVED: SelfModel = {
  agentId: 'agent-a',
  traits: ['curious', 'guarded'],
  selfNarrative: 'After the hostile exchange, I keep my distance from Bob.',
  longTermGoals: ['grow a rare orchid', 'avoid Bob'],
  revision: 3,
  updatedAt: 900,
};

function makePerceptionResult(overrides: Partial<PerceptionResult> = {}): PerceptionResult {
  const passive: PassivePerception = {
    roomId: 'garden',
    objectsPresent: [],
    drives: { energy: 90, hunger: 80, social: 50, comfort: 70, curiosity: 60 },
    ...overrides.passive,
  };
  return {
    passive,
    prunedAffordances: [],
    primaryDriveLabel: 'comfortable',
    persona: SPAWN_PERSONA,
    ...overrides,
    ...(overrides.passive ? { passive: { ...passive, ...overrides.passive } } : {}),
  } as PerceptionResult;
}

// ── AC-13 — evolved self-model reaches the prompt ────────────────────────────

describe('self-model prompt injection (AC-13, R11/R14)', () => {
  const builder = new PerceptionBuilderImpl();

  it('includes the evolved self-model content in the system prompt when present', () => {
    const payload = builder.build(makePerceptionResult({ selfModel: EVOLVED }));
    expect(payload.systemPrompt).toContain('keep my distance from Bob');
    expect(payload.systemPrompt).toContain('guarded');
    expect(payload.systemPrompt).toContain('avoid Bob');
  });

  it('marks the self-model as the evolved self so the LLM prefers it over the seed', () => {
    const payload = builder.build(makePerceptionResult({ selfModel: EVOLVED }));
    expect(payload.systemPrompt.toLowerCase()).toContain('self-model');
  });

  it('falls back to the spawn persona when no self-model exists (backward compat)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.systemPrompt).toContain('Tends the community garden');
    expect(payload.systemPrompt).not.toContain('self-model');
  });

  it('is deterministic for the same inputs (KV-cache friendliness, spec 021)', () => {
    const a = builder.build(makePerceptionResult({ selfModel: EVOLVED })).systemPrompt;
    const b = builder.build(makePerceptionResult({ selfModel: EVOLVED })).systemPrompt;
    expect(a).toBe(b);
  });
});
