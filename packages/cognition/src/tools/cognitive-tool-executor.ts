/**
 * tools/cognitive-tool-executor — Concrete cognitive tool executor (spec 015)
 * ────────────────────────────────────────────────────────────────────────────
 * Section 8 / spec 015: A concrete {@link CognitiveToolExecutor} that the
 * `OpenAICompatibleLLMClient` calls mid-loop when the LLM invokes a cognitive
 * tool (`query_memory` or `update_internal_state`). The application entry point
 * wires the `MemoryInjector` (from `@evol-hive/memory`) and a
 * `CognitiveToolDataProvider` (a focused subset of `ReflectDataProvider`) into
 * this class, then passes the executor to the LLM client config.
 *
 * Both dependencies are optional. When `memoryInjector` is absent,
 * `executeQueryMemory` returns `{ memories: [] }` (no error). When
 * `stateDataProvider` is absent, `executeUpdateInternalState` returns a
 * not-available confirmation. This keeps the system resilient — a missing
 * memory subsystem degrades gracefully instead of aborting the LLM interaction.
 *
 * Package boundaries (per ADR-0001): this class imports the
 * `CognitiveToolExecutor`, `CognitiveToolDataProvider`, `QueryMemoryToolResult`,
 * and `UpdateStateToolResult` types from `@evol-hive/shared`, and the
 * `MemoryInjector` type from `@evol-hive/memory`. It does NOT import from
 * `@evol-hive/engine`.
 */

import type {
  CognitiveToolDataProvider,
  CognitiveToolExecutor,
  QueryMemoryToolResult,
  UpdateStateToolResult,
} from '@evol-hive/shared';
import type { MemoryInjector } from '@evol-hive/memory';

/** Constructor options for {@link CognitiveToolExecutorImpl}. */
export interface CognitiveToolExecutorOptions {
  /** The memory injector used for `query_memory` (Track 2 active recall). Optional. */
  memoryInjector?: MemoryInjector;
  /** The state data provider used for `update_internal_state`. Optional. */
  stateDataProvider?: CognitiveToolDataProvider;
}

/**
 * Concrete {@link CognitiveToolExecutor} that executes cognitive tools
 * mid-loop. Both dependencies are optional; missing dependencies produce
 * graceful no-op / not-available results rather than errors.
 */
export class CognitiveToolExecutorImpl implements CognitiveToolExecutor {
  private readonly memoryInjector: MemoryInjector | undefined;
  private readonly stateDataProvider: CognitiveToolDataProvider | undefined;

  constructor(options: CognitiveToolExecutorOptions) {
    this.memoryInjector = options.memoryInjector;
    this.stateDataProvider = options.stateDataProvider;
  }

  // ── query_memory ───────────────────────────────────────────────────────────

  async executeQueryMemory(
    agentId: string,
    query: string,
    topK: number,
  ): Promise<QueryMemoryToolResult> {
    if (this.memoryInjector === undefined) {
      return { memories: [] };
    }
    try {
      const memories = await this.memoryInjector.activeRecall(agentId, query, topK);
      return { memories };
    } catch (err) {
      // A memory query failure must not abort the LLM interaction (spec 015, Req 10).
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[CognitiveToolExecutor] query_memory failed: ${message}`);
      return { memories: [] };
    }
  }

  // ── update_internal_state ──────────────────────────────────────────────────

  async executeUpdateInternalState(
    agentId: string,
    newGoal?: string,
    driveOverrides?: Partial<Record<string, number>>,
  ): Promise<UpdateStateToolResult> {
    if (this.stateDataProvider === undefined) {
      return {
        success: false,
        goalUpdated: false,
        drivesUpdated: false,
        message: 'State update not available.',
      };
    }

    let goalUpdated = false;
    let drivesUpdated = false;

    // (1) Apply goal update if a non-empty newGoal is provided.
    if (typeof newGoal === 'string' && newGoal.length > 0) {
      try {
        this.stateDataProvider.updateGoal(agentId, newGoal);
        goalUpdated = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          goalUpdated,
          drivesUpdated,
          message: `State update failed: ${message}.`,
        };
      }
    }

    // (2) Apply drive overrides if a non-empty object is provided.
    if (driveOverrides !== undefined && Object.keys(driveOverrides).length > 0) {
      try {
        this.stateDataProvider.applyDriveChanges(agentId, driveOverrides);
        drivesUpdated = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          goalUpdated,
          drivesUpdated,
          message: `State update failed: ${message}.`,
        };
      }
    }

    // Construct a human-readable confirmation message.
    const parts: string[] = [];
    if (goalUpdated) {
      parts.push(`Goal updated to: ${newGoal}.`);
    }
    if (drivesUpdated) {
      const driveSummary = Object.entries(driveOverrides ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      parts.push(`Drives updated: ${driveSummary}.`);
    }
    const message = parts.length > 0 ? parts.join(' ') : 'No updates applied.';

    return {
      success: goalUpdated || drivesUpdated,
      goalUpdated,
      drivesUpdated,
      message,
    };
  }
}

export {};
