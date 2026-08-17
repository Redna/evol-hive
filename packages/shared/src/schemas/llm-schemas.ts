/**
 * JSON Schemas for Structured Outputs — now used as tool `parameters` (spec 011).
 * ────────────────────────────────────────────────────────────────────────────
 * Section 7: The engine strictly relies on Structured Outputs to parse LLM
 * intentions. These schemas are passed to the LLM backend as tool definition
 * `parameters` via the OpenAI-compatible `tools` parameter (spec 011).
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

// ─── Tool Definitions (spec 011, Req 3) ─────────────────────────────────────
//
// Each PPER phase has a primary tool definition. The existing JSON schema objects
// are reused as the tool `parameters` — no modification needed. The LLM calls the
// tool and returns `tool_calls[0].function.arguments` as valid JSON.

import type { ToolDefinition } from '../types/cognition.js';

/** Tool definition for the Plan phase (spec 011, Req 3). */
export const formulatePlanTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'formulate_plan',
    description: "Create a plan to satisfy the agent's drives",
    parameters: formulatePlanSchema,
  },
};

/** Tool definition for the Execute/Perceive phase (spec 011, Req 3). */
export const chooseActionTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'choose_action',
    description: 'Choose one action to perform this tick',
    parameters: llmActionResponseSchema,
  },
};

/** Tool definition for the Reflect phase (spec 011, Req 3). */
export const reflectTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'reflect',
    description: 'Reflect on the last action and update internal state',
    parameters: reflectSchema,
  },
};

/** Tool definition for memory consolidation (spec 011, Req 3). */
export const memoryConsolidationTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'consolidate_memories',
    description: 'Consolidate memory nodes into higher-level insights',
    parameters: memoryConsolidationSchema,
  },
};
