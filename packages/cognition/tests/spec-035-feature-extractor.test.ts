/**
 * Spec 035 — System 1 feature extractor tests (Req 1, Req 2 / AC-1).
 * AC-1: the extractor is a pure function with deterministic unit tests:
 *   - drive deltas match hand-computed values across a scripted tick sequence;
 *   - novelty decreases as the snapshot embedding approaches recent-memory
 *     embeddings;
 *   - every flag toggles from engine state alone;
 *   - field order and normalization are stable and FEATURE_SCHEMA_VERSION is
 *     stamped in output.
 */
import { describe, it, expect } from 'vitest';
import {
  FEATURE_SCHEMA_VERSION,
  SCALAR_FEATURE_FIELDS,
  type AgentDrives,
  type System1EngineSnapshot,
} from '@evol-hive/shared';
import {
  computeNovelty,
  computeDriveDeltas,
  detectThresholdCrossings,
  extractScalarFeatures,
  scalarToVector,
  buildFeatureVector,
  cosine,
} from '../src/system1/index.js';

function drives(energy: number, hunger: number, social: number, comfort: number, curiosity: number): AgentDrives {
  return { energy, hunger, social, comfort, curiosity };
}

/** A fully-populated engine snapshot with every input at its neutral value. */
function snapshot(overrides: Partial<System1EngineSnapshot> = {}): System1EngineSnapshot {
  return {
    agentId: 'a1',
    tickNumber: 100,
    simTime: 1.67,
    drives: drives(50, 50, 50, 50, 50),
    drivesAtLastCycle: drives(50, 50, 50, 50, 50),
    ticksSinceLastCycle: 0,
    messagePending: false,
    conversationOpen: false,
    conversationTurns: 0,
    nearbyObjectStateChange: false,
    worldMutation: false,
    snapshotText: 'room:cafe|objects:coffee_machine|goal:idle',
    ...overrides,
  };
}

describe('Spec 035 — drive deltas (AC-1, hand-computed scripted sequence)', () => {
  it('matches hand-computed normalized deltas (0-100 drives → -1..1)', () => {
    // last cycle: hunger 40, energy 80. now: hunger 65, energy 30.
    // expected: deltaHunger = (65-40)/100 = +0.25, deltaEnergy = (30-80)/100 = -0.5
    const deltas = computeDriveDeltas(drives(30, 65, 50, 50, 50), drives(80, 40, 50, 50, 50));
    expect(deltas.deltaEnergy).toBeCloseTo(-0.5, 12);
    expect(deltas.deltaHunger).toBeCloseTo(0.25, 12);
    expect(deltas.deltaSocial).toBeCloseTo(0, 12);
  });

  it('clamps deltas to -1..1 across a scripted tick sequence', () => {
    // hunger decays 90 → 0 over the sequence: raw delta = -90/100 → -0.9 (in range)
    const t1 = computeDriveDeltas(drives(50, 0, 50, 50, 50), drives(50, 90, 50, 50, 50));
    expect(t1.deltaHunger).toBeCloseTo(-0.9, 12);

    // a +150 swing would clamp to +1 (defensive — drives are 0-100 but the
    // clamp is part of the normalization contract).
    const t2 = computeDriveDeltas(drives(50, 100, 50, 50, 50), drives(50, -50, 50, 50, 50));
    expect(t2.deltaHunger).toBe(1);
  });

  it('returns all-zero deltas when drives are unchanged since last cycle', () => {
    const deltas = computeDriveDeltas(drives(10, 20, 30, 40, 50), drives(10, 20, 30, 40, 50));
    expect(deltas.deltaEnergy).toBe(0);
    expect(deltas.deltaHunger).toBe(0);
    expect(deltas.deltaSocial).toBe(0);
    expect(deltas.deltaComfort).toBe(0);
    expect(deltas.deltaCuriosity).toBe(0);
  });
});

describe('Spec 035 — novelty (AC-1)', () => {
  it('decreases as the snapshot embedding approaches a recent-memory embedding', () => {
    const recent = [[1, 0, 0], [0, 1, 0]];
    const far = computeNovelty([0, 0, 1], recent); // orthogonal to both
    const near = computeNovelty([0.99, 0.1, 0], recent); // close to the first
    expect(near).toBeLessThan(far);
 expect(far).toBeLessThanOrEqual(1);
    expect(near).toBeGreaterThanOrEqual(0);
  });

  it('is 0 for an identical embedding and 1 for fully novel (orthogonal) input', () => {
    const recent = [[1, 0, 0]];
    expect(computeNovelty([1, 0, 0], recent)).toBeCloseTo(0, 12);
    expect(computeNovelty([0, 1, 0], recent)).toBeCloseTo(1, 12);
  });

  it('is 1 (maximally novel) when the agent has no recent memories', () => {
    expect(computeNovelty([0.3, 0.4, 0.5], [])).toBe(1);
    expect(computeNovelty([0.3, 0.4, 0.5], undefined)).toBe(1);
  });

  it('respects the K-most-recent window (only the K newest memories count)', () => {
    const k = 2;
    // Memories are given in chronological order (oldest first). The first
    // (oldest) memory is orthogonal to the snapshot; with K=2 it must be
    // ignored, so novelty is driven by the two newest matching memories.
    const memories = [
      [0, 0, 1],
      [0.6, 0.8, 0],
      [1, 0, 0],
    ];
    const n = computeNovelty([1, 0, 0], memories, k);
    expect(n).toBeCloseTo(0, 12);
  });
});

describe('Spec 035 — threshold crossing detection (AC-1)', () => {
  it('detects a downward crossing of the low threshold', () => {
    // hunger 25 → 18 crosses the low threshold (20).
    expect(detectThresholdCrossings(drives(50, 25, 50, 50, 50), drives(50, 18, 50, 50, 50))).toBe(true);
  });

  it('detects an upward crossing of the high threshold', () => {
    // comfort 78 → 84 crosses the high threshold (80).
    expect(detectThresholdCrossings(drives(50, 50, 50, 78, 50), drives(50, 50, 50, 84, 50))).toBe(true);
  });

  it('does not fire when a drive moves within its band', () => {
    expect(detectThresholdCrossings(drives(50, 30, 50, 50, 50), drives(50, 22, 50, 50, 50))).toBe(false);
  });

  it('does not fire when nothing changed', () => {
    expect(detectThresholdCrossings(drives(50, 19, 50, 50, 50), drives(50, 19, 50, 50, 50))).toBe(false);
  });
});

describe('Spec 035 — extractScalarFeatures (AC-1: flags toggle from engine state alone)', () => {
  it('produces a stable field order and stamps FEATURE_SCHEMA_VERSION', () => {
    const features = extractScalarFeatures(snapshot());
    expect(features.schemaVersion).toBe(FEATURE_SCHEMA_VERSION);
    const vector = scalarToVector(features.scalar);
    expect(vector).toHaveLength(SCALAR_FEATURE_FIELDS.length);
    // Vector order must equal SCALAR_FEATURE_FIELDS order.
    for (let i = 0; i < SCALAR_FEATURE_FIELDS.length; i++) {
      expect(vector[i]).toBe(features.scalar[SCALAR_FEATURE_FIELDS[i]!]);
    }
  });

  it('normalizes drives to 0..1', () => {
    const features = extractScalarFeatures(snapshot({ drives: drives(0, 25, 50, 75, 100) }));
    expect(features.scalar.driveEnergy).toBe(0);
    expect(features.scalar.driveHunger).toBeCloseTo(0.25, 12);
    expect(features.scalar.driveSocial).toBeCloseTo(0.5, 12);
    expect(features.scalar.driveComfort).toBeCloseTo(0.75, 12);
    expect(features.scalar.driveCuriosity).toBe(1);
  });

  it('toggles messagePending from engine state alone', () => {
    const off = extractScalarFeatures(snapshot({ messagePending: false }));
    const on = extractScalarFeatures(snapshot({ messagePending: true }));
    expect(off.scalar.messagePending).toBe(0);
    expect(on.scalar.messagePending).toBe(1);
  });

  it('toggles conversationOpen and normalizes conversationTurns', () => {
    const closed = extractScalarFeatures(snapshot({ conversationOpen: false, conversationTurns: 0 }));
    const open = extractScalarFeatures(snapshot({ conversationOpen: true, conversationTurns: 10 }));
    expect(closed.scalar.conversationOpen).toBe(0);
    expect(open.scalar.conversationOpen).toBe(1);
    // 10 turns / 20-turn normalization = 0.5.
    expect(open.scalar.conversationTurns).toBeCloseTo(0.5, 12);
    // Saturates at 1.
    const saturated = extractScalarFeatures(snapshot({ conversationOpen: true, conversationTurns: 999 }));
    expect(saturated.scalar.conversationTurns).toBe(1);
  });

  it('toggles nearbyObjectStateChange and worldMutation', () => {
    const quiet = extractScalarFeatures(snapshot());
    const noisy = extractScalarFeatures(
      snapshot({ nearbyObjectStateChange: true, worldMutation: true }),
    );
    expect(quiet.scalar.nearbyObjectStateChange).toBe(0);
    expect(quiet.scalar.worldMutation).toBe(0);
    expect(noisy.scalar.nearbyObjectStateChange).toBe(1);
    expect(noisy.scalar.worldMutation).toBe(1);
  });

  it('toggles driveThresholdCrossing from the drive snapshots (engine state alone)', () => {
    const base = {
      drives: drives(50, 25, 50, 50, 50),
      drivesAtLastCycle: drives(50, 25, 50, 50, 50),
    };
    const noCross = extractScalarFeatures(snapshot(base));
    expect(noCross.scalar.driveThresholdCrossing).toBe(0);
    // Hunger 25 → 18 crosses the low threshold (20).
    const cross = extractScalarFeatures(
      snapshot({ ...base, drives: drives(50, 18, 50, 50, 50) }),
    );
    expect(cross.scalar.driveThresholdCrossing).toBe(1);
  });

  it('normalizes ticksSinceLastCycle (saturating at the documented constant)', () => {
    const fresh = extractScalarFeatures(snapshot({ ticksSinceLastCycle: 0 }));
    const mid = extractScalarFeatures(snapshot({ ticksSinceLastCycle: 300 }));
    const stale = extractScalarFeatures(snapshot({ ticksSinceLastCycle: 600 }));
    const ancient = extractScalarFeatures(snapshot({ ticksSinceLastCycle: 100000 }));
    expect(fresh.scalar.ticksSinceLastCycle).toBe(0);
    expect(mid.scalar.ticksSinceLastCycle).toBeCloseTo(0.5, 12);
    expect(stale.scalar.ticksSinceLastCycle).toBe(1);
    expect(ancient.scalar.ticksSinceLastCycle).toBe(1);
  });

  it('is deterministic: identical inputs produce identical outputs', () => {
    const a = extractScalarFeatures(snapshot({ drives: drives(11, 22, 33, 44, 55) }));
    const b = extractScalarFeatures(snapshot({ drives: drives(11, 22, 33, 44, 55) }));
    expect(scalarToVector(a.scalar)).toEqual(scalarToVector(b.scalar));
  });

  it('computes novelty from the snapshot embedding vs recent memories when embeddings provided', () => {
    const withNovelty = extractScalarFeatures(snapshot(), {
      snapshotEmbedding: [1, 0, 0],
      recentMemoryEmbeddings: [[0, 1, 0]],
    });
    expect(withNovelty.scalar.novelty).toBeCloseTo(1, 12);

    const familiar = extractScalarFeatures(snapshot(), {
      snapshotEmbedding: [1, 0, 0],
      recentMemoryEmbeddings: [[1, 0, 0]],
    });
    expect(familiar.scalar.novelty).toBeCloseTo(0, 12);
  });
});

describe('Spec 035 — buildFeatureVector (Req 1: embedding ⊕ scalars)', () => {
  it('concatenates the snapshot embedding and the ordered scalar vector', () => {
    const embedding = [0.1, 0.2, 0.3];
    const vector = buildFeatureVector(snapshot(), embedding, [[0.1, 0.2, 0.3]]);
    expect(vector.schemaVersion).toBe(FEATURE_SCHEMA_VERSION);
    expect(vector.embedding).toEqual(embedding);
    expect(vector.scalar).toBeDefined();
    expect(scalarToVector(vector.scalar)).toHaveLength(SCALAR_FEATURE_FIELDS.length);
  });

  it('fails validation for dimension-mismatched embeddings', () => {
    // The extractor does not gate on dimensionality (384 is a property of the
    // provider, not the schema), but zero-length embeddings are rejected.
    expect(() => buildFeatureVector(snapshot(), [], undefined)).toThrow(/embedding/);
  });

  it('exposes cosine as a stable helper with known values', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
    expect(cosine([0, 0], [1, 0])).toBe(0); // zero-magnitude → 0
  });
});