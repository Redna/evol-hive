/**
 * Performance Tuning types (spec 022)
 * ───────────────────────────────
 * Cross-cutting config + reporting types shared by the `engine`, `cognition`,
 * and `memory` packages. Kept in `@evol-hive/shared` per ADR-0001 so the two
 * implementation packages never import from each other directly.
 */

/**
 * A single LLM token-usage measurement captured from an OpenAI-compatible
 * API response envelope (spec 022, Req 10). `agentId`, `phase`, and
 * `tickNumber` are optional metadata used for aggregation; they are omitted
 * when the caller does not know them (e.g. the LLM client has no tick
 * context).
 */
export interface TokenUsageReport {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  agentId?: string;
  phase?: string;
  tickNumber?: number;
}

/**
 * Configuration for associative memory injection (spec 022, Req 13, AC-12).
 * `topK` caps the number of memories injected into the perception context
 * window. Defaults to `3` (down from the previous hardcoded `5`).
 */
export interface MemoryInjectionConfig {
  topK: number;
}

/**
 * Configuration for the {@link BatchPlanService} (spec 022, Req 7, AC-5).
 * `maxBatchSize` caps how many agents are folded into a single batched LLM
 * call. Defaults to `5`.
 */
export interface BatchPlanConfig {
  maxBatchSize: number;
}

/**
 * A single per-agent plan entry returned by a multi-agent batch plan LLM call
 * (spec 022, Req 6). The `agentId` identifies which agent the plan belongs to.
 */
export interface MultiAgentPlanEntry {
  agentId: string;
  description: string;
  steps: { description: string; targetAffordance?: string }[];
}

/**
 * The parsed response of a `multi_agent_plans` tool call (spec 022, Req 6).
 */
export interface MultiAgentPlanResponse {
  plans: MultiAgentPlanEntry[];
}

export {};
