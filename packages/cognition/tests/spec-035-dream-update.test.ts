/**
 * Spec 035 — Dream-time weight update tests (Req 11, 12, 13 / AC-6).
 * AC-6: over an accumulated sample set, one dream applies bounded updates,
 * writes a `dream_update` audit event with loss before/after, and hot-swaps
 * weights for subsequent gating; a seeded case where the update degrades
 * holdout loss reverts to the prior snapshot (post-dream loss is never worse).
 */
import { describe, it, expect } from 'vitest';
import {
  FEATURE_SCHEMA_VERSION,
  SCALAR_FEATURE_FIELDS,
  type GateWeightArtifact,
  type CycleOutcomeSample,
  type DreamUpdateEvent,
} from '@evol-hive/shared';
import {
  applyDreamUpdate,
  binaryCrossEntropy,
  evaluateLinearProbe,
  defaultDreamUpdateConfig,
} from '../src/system1/index.js';

function artifact(bias: number, slope: number): GateWeightArtifact {
  const scalarWeights: Record<string, number> = {};
  for (const f of SCALAR_FEATURE_FIELDS) {
    scalarWeights[f] = 0;
  }
  scalarWeights['novelty'] = slope;
  return {
    kind: 'react-gate',
    headVersion: 1,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    bias,
    scalarWeights,
    embeddingWeights: undefined,
  };
}

/** A sample whose scalar vector is all zeros except `novelty`. */
function sample(novelty: number, label: 'react' | 'ignore', index = 0): CycleOutcomeSample {
  const scalar = {} as CycleOutcomeSample['scalar'];
  for (const f of SCALAR_FEATURE_FIELDS) {
    scalar[f] = 0;
  }
  scalar['novelty'] = novelty;
  return {
    schemaVersion: FEATURE_SCHEMA_VERSION,
    headVersion: 1,
    agentId: 'a1',
    tickNumber: index,
    simTime: index * 0.0167,
    label,
    hardTrigger: false,
    pReact: 0.5,
    scalar,
    embedding: [],
  };
}

/** A deterministic event-collecting callback target. */
function collectEvents(): { events: DreamUpdateEvent[]; onEvent: (e: DreamUpdateEvent) => void } {
  const events: DreamUpdateEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

describe('Spec 035 — dream update mechanics (Req 11)', () => {
  it('defaultDreamUpdateConfig enforces the documented bounds (≤200 steps, LR cap)', () => {
    const cfg = defaultDreamUpdateConfig();
    expect(cfg.maxSteps).toBeLessThanOrEqual(200);
    expect(cfg.maxLearningRate).toBeLessThanOrEqual(0.1);
    expect(cfg.learningRate).toBeLessThanOrEqual(cfg.maxLearningRate);
    expect(cfg.lossTolerance).toBeGreaterThanOrEqual(0);
  });

  it('reduces training loss on a separable fixture (the one-line update learns)', () => {
    // Linearly separable: high novelty → react, low novelty → ignore.
    const samples: CycleOutcomeSample[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push(sample(0.9, 'react', i));
      samples.push(sample(0.1, 'ignore', i + 100));
    }
    const prev = artifact(0, 0); // untrained: p = 0.5 everywhere
    const lossBeforeAll = binaryCrossEntropy(
      samples.map((s) =>
        evaluateLinearProbe(prev, {
          schemaVersion: FEATURE_SCHEMA_VERSION,
          embedding: [],
          scalar: s.scalar,
        }),
      ),
      samples.map((s) => (s.label === 'react' ? 1 : 0)),
    );

    const result = applyDreamUpdate(prev, samples, defaultDreamUpdateConfig());
    const lossAfterAll = binaryCrossEntropy(
      samples.map((s) =>
        evaluateLinearProbe(result.artifact, {
          schemaVersion: FEATURE_SCHEMA_VERSION,
          embedding: [],
          scalar: s.scalar,
        }),
      ),
      samples.map((s) => (s.label === 'react' ? 1 : 0)),
    );
    expect(lossAfterAll).toBeLessThan(lossBeforeAll);
    void lossBeforeAll;
  });

  it('applies bounded updates: steps never exceed maxSteps even with more samples', () => {
    const cfg = { ...defaultDreamUpdateConfig(), maxSteps: 20, holdoutFraction: 0 };
    const samples: CycleOutcomeSample[] = [];
    for (let i = 0; i < 500; i++) {
      samples.push(sample(i % 2 === 0 ? 0.9 : 0.1, i % 2 === 0 ? 'react' : 'ignore', i));
    }
    const result = applyDreamUpdate(artifact(0, 0), samples, cfg);
    expect(result.event.trainCount).toBeLessThanOrEqual(20);
  });

  it('bumps headVersion on a committed update and preserves the schema version', () => {
    const samples = [sample(0.9, 'react', 0), sample(0.1, 'ignore', 1)];
    const result = applyDreamUpdate(artifact(0, 0), samples, {
      ...defaultDreamUpdateConfig(),
      holdoutFraction: 0,
    });
    expect(result.artifact.headVersion).toBe(2); // 1 → 2
    expect(result.artifact.featureSchemaVersion).toBe(FEATURE_SCHEMA_VERSION);
    expect(result.event.headVersion).toBe(2);
    expect(result.event.headVersionBefore).toBe(1);
  });
});

describe('Spec 035 — dream audit event (Req 12)', () => {
  it('records N samples and loss before/after in a `dream_update` event', () => {
    const samples: CycleOutcomeSample[] = [];
    for (let i = 0; i < 12; i++) {
      samples.push(sample(0.9, 'react', i));
      samples.push(sample(0.1, 'ignore', i + 50));
    }
    const result = applyDreamUpdate(artifact(0, 0), samples, defaultDreamUpdateConfig());
    expect(result.event.type).toBe('dream_update');
    expect(result.event.sampleCount).toBe(24);
    expect(result.event.lossBefore).toBeGreaterThanOrEqual(0);
    expect(result.event.lossAfter).toBeGreaterThanOrEqual(0);
    expect(result.event.reverted).toBe(false);
  });

  it('emits the event through the audit callback as an auditable record (Req 12)', () => {
    const { events, onEvent } = collectEvents();
    const samples = [sample(0.9, 'react', 0), sample(0.1, 'ignore', 1), sample(0.8, 'react', 2)];
    applyDreamUpdate(
      artifact(0, 0),
      samples,
      { ...defaultDreamUpdateConfig(), holdoutFraction: 0 },
      onEvent,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('dream_update');
    expect(events[0]!.sampleCount).toBe(3);
    expect(events[0]!.headVersion).toBe(2);
  });
});

describe('Spec 035 — holdout revert guardrail (Req 12 / AC-6)', () => {
  it('reverts when the update degrades holdout loss (post-dream loss is never worse)', () => {
    // An already-perfect head evaluated against labels that contradict the
    // training signal: training pushes weights in a direction that wrecks the
    // holdout (labels flipped between train and holdout splits).
    const train: CycleOutcomeSample[] = [
      sample(0.9, 'react', 0),
      sample(0.95, 'react', 1),
      sample(0.85, 'react', 2),
      sample(0.1, 'ignore', 3),
      sample(0.15, 'ignore', 4),
      sample(0.05, 'ignore', 5),
    ];
    // Holdout labels are flipped vs. the pattern the training set teaches.
    const holdout: CycleOutcomeSample[] = [
      sample(0.9, 'ignore', 100),
      sample(0.95, 'ignore', 101),
      sample(0.1, 'react', 102),
    ];
    const prev = artifact(0, 6); // already separates train AND holdout well
    const cfg = { ...defaultDreamUpdateConfig(), learningRate: 0.5, holdoutFraction: 0.35 };

    // Feed train + flipped holdout: the update overfits the train labels and
    // degrades the flipped holdout → the guardrail must revert.
    const all = [...train, ...holdout];
    // Manually partition: put flipped samples at the END (holdout = last 35%).
    const result = applyDreamUpdate(prev, all, cfg);
    if (result.event.lossAfter > result.event.lossBefore) {
      expect(result.event.reverted).toBe(true);
      expect(result.artifact).toEqual(prev); // previous snapshot restored
    } else {
      expect(result.event.reverted).toBe(false);
    }
    // Post-dream holdout loss is never worse than pre-dream (the guarantee).
    const holdoutX = all.slice(-Math.max(1, Math.floor(all.length * cfg.holdoutFraction)));
    const lossAfter = binaryCrossEntropy(
      holdoutX.map((s) =>
        evaluateLinearProbe(result.artifact, {
          schemaVersion: FEATURE_SCHEMA_VERSION,
          embedding: [],
          scalar: s.scalar,
        }),
      ),
      holdoutX.map((s) => (s.label === 'react' ? 1 : 0)),
    );
    const lossBefore = binaryCrossEntropy(
      holdoutX.map((s) =>
        evaluateLinearProbe(prev, {
          schemaVersion: FEATURE_SCHEMA_VERSION,
          embedding: [],
          scalar: s.scalar,
        }),
      ),
      holdoutX.map((s) => (s.label === 'react' ? 1 : 0)),
    );
    expect(lossAfter).toBeLessThanOrEqual(lossBefore + cfg.lossTolerance);
  });

  it('a deterministic seeded case reverts: contradicting holdout labels force restoration', () => {
    // Construct so the committed update MUST degrade the holdout: huge LR,
    // extreme train labels, and holdout labels exactly opposite.
    const train: CycleOutcomeSample[] = [];
    for (let i = 0; i < 13; i++) {
      train.push(sample(0.99, 'react', i));
    }
    const holdout: CycleOutcomeSample[] = [sample(0.99, 'ignore', 90)];
    const prev = artifact(0, 0.1);
    const cfg = { ...defaultDreamUpdateConfig(), learningRate: 0.9, holdoutFraction: 0.07 };
    const result = applyDreamUpdate(prev, [...train, ...holdout], cfg);
    // With one flipped holdout sample and an aggressive LR, the update pushes
    // novelty weight way up, making the flipped holdout loss explode → revert.
    expect(result.event.reverted).toBe(true);
    expect(result.artifact.headVersion).toBe(prev.headVersion);
    // The artifact weights are byte-identical to the previous snapshot.
    expect(result.artifact.bias).toBe(prev.bias);
  });

  it('refuses to update when sample schema versions do not match the artifact (contract)', () => {
    const stale = sample(0.9, 'react', 0);
    stale.schemaVersion = FEATURE_SCHEMA_VERSION + 1;
    const result = applyDreamUpdate(artifact(0, 0), [stale], {
      ...defaultDreamUpdateConfig(),
      holdoutFraction: 0,
    });
    expect(result.event.reverted).toBe(true);
    expect(result.event.headVersion).toBe(1); // unchanged
    expect(result.event.sampleCount).toBe(0);
  });
});

describe('Spec 035 — shared head first (Req 13)', () => {
  it('one dream applies updates over samples from multiple agents (shared head)', () => {
    const samples = [sample(0.9, 'react', 0), sample(0.1, 'ignore', 1)];
    samples[0]!.agentId = 'a1';
    samples[1]!.agentId = 'a2';
    const result = applyDreamUpdate(artifact(0, 0), samples, {
      ...defaultDreamUpdateConfig(),
      holdoutFraction: 0,
    });
    expect(result.event.sampleCount).toBe(2);
    expect(result.artifact.headVersion).toBe(2); // single shared head bumped once
  });
});
