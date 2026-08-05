// pper/ — PPER loop orchestration (Perceive phase)
// ────────────────────────────────────────────────
// Section 6.1: The Perceive phase is System 1 (passive). It builds
// passive perception, prunes affordances via the System 0 classifier,
// and constructs the LLM context payload. It does NOT call the LLM.

import type {
  PassivePerception,
  PassivePerceptionInput,
  PerceptionCompileInput,
  PerceptionResult,
  Affordance,
  CognitiveTool,
} from '@evol-hive/shared';
import { llmActionResponseSchema } from '@evol-hive/shared';
import type { AffordanceClassifier, PerceptionBuilder, LLMContextPayload } from '../index.js';

// ── Default Cognitive Tools (Section 8) ──────────────────────────────────────

/** The default cognitive tools available to the LLM. */
const DEFAULT_COGNITIVE_TOOLS: CognitiveTool[] = [
  {
    name: 'formulate_plan',
    description: 'Break a high-level desire into actionable steps.',
    argsSchema: {
      description: { type: 'string' },
      steps: {
        type: 'array',
        items: {
          description: { type: 'string' },
          targetAffordance: { type: 'string' },
        },
      },
    },
  },
  {
    name: 'query_memory',
    description: 'Actively recall relevant memories from the memory subsystem.',
    argsSchema: {
      query: { type: 'string' },
    },
  },
  {
    name: 'update_internal_state',
    description: 'Update the agent goal or drive overrides.',
    argsSchema: {
      newGoal: { type: 'string' },
      driveOverrides: { type: 'object', additionalProperties: { type: 'number' } },
    },
  },
];

// ── Default System Prompt ────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `You are an autonomous NPC in a simulated world. You perceive your surroundings, form plans, execute actions, and reflect on outcomes. Choose actions from the available affordances or cognitive tools. Use formulate_plan when you need to break down a complex goal. Always provide clear reasoning for your choices.`;

// ── Passive Perception Assembly ──────────────────────────────────────────────

/**
 * Build a `PassivePerception` from raw engine data.
 *
 * (AC-11) Returns a PassivePerception with:
 *   - roomId matching the agent's location
 *   - objectsPresent containing { objectId, name, type } for each object
 *   - drives matching the agent's current drive values
 *
 * (AC-12) objectsPresent entries do NOT contain state or affordances fields.
 * (AC-20) associativeMemories is undefined when not provided.
 * (AC-21) systemFeedback is included when present.
 *
 * This function does NOT call the LLM (System 1 only).
 */
export function buildPassivePerception(input: PassivePerceptionInput): PassivePerception {
  return {
    roomId: input.roomId,
    objectsPresent: input.objectsInRoom.map((o) => ({
      objectId: o.id,
      name: o.name,
      type: o.type,
    })),
    drives: input.drives,
    ...(input.systemFeedback !== undefined ? { systemFeedback: input.systemFeedback } : {}),
    ...(input.associativeMemories !== undefined
      ? { associativeMemories: input.associativeMemories }
      : {}),
  };
}

// ── Full Perception Compilation ──────────────────────────────────────────────

/**
 * Run the full Perceive phase: build passive perception + classifier pruning.
 *
 * (AC-16) Returns a PerceptionResult with:
 *   - passive: the PassivePerception
 *   - prunedAffordances: exactly the output of AffordanceClassifier.prune()
 *   - primaryDriveLabel: the semantic drive label
 *
 * (AC-19) Does NOT call the LLM — only the embedding-based classifier is used.
 */
export async function runPerception(
  input: PerceptionCompileInput,
  classifier: AffordanceClassifier,
): Promise<PerceptionResult> {
  const passive = buildPassivePerception({
    roomId: input.roomId,
    objectsInRoom: input.objectsInRoom,
    drives: input.drives,
    ...(input.systemFeedback !== undefined ? { systemFeedback: input.systemFeedback } : {}),
    ...(input.associativeMemories !== undefined
      ? { associativeMemories: input.associativeMemories }
      : {}),
  });

  const prunedAffordances: Affordance[] = await classifier.prune(
    input.primaryDriveLabel,
    input.roomAffordances,
  );

  return {
    passive,
    prunedAffordances,
    primaryDriveLabel: input.primaryDriveLabel,
  };
}

// ── Perception Builder ───────────────────────────────────────────────────────

/**
 * Implementation of `PerceptionBuilder`.
 *
 * (AC-18) build(perceptionResult) returns an LLMContextPayload with:
 *   - availableAffordances set to the pruned list
 *   - perceptionContext containing the room name and object names
 *   - responseSchema set to llmActionResponseSchema
 *
 * (AC-19) Does NOT call the LLM — this is a synchronous, deterministic builder.
 */
export class PerceptionBuilderImpl implements PerceptionBuilder {
  build(perceptionResult: PerceptionResult): LLMContextPayload {
    const { passive, prunedAffordances } = perceptionResult;

    // Build a compact perception context string (token budget constraint).
    // Contains: room identifier, object names, drive summary.
    const objectNames = passive.objectsPresent.map((o) => o.name).join(', ');
    const driveSummary = Object.entries(passive.drives)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');

    const perceptionContext = `Room: ${passive.roomId}\nObjects: ${objectNames || 'none'}\nDrives: ${driveSummary}`;

    return {
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      perceptionContext,
      availableAffordances: prunedAffordances,
      cognitiveTools: DEFAULT_COGNITIVE_TOOLS,
      responseSchema: llmActionResponseSchema,
    };
  }
}
