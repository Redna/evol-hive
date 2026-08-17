/**
 * pper/reflect-service — Reflect phase orchestration
 * ──────────────────────────────────────────────────
 * Section 6 / §9.1 / spec 004: Orchestrates the Reflect phase of the PPER
 * loop. Sets `isThinking` on the agent, builds the context payload, calls
 * the LLM, validates the response, applies drive/goal/memory updates, and
 * clears the plan if complete.
 *
 * The `isThinking` flag is always reset to `false` — on success, on
 * failure, and on any exception path. The method never re-throws; it
 * returns a `ReflectResult` with `success: false` on error so the PPER
 * orchestrator can retry on the next tick.
 *
 * Atomicity: If the LLM's `memoryEntry` is invalid, the entire Reflect
 * result is a failure — no partial updates (drives, goal) are applied.
 * Once validation passes, updates are applied in sequence (drives → goal →
 * memory). If the memory store call fails after drives and goal were
 * applied, those updates are NOT rolled back — the `ReflectResult` flags
 * report which updates succeeded.
 */

import type {
  ExecuteResult,
  MemoryEntryInput,
  MemoryType,
  ReflectDataProvider,
  ReflectLLMResponse,
  ReflectResult,
} from '@evol-hive/shared';
import type { LLMClient, ReflectBuilder } from '../index.js';
import { LLMResponseError } from '../llm/index.js';

/** Constructor options for {@link ReflectServiceImpl}. */
export interface ReflectServiceOptions {
  reflectBuilder: ReflectBuilder;
  llmClient: LLMClient;
  dataProvider: ReflectDataProvider;
}

const VALID_MEMORY_TYPES: readonly MemoryType[] = [
  'observation',
  'reflection',
  'action',
  'interaction',
];

/** Concrete ReflectService that orchestrates reflection via the LLM. */
export class ReflectServiceImpl {
  constructor(private readonly options: ReflectServiceOptions) {}

  async reflect(agentId: string, executeResult: ExecuteResult): Promise<ReflectResult> {
    const { reflectBuilder, llmClient, dataProvider } = this.options;

    // Retrieve the agent's state. If the agent does not exist, return failure.
    const agentState = dataProvider.getAgentState(agentId);
    if (!agentState) {
      return {
        success: false,
        error: 'Agent not found',
        cycleComplete: false,
        memoryStored: false,
        goalUpdated: false,
        drivesUpdated: false,
      };
    }

    // Set isThinking = true before the LLM call (§9.1).
    dataProvider.setThinking(agentId, true);

    try {
      // Retrieve the agent's persona profile (spec 012, Req 12).
      let profile: import('@evol-hive/shared').AgentProfile | null | undefined;
      try {
        if (typeof dataProvider.getAgentProfile === 'function') {
          profile = dataProvider.getAgentProfile(agentId);
        } else {
          profile = undefined;
        }
      } catch {
        profile = undefined;
      }

      // Build the context payload.
      const payload = reflectBuilder.build(agentId, agentState, executeResult, profile);

      // Call the LLM and await the ReflectLLMResponse.
      const response = await llmClient.completeReflect(payload);

      // Treat null/undefined as an empty object (no updates needed).
      const llmResponse: ReflectLLMResponse = response ?? {};

      // Validate the LLM response before applying any changes (Req 15).
      const validationError = validateReflectLLMResponse(llmResponse);
      if (validationError !== null) {
        return {
          success: false,
          error: validationError,
          cycleComplete: false,
          memoryStored: false,
          goalUpdated: false,
          drivesUpdated: false,
        };
      }

      // Track which updates were applied.
      let drivesUpdated = false;
      let goalUpdated = false;
      let memoryStored = false;

      // (1) Apply drive overrides if present and non-empty.
      if (
        llmResponse.driveOverrides !== undefined &&
        Object.keys(llmResponse.driveOverrides).length > 0
      ) {
        dataProvider.applyDriveChanges(agentId, llmResponse.driveOverrides);
        drivesUpdated = true;
      }

      // (2) Apply newGoal if present and non-empty.
      if (llmResponse.newGoal !== undefined && llmResponse.newGoal.length > 0) {
        dataProvider.updateGoal(agentId, llmResponse.newGoal);
        goalUpdated = true;
      }

      // (3) Store memory entry if present and valid.
      if (llmResponse.memoryEntry !== undefined) {
        try {
          await dataProvider.storeMemory(agentId, llmResponse.memoryEntry);
          memoryStored = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            error: `Failed to store memory: ${message}`,
            cycleComplete: false,
            memoryStored: false,
            goalUpdated,
            drivesUpdated,
          };
        }
      }

      // Clear the plan if it is complete (side-effect, not critical).
      try {
        dataProvider.clearPlanIfComplete(agentId);
      } catch {
        // Log but do not fail — plan clearing is a side-effect (Req 19).
      }

      return {
        success: true,
        cycleComplete: true,
        memoryStored,
        goalUpdated,
        drivesUpdated,
      };
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      // Distinguish LLM response (parse) errors from transient errors (spec 008, Req 3.2, AC-10).
      if (err instanceof LLMResponseError) {
        message = `LLM response error: ${message}`;
      }
      return {
        success: false,
        error: message,
        cycleComplete: false,
        memoryStored: false,
        goalUpdated: false,
        drivesUpdated: false,
      };
    } finally {
      // Always reset isThinking — on success, failure, and exception paths (§9.1).
      dataProvider.setThinking(agentId, false);
    }
  }
}

/**
 * Validates the ReflectLLMResponse before any changes are applied (Req 15).
 * Returns an error message string if invalid, or `null` if valid.
 *
 * - `newGoal` empty string → treated as undefined (no error, just no update).
 * - `driveOverrides` empty object → treated as undefined (no error, just no update).
 * - `memoryEntry` invalid → returns an error (atomicity: no partial updates).
 * - null/undefined response → treated as empty object (valid, no updates).
 */
function validateReflectLLMResponse(response: ReflectLLMResponse): string | null {
  // Validate memoryEntry if present.
  if (response.memoryEntry !== undefined) {
    const entry: MemoryEntryInput = response.memoryEntry;

    if (typeof entry.content !== 'string' || entry.content.length === 0) {
      return 'Invalid memory entry from LLM: content must be non-empty';
    }

    if (
      typeof entry.importance !== 'number' ||
      !Number.isInteger(entry.importance) ||
      entry.importance < 1 ||
      entry.importance > 10
    ) {
      return 'Invalid memory entry from LLM: importance must be an integer 1–10';
    }

    if (typeof entry.type !== 'string' || !VALID_MEMORY_TYPES.includes(entry.type)) {
      return 'Invalid memory entry from LLM: type must be one of observation, reflection, action, interaction';
    }
  }

  return null;
}

export {};
