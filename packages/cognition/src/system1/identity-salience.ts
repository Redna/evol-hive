/**
 * system1/identity-salience — Salience-weighted identity hook (spec 035, Req 16–17)
 * ─────────────────────────────────────────────────────────────────────────────────
 * Spec 033 amendment:
 *   - Req 16: session-end identity consolidation weights proposed deltas by
 *     accumulated event importance from the importance head — a high-salience
 *     session drifts identity more than a quiet one. The weighting mechanism
 *     scales the per-pass delta budget (never beyond spec 033's remaining
 *     session budget): quiet session → fewer applied deltas.
 *   - Req 17: a mid-session consolidation pass triggers when accumulated
 *     salience crosses a configured threshold, within spec 033's existing pass
 *     budget and delta bounds. `update_self_model` remains the conscious
 *     override — this service never writes identity outside a consolidation
 *     pass, and every write flows through the same audited, guarded bridge.
 */

import type { MemorySnippet } from '@evol-hive/shared';
import type { IdentityConsolidationServiceImpl } from '../identity/identity-consolidation.js';
import type {
  ConversationThreadSummary,
  IdentityConsolidationResult,
} from '../identity/identity-consolidation.js';

/** Salience configuration (Req 16/17). */
export interface SalienceConfig {
  /** Accumulated salience (Σ predicted importance) that fires the mid-session pass. */
  midSessionThreshold: number;
  /** Accumulated salience that maps to the FULL delta budget (normalizer). */
  salienceNormalization: number;
  /** The session delta budget being weighted (spec 033 default 10). */
  maxDeltasPerSession: number;
}

/** Default salience config (spec 035). */
export function defaultSalienceConfig(): SalienceConfig {
  return { midSessionThreshold: 3, salienceNormalization: 10, maxDeltasPerSession: 10 };
}

/**
 * Per-agent accumulated salience (Req 16): the importance head's predicted
 * importance for each event, summed since the last (mid-session or session-
 * end) consolidation.
 */
export class SalienceAccumulator {
  private readonly accumulated = new Map<string, number>();

  /**
   * Record one event's salience for the agent. Per-event importances from the
   * head are 0–1; the accumulation itself is unbounded (the norm saturates).
   */
  record(agentId: string, importance: number): void {
    const value = Math.max(0, importance);
    this.accumulated.set(agentId, (this.accumulated.get(agentId) ?? 0) + value);
  }

  /** The accumulated salience for the agent. */
  getAccumulated(agentId: string): number {
    return this.accumulated.get(agentId) ?? 0;
  }

  /** Reset the accumulator (consumed by a consolidation trigger). */
  reset(agentId: string): void {
    this.accumulated.delete(agentId);
  }
}

/** Maps accumulated salience to a 0–1 norm (saturating). */
export function computeSalienceNorm(accumulated: number, config: SalienceConfig): number {
  if (config.salienceNormalization <= 0) return 0;
  return Math.min(1, Math.max(0, accumulated / config.salienceNormalization));
}

/** Options for {@link SalienceWeightedIdentityService}. */
export interface SalienceIdentityServiceOptions {
  /** The spec 033 consolidation service (owns budgeting + the audited bridge). */
  inner: IdentityConsolidationServiceImpl;
  accumulator?: SalienceAccumulator;
  config?: SalienceConfig;
}

/**
 * Salience-weighted identity service (Req 16/17). Wraps the spec 033
 * `IdentityConsolidationServiceImpl`: every delta still flows through the
 * same guarded, audited `SelfModelBridge`; this service only scales HOW MUCH
 * the agent may drift per pass (the weighted delta budget) and WHEN a
 * mid-session pass may fire (accumulated salience threshold, within the
 * existing pass budget).
 */
export class SalienceWeightedIdentityService {
  private readonly inner: IdentityConsolidationServiceImpl;
  private readonly accumulator: SalienceAccumulator;
  private readonly config: SalienceConfig;

  constructor(options: SalienceIdentityServiceOptions) {
    this.inner = options.inner;
    this.accumulator = options.accumulator ?? new SalienceAccumulator();
    this.config = options.config ?? defaultSalienceConfig();
  }

  /** Record one event's salience for the agent (from the importance head). */
  recordSalience(agentId: string, importance: number): void {
    this.accumulator.record(agentId, importance);
  }

  /** Record a batch of predicted importances (e.g. samples since last dream). */
  recordSampleSalience(agentId: string, predictedImportances: number[]): void {
    for (const importance of predictedImportances) {
      this.recordSalience(agentId, importance);
    }
  }

  /** The accumulated (raw) salience for the agent. */
  getAccumulatedSalience(agentId: string): number {
    return this.accumulator.getAccumulated(agentId);
  }

  /** Req 17: has the agent's accumulated salience crossed the threshold? */
  shouldConsolidateMidSession(agentId: string): boolean {
    return this.accumulator.getAccumulated(agentId) >= this.config.midSessionThreshold;
  }

  /** Consume the mid-session trigger: re-arm the accumulation window. */
  consumeMidSessionTrigger(agentId: string): void {
    this.accumulator.reset(agentId);
  }

  /**
   * Run a salience-weighted consolidation pass (Req 16). The delta budget for
   * this pass scales with the normalized accumulated salience: high-salience
   * session → larger weighted delta; quiet session → smaller. The budget is
   * always clamped to spec 033's remaining session bound by the inner service.
   */
  async consolidateWithSalience(
    agentId: string,
    sessionMemories: MemorySnippet[],
    conversationThreads: ConversationThreadSummary[],
  ): Promise<IdentityConsolidationResult> {
    const norm = computeSalienceNorm(this.accumulator.getAccumulated(agentId), this.config);
    const weightedBudget = Math.round(this.config.maxDeltasPerSession * norm);
    return this.inner.consolidate(agentId, sessionMemories, conversationThreads, {
      maxDeltasOverride: weightedBudget,
    });
  }

  /**
   * Req 17: a mid-session pass — same weighted path, then re-arms the
   * accumulation window. The inner service enforces the pass budget.
   */
  async consolidateMidSession(
    agentId: string,
    sessionMemories: MemorySnippet[],
    conversationThreads: ConversationThreadSummary[] = [],
  ): Promise<IdentityConsolidationResult> {
    const result = await this.consolidateWithSalience(
      agentId,
      sessionMemories,
      conversationThreads,
    );
    this.consumeMidSessionTrigger(agentId);
    return result;
  }
}
