/**
 * pper/reflect-service — Reflect phase orchestration
 * ──────────────────────────────────────────────────
 * Section 6 / §9.1 / spec 004: Orchestrates the Reflect phase of the PPER
 * loop. Sets `isThinking` on the agent, builds the context payload, calls
 * the LLM, validates the response, applies drive/goal/memory updates, and
 * clears the plan if complete.
 *
 * Spec 025: The memory entry is now specified via flattened top-level fields
 * (`memoryContent`, `memoryImportance`, `memoryType`, `memoryLocation`) on
 * the `ReflectLLMResponse`. When the LLM omits all memory fields, an
 * auto-fallback memory is generated from the execution result and agent
 * state, guaranteeing at least one memory per reflect cycle.
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
      payload.agentId = agentId;

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

      // (3) Store memory entry — flattened fields, legacy memoryEntry, or auto-fallback (spec 025).
      const memoryEntry = resolveMemoryEntry(llmResponse, executeResult, agentState);
      if (memoryEntry !== undefined) {
        try {
          await dataProvider.storeMemory(agentId, memoryEntry);
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
 * Resolves the memory entry to store from the LLM response, execution result,
 * and agent state (spec 025, R4 + R5).
 *
 * Priority:
 * 1. Flattened `memoryContent` (if present and non-empty) — constructs a
 *    `MemoryEntryInput` from the flattened fields with defaults.
 * 2. Legacy `memoryEntry` (if present and valid) — backward compatibility.
 * 3. Auto-fallback — generates a memory from the execution result and agent
 *    state when the LLM omits all memory fields (R5).
 *
 * Returns `undefined` when no memory should be stored (this should not
 * happen with the auto-fallback, but is retained for safety).
 */
function resolveMemoryEntry(
  response: ReflectLLMResponse,
  executeResult: ExecuteResult,
  agentState: import('@evol-hive/shared').AgentInternalState,
): MemoryEntryInput | undefined {
  // (1) Flattened memoryContent (spec 025, R4.2).
  if (response.memoryContent !== undefined && response.memoryContent.trim().length > 0) {
    return {
      content: response.memoryContent,
      importance: response.memoryImportance ?? 5,
      type: response.memoryType ?? 'observation',
      ...(response.memoryLocation !== undefined ? { location: response.memoryLocation } : {}),
    };
  }

  // (2) Legacy memoryEntry (spec 025, R4.3).
  if (response.memoryEntry !== undefined) {
    return response.memoryEntry;
  }

  // (3) Auto-fallback (spec 025, R5.1).
  return generateAutoFallbackMemory(executeResult, agentState);
}

/**
 * Generates an auto-fallback memory entry from the execution result and agent
 * state (spec 025, R5).
 *
 * - Content: `"Idle tick — no action taken. Goal: {currentGoal}"` when
 *   `stepSkipped` is true; `"Action succeeded: {currentGoal}"` (plus drive
 *   changes) on success; `"Action failed: {error}. Goal: {currentGoal}"` on
 *   failure.
 * - Importance: `3` (low — auto-generated, not LLM-curated).
 * - Type: `"action"` when execution succeeded, `"observation"` otherwise.
 * - Location: the agent's `location` from `AgentInternalState`, or
 *   `undefined`.
 */
function generateAutoFallbackMemory(
  executeResult: ExecuteResult,
  agentState: import('@evol-hive/shared').AgentInternalState,
): MemoryEntryInput {
  let content: string;
  let type: MemoryType;

  if (executeResult.stepSkipped === true) {
    content = `Idle tick — no action taken. Goal: ${agentState.currentGoal}`;
    type = 'observation';
  } else if (executeResult.success) {
    content = `Action succeeded: ${agentState.currentGoal}`;
    type = 'action';

    // Append drive changes when present (R5.2).
    if (executeResult.result?.driveChanges !== undefined) {
      const changes = Object.entries(executeResult.result.driveChanges);
      if (changes.length > 0) {
        const formatted = changes
          .map(([key, value]) => `${key} ${value! >= 0 ? '+' : ''}${value!}`)
          .join(', ');
        content += `, drives: ${formatted}`;
      }
    }
  } else {
    const error = executeResult.error ?? 'unknown';
    content = `Action failed: ${error}. Goal: ${agentState.currentGoal}`;
    type = 'observation';
  }

  return {
    content,
    importance: 3,
    type,
    ...(agentState.location !== undefined ? { location: agentState.location } : {}),
  };
}

/**
 * Validates the ReflectLLMResponse before any changes are applied (Req 15).
 * Returns an error message string if invalid, or `null` if valid.
 *
 * - `newGoal` empty string → treated as undefined (no error, just no update).
 * - `driveOverrides` empty object → treated as undefined (no error, just no update).
 * - `memoryContent` present but empty → not an error (treated as "no memory").
 * - `memoryEntry` invalid → returns an error (atomicity: no partial updates).
 * - null/undefined response → treated as empty object (valid, no updates).
 */
function validateReflectLLMResponse(response: ReflectLLMResponse): string | null {
  // Validate flattened memoryContent if present (R4.1).
  // An empty/whitespace-only memoryContent is NOT an error — it means the
  // LLM chose not to store a memory. The auto-fallback handles this case.
  if (response.memoryContent !== undefined && response.memoryContent.trim().length > 0) {
    if (typeof response.memoryContent !== 'string') {
      return 'Invalid memory content from LLM: memoryContent must be a string';
    }
  }

  // Validate legacy memoryEntry if present (R4.1, backward compatibility).
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
