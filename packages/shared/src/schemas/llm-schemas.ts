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
    topK: {
      type: 'integer',
      minimum: 1,
      maximum: 20,
      description: 'Maximum number of memories to retrieve (default: 5).',
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

/** Tool definition for the query_memory cognitive tool (spec 015, Req 7). */
export const queryMemoryTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'query_memory',
    description: 'Actively recall relevant memories for the current situation.',
    parameters: queryMemorySchema,
  },
};

/** Tool definition for the update_internal_state cognitive tool (spec 015, Req 7). */
export const updateInternalStateTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'update_internal_state',
    description: 'Update the agent goal or drive overrides.',
    parameters: updateInternalStateSchema,
  },
};

// ─── Social Tool Schemas (spec 018, Req 13) ─────────────────────────────────

/** Schema for the talk_to social tool (spec 018, Req 13). */
export const talkToSchema = {
  type: 'object',
  properties: {
    targetAgentId: {
      type: 'string',
      description: 'The ID of the agent to send the message to.',
    },
    message: {
      type: 'string',
      description: 'The message content to send to the target agent.',
    },
  },
  required: ['targetAgentId', 'message'],
  additionalProperties: false,
} as const;

/** Schema for the observe_agent social tool (spec 018, Req 13). */
export const observeAgentSchema = {
  type: 'object',
  properties: {
    targetAgentId: {
      type: 'string',
      description: 'The ID of the agent to observe.',
    },
  },
  required: ['targetAgentId'],
  additionalProperties: false,
} as const;

/** Schema for the help social tool (spec 018, Req 13). */
export const helpSchema = {
  type: 'object',
  properties: {
    targetAgentId: {
      type: 'string',
      description: 'The ID of the agent to help.',
    },
  },
  required: ['targetAgentId'],
  additionalProperties: false,
} as const;

/** Schema for the ignore social tool (spec 018, Req 13). */
export const ignoreSchema = {
  type: 'object',
  properties: {
    targetAgentId: {
      type: 'string',
      description: 'The ID of the agent to ignore.',
    },
  },
  required: ['targetAgentId'],
  additionalProperties: false,
} as const;

// ─── Social Tool Definitions (spec 018, Req 14) ─────────────────────────────

/** Tool definition for the talk_to social cognitive tool (spec 018, Req 14). */
export const talkToTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'talk_to',
    description:
      'Send a message to another agent in the same room. The message will appear in their next perception tick.',
    parameters: talkToSchema,
  },
};

/** Tool definition for the observe_agent social cognitive tool (spec 018, Req 14). */
export const observeAgentTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'observe_agent',
    description:
      'Observe another agent in the same room. Returns their current activity, drives, and state.',
    parameters: observeAgentSchema,
  },
};

/** Tool definition for the help social cognitive tool (spec 018, Req 14). */
export const helpTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'help',
    description:
      'Help another agent in the same room. Boosts their primary drive and your social drive.',
    parameters: helpSchema,
  },
};

/** Tool definition for the ignore social cognitive tool (spec 018, Req 14). */
export const ignoreTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'ignore',
    description: 'Choose to ignore another agent in the same room. Signals social disengagement.',
    parameters: ignoreSchema,
  },
};
