/**
 * system1/dream-update — Sleep-time (dream) weight updates (spec 035, Req 11–13)
 * ─────────────────────────────────────────────────────────────────────────────
 * On the existing idle/reflect trigger (`ReflectionLoop.shouldReflect`, no
 * urgent drives), the runtime applies incremental updates to the shared head
 * over all samples accumulated since the last dream — the one-line linear
 * update `W += lr · (p − y) · x` per sample. No backprop, no ML library,
 * milliseconds of arithmetic.
 *
 * Dream guardrails (Req 12, mirroring spec 033):
 *   - bounded steps per dream (≤ `maxSteps`, default/cap 200) + LR cap;
 *   - a validation holdout is evaluated before commit — if holdout loss
 *     degrades beyond `lossTolerance`, the previous weight snapshot is
 *     restored (post-dream loss is never worse);
 *   - every dream emits an audited `dream_update` event (N samples, loss
 *     before/after, head-version bump) and, on commit, a versioned snapshot;
 *   - the caller hot-swaps the returned artifact — new weights apply to
 *     future gating with no restart.
 *
 * Shared head first (Req 13): one head, updated at any agent's dream.
 */

import type {
  CycleOutcomeSample,
  DreamUpdateConfig,
  DreamUpdateEvent,
  GateWeightArtifact,
} from '@evol-hive/shared';
import { FEATURE_SCHEMA_VERSION, SCALAR_FEATURE_FIELDS, defaultDreamUpdateConfig } from '@evol-hive/shared';


/** Enforces the guardrail caps on a config (never trusts a wider config). */
function clampConfig(config: DreamUpdateConfig): DreamUpdateConfig {
  const caps = defaultDreamUpdateConfig();
  return {
    learningRate: Math.min(Math.max(0, config.learningRate), caps.maxLearningRate),
    maxLearningRate: Math.min(config.maxLearningRate, caps.maxLearningRate),
    maxSteps: Math.min(Math.max(1, Math.floor(config.maxSteps)), caps.maxSteps),
    holdoutFraction: Math.min(Math.max(0, config.holdoutFraction), 0.9),
    lossTolerance: Math.max(0, config.lossTolerance),
  };
}

/** Binary cross-entropy, mean over the batch (numerically clamped). */
export function binaryCrossEntropy(p: number[], y: number[]): number {
  if (p.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    const pi = Math.min(1 - 1e-9, Math.max(1e-9, p[i]!));
    sum += -(y[i]! * Math.log(pi) + (1 - y[i]!) * Math.log(1 - pi));
  }
  return sum / p.length;
}

/** Builds the full linear-model input for a sample: [embedding…, scalars…]. */
function sampleToVector(sample: CycleOutcomeSample): number[] {
  const scalarVector = SCALAR_FEATURE_FIELDS.map((f) => sample.scalar?.[f] ?? 0);
  return [...(sample.embedding ?? []), ...scalarVector];
}

/** Extracts the current weight vector from an artifact ([W_emb…, W_scalar…]). */
function artifactToWeights(artifact: GateWeightArtifact, dim: number): number[] {
  const weights = new Array<number>(dim).fill(0);
  const emb = artifact.embeddingWeights;
  if (emb) {
    for (let i = 0; i < Math.min(emb.length, dim); i++) {
      weights[i] = emb[i]!;
    }
  }
  SCALAR_FEATURE_FIELDS.forEach((field, i) => {
    const idx = (emb?.length ?? 0) + i;
    if (idx < dim) {
      const w = artifact.scalarWeights[field];
      weights[idx] = typeof w === 'number' ? w : 0;
    }
  });
  return weights;
}

/** Writes a weight vector back into a fresh artifact copy. */
function weightsToArtifact(
  artifact: GateWeightArtifact,
  weights: number[],
  embDim: number,
): GateWeightArtifact {
  const scalarWeights: Record<string, number> = {};
  SCALAR_FEATURE_FIELDS.forEach((field, i) => {
    scalarWeights[field] = weights[embDim + i] ?? 0;
  });
  const next: GateWeightArtifact = {
    ...artifact,
    scalarWeights,
  };
  if (embDim > 0) {
    next.embeddingWeights = weights.slice(0, embDim);
  }
  return next;
}

/** The result of one dream. */
export interface DreamUpdateResult {
  /** The artifact to hot-swap in (the previous snapshot when reverted). */
  artifact: GateWeightArtifact;
  /** The audited dream event. */
  event: DreamUpdateEvent;
}

/**
 * Applies one dream update over the accumulated samples (Req 11) under the
 * guardrails (Req 12). Pure: returns the (possibly reverted) artifact + the
 * audit event; the caller hot-swaps and persists.
 *
 * The holdout is the LAST `holdoutFraction` of samples (most recent — the
 * runtime appends chronologically); training runs on the first
 * `min(maxSteps, rest)` samples.
 */
export function applyDreamUpdate(
  previous: GateWeightArtifact,
  samples: CycleOutcomeSample[],
  config: DreamUpdateConfig,
  onEvent?: (event: DreamUpdateEvent) => void,
): DreamUpdateResult {
  const cfg = clampConfig(config);

  const emit = (event: DreamUpdateEvent): void => {
    onEvent?.(event);
  };

  // Schema contract: a sample from another schema version must never touch
  // these weights (Req 2 — the schema is the cross-world contract).
  const compatible = samples.filter((s) => s.schemaVersion === previous.featureSchemaVersion);
  if (
    compatible.length !== samples.length ||
    previous.featureSchemaVersion !== FEATURE_SCHEMA_VERSION
  ) {
    const event: DreamUpdateEvent = {
      type: 'dream_update',
      sampleCount: 0,
      trainCount: 0,
      holdoutCount: 0,
      lossBefore: 0,
      lossAfter: 0,
      headVersion: previous.headVersion,
      headVersionBefore: previous.headVersion,
      reverted: true,
      featureSchemaVersion: previous.featureSchemaVersion,
    };
    emit(event);
    return { artifact: previous, event };
  }

  if (compatible.length === 0) {
    const event: DreamUpdateEvent = {
      type: 'dream_update',
      sampleCount: 0,
      trainCount: 0,
      holdoutCount: 0,
      lossBefore: 0,
      lossAfter: 0,
      headVersion: previous.headVersion,
      headVersionBefore: previous.headVersion,
      reverted: true,
      featureSchemaVersion: previous.featureSchemaVersion,
    };
    emit(event);
    return { artifact: previous, event };
  }

  // Holdout = most recent fraction; train = the rest (bounded).
  const holdoutCount =
    cfg.holdoutFraction > 0
      ? Math.max(1, Math.floor(compatible.length * cfg.holdoutFraction))
      : 0;
  const holdoutStart = compatible.length - holdoutCount;
  const trainSamples = compatible.slice(0, holdoutStart).slice(-cfg.maxSteps);
  const holdoutSamples = compatible.slice(holdoutStart);

  const dim = sampleToVector(compatible[0]!).length;
  const embDim = compatible[0]!.embedding?.length ?? 0;
  const weights = artifactToWeights(previous, dim);
  const bias = previous.bias;

  // Loss before (holdout; fall back to train when no holdout).
  const evalSet = holdoutSamples.length > 0 ? holdoutSamples : trainSamples;
  const lossBefore = binaryCrossEntropy(
    evalSet.map((s) => {
      const x = sampleToVector(s);
      return sigmoidOf(dotVec(weights, x) + bias);
    }),
    evalSet.map((s) => (s.label === 'react' ? 1 : 0)),
  );

  // The one-line linear update per training sample (Req 11), bounded.
  let w = weights;
  let b = bias;
  let steps = 0;
  for (const sample of trainSamples) {
    if (steps >= cfg.maxSteps) break;
    const x = sampleToVector(sample);
    const p = sigmoidOf(dotVec(w, x) + b);
    const y = sample.label === 'react' ? 1 : 0;
    const err = p - y;
    w = w.map((wi, i) => wi - cfg.learningRate * err * x[i]!);
    b = b - cfg.learningRate * err;
    steps += 1;
  }

  const updatedArtifact: GateWeightArtifact = {
    ...weightsToArtifact(previous, w, embDim),
    bias: b,
    headVersion: previous.headVersion + 1,
    featureSchemaVersion: previous.featureSchemaVersion,
  };

  // Holdout guardrail (Req 12): never worse after a dream.
  const lossAfter = binaryCrossEntropy(
    evalSet.map((s) => {
      const x = sampleToVector(s);
      return sigmoidOf(dotVec(w, x) + b);
    }),
    evalSet.map((s) => (s.label === 'react' ? 1 : 0)),
  );

  if (lossAfter > lossBefore + cfg.lossTolerance) {
    // Revert: restore the previous snapshot verbatim.
    const event: DreamUpdateEvent = {
      type: 'dream_update',
      sampleCount: compatible.length,
      trainCount: steps,
      holdoutCount: holdoutSamples.length,
      lossBefore,
      lossAfter,
      headVersion: previous.headVersion,
      headVersionBefore: previous.headVersion,
      reverted: true,
      featureSchemaVersion: previous.featureSchemaVersion,
    };
    emit(event);
    return { artifact: previous, event };
  }

  const event: DreamUpdateEvent = {
    type: 'dream_update',
    sampleCount: compatible.length,
    trainCount: steps,
    holdoutCount: holdoutSamples.length,
    lossBefore,
    lossAfter,
    headVersion: previous.headVersion + 1,
    headVersionBefore: previous.headVersion,
    reverted: false,
    featureSchemaVersion: previous.featureSchemaVersion,
  };
  emit(event);
  return { artifact: updatedArtifact, event };
}

function dotVec(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

function sigmoidOf(z: number): number {
  if (z >= 0) {
    return 1 / (1 + Math.exp(-z));
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}