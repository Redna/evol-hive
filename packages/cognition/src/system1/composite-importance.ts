/**
 * system1/composite-importance — Composite importance at memory-write time
 * (spec 035, Req 14 / AC-7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Final stored importance at memory write is the documented composite of:
 *   - the importance head's predicted prior (from the frozen feature base),
 *   - drive-delta magnitude (deterministic, from engine state),
 *   - downstream utility (retrieval count × plan-success outcomes — a
 *     background counter, retroactively folded into later writes/reflections),
 *   - the LLM-assigned 1–10 score demoted to one feature among several.
 *
 * The composition weights are fixed and sum to 1. The LLM score can never
 * dominate (its weight is < 0.5): the composite is grounded in what actually
 * mattered, not in LLM self-report.
 *
 * `RetrievalEngineImpl`'s spec-014 scoring formula is untouched (Req 15,
 * frozen) — composite importance improves the *input quality*, not the
 * formula.
 */

import type {
  ImportanceCompositionContext,
  MemoryEntryInput,
  System1FeatureVector,
} from '@evol-hive/shared';
import { NEUTRAL_IMPORTANCE_PRIOR } from './importance-head.js';

/** The fixed, documented composition weights (sum to 1). */
export const IMPORTANCE_COMPOSITION_WEIGHTS = {
  /** Predicted prior from the importance head (0–1 → ×10). */
  prior: 0.3,
  /** Drive-delta magnitude, mean |Δdrive| normalized (0–1 → ×10). */
  driveDelta: 0.25,
  /** Downstream utility (retrievals + plan successes, 0–1 → ×10). */
  utility: 0.15,
  /** LLM-assigned 1–10 score (one feature among several). */
  llm: 0.3,
} as const;

/** Inputs to the composite (all normalized per the docs above). */
export interface ImportanceCompositionInputs {
  /** Predicted importance prior from the head, in (0, 1). */
  predictedPrior: number;
  /** Mean absolute normalized drive delta (0–1), from engine state. */
  driveDeltaMagnitude: number;
  /** Downstream utility (0–1), from the background counters. */
  downstreamUtility: number;
  /** LLM-assigned importance, 1–10. */
  llmScore: number;
}

/** Clamps a value into 0..1. */
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Computes the composite importance (1..10, 2-decimal precision).
 * Deterministic given the inputs (AC-7 fixture contract).
 */
export function composeImportance(inputs: ImportanceCompositionInputs): number {
  const w = IMPORTANCE_COMPOSITION_WEIGHTS;
  const prior10 = clamp01(inputs.predictedPrior) * 10;
  const drive10 = clamp01(inputs.driveDeltaMagnitude) * 10;
  const utility10 = clamp01(inputs.downstreamUtility) * 10;
  const llm = Math.min(10, Math.max(0, inputs.llmScore)); // 1..10 scale is already the output scale
  const raw = w.prior * prior10 + w.driveDelta * drive10 + w.utility * utility10 + w.llm * llm;
  // The stored contract is importance 1..10 (§11.2).
  const clamped = Math.min(10, Math.max(1, raw));
  return Math.round(clamped * 100) / 100;
}

/** Mean absolute normalized drive delta from a normalized delta set (0–1). */
export function driveDeltaMagnitude(deltas: {
  deltaEnergy: number;
  deltaHunger: number;
  deltaSocial: number;
  deltaComfort: number;
  deltaCuriosity: number;
}): number {
  const meanAbs =
    (Math.abs(deltas.deltaEnergy) +
      Math.abs(deltas.deltaHunger) +
      Math.abs(deltas.deltaSocial) +
      Math.abs(deltas.deltaComfort) +
      Math.abs(deltas.deltaCuriosity)) /
    5;
  return clamp01(meanAbs);
}

/** Per-memory downstream-utility counters (Req 14/15: background counter). */
export interface DownstreamUtilityStats {
  retrievals: number;
  planSuccesses: number;
}

/** Utility accumulation constants (documented): each retrieval adds 0.1,
 * each plan-success adds 0.2; the utility saturates at 1. */
export const UTILITY_RETRIEVAL_WEIGHT = 0.1;
export const UTILITY_PLAN_SUCCESS_WEIGHT = 0.2;

/**
 * Background downstream-utility tracker (Req 14/15): counts retrievals and
 * plan-success outcomes per memory WITHOUT touching retrieval scores. The
 * utility is folded into later writes/reflections for related content via
 * {@link getUtility}.
 */
export class DownstreamUtilityTracker {
  private readonly retrievals = new Map<string, number>();
  private readonly planSuccesses = new Map<string, number>();

  /** Record one retrieval of the memory (fired from retrieval plumbing). */
  recordRetrieval(memoryId: string): void {
    this.retrievals.set(memoryId, (this.retrievals.get(memoryId) ?? 0) + 1);
  }

  /** Record one plan-success outcome attributable to the memory. */
  recordPlanSuccess(memoryId: string): void {
    this.planSuccesses.set(memoryId, (this.planSuccesses.get(memoryId) ?? 0) + 1);
  }

  /** Raw counters (for folding into later writes/reflections). */
  getStats(memoryId: string): DownstreamUtilityStats {
    return {
      retrievals: this.retrievals.get(memoryId) ?? 0,
      planSuccesses: this.planSuccesses.get(memoryId) ?? 0,
    };
  }

  /** The normalized utility (0–1, saturating) used in the composite. */
  getUtility(memoryId: string): number {
    const stats = this.getStats(memoryId);
    return clamp01(
      stats.retrievals * UTILITY_RETRIEVAL_WEIGHT +
        stats.planSuccesses * UTILITY_PLAN_SUCCESS_WEIGHT,
    );
  }
}

/**
 * An {@link ImportanceComposer} implementation over the importance head +
 * utility tracker (the object wired into `MemoryStoreImpl` at assembly).
 * `relatedMemoryIds` lets the caller fold downstream utility of related
 * content (retrieval/plan outcomes) into this write.
 */
export interface CompositeImportanceContext extends ImportanceCompositionContext {
  /** The cached feature vector for this write (drives the predicted prior). */
  features?: System1FeatureVector | null;
  /** Normalized drive deltas since the last completed cycle (engine state). */
  driveDeltas?: {
    deltaEnergy: number;
    deltaHunger: number;
    deltaSocial: number;
    deltaComfort: number;
    deltaCuriosity: number;
  } | null;
  /** IDs of related memories whose downstream utility should be folded in. */
  relatedMemoryIds?: string[];
}

export class CompositeImportanceComposer {
  private readonly head: { predict(vector: System1FeatureVector): number };
  private readonly utility: DownstreamUtilityTracker;

  constructor(options: {
    head: { predict(vector: System1FeatureVector): number };
    utility: DownstreamUtilityTracker;
  }) {
    this.head = options.head;
    this.utility = options.utility;
  }

  compose(entry: MemoryEntryInput, context: CompositeImportanceContext): number {
    const prior = context.features ? this.head.predict(context.features) : NEUTRAL_IMPORTANCE_PRIOR;
    const magnitude = context.driveDeltas ? driveDeltaMagnitude(context.driveDeltas) : 0;
    let utility = 0;
    for (const id of context.relatedMemoryIds ?? []) {
      utility = Math.max(utility, this.utility.getUtility(id));
    }
    return composeImportance({
      predictedPrior: prior,
      driveDeltaMagnitude: magnitude,
      downstreamUtility: utility,
      llmScore: entry.importance,
    });
  }
}
