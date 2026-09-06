/**
 * Spec 035 — System 1 React/Ignore gate head tests (Req 3, 4, 6 / AC-2).
 * AC-2: gate inference is deterministic over a fixed weight artifact; artifact
 * load failure, corrupt file, and schema-version mismatch all fail open (all
 * candidates pass) with a single logged warning — never a throw.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  FEATURE_SCHEMA_VERSION,
  SCALAR_FEATURE_FIELDS,
  type GateWeightArtifact,
  type System1FeatureVector,
} from '@evol-hive/shared';
import {
  ReactGateHead,
  sigmoid,
  dotProduct,
  evaluateLinearProbe,
  makeFeatureArtifactLoader,
  makeFileArtifactLoader,
  buildFeatureVector,
} from '../src/system1/index.js';
import { extractScalarFeatures } from '@evol-hive/shared';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Deterministic artifact: scalar weights = field index + 1, embedding weights = 0.1 × i. */
function fixedArtifact(overrides: Partial<GateWeightArtifact> = {}): GateWeightArtifact {
  const scalarWeights: Record<string, number> = {};
  SCALAR_FEATURE_FIELDS.forEach((f, i) => {
    scalarWeights[f] = i + 1;
  });
  return {
    kind: 'react-gate',
    headVersion: 3,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    bias: -0.35,
    scalarWeights,
    embeddingWeights: [0.1, -0.2, 0.3],
    ...overrides,
  };
}

const EMBED_DIM = 3;

function featureVector(embedding: number[], scalarValues: number[]): System1FeatureVector {
  const scalar = {} as System1FeatureVector['scalar'];
  SCALAR_FEATURE_FIELDS.forEach((f, i) => {
    scalar[f] = scalarValues[i % scalarValues.length]!;
  });
  return { schemaVersion: FEATURE_SCHEMA_VERSION, embedding, scalar };
}

describe('Spec 035 — linear probe math (Req 3)', () => {
  it('sigmoid has known values', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 12);
    expect(sigmoid(2)).toBeCloseTo(1 / (1 + Math.exp(-2)), 12);
    expect(sigmoid(-3)).toBeCloseTo(1 / (1 + Math.exp(3)), 12);
    expect(sigmoid(20)).toBeLessThan(1); // no Infinity/NaN at extremes
    expect(Number.isFinite(sigmoid(-1000))).toBe(true);
    expect(sigmoid(1000)).toBeLessThanOrEqual(1);
  });

  it('dotProduct matches hand-computed values', () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(dotProduct([], [])).toBe(0);
  });

  it('evaluateLinearProbe = σ(b + W·x) with known vector → known p', () => {
    const artifact = fixedArtifact();
    // scalar vector: first two fields = 1, rest 0. embedding = [1, 0, 0].
    const scalarValues = SCALAR_FEATURE_FIELDS.map((_, i) => (i < 2 ? 1 : 0));
    const vector = featureVector([1, 0, 0], scalarValues);
    // z = bias + Σ wᵢ·sᵢ + Σ wⱼ·eⱼ = -0.35 + (1·1 + 2·1) + (0.1·1) = 2.75
    const z = -0.35 + (1 + 2) + 0.1;
    const p = evaluateLinearProbe(artifact, vector);
    expect(p).toBeCloseTo(sigmoid(z), 12);
  });

  it('treats missing embeddingWeights as zeros (scalar-only artifact)', () => {
    const artifact = fixedArtifact({ embeddingWeights: undefined });
    const scalarValues = SCALAR_FEATURE_FIELDS.map(() => 0.5);
    const withEmbed = evaluateLinearProbe(artifact, featureVector([1, 2, 3], scalarValues));
    const zeroEmbed = evaluateLinearProbe(artifact, featureVector([0, 0, 0], scalarValues));
    expect(withEmbed).toBe(zeroEmbed);
  });

  it('is deterministic for repeated evaluation', () => {
    const artifact = fixedArtifact();
    const vector = featureVector(
      [0.5, -0.5, 1],
      SCALAR_FEATURE_FIELDS.map(() => 0.3),
    );
    expect(evaluateLinearProbe(artifact, vector)).toBe(evaluateLinearProbe(artifact, vector));
  });
});

describe('Spec 035 — ReactGateHead deterministic inference (AC-2)', () => {
  it('known vector → known p(react) with a fixed artifact', async () => {
    const artifact = fixedArtifact();
    const loader = makeFeatureArtifactLoader(async () => artifact);
    const head = new ReactGateHead({ loader, threshold: 0.5 });
    await head.ensureLoaded();

    const scalarValues = SCALAR_FEATURE_FIELDS.map(() => 0);
    const vector = featureVector([1, 0, 0], scalarValues);
    // z = -0.35 + 0.1 → p = σ(-0.25) ≈ 0.4378
    const decision = head.decide('a1', 1, vector, {
      messagePending: false,
      conversationInvite: false,
      nearbyObjectMutation: false,
      driveThresholdCrossing: false,
    });
    expect(decision.pReact).toBeCloseTo(sigmoid(-0.25), 9);
    expect(decision.react).toBe(false); // p < 0.5
    expect(decision.headVersion).toBe(3);
    expect(decision.failOpen).toBe(false);
  });

  it('reacts when p(react) >= threshold', async () => {
    const head = new ReactGateHead({
      loader: makeFeatureArtifactLoader(async () => fixedArtifact()),
      threshold: 0.4,
    });
    await head.ensureLoaded();
    const decision = head.decide(
      'a1',
      1,
      'a1',
      1,
      featureVector(
        [1, 1, 1],
        SCALAR_FEATURE_FIELDS.map(() => 1),
      ),
      {
        messagePending: false,
        conversationInvite: false,
        nearbyObjectMutation: false,
        driveThresholdCrossing: false,
      },
    );
    // z = -0.35 + Σ(i+1)·1 + (0.1-0.2+0.3) = -0.35 + 171 + 0.2 → p ≈ 1
    expect(decision.pReact).toBeGreaterThan(0.4);
    expect(decision.react).toBe(true);
  });

  it('hard triggers force react even at p(react) = 0 (Req 5)', async () => {
    // An artifact that always produces p = 0: bias = -10000.
    const head = new ReactGateHead({
      loader: makeFeatureArtifactLoader(async () => fixedArtifact({ bias: -10000 })),
      threshold: 0.5,
    });
    await head.ensureLoaded();
    const noTriggers = {
      messagePending: false,
      conversationInvite: false,
      nearbyObjectMutation: false,
      driveThresholdCrossing: false,
    };
    expect(
      head.decide(
        'a1',
        1,
        featureVector(
          [1, 0, 0],
          SCALAR_FEATURE_FIELDS.map(() => 0),
        ),
        noTriggers,
      ).react,
    ).toBe(false);

    for (const trigger of [
      'messagePending',
      'conversationInvite',
      'nearbyObjectMutation',
      'driveThresholdCrossing',
    ] as const) {
      const decision = head.decide(
        'a1',
        1,
        featureVector(
          [1, 0, 0],
          SCALAR_FEATURE_FIELDS.map(() => 0),
        ),
        {
          ...noTriggers,
          [trigger]: true,
        },
      );
      expect(decision.react).toBe(true);
      expect(decision.hardTrigger).toBe(true);
      expect(decision.pReact).toBeLessThan(0.001);
    }
  });
});

describe('Spec 035 — fail-open semantics (Req 6 / AC-2)', () => {
  it('fails open when the artifact loader throws (load failure)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const head = new ReactGateHead({
      loader: makeFeatureArtifactLoader(async () => {
        throw new Error('file not found');
      }),
      threshold: 0.5,
    });
    await head.ensureLoaded();

    const vector = featureVector(
      [1, 0, 0],
      SCALAR_FEATURE_FIELDS.map(() => 0),
    );
    const decision = head.decide('a1', 1, vector, {
      messagePending: false,
      conversationInvite: false,
      nearbyObjectMutation: false,
      driveThresholdCrossing: false,
    });
    expect(decision.react).toBe(true); // pass all candidates
    expect(decision.failOpen).toBe(true);
    expect(decision.pReact).toBe(1);
  });

  it('fails open on a corrupt (unparseable) artifact file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loader = makeFeatureArtifactLoader(async () => {
      // Simulates reading a file whose contents are not valid JSON.
      return JSON.parse('{not valid json!!') as unknown as GateWeightArtifact;
    });
    const head = new ReactGateHead({ loader, threshold: 0.5 });
    await head.ensureLoaded();
    const decision = head.decide(
      'a1',
      1,
      'a1',
      1,
      featureVector(
        [1, 0, 0],
        SCALAR_FEATURE_FIELDS.map(() => 0),
      ),
      {
        messagePending: false,
        conversationInvite: false,
        nearbyObjectMutation: false,
        driveThresholdCrossing: false,
      },
    );
    expect(decision.react).toBe(true);
    expect(decision.failOpen).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1); // warn once, not per decision
  });

  it('fails open on schema-version mismatch and warns exactly once across many decisions', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const head = new ReactGateHead({
      loader: makeFeatureArtifactLoader(async () =>
        fixedArtifact({ featureSchemaVersion: FEATURE_SCHEMA_VERSION + 5 }),
      ),
      threshold: 0.5,
    });
    await head.ensureLoaded();
    for (let i = 0; i < 25; i++) {
      const decision = head.decide(
        'a1',
        1,
        'a1',
        1,
        featureVector(
          [0.1, 0, 0],
          SCALAR_FEATURE_FIELDS.map(() => 0.1),
        ),
        {
          messagePending: false,
          conversationInvite: false,
          nearbyObjectMutation: false,
          driveThresholdCrossing: false,
        },
      );
      expect(decision.react).toBe(true);
      expect(decision.failOpen).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('fails open (no throw) when the artifact is missing entirely', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const head = new ReactGateHead({
      loader: makeFeatureArtifactLoader(async () => null),
      threshold: 0.5,
    });
    await head.ensureLoaded();
    const decision = head.decide(
      'a1',
      1,
      'a1',
      1,
      featureVector(
        [1, 0, 0],
        SCALAR_FEATURE_FIELDS.map(() => 0),
      ),
      {
        messagePending: false,
        conversationInvite: false,
        nearbyObjectMutation: false,
        driveThresholdCrossing: false,
      },
    );
    expect(decision.react).toBe(true);
    expect(decision.failOpen).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never throws from decide(), even for malformed weight shapes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const head = new ReactGateHead({
      loader: makeFeatureArtifactLoader(async () =>
        fixedArtifact({
          scalarWeights: 'garbage' as unknown as GateWeightArtifact['scalarWeights'],
        }),
      ),
      threshold: 0.5,
    });
    await head.ensureLoaded();
    expect(() =>
      head.decide(
        'a1',
        1,
        'a1',
        1,
        featureVector(
          [1, 0, 0],
          SCALAR_FEATURE_FIELDS.map(() => 0),
        ),
        {
          messagePending: false,
          conversationInvite: false,
          nearbyObjectMutation: false,
          driveThresholdCrossing: false,
        },
      ),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn at all when the artifact is healthy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const head = new ReactGateHead({
      loader: makeFeatureArtifactLoader(async () => fixedArtifact()),
      threshold: 0.5,
    });
    await head.ensureLoaded();
    head.decide(
      'a1',
      1,
      featureVector(
        [1, 0, 0],
        SCALAR_FEATURE_FIELDS.map(() => 0),
      ),
      {
        messagePending: false,
        conversationInvite: false,
        nearbyObjectMutation: false,
        driveThresholdCrossing: false,
      },
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Spec 035 — hot-swap (Req 12: new weights hot-swap, no restart)', () => {
  it('a hot-swapped artifact changes subsequent decisions and bumps the logged head version', async () => {
    const head = new ReactGateHead({
      loader: makeFeatureArtifactLoader(async () => fixedArtifact({ bias: -10000 })),
      threshold: 0.5,
    });
    await head.ensureLoaded();
    const vector = featureVector(
      [1, 0, 0],
      SCALAR_FEATURE_FIELDS.map(() => 0),
    );
    const triggers = {
      messagePending: false,
      conversationInvite: false,
      nearbyObjectMutation: false,
      driveThresholdCrossing: false,
    };
    expect(head.decide('a1', 1, vector, triggers).react).toBe(false);

    head.hotSwap(fixedArtifact({ bias: 10000, headVersion: 4 }));
    const after = head.decide('a1', 1, vector, triggers);
    expect(after.react).toBe(true);
    expect(after.headVersion).toBe(4);
    expect(after.failOpen).toBe(false);
  });

  it('hot-swapping a schema-mismatched artifact is rejected (stays on current weights)', async () => {
    const head = new ReactGateHead({
      loader: makeFeatureArtifactLoader(async () => fixedArtifact({ bias: -10000 })),
      threshold: 0.5,
    });
    await head.ensureLoaded();
    const vector = featureVector(
      [1, 0, 0],
      SCALAR_FEATURE_FIELDS.map(() => 0),
    );
    head.hotSwap(fixedArtifact({ featureSchemaVersion: 999 }));
    // Still the old (healthy) artifact — a bad swap must not brick the gate.
    expect(
      head.decide('a1', 1, vector, {
        messagePending: false,
        conversationInvite: false,
        nearbyObjectMutation: false,
        driveThresholdCrossing: false,
      }).failOpen,
    ).toBe(false);
  });
});

describe('Spec 035 — artifact loader (spec-007 pattern: lazy load, injectable factory)', () => {
  it('makeFileArtifactLoader reads a JSON artifact from disk lazily and caches it', async () => {
    // Uses the committed training fixture artifact (AC-5) to prove the
    // loader path end-to-end.
    const load = makeFileArtifactLoader(
      join(__dirname, '../../../training/artifacts/react-gate-fixture-v1.json'),
    );
    const first = await load();
    expect(first).not.toBeNull();
    expect(first?.kind).toBe('react-gate');
    expect(first?.featureSchemaVersion).toBe(FEATURE_SCHEMA_VERSION);
    const second = await load();
    expect(second).toBe(first); // cached — one read
  });

  it('makeFileArtifactLoader surfaces a missing file as null (fail-open upstream)', async () => {
    const load = makeFileArtifactLoader(
      join(__dirname, '../../../training/artifacts/does-not-exist.json'),
    );
    await expect(load()).resolves.toBeNull();
  });
});

describe('Spec 035 — gate over full engine-produced vectors', () => {
  it('evaluates a vector built by buildFeatureVector end-to-end', async () => {
    const artifact = fixedArtifact();
    const head = new ReactGateHead({
      loader: makeFeatureArtifactLoader(async () => artifact),
      threshold: 0.5,
    });
    await head.ensureLoaded();
    const snapshot = {
      agentId: 'a1',
      tickNumber: 1,
      simTime: 0.0167,
      drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      drivesAtLastCycle: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      ticksSinceLastCycle: 0,
      messagePending: false,
      conversationOpen: false,
      conversationTurns: 0,
      nearbyObjectStateChange: false,
      worldMutation: false,
      snapshotText: 'test',
    };
    const vector = buildFeatureVector(snapshot, [1, 0, 0], undefined);
    const decision = head.decide('a1', 1, vector, {
      messagePending: false,
      conversationInvite: false,
      nearbyObjectMutation: false,
      driveThresholdCrossing: false,
    });
    // z = -0.35 + 0.1 (embedding only; scalars: drives 0.5 × (i+1) and deltas 0).
    const z =
      -0.35 +
      0.1 +
      (1 + 2 + 3 + 4 + 5) * 0.5 +
      6 * 0 + // novelty field (index 10) weight 11 × novelty 1? — computed below
      0;
    // Explicitly compute from the vector to avoid hand-arithmetic drift.
    let expected = artifact.bias!;
    SCALAR_FEATURE_FIELDS.forEach((f, i) => {
      expected += (i + 1) * vector.scalar[f];
    });
    expected += 0.1 * 1 + -0.2 * 0 + 0.3 * 0;
    void z;
    expect(decision.pReact).toBeCloseTo(sigmoid(expected), 9);
  });
});
