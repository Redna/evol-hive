/**
 * tools/cognitive-tool-executor — Concrete CognitiveToolExecutor (spec 015, §8)
 * ────────────────────────────────────────────────────────────────────────────
 * Executes `query_memory` and `update_internal_state` mid-loop during the LLM
 * tool call loop (spec 015, Req 9–11). Wired at the application entry point
 * with a `MemoryInjector` (for active recall) and a `CognitiveToolDataProvider`
 * (for goal/drive updates). Both dependencies are optional — when absent, the
 * methods return safe, non-error results so the LLM can proceed.
 *
 * Per ADR-0001, this class imports from `@evol-hive/shared` (bridge interfaces
 * and result types) and `@evol-hive/memory` (`MemoryInjector` type). It does
 * NOT import from `@evol-hive/engine`.
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
  /** Optional memory injector for active recall (query_memory). */
  memoryInjector?: MemoryInjector;
  /** Optional state data provider for goal/drive updates (update_internal_state). */
  stateDataProvider?: CognitiveToolDataProvider;
}

/**
 * Concrete `CognitiveToolExecutor` that wires `MemoryInjector.activeRecall` and
 * the state data provider methods to the cognitive tool execution loop.
 *
 * Error-resilient: `executeQueryMemory` catches `activeRecall` errors and
 * returns `{ memories: [] }` (a memory query failure never aborts the LLM
 * interaction). `executeUpdateInternalState` reports partial success when one
 * update throws after the other succeeded.
 */
export class CognitiveToolExecutorImpl implements CognitiveToolExecutor {
  private readonly memoryInjector: MemoryInjector | undefined;
  private readonly stateDataProvider: CognitiveToolDataProvider | undefined;

  constructor(options: CognitiveToolExecutorOptions = {}) {
    this.memoryInjector = options.memoryInjector;
    this.stateDataProvider = options.stateDataProvider;
  }

  async executeQueryMemory(
    agentId: string,
    query: string,
    topK: number,
  ): Promise<QueryMemoryToolResult> {
    if (this.memoryInjector === undefined) {
      return { memories: [] };
    }
    try {
      const snippets = await this.memoryInjector.activeRecall(agentId, query, topK);
      return { memories: snippets };
    } catch {
      // A memory query failure must not abort the LLM interaction (Req 10).
      return { memories: [] };
    }
  }

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
    let failed = false;
    let failMessage = '';

    if (newGoal !== undefined && newGoal.length > 0) {
      try {
        this.stateDataProvider.updateGoal(agentId, newGoal);
        goalUpdated = true;
      } catch (err) {
        failed = true;
        failMessage = err instanceof Error ? err.message : String(err);
      }
    }

    if (driveOverrides !== undefined && Object.keys(driveOverrides).length > 0) {
      try {
        this.stateDataProvider.applyDriveChanges(agentId, driveOverrides);
        drivesUpdated = true;
      } catch (err) {
        failed = true;
        failMessage = err instanceof Error ? err.message : String(err);
      }
    }

    if (failed) {
      return {
        success: goalUpdated || drivesUpdated,
        goalUpdated,
        drivesUpdated,
        message: `State update failed: ${failMessage}.`,
      };
    }

    const messageParts: string[] = [];
    if (goalUpdated) {
      messageParts.push(`Goal updated to: ${newGoal}.`);
    }
    if (drivesUpdated) {
      const driveSummary = Object.entries(driveOverrides!)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      messageParts.push(`Drives updated: ${driveSummary}.`);
    }
    if (messageParts.length === 0) {
      messageParts.push('No state changes requested.');
    }

    return {
      success: true,
      goalUpdated,
      drivesUpdated,
      message: messageParts.join(' '),
    };
  }
}

export {};
