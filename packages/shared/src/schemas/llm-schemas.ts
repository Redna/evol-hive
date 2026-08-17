/**
 * JSON Schemas for Structured Outputs (Grammar Constraints)
 * ──────────────────────────────────────────────────────────
 * Section 7: The engine strictly relies on Structured Outputs to parse LLM
 * intentions. These schemas are passed to the LLM backend (Ollama, vLLM,
 * llama.cpp) as grammar constraints / response_format.
 */

/** The LLM action response schema (Section 7). */
export const llmActionResponseSchema = {
  type: 'object',
  properties: {
    reasoning: {
      type: 'string',
      description: 'Internal reasoning / monologue. Not shown to the player.',
    },
    action: {
      type: 'string',
      description: 'The chosen action — an affordance ID or cognitive tool name.',
    },
    actionArgs: {
      type: 'object',
      description: 'Arguments for the action, if any.',
      additionalProperties: true,
    },
    observeTarget: {
      type: ['string', 'null'],
      description: 'Object ID to observe before acting, if the agent wants deeper info.',
    },
    updatedGoal: {
      type: ['string', 'null'],
      description: "The agent's updated goal, if it changed during this tick.",
    },
  },
  required: ['reasoning', 'action'],
  additionalProperties: false,
} as const;

/** The formulate_plan tool response schema. */
export const formulatePlanSchema = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'High-level description of the plan.',
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          targetAffordance: { type: ['string', 'null'] },
        },
        required: ['description'],
        additionalProperties: false,
      },
    },
  },
  required: ['description', 'steps'],
  additionalProperties: false,
} as const;

/** The query_memory tool response schema. */
export const queryMemorySchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'The search query for active recall.',
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

/** The update_internal_state tool response schema. */
export const updateInternalStateSchema = {
  type: 'object',
  properties: {
    newGoal: { type: ['string', 'null'] },
    driveOverrides: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
  },
  additionalProperties: false,
} as const;

/**
 * The memory consolidation schema (spec 006, Req 1).
 *
 * Used by `completeReflection` for the LLM's raw response during background
 * memory consolidation (§11.3). The LLM returns higher-level consolidated
 * memory descriptions and the IDs of the low-level nodes that were
 * consolidated (to be deprioritized).
 */
export const memoryConsolidationSchema = {
  type: 'object',
  properties: {
    consolidatedMemories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          importance: { type: 'integer', minimum: 1, maximum: 10 },
          type: {
            type: 'string',
            enum: ['observation', 'reflection', 'action', 'interaction'],
          },
        },
        required: ['content', 'importance', 'type'],
        additionalProperties: false,
      },
    },
    consolidatedNodeIds: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  additionalProperties: false,
} as const;

/**
 * The JSON instruction suffix appended to builder system prompts (spec 009, Req 15).
 *
 * Reminds the LLM to respond ONLY in valid JSON even when the backend does not
 * enforce the `json_schema` grammar constraint (e.g. Ollama cloud-backed models).
 */
export const JSON_INSTRUCTION_SUFFIX =
  'IMPORTANT: Respond ONLY with a valid JSON object. Do not include any prose, markdown formatting, code fences, or XML tags. The JSON must match the provided schema exactly.';

// ─── Schema-in-Prompt Hints (spec 010, Req 2) ────────────────────────────────
//
// Concrete field-by-field JSON templates appended to the **user message** so
// the LLM sees the exact field names it must produce, regardless of whether
// the backend enforces `json_schema` or `json_object`. These are distinct from
// `JSON_INSTRUCTION_SUFFIX` (a general "respond in JSON" reminder in the system
// prompt) — the schema hint is a concrete template in the user message.

/** Schema hint for `formulatePlanSchema` (spec 010, Req 2, AC-2). */
export const PLAN_SCHEMA_HINT =
  'Respond with JSON in this exact format: {"description": "<plan description>", "steps": [{"description": "<step description>", "targetAffordance": "<affordance id or null>"}]}';

/** Schema hint for `llmActionResponseSchema` (spec 010, Req 2, AC-3). */
export const ACTION_RESPONSE_SCHEMA_HINT =
  'Respond with JSON in this exact format: {"reasoning": "<your reasoning>", "action": "<affordance id or cognitive tool name>", "actionArgs": {}, "observeTarget": "<object id or null>", "updatedGoal": "<new goal or null>"}';

/** Schema hint for `reflectSchema` (spec 010, Req 2, AC-4). */
export const REFLECT_SCHEMA_HINT =
  'Respond with JSON in this exact format: {"newGoal": "<new goal or null>", "driveOverrides": {"<driveName>": <value>}, "memoryEntry": {"content": "<description>", "importance": 1, "type": "observation", "location": "<room or null>"}}';

/** Schema hint for `memoryConsolidationSchema` (spec 010, Req 2, AC-5). */
export const MEMORY_CONSOLIDATION_SCHEMA_HINT =
  'Respond with JSON in this exact format: {"consolidatedMemories": [{"content": "<description>", "importance": 1, "type": "observation"}], "consolidatedNodeIds": ["<nodeId>"]}';

/** The reflect phase response schema (spec 004, Req 4). No top-level fields are required. */
export const reflectSchema = {
  type: 'object',
  properties: {
    newGoal: { type: ['string', 'null'] },
    driveOverrides: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    memoryEntry: {
      type: ['object', 'null'],
      properties: {
        content: { type: 'string' },
        importance: { type: 'integer', minimum: 1, maximum: 10 },
        type: {
          type: 'string',
          enum: ['observation', 'reflection', 'action', 'interaction'],
        },
        location: { type: ['string', 'null'] },
      },
      required: ['content', 'importance', 'type'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;
