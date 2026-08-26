/**
 * llm/token-usage-reporter — token usage aggregation (spec 022, Req 10, AC-8)
 * ────────────────────────────────────────────────────────────────────────────
 * Aggregates {@link TokenUsageReport} records per tick and cumulatively. The
 * `OpenAICompatibleLLMClient` records a report for each API call (capturing
 * the `usage` field from the OpenAI response envelope). When a provider omits
 * `usage`, the client records a zero report (no crash) — see AC-9.
 *
 * Token usage tracking is best-effort and opt-in: it only happens when a
 * `TokenUsageReporter` is wired into the LLM client config.
 */

import type { TokenUsageReport } from '@evol-hive/shared';

/** Aggregates per-tick and cumulative LLM token usage (spec 022, Req 10). */
export class TokenUsageReporter {
  private readonly perTick = new Map<number, TokenUsageReport>();
  private total: TokenUsageReport = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  /** Record a single usage report. Sums into the tick bucket and the total. */
  record(report: TokenUsageReport): void {
    // Cumulative total.
    this.total = {
      promptTokens: this.total.promptTokens + report.promptTokens,
      completionTokens: this.total.completionTokens + report.completionTokens,
      totalTokens: this.total.totalTokens + report.totalTokens,
    };

    // Per-tick aggregation (only when tickNumber is provided).
    if (report.tickNumber !== undefined) {
      const tick = report.tickNumber;
      const existing = this.perTick.get(tick);
      if (existing === undefined) {
        this.perTick.set(tick, {
          promptTokens: report.promptTokens,
          completionTokens: report.completionTokens,
          totalTokens: report.totalTokens,
          tickNumber: tick,
        });
      } else {
        existing.promptTokens += report.promptTokens;
        existing.completionTokens += report.completionTokens;
        existing.totalTokens += report.totalTokens;
      }
    }
  }

  /** Sum of token usage for all LLM calls in the given tick (zeros if none). */
  getTickUsage(tickNumber: number): TokenUsageReport {
    const entry = this.perTick.get(tickNumber);
    if (entry === undefined) {
      return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    }
    return {
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      totalTokens: entry.totalTokens,
    };
  }

  /** Cumulative token usage across all recorded calls. */
  getTotalUsage(): TokenUsageReport {
    return {
      promptTokens: this.total.promptTokens,
      completionTokens: this.total.completionTokens,
      totalTokens: this.total.totalTokens,
    };
  }

  /** Reset all recorded usage. */
  clear(): void {
    this.perTick.clear();
    this.total = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
}

export {};
