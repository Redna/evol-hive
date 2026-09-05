/**
 * Spec 035 — Offline baseline trainer artifacts (Req 10 / AC-5, Node side).
 * AC-5: given a fixture JSONL session log, the training/ script emits a
 * versioned weight artifact + ONNX parity export; the artifact loads in Node
 * and reproduces the fixture's expected p(react) within tolerance.
 *
 * Python is a build-time batch tool and is NEVER invoked from the test suite
 * (training/ is absent from CI runtime paths). These tests validate the
 * committed artifacts produced by `training/train_react_gate.py`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FEATURE_SCHEMA_VERSION,
  SCALAR_FEATURE_FIELDS,
  type GateWeightArtifact,
} from '@evol-hive/shared';
import { evaluateLinearProbe, sigmoid } from '../src/system1/index.js';

const ARTIFACT_PATH = join(
  __dirname,
  '../../../training/artifacts/react-gate-fixture-v1.json',
);
const ONNX_PATH = join(__dirname, '../../../training/artifacts/react-gate-fixture-v1.onnx');
const FIXTURE_PATH = join(__dirname, '../../../training/fixtures/react-gate-fixture.jsonl');

interface FixtureRow {
  schemaVersion: number;
  label: 'react' | 'ignore';
  scalar: Record<string, number>;
}

function loadFixture(): FixtureRow[] {
  return readFileSync(FIXTURE_PATH, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FixtureRow);
}

/** Closed-form ridge solve in TS (independent of the Python trainer). */
function ridgeSolve(
  X: number[][],
  y: number[],
  lambda: number,
): { weights: number[]; bias: number } {
  const d = X[0]!.length;
  // Design matrix with bias column absorbed as a constant 1 column and the
  // bias left unregularized (matches the Python trainer).
  const Xb = X.map((row) => [1, ...row]);
  const dim = d + 1;
  // A = XbᵀXb + λ·diag(0, 1, ..., 1); b = Xbᵀy
  const A: number[][] = Array.from({ length: dim }, () => Array.from({ length: dim }, () => 0));
  const b: number[] = Array.from({ length: dim }, () => 0);
  for (let i = 0; i < Xb.length; i++) {
    for (let r = 0; r < dim; r++) {
      for (let c = 0; c < dim; c++) {
        A[r]![c]! += Xb[i]![r]! * Xb[i]![c]!;
      }
      b[r]! += Xb[i]![r]! * y[i]!;
    }
  }
  for (let r = 1; r < dim; r++) {
    A[r]![r]! += lambda;
  }
  // Gaussian elimination with partial pivoting.
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < dim; col++) {
    let pivot = col;
    for (let r = col + 1; r < dim; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    for (let r = col + 1; r < dim; r++) {
      const factor = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= dim; c++) {
        M[r]![c]! -= factor * M[col]![c]!;
      }
    }
  }
  const w = Array.from({ length: dim }, () => 0);
  for (let r = dim - 1; r >= 0; r--) {
    let s = M[r]![dim]!;
    for (let c = r + 1; c < dim; c++) {
      s -= M[r]![c]! * w[c]!;
    }
    w[r]! = s / M[r]![r]!;
  }
  return { bias: w[0]!, weights: w.slice(1) };
}

describe('Spec 035 — training artifacts exist and are versioned (AC-5)', () => {
  it('the weight artifact carries headVersion + featureSchemaVersion + kind', () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as GateWeightArtifact;
    expect(artifact.kind).toBe('react-gate');
    expect(artifact.headVersion).toBeGreaterThanOrEqual(1);
    expect(artifact.featureSchemaVersion).toBe(FEATURE_SCHEMA_VERSION);
    expect(typeof artifact.bias).toBe('number');
    for (const field of SCALAR_FEATURE_FIELDS) {
      expect(typeof artifact.scalarWeights[field]).toBe('number');
    }
  });

  it('the ONNX parity export exists and contains the MatMul → Add → Sigmoid graph', () => {
    // Minimal structural check of the protobuf-encoded ONNX ModelProto: the
    // op_type strings appear in the graph's node list.
    const bytes = readFileSync(ONNX_PATH);
    expect(bytes.length).toBeGreaterThan(0);
    const text = bytes.toString('latin1');
    expect(text).toContain('MatMul');
    expect(text).toContain('Add');
    expect(text).toContain('Sigmoid');
  });
});

describe('Spec 035 — the artifact reproduces the fixture expectation (AC-5 parity)', () => {
  it('artifact predictions match an independent TS ridge solve of the fixture within 1e-6', () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as GateWeightArtifact;
    const rows = loadFixture();
    expect(rows.length).toBeGreaterThanOrEqual(12);

    const X = rows.map((r) => SCALAR_FEATURE_FIELDS.map((f) => r.scalar[f]!));
    const y = rows.map((r) => (r.label === 'react' ? 1 : 0));
    const { weights, bias } = ridgeSolve(X, y, 0.1); // λ = 0.1 (documented)

    for (let i = 0; i < rows.length; i++) {
      const scalar = {} as GateWeightArtifact['scalarWeights'];
      SCALAR_FEATURE_FIELDS.forEach((f, j) => {
        scalar[f] = X[i]![j]!;
      });
      const pArtifact = evaluateLinearProbe(
        { ...artifact, embeddingWeights: undefined },
        { schemaVersion: FEATURE_SCHEMA_VERSION, embedding: [], scalar },
      );
      const z = bias + weights.reduce((acc, wj, j) => acc + wj * X[i]![j]!, 0);
      expect(pArtifact).toBeCloseTo(sigmoid(z), 6);
    }
  });

  it('golden p(react) values pinned from the committed artifact (drift detector)', () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as GateWeightArtifact;
    const zero = {} as GateWeightArtifact['scalarWeights'];
    SCALAR_FEATURE_FIELDS.forEach((f) => {
      zero[f] = 0;
    });
    const pZero = evaluateLinearProbe(
      { ...artifact, embeddingWeights: undefined },
      { schemaVersion: FEATURE_SCHEMA_VERSION, embedding: [], scalar: zero },
    );
    // Golden: σ(bias) of the committed artifact — retrain must consciously
    // update this pin.
    expect(pZero).toBeCloseTo(0.484075184, 9);

    // A high-urgency vector (all 1s) scores clearly above an all-zero one.
    const hot = {} as GateWeightArtifact['scalarWeights'];
    SCALAR_FEATURE_FIELDS.forEach((f) => {
      hot[f] = 1;
    });
    const pHot = evaluateLinearProbe(
      { ...artifact, embeddingWeights: undefined },
      { schemaVersion: FEATURE_SCHEMA_VERSION, embedding: [], scalar: hot },
    );
    expect(pHot).toBeGreaterThan(pZero + 0.05);
  });
});