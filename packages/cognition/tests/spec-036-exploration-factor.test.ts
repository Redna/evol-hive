/**
 * Spec 036 — curiosity-modulated exploration factor tests.
 * Deterministic: seeded PRNG, no Math.random, no LLM.
 */
import { describe, it, expect } from 'vitest';
import type { GateWeightArtifact, HardTriggerFlags, System1FeatureVector } from '@evol-hive/shared';
import { FEATURE_SCHEMA_VERSION, NO_HARD_TRIGGERS } from '@evol-hive/shared';
import { seededDraw, explorationEpsilon, decideWithArtifact } from '../src/system1/react-gate.js';

const EMBED_DIM = 3;

function fixedArtifact(): GateWeightArtifact {
  const scalarWeights: Record<string, number> = {};
  ['energy', 'hunger', 'social', 'comfort', 'curiosity'].forEach((f, i) => {
    scalarWeights[f] = (i + 1) * 0.01;
  });
  return {
    kind: 'react-gate',
    headVersion: 3,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    bias: -0.35,
    scalarWeights,
    embeddingWeights: [0.1, -0.2, 0.3],
  };
}

function featureVector(curiosity: number): System1FeatureVector {
  return {
    schemaVersion: FEATURE_SCHEMA_VERSION,
    embedding: [0, 0, 0],
    scalar: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity },
  };
}

// Zero weights → p(react) = σ(-0.35) ≈ 0.413 < threshold 0.9 → gate says ignore.
const HIGH_THRESHOLD = 0.9;

describe('Spec 036 — explorationEpsilon (Req 1 / AC-2)', () => {
  it('scales linearly with curiosity', () => {
    expect(explorationEpsilon(80, 0.1)).toBeCloseTo(0.08);
    expect(explorationEpsilon(10, 0.1)).toBeCloseTo(0.01);
    expect(explorationEpsilon(100, 0.1)).toBeCloseTo(0.1);
  });

  it('disables exploration at curiosity 0', () => {
    expect(explorationEpsilon(0, 0.1)).toBe(0);
  });

  it('clamps curiosity to [0, 100]', () => {
    expect(explorationEpsilon(150, 0.1)).toBeCloseTo(0.1);
    expect(explorationEpsilon(-20, 0.1)).toBe(0);
  });
});

describe('Spec 036 — seededDraw (Req 2 / AC-3)', () => {
  it('is deterministic for the same seed', () => {
    expect(seededDraw('a1:100:3')).toBe(seededDraw('a1:100:3'));
  });

  it('produces effectively independent draws across agents/ticks', () => {
    const draws = new Set(['a1:100:3', 'a1:101:3', 'a1:102:3', 'a2:100:3'].map(seededDraw));
    expect(draws.size).toBeGreaterThan(1);
  });

  it('always returns a value in [0, 1)', () => {
    for (let i = 0; i < 200; i++) {
      const v = seededDraw(`seed-${i}`);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('Spec 036 — exploration in the gate decision (Req 3-4 / AC-4, AC-5)', () => {
  it('AC-4: exploration fires on low-p(react) ticks when the draw < ε', () => {
    // epsilonBase 1.0 + curiosity 100 → ε = 1 → every tick explores.
    const d = decideWithArtifact(
      fixedArtifact(),
      featureVector(100),
      NO_HARD_TRIGGERS,
      HIGH_THRESHOLD,
      { agentId: 'a1', tickNumber: 5, curiosity: 100, epsilonBase: 1.0 },
    );
    expect(d.react).toBe(true);
    expect(d.explored).toBe(true);
    expect(d.hardTrigger).toBe(false);
  });

  it('AC-4: with curiosity 0 exploration never fires (gate says ignore)', () => {
    const d = decideWithArtifact(
      fixedArtifact(),
      featureVector(0),
      NO_HARD_TRIGGERS,
      HIGH_THRESHOLD,
      { agentId: 'a1', tickNumber: 5, curiosity: 0, epsilonBase: 1.0 },
    );
    expect(d.react).toBe(false);
    expect(d.explored).toBe(false);
  });

  it('AC-5: hard triggers take precedence — explored is false on alarmed cycles', () => {
    const d = decideWithArtifact(
      fixedArtifact(),
      featureVector(100),
      { ...NO_HARD_TRIGGERS, messagePending: true },
      HIGH_THRESHOLD,
      { agentId: 'a1', tickNumber: 5, curiosity: 100, epsilonBase: 1.0 },
    );
    expect(d.react).toBe(true);
    expect(d.hardTrigger).toBe(true);
    expect(d.explored).toBe(false);
  });

  it('Req 5: without exploration config the decision matches spec 035 (default-off)', () => {
    const d = decideWithArtifact(
      fixedArtifact(),
      featureVector(50),
      NO_HARD_TRIGGERS,
      HIGH_THRESHOLD,
    );
    expect(d.react).toBe(false);
    expect(d.explored).toBe(false);
  });

  it('AC-7: replay determinism — the same tick sequence produces an identical decision trace', () => {
    const trace = (): boolean[] => {
      const out: boolean[] = [];
      for (let t = 1; t <= 50; t++) {
        const d = decideWithArtifact(
          fixedArtifact(),
          featureVector(80),
          NO_HARD_TRIGGERS,
          HIGH_THRESHOLD,
          { agentId: 'a1', tickNumber: t, curiosity: 80, epsilonBase: 0.5 },
        );
        out.push(d.react);
      }
      return out;
    };
    expect(trace()).toEqual(trace());
  });
});
