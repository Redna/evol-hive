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
