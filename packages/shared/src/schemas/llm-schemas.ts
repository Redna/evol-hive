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

/**
 * The reflect phase response schema (spec 004, Req 4; spec 025, Req 1).
 *
 * Spec 025 flattens the nested `memoryEntry` object into four top-level
 * fields (`memoryContent`, `memoryImportance`, `memoryType`,
 * `memoryLocation`) because small models do not reliably populate nested
 * objects. Only `memoryContent` is required — the other three have defaults
 * applied at the parsing layer (R3.3).
 */
export const reflectSchema = {
  type: 'object',
  properties: {
    newGoal: { type: ['string', 'null'] },
    driveOverrides: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    memoryContent: {
      type: 'string',
      description: 'Memory content to store for future reference.',
    },
    memoryImportance: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'Importance score 1-10 (default: 5).',
    },
    memoryType: {
      type: 'string',
      enum: ['observation', 'reflection', 'action', 'interaction'],
      description: 'Type of memory (default: observation).',
    },
    memoryLocation: {
      type: 'string',
      description: 'Optional room/scene ID where the event occurred.',
    },
  },
  required: ['memoryContent'],
  additionalProperties: false,
} as const;

// ─── Tool Definitions (spec 011, Req 3) ─────────────────────────────────────
//
// Each PPER phase has a primary tool definition. The existing JSON schema objects
// are reused as the tool `parameters` — no modification needed. The LLM calls the
// tool and returns `tool_calls[0].function.arguments` as valid JSON.

import type { ToolDefinition } from '../types/cognition.js';
import type { Affordance } from '../types/affordance.js';

// ─── Affordance-as-Tools helpers (spec 019, Req 1-5) ──────────────────────────

/**
 * Empty parameters schema for affordance tools that take no arguments
 * (spec 019, Req 5). Affordances that accept arguments in the future can
 * define their own parameter schemas.
 */
export const AFFORDANCE_TOOL_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

/**
 * Formats an affordance's `effects` into a human-readable string for the tool
 * description (spec 019, Req 3).
 *
 * Examples:
 *   `{ energy: 20 }` → `"energy +20"`
 *   `{ comfort: -5, energy: 10 }` → `"comfort -5, energy +10"`
 *   `{}` → `"none"`
 */
export function formatAffordanceEffects(effects: Partial<Record<string, number>>): string {
  const entries = Object.entries(effects ?? {});
  if (entries.length === 0) {
    return 'none';
  }
  return entries.map(([key, value]) => `${key} ${value! >= 0 ? '+' : ''}${value!}`).join(', ');
}

/**
 * Converts a single `Affordance` to a `ToolDefinition` (spec 019, Req 1).
 *
 * The tool `name` IS the affordance ID — the LLM cannot call a non-existent
 * tool, so it must use the exact affordance ID. The tool `description` is the
 * affordance label plus a summary of effects. The `parameters` is the empty
 * object schema (all affordances are parameterless for now).
 */
export function affordanceToToolDefinition(affordance: Affordance): ToolDefinition {
  const effectsStr = formatAffordanceEffects(affordance.effects);
  return {
    type: 'function',
    function: {
      name: affordance.id,
      description: `${affordance.label}. Effects: ${effectsStr}.`,
      parameters: AFFORDANCE_TOOL_PARAMETERS,
    },
  };
}

/**
 * Convenience function that maps an array of `Affordance` objects to an array
 * of `ToolDefinition` objects (spec 019, Req 2). Returns an empty array for
 * empty input.
 */
export function affordancesToToolDefinitions(affordances: Affordance[]): ToolDefinition[] {
  return affordances.map((a) => affordanceToToolDefinition(a));
}

/** Tool definition for the Plan phase (spec 011, Req 3). */
export const formulatePlanTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'formulate_plan',
    description: "Create a plan to satisfy the agent's drives",
    parameters: formulatePlanSchema,
  },
};

/**
 * Tool definition for the Execute/Perceive phase (spec 011, Req 3).
 *
 * @deprecated Superseded by per-affordance tool definitions (spec 019).
 * Affordances are now registered as individual tools whose `name` IS the
 * affordance ID. This constant remains exported for backward compatibility
 * during the transition — it is no longer used by any builder.
 */
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

/**
 * JSON schema for the `multi_agent_plans` tool arguments (spec 022, Req 6).
 * The LLM returns one entry per agent, each with its own plan description and
 * steps, so a single batched call can formulate plans for multiple agents
 * sharing a room.
 */
export const multiAgentPlansSchema = {
  type: 'object',
  properties: {
    plans: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'The agent this plan is for.' },
          description: { type: 'string', description: 'High-level description of the plan.' },
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
        required: ['agentId', 'description', 'steps'],
        additionalProperties: false,
      },
    },
  },
  required: ['plans'],
  additionalProperties: false,
} as const;

/** Tool definition for the multi-agent batch Plan phase (spec 022, Req 6). */
export const multiAgentPlansTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'multi_agent_plans',
    description:
      'Formulate a plan for each agent in the shared room. Return one plan entry per agentId.',
    parameters: multiAgentPlansSchema,
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

/** Schema for the talk_to social tool (spec 018, Req 13; spec 033 R3). */
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
    sentiment: {
      type: 'string',
      enum: ['positive', 'neutral', 'negative'],
      description:
        'The sentiment of your message (spec 033). Tagged at write time; a predominantly negative exchange will not build trust. Default: neutral.',
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

/** Tool definition for the talk_to social cognitive tool (spec 018, Req 14; spec 033 R3). */
export const talkToTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'talk_to',
    description:
      'Send a message to another agent in the same room. The message will appear in their next perception tick, join the ongoing conversation thread between you, and open one if none exists. Optionally tag the message sentiment.',
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

// ─── Identity Self-Model Tool (spec 033, R12) ────────────────────────────────

/** Schema for the update_self_model cognitive tool (spec 033, R12). */
export const updateSelfModelSchema = {
  type: 'object',
  properties: {
    addTraits: {
      type: 'array',
      items: { type: 'string' },
      description: 'New traits to adopt (e.g. "patient"). Slow, long-term self-change only.',
    },
    removeTraits: {
      type: 'array',
      items: { type: 'string' },
      description: 'Traits to shed.',
    },
    narrative: {
      type: 'string',
      description: 'An updated first-person self-narrative (replaces the current one).',
    },
    addGoals: {
      type: 'array',
      items: { type: 'string' },
      description: 'New long-term goals / aspirations.',
    },
    removeGoals: {
      type: 'array',
      items: { type: 'string' },
      description: 'Long-term goals to abandon.',
    },
    reason: {
      type: 'string',
      description: 'Why you are changing (recorded in the identity_change audit trail).',
    },
  },
  additionalProperties: false,
} as const;

/** Tool definition for the update_self_model cognitive tool (spec 033, R12). */
export const updateSelfModelTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'update_self_model',
    description:
      'Propose slow, bounded edits to your own identity self-model (traits, self-narrative, long-term goals). Use sparingly — this is a guarded, rate-limited, audited tool for genuine self-change, not for reacting to a single message.',
    parameters: updateSelfModelSchema,
  },
};
