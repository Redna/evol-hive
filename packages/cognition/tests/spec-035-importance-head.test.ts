/**
 * Spec 035 — Trainable importance head + composite importance tests
 * (Req 14, 15 / AC-7).
 * AC-7: importance composition is the documented composite (prior ⊕ drive-delta
 * magnitude ⊕ downstream utility ⊕ LLM score as one feature) with deterministic
 * fixtures; downstream-utility counters increment on retrieval/plan-success.
 * The retrieval formula itself is frozen (covered by
 * `spec-035-retrieval-frozen-regression.test.ts`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  FEATURE_SCHEMA_VERSION,
  SCALAR_FEATURE_FIELDS,
  type GateWeightArtifact,
} from '@evol-hive/shared';
import {
  LinearImportanceHead,
  makeFeatureArtifactLoader,
  composeImportance,
  IMPORTANCE_COMPOSITION_WEIGHTS,
  DownstreamUtilityTracker,
  sigmoid,
} from '../src/system1/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function importanceArtifact(overrides: Partial<GateWeightArtifact> = {}): GateWeightArtifact {
  const scalarWeights: Record<string, number> = {};
  SCALAR_FEATURE_FIELDS.forEach((f, i) => {
    scalarWeights[f] = 0.1 * (i + 1);
  });
  return {
    kind: 'importance-head',
    headVersion: 2,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    bias: -0.1,
    scalarWeights,
    embeddingWeights: undefined,
    ...overrides,
  };
}

describe('Spec 035 — LinearImportanceHead (Req 14: predicted prior)', () => {
  it('produces a prior in (0, 1) from the frozen feature base', async () => {
    const head = new LinearImportanceHead({
      loader: makeFeatureArtifactLoader(async () => importanceArtifact()),
    });
    await head.ensureLoaded();
    const scalar = {} as GateWeightArtifact['scalarWeights'];
    SCALAR_FEATURE_FIELDS.forEach((f) => {
      scalar[f] = 0.5;
    });
    const prior = head.predict({ schemaVersion: FEATURE_SCHEMA_VERSION, embedding: [], scalar });
    expect(prior).toBeGreaterThan(0);
    expect(prior).toBeLessThan(1);
  });

  it('is deterministic for fixed inputs', async () => {
    const head = new LinearImportanceHead({
      loader: makeFeatureArtifactLoader(async () => importanceArtifact()),
    });
    await head.ensureLoaded();
    const scalar = {} as GateWeightArtifact['scalarWeights'];
    SCALAR_FEATURE_FIELDS.forEach((f, i) => {
      scalar[f] = i % 3 === 0 ? 1 : 0;
    });
    const vector = { schemaVersion: FEATURE_SCHEMA_VERSION, embedding: [0.5], scalar };
    expect(head.predict(vector)).toBe(head.predict(vector));
  });

  it('fails open with a neutral 0.5 prior when the artifact is missing (single warning)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const head = new LinearImportanceHead({
      loader: makeFeatureArtifactLoader(async () => null),
    });
    await head.ensureLoaded();
    const scalar = {} as GateWeightArtifact['scalarWeights'];
    SCALAR_FEATURE_FIELDS.forEach((f) => {
      scalar[f] = 0.9;
    });
    const prior = head.predict({ schemaVersion: FEATURE_SCHEMA_VERSION, embedding: [], scalar });
    expect(prior).toBeCloseTo(0.5, 12);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('Spec 035 — composite importance (Req 14 / AC-7, deterministic fixtures)', () => {
  it('documents composition weights that sum to 1', () => {
    const sum =
      IMPORTANCE_COMPOSITION_WEIGHTS.prior +
      IMPORTANCE_COMPOSITION_WEIGHTS.driveDelta +
      IMPORTANCE_COMPOSITION_WEIGHTS.utility +
      IMPORTANCE_COMPOSITION_WEIGHTS.llm;
    expect(sum).toBeCloseTo(1, 12);
    // The LLM 1–10 score is demoted to ONE feature among several — it may not
    // dominate the composite.
    expect(IMPORTANCE_COMPOSITION_WEIGHTS.llm).toBeLessThan(0.5);
  });

  it('computes the documented composite for a fixture input', () => {
    // prior 0.8, drive-delta magnitude 0.5, utility 0.25, LLM score 6/10.
    const expected =
      IMPORTANCE_COMPOSITION_WEIGHTS.prior * (0.8 * 10) +
      IMPORTANCE_COMPOSITION_WEIGHTS.driveDelta * (0.5 * 10) +
      IMPORTANCE_COMPOSITION_WEIGHTS.utility * (0.25 * 10) +
      IMPORTANCE_COMPOSITION_WEIGHTS.llm * 6;
    const composite = composeImportance({
      predictedPrior: 0.8,
      driveDeltaMagnitude: 0.5,
      downstreamUtility: 0.25,
      llmScore: 6,
    });
    expect(composite).toBeCloseTo(expected, 9);
  });

  it('clamps the composite to 1..10', () => {
    const max = composeImportance({
      predictedPrior: 1,
      driveDeltaMagnitude: 1,
      downstreamUtility: 1,
      llmScore: 10,
    });
    expect(max).toBeLessThanOrEqual(10);
    const min = composeImportance({
      predictedPrior: 0,
      driveDeltaMagnitude: 0,
      downstreamUtility: 0,
      llmScore: 1,
    });
    expect(min).toBeGreaterThanOrEqual(1);
    expect(min).toBeCloseTo(1, 9); // floor applies
  });

  it('treats the LLM score as one feature among several: a high LLM score with low signals stays mid-range', () => {
    const composite = composeImportance({
      predictedPrior: 0,
      driveDeltaMagnitude: 0,
      downstreamUtility: 0,
      llmScore: 10,
    });
    // LLM alone contributes weights.llm × 10 ≤ 5 — never a 10 on its own.
    expect(composite).toBeLessThan(5);
  });

  it('drive-delta magnitude comes from engine state (mean absolute normalized delta)', () => {
    // Mean of |−1, +0.5, 0, 0, 0| = 0.3 — the composition consumes it directly.
    const driveDeltaMagnitude = (1 + 0.5 + 0 + 0 + 0) / 5;
    const composite = composeImportance({
      predictedPrior: 0.5,
      driveDeltaMagnitude,
      downstreamUtility: 0,
      llmScore: 5,
    });
    const expected =
      IMPORTANCE_COMPOSITION_WEIGHTS.prior * 5 +
      IMPORTANCE_COMPOSITION_WEIGHTS.driveDelta * 3 +
      IMPORTANCE_COMPOSITION_WEIGHTS.utility * 0 +
      IMPORTANCE_COMPOSITION_WEIGHTS.llm * 5;
    expect(composite).toBeCloseTo(expected, 9);
  });
});

describe('Spec 035 — downstream utility tracker (Req 14/15: background counter, not a scoring change)', () => {
  it('increments on retrieval and plan-success and saturates at 1', () => {
    const tracker = new DownstreamUtilityTracker();
    expect(tracker.getUtility('m1')).toBe(0);
    tracker.recordRetrieval('m1');
    expect(tracker.getUtility('m1')).toBeGreaterThan(0);
    tracker.recordPlanSuccess('m1');
    expect(tracker.getUtility('m1')).toBeGreaterThan(tracker.getUtility('m2'));
    for (let i = 0; i < 100; i++) {
      tracker.recordRetrieval('m1');
      tracker.recordPlanSuccess('m1');
    }
    expect(tracker.getUtility('m1')).toBe(1); // saturates
  });

  it('keeps per-memory counters independent', () => {
    const tracker = new DownstreamUtilityTracker();
    tracker.recordRetrieval('m1');
    tracker.recordRetrieval('m1');
    expect(tracker.getUtility('m1')).toBeCloseTo(Math.min(1, 2 * 0.1), 12);
    expect(tracker.getUtility('m2')).toBe(0);
  });

  it('exposes raw counts for folding into later writes/reflections', () => {
    const tracker = new DownstreamUtilityTracker();
    tracker.recordRetrieval('m1');
    tracker.recordPlanSuccess('m1');
    const stats = tracker.getStats('m1');
    expect(stats.retrievals).toBe(1);
    expect(stats.planSuccesses).toBe(1);
  });
});

describe('Spec 035 — importance head feeds the prior used at write time (Req 14)', () => {
  it('end-to-end: head prior → composite with engine-state and utility inputs', async () => {
    const head = new LinearImportanceHead({
      loader: makeFeatureArtifactLoader(async () => importanceArtifact({ bias: 3 })),
    });
    await head.ensureLoaded();
    const scalar = {} as GateWeightArtifact['scalarWeights'];
    SCALAR_FEATURE_FIELDS.forEach((f) => {
      scalar[f] = 1;
    });
    const prior = head.predict({ schemaVersion: FEATURE_SCHEMA_VERSION, embedding: [], scalar });
    // bias 3 + Σ 0.1(i+1)·1 = 3 + 1.8·... z = 3 + 0.1·(1+2+...+18) = 3 + 17.1 → σ ≈ 1
    expect(prior).toBeCloseTo(sigmoid(3 + 0.1 * 171), 9);

    const composite = composeImportance({
      predictedPrior: prior,
      driveDeltaMagnitude: 0.4,
      downstreamUtility: 0.1,
      llmScore: 7,
    });
    expect(composite).toBeGreaterThan(5); // a high-signal write
    expect(composite).toBeLessThanOrEqual(10);
  });
});