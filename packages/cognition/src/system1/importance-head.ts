/**
 * system1/importance-head — Trainable importance probe (spec 035, Req 14)
 * ────────────────────────────────────────────────────────────────────────
 * The same frozen feature base feeds an importance probe producing a
 * predicted importance prior in (0, 1). The composite (with drive-delta
 * magnitude, downstream utility, and the LLM 1–10 score demoted to one
 * feature) is applied at memory-write time — see `composite-importance.ts`
 * and the `ImportanceComposer` wiring in `@evol-hive/memory`.
 *
 * Fail-open: a missing/corrupt/mismatched artifact yields the neutral prior
 * 0.5 with a single warning — the composite then leans on its other inputs,
 * never blocks a write.
 */

import type {
  GateWeightArtifact,
  System1FeatureVector,
} from '@evol-hive/shared';
import { FEATURE_SCHEMA_VERSION } from '@evol-hive/shared';
import type { ArtifactLoader } from './react-gate.js';
import { evaluateLinearProbe, makeFeatureArtifactLoader } from './react-gate.js';

/** Options for {@link LinearImportanceHead}. */
export interface LinearImportanceHeadOptions {
  loader: ArtifactLoader;
}

/** The neutral prior used while failing open. */
export const NEUTRAL_IMPORTANCE_PRIOR = 0.5;

/**
 * Linear importance head: `prior = σ(W·x + b)` over the frozen feature layer
 * (Req 14). Shares the artifact shape with the react gate (`kind:
 * 'importance-head'`), lazy-loads once, fails open with one warning.
 */
export class LinearImportanceHead {
  private artifact: GateWeightArtifact | null = null;
  private loaded = false;
  private warned = false;
  private readonly loader: ArtifactLoader;

  constructor(options: LinearImportanceHeadOptions) {
    this.loader = makeFeatureArtifactLoader(options.loader);
  }

  /** Lazily load the artifact once. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let artifact: GateWeightArtifact | null = null;
    try {
      artifact = await this.loader();
    } catch {
      artifact = null;
    }
    this.setArtifactValidated(artifact);
  }

  /** The current artifact (null while fail-open). */
  getArtifact(): GateWeightArtifact | null {
    return this.artifact;
  }

  /** Hot-swap committed dream updates for the importance head (Req 12/14). */
  hotSwap(artifact: GateWeightArtifact): void {
    this.setArtifactValidated(artifact);
  }

  private setArtifactValidated(artifact: GateWeightArtifact | null): void {
    const valid =
      artifact !== null &&
      typeof artifact === 'object' &&
      typeof artifact.bias === 'number' &&
      Number.isFinite(artifact.bias) &&
      artifact.scalarWeights !== null &&
      typeof artifact.scalarWeights === 'object' &&
      artifact.featureSchemaVersion === FEATURE_SCHEMA_VERSION;
    if (valid) {
      this.artifact = artifact;
      return;
    }
    this.artifact = null;
    this.warnOnce(artifact);
  }

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
      `[LinearImportanceHead] importance head failing OPEN with the neutral prior ${NEUTRAL_IMPORTANCE_PRIOR} (${reason}).`,
    );
  }

  /**
   * Predict the importance prior from cached features. Never throws; the
   * neutral prior (0.5) is returned while failing open.
   */
  predict(vector: System1FeatureVector): number {
    const artifact = this.artifact;
    if (artifact === null) {
      return NEUTRAL_IMPORTANCE_PRIOR;
    }
    try {
      const p = evaluateLinearProbe(artifact, vector);
      return Number.isFinite(p) ? p : NEUTRAL_IMPORTANCE_PRIOR;
    } catch {
      return NEUTRAL_IMPORTANCE_PRIOR;
    }
  }
}