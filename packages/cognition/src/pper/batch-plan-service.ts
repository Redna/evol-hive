/**
 * pper/batch-plan-service — LLM request batching for the Plan phase (spec 022)
 * ────────────────────────────────────────────────────────────────────────────
 * Batches the Plan phase for multiple agents sharing a room into a single LLM
 * call (spec 022, Req 5/6). Collects the `PerceptionResult` for each agent,
 * builds a multi-agent prompt (each agent's stable perception context
 * separated by delimiters), sends one `completeBatchPlan` call with the
 * `multi_agent_plans` tool, and parses the response into per-agent
 * `FormulatePlanResult` objects.
 *
 * When more agents than `maxBatchSize` share a room, they are split into
 * multiple batches (Req 7). When the batched response cannot be parsed for an
 * agent (missing agentId or invalid steps), the service falls back to
 * individual `PlanService.plan()` calls for the affected agents (Req 8).
 *
 * Batching is opt-in (Req 9): the `PPEROrchestratorImpl` only uses a
 * `BatchPlanService` when one is explicitly wired into its options.
 *
 * Package boundary (ADR-0001): the `BatchPlanService` lives in `@evol-hive/cognition`
 * and depends only on `@evol-hive/shared`, the `PlanBuilder`, `PlanDataProvider`,
 * and `PlanService` ports, plus the {@link BatchPlanLLMClient} port (satisfied
 * structurally by `OpenAICompatibleLLMClient`).
 */

import type {
  PerceptionResult,
  FormulatePlanResult,
  PlanDataProvider,
  PlanResult,
  MultiAgentPlanResponse,
  MultiAgentPlanEntry,
} from '@evol-hive/shared';
import { multiAgentPlansTool } from '@evol-hive/shared';
import type { LLMContextPayload, PlanBuilder, PlanService } from '../index.js';

/**
 * A single agent's perception result, paired with its agentId for batch
 * dispatch and response mapping. (`PerceptionResult` carries no agentId, so
 * callers must supply it alongside the perception.)
 */
export interface BatchPlanEntry {
  agentId: string;
  perception: PerceptionResult;
}

/**
 * Narrower LLM client port for batched plan calls (spec 022, Req 5). The
 * concrete `OpenAICompatibleLLMClient` satisfies this structurally via its
 * `completeBatchPlan` method (added in spec 022, not part of the `LLMClient`
 * interface).
 */
export interface BatchPlanLLMClient {
  completeBatchPlan(payload: LLMContextPayload): Promise<MultiAgentPlanResponse>;
}

/** Constructor options for {@link BatchPlanService}. */
export interface BatchPlanServiceOptions {
  /** LLM client used for batched multi-agent plan calls. */
  llmClient: BatchPlanLLMClient;
  /** Builds each agent's perception context (reused for the combined prompt). */
  planBuilder: PlanBuilder;
  /** Stores the formulated plans for agents with valid batch responses. */
  dataProvider: PlanDataProvider;
  /** Fallback single-agent plan service for agents with invalid batch responses (Req 8). */
  planService: PlanService;
  /** Max agents per batch (default 5, Req 7). */
  maxBatchSize?: number;
}

/** Default batch size (spec 022, Req 7). */
const DEFAULT_MAX_BATCH_SIZE = 5;

/**
 * Batches the Plan phase for multiple agents sharing a room into one or a few
 * LLM calls (spec 022, Req 5–8).
 */
export class BatchPlanService {
  private readonly llmClient: BatchPlanLLMClient;
  private readonly planBuilder: PlanBuilder;
  private readonly dataProvider: PlanDataProvider;
  private readonly planService: PlanService;
  private readonly maxBatchSize: number;

  constructor(options: BatchPlanServiceOptions) {
    this.llmClient = options.llmClient;
    this.planBuilder = options.planBuilder;
    this.dataProvider = options.dataProvider;
    this.planService = options.planService;
    const configured = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxBatchSize = configured >= 1 ? configured : DEFAULT_MAX_BATCH_SIZE;
  }

  /**
   * Formulate and store plans for the given agents. Entries are grouped by
   * room (spec 022, Req 5) and split into batches of at most `maxBatchSize`.
   * Returns a `Map<agentId, PlanResult>`.
   */
  async batchPlan(entries: BatchPlanEntry[]): Promise<Map<string, PlanResult>> {
    const results = new Map<string, PlanResult>();

    // Group by room (agents sharing a room are batched together, Req 5).
    const byRoom = new Map<string, BatchPlanEntry[]>();
    for (const entry of entries) {
      const room = entry.perception.passive.roomId;
      const bucket = byRoom.get(room);
      if (bucket === undefined) {
        byRoom.set(room, [entry]);
      } else {
        bucket.push(entry);
      }
    }

    for (const roomEntries of byRoom.values()) {
      // Split into batches of at most maxBatchSize (Req 7).
      for (let i = 0; i < roomEntries.length; i += this.maxBatchSize) {
        const batch = roomEntries.slice(i, i + this.maxBatchSize);
        await this.processBatch(batch, results);
      }
    }

    return results;
  }

  /** Process a single batch: one LLM call, then per-agent store or fallback. */
  private async processBatch(
    batch: BatchPlanEntry[],
    results: Map<string, PlanResult>,
  ): Promise<void> {
    const payload = this.buildBatchPayload(batch);
    let response: MultiAgentPlanResponse;
    try {
      response = await this.llmClient.completeBatchPlan(payload);
    } catch {
      // Any batch LLM failure → fall back to individual calls for the whole batch.
      await this.fallbackAll(batch, results);
      return;
    }

    // Map agentId → parsed entry for quick lookup.
    const byAgent = new Map<string, MultiAgentPlanEntry>();
    for (const entry of response.plans) {
      byAgent.set(entry.agentId, entry);
    }

    for (const { agentId, perception } of batch) {
      const entry = byAgent.get(agentId);
      if (entry === undefined || !isValidBatchEntry(entry)) {
        // Fallback for missing/invalid agents (Req 8).
        const fallback = await this.planService.plan(agentId, perception);
        results.set(agentId, fallback);
        continue;
      }
      const formulate: FormulatePlanResult = {
        description: entry.description,
        steps: entry.steps,
      };
      const plan = this.dataProvider.storePlan(agentId, formulate);
      results.set(agentId, { success: true, plan });
    }
  }

  /** Fall back to individual `PlanService.plan()` calls for every entry. */
  private async fallbackAll(
    batch: BatchPlanEntry[],
    results: Map<string, PlanResult>,
  ): Promise<void> {
    for (const { agentId, perception } of batch) {
      const result = await this.planService.plan(agentId, perception);
      results.set(agentId, result);
    }
  }

  /**
   * Build the multi-agent prompt payload (Req 6). The system prompt instructs
   * the LLM to formulate a plan for each agent; the perception context lists
   * each agent's stable perception context separated by clear delimiters; the
   * tool schema is the `multi_agent_plans` tool.
   */
  private buildBatchPayload(batch: BatchPlanEntry[]): LLMContextPayload {
    const sections: string[] = [];
    for (const { agentId, perception } of batch) {
      const single = this.planBuilder.build(perception);
      sections.push(
        `=== Agent ${agentId} (room: ${perception.passive.roomId}) ===\n${single.perceptionContext}`,
      );
    }
    return {
      systemPrompt:
        'You are formulating plans for multiple agents sharing a room. ' +
        'Use the multi_agent_plans tool to return one plan entry per agentId, ' +
        'each with a description and a non-empty steps array mapping to available affordances when possible.',
      perceptionContext: sections.join('\n\n'),
      availableAffordances: [],
      cognitiveTools: [],
      tools: [multiAgentPlansTool],
    };
  }
}

/**
 * Validate a single batch entry (spec 022, Req 8). An entry is valid when it
 * has a non-empty description and a non-empty steps array with non-empty step
 * descriptions.
 */
function isValidBatchEntry(entry: MultiAgentPlanEntry): boolean {
  if (typeof entry.description !== 'string' || entry.description.length === 0) {
    return false;
  }
  if (!Array.isArray(entry.steps) || entry.steps.length === 0) {
    return false;
  }
  for (const step of entry.steps) {
    if (typeof step.description !== 'string' || step.description.length === 0) {
      return false;
    }
  }
  return true;
}

export {};
