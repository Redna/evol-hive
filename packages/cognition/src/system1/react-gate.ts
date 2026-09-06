/**
 * system1/react-gate — Trainable React/Ignore linear-probe head (spec 035, Req 3–6)
 * ─────────────────────────────────────────────────────────────────────────────────
 * The gate is a linear probe over the frozen feature layer:
 * `p(react) = σ(W·x + b)` where `x = [embedding…, scalars…]` (~400 parameters).
 * Inference is a pure TS dot-product + sigmoid — no model graph execution is
 * needed for a linear layer (ADR-0002 as amended; ONNX remains the offline
 * Python↔TS interface, emitted by `training/train_react_gate.py`).
 *
 * Fail-open semantics (Req 6): a missing, unloadable, or schema-version-
 * mismatched artifact passes ALL candidates (today's every-tick behavior) with
 * a single logged warning. A broken model degrades to current behavior, never
 * to a bricked agent. Hard triggers (Req 5) force react at any `p(react)`.
 *
 * Artifact loading follows the spec-007 pattern: lazy, injectable factory.
 */

import type {
  GateWeightArtifact,
  HardTriggerFlags,
  ReactGateDecision,
  ScalarFeatures,
  System1FeatureVector,
} from '@evol-hive/shared';
import { FEATURE_SCHEMA_VERSION, SCALAR_FEATURE_FIELDS, hasHardTrigger } from '@evol-hive/shared';

/** Injectable artifact factory (spec-007 pattern): resolves the current weight
 * snapshot, or `null` when none is available (fail-open). */
export type ArtifactLoader = () => Promise<GateWeightArtifact | null>;

/** Numerically stable sigmoid. */
export function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

/** Plain dot product (truncates to the shorter operand; empty → 0). */
export function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

/**
 * Evaluates a linear probe: `p = σ(b + W_scalar·scalar + W_emb·embedding)`.
 * Missing/`null` embedding weights contribute 0. Malformed weight shapes are
 * swallowed by the caller (the head wraps this in fail-open).
 */
export function evaluateLinearProbe(
  artifact: GateWeightArtifact,
  vector: System1FeatureVector,
): number {
  let z = artifact.bias;
  for (const field of SCALAR_FEATURE_FIELDS) {
    const w = artifact.scalarWeights[field];
    if (typeof w === 'number') {
      z += w * vector.scalar[field];
    }
  }
  const embWeights = artifact.embeddingWeights;
  if (embWeights && embWeights.length > 0) {
    z += dotProduct(embWeights, vector.embedding);
  }
  return sigmoid(z);
}

/**
 * Seeded PRNG (mulberry32) — deterministic exploration draws. The seed is a
 * pure function of (agentId, tick, headVersion), so save/replay reproduces
 * the same exploration decisions (spec 035 determinism, AC-14).
 */
export function seededDraw(seedStr: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let t = (h += 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Exploration epsilon modulated by the curiosity drive (0–100):
 * ε = ε_base × (curiosity / 100). A high-curiosity agent explores
 * low-p(react) situations (~8% at ε_base=0.1, curiosity=80); a low-curiosity
 * agent almost never does. Exploration reactions produce outcome-labeled
 * samples in the region the gate would otherwise never observe — fixing the
 * counterfactual data starvation of a purely greedy gate — and express
 * curiosity-driven serendipity in behavior.
 */
export function explorationEpsilon(curiosity: number, epsilonBase: number): number {
  const c = Math.min(100, Math.max(0, curiosity));
  return epsilonBase * (c / 100);
}

/**
 * Pure gate decision from an artifact + vector + triggers + threshold.
 * `react = hardTrigger || seededExplore < ε(curiosity) || p(react) >= threshold`
 * (Req 5, Req 7 + exploration factor amendment).
 *
 * The exploration draw is seeded on (agentId, tick, headVersion) so it is
 * deterministic under save/replay, and it is gated by the curiosity drive —
 * exploration is motivated, not noise.
 */
export function decideWithArtifact(
  artifact: GateWeightArtifact,
  vector: System1FeatureVector,
  hardTriggers: HardTriggerFlags,
  threshold: number,
  exploration?: {
    agentId: string;
    tickNumber: number;
    curiosity: number;
    epsilonBase: number;
  },
): ReactGateDecision {
  const p = evaluateLinearProbe(artifact, vector);
  if (!Number.isFinite(p)) {
    // A NaN/∞ probe (corrupt weights) must never silently suppress cycles —
    // the head catches this and fails open.
    throw new Error('[system1] linear probe produced a non-finite p(react)');
  }
  const hard = hasHardTrigger(hardTriggers);
  let explored = false;
  if (exploration && !hard) {
    const ε = explorationEpsilon(exploration.curiosity, exploration.epsilonBase);
    explored =
      seededDraw(`${exploration.agentId}:${exploration.tickNumber}:${artifact.headVersion}`) < ε;
  }
  return {
    pReact: p,
    react: hard || explored || p >= threshold,
    hardTrigger: hard,
    explored,
    headVersion: artifact.headVersion,
    failOpen: false,
  };
}

/** Structural + schema validation for a candidate artifact. */
function isValidArtifact(artifact: GateWeightArtifact | null): artifact is GateWeightArtifact {
  return (
    artifact !== null &&
    typeof artifact === 'object' &&
    typeof artifact.bias === 'number' &&
    Number.isFinite(artifact.bias) &&
    artifact.scalarWeights !== null &&
    typeof artifact.scalarWeights === 'object' &&
    artifact.featureSchemaVersion === FEATURE_SCHEMA_VERSION
  );
}

/** The fail-open decision: pass all candidates (Req 6). */
function failOpenDecision(hardTriggers: HardTriggerFlags): ReactGateDecision {
  return {
    pReact: 1,
    react: true,
    hardTrigger: hasHardTrigger(hardTriggers),
    headVersion: 0,
    failOpen: true,
  };
}

/** Options for {@link ReactGateHead}. */
export interface ReactGateHeadOptions {
  /** Injectable artifact factory (lazy — invoked once, on first ensureLoaded). */
  loader: ArtifactLoader;
  /** React threshold (default 0.5). */
  threshold: number;
  /**
   * Exploration factor (amendment): base epsilon for the curiosity-modulated
   * exploration draw. Default 0 (off). A typical value is 0.1 — a
   * high-curiosity agent (curiosity=80) then explores low-p(react) situations
   * ~8% of ticks, generating outcome labels in the region a greedy gate
   * never observes.
   */
  epsilonBase?: number;
  /**
   * Live curiosity source for the exploration draw (0-100). When absent,
   * exploration is disabled even if epsilonBase is set.
   */
  curiositySource?: (agentId: string) => number;
}

/**
 * The shared React/Ignore head (Req 3, 4, 6, 12). Holds the current artifact,
 * lazy-loads it once via the injected factory, fails open with a single
 * warning, supports hot-swapping committed dream updates (Req 12), and never
 * throws from `decide()`.
 */
export class ReactGateHead {
  private artifact: GateWeightArtifact | null = null;
  private loaded = false;
  private warned = false;
  private readonly loader: ArtifactLoader;
  private readonly threshold: number;
  private readonly epsilonBase: number;
  private readonly curiositySource: ((agentId: string) => number) | undefined;

  constructor(options: ReactGateHeadOptions) {
    this.loader = options.loader;
    this.threshold = options.threshold;
    this.epsilonBase = options.epsilonBase ?? 0;
    this.curiositySource = options.curiositySource;
  }

  /** Lazily load the artifact once (subsequent calls are no-ops). */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let artifact: GateWeightArtifact | null = null;
    try {
      artifact = await this.loader();
    } catch {
      // load failure → fail-open below (artifact stays null)
    }
    this.setArtifactValidated(artifact);
  }

  /** The current artifact (null while fail-open). */
  getArtifact(): GateWeightArtifact | null {
    return this.artifact;
  }

  /**
   * Hot-swap new weights (Req 12: "New weights hot-swap for future gating —
   * no restart"). Schema-mismatched or malformed artifacts are REJECTED —
   * the current weights stay (a bad swap must never brick the gate).
   */
  hotSwap(artifact: GateWeightArtifact): void {
    if (isValidArtifact(artifact)) {
      this.artifact = artifact;
      return;
    }
    this.warnOnce(artifact);
  }

  /** Validate + install (or fail-open on) an artifact. */
  private setArtifactValidated(artifact: GateWeightArtifact | null): void {
    if (isValidArtifact(artifact)) {
      this.artifact = artifact;
      return;
    }
    this.artifact = null;
    this.warnOnce(artifact);
  }

  /** Warn exactly once across the lifetime of this head (Req 6). */
  private warnOnce(artifact: GateWeightArtifact | null): void {
    if (this.warned) return;
    this.warned = true;
    const reason =
      artifact === null
        ? 'artifact missing or unloadable'
        : artifact.featureSchemaVersion !== FEATURE_SCHEMA_VERSION
          ? `schema version mismatch (artifact ${artifact.featureSchemaVersion} vs runtime ${FEATURE_SCHEMA_VERSION})`
          : 'artifact malformed';
    console.warn(
      `[ReactGateHead] System 1 gate failing OPEN (${reason}) — every tick will cycle until a valid artifact is loaded.`,
    );
  }

  /**
   * Synchronous gate decision from cached features (Req 7: no await in the
   * scheduler hot path). Never throws.
   */
  decide(
    agentId: string,
    tickNumber: number,
    vector: System1FeatureVector,
    hardTriggers: HardTriggerFlags,
  ): ReactGateDecision {
    const artifact = this.artifact;
    if (artifact === null) {
      return failOpenDecision(hardTriggers);
    }
    try {
      const exploration =
        this.epsilonBase > 0 && this.curiositySource !== undefined
          ? {
              agentId,
              tickNumber,
              curiosity: this.curiositySource(agentId),
              epsilonBase: this.epsilonBase,
            }
          : undefined;
      return decideWithArtifact(artifact, vector, hardTriggers, this.threshold, exploration);
    } catch {
      // Any malformed-shape surprise degrades to fail-open, never a throw.
      this.artifact = null;
      this.warnOnce(artifact);
      return failOpenDecision(hardTriggers);
    }
  }
}

/**
 * Wraps an async factory so that resolution failures surface as `null`
 * (fail-open) instead of throwing — used by tests and assembly.
 */
export function makeFeatureArtifactLoader(factory: ArtifactLoader): ArtifactLoader {
  return async (): Promise<GateWeightArtifact | null> => {
    try {
      return await factory();
    } catch {
      return null;
    }
  };
}

/**
 * File-backed artifact loader (spec-007 pattern): lazily reads a JSON weight
 * snapshot from disk, caches it, and surfaces missing/unreadable files as
 * `null` (the head then fails open with its single warning).
 */
export function makeFileArtifactLoader(path: string): ArtifactLoader {
  let cached: GateWeightArtifact | null | undefined;
  return async (): Promise<GateWeightArtifact | null> => {
    if (cached !== undefined) return cached;
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(path, 'utf8');
      cached = JSON.parse(raw) as GateWeightArtifact;
    } catch {
      cached = null;
    }
    return cached;
  };
}

/** Re-exported for the engine-facing scalar helper surface. */
export type { ScalarFeatures };
