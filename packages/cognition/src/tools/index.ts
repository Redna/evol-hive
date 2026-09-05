/**
 * tools/ — Cognitive tool registry & execution
 * ──────────────────────────────────────────
 * Section 8: Intrinsic cognitive tools the LLM may invoke instead of a
 * physical affordance. This module provides the default tool catalog surfaced
 * to the LLM via the perception context payload.
 */

import type { CognitiveTool, ToolDefinition } from '@evol-hive/shared';

export {
  CognitiveToolExecutorImpl,
  type CognitiveToolExecutorOptions,
} from './cognitive-tool-executor.js';

/** The default cognitive tools available to every agent (Section 8). */
export const defaultCognitiveTools: CognitiveTool[] = [
  {
    name: 'formulate_plan',
    description: 'Break the current goal into a sequence of actionable steps.',
    argsSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal to plan toward.' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_memory',
    description: 'Actively recall relevant memories for the current situation.',
    argsSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query for active recall.' },
        topK: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Maximum number of memories to retrieve (default: 5).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_internal_state',
    description: 'Update the agent goal or drive overrides.',
    argsSchema: {
      type: 'object',
      properties: {
        newGoal: { type: ['string', 'null'] },
        driveOverrides: { type: 'object', additionalProperties: { type: 'number' } },
      },
      additionalProperties: false,
    },
  },
  // Identity self-model tool (spec 033, R12).
  {
    name: 'update_self_model',
    description:
      'Propose slow, bounded edits to your own identity self-model (traits, self-narrative, long-term goals). Use sparingly — guarded, rate-limited, audited; not for reacting to a single message.',
    argsSchema: {
      type: 'object',
      properties: {
        addTraits: { type: 'array', items: { type: 'string' } },
        removeTraits: { type: 'array', items: { type: 'string' } },
        narrative: { type: 'string' },
        addGoals: { type: 'array', items: { type: 'string' } },
        removeGoals: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string', description: 'Why you are changing (audit trail).' },
      },
      additionalProperties: false,
    },
  },
  // ── Social cognitive tools (spec 018, Req 15) ────────────────────────────
  {
    name: 'talk_to',
    description:
      'Send a message to another agent in the same room. The message will appear in their next perception tick.',
    argsSchema: {
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
    },
  },
  {
    name: 'observe_agent',
    description:
      'Observe another agent in the same room. Returns their current activity, drives, and state.',
    argsSchema: {
      type: 'object',
      properties: {
        targetAgentId: {
          type: 'string',
          description: 'The ID of the agent to observe.',
        },
      },
      required: ['targetAgentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'help',
    description:
      'Help another agent in the same room. Boosts their primary drive and your social drive.',
    argsSchema: {
      type: 'object',
      properties: {
        targetAgentId: {
          type: 'string',
          description: 'The ID of the agent to help.',
        },
      },
      required: ['targetAgentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'ignore',
    description: 'Choose to ignore another agent in the same room. Signals social disengagement.',
    argsSchema: {
      type: 'object',
      properties: {
        targetAgentId: {
          type: 'string',
          description: 'The ID of the agent to ignore.',
        },
      },
      required: ['targetAgentId'],
      additionalProperties: false,
    },
  },
  // ── Dynamic world tool (spec 030, Req 13) ───────────────────────────────
  {
    name: 'modify_scene',
    description:
      'Propose a structural change to the world (add/remove/move an object, spawn/despawn an agent, or change a room connection). Proposals are validated by the engine; invalid proposals are rejected with an actionable error so you can self-correct. Rate limited per PPER cycle.',
    argsSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: [
            'add_object',
            'remove_object',
            'move_object',
            'spawn_agent',
            'despawn_agent',
            'set_connection_state',
          ],
          description: 'The mutation operation to propose.',
        },
        object: {
          type: 'object',
          description:
            'For add_object: the SmartObject to add ({ id, name, type, state, affordances, roomId }).',
        },
        objectId: {
          type: 'string',
          description: 'For remove_object/move_object: the ID of the object.',
        },
        toRoomId: {
          type: 'string',
          description: 'For move_object: the destination room ID.',
        },
        profile: {
          type: 'object',
          description:
            'For spawn_agent: the AgentProfile { id, name, description, traits, initialDrives, startRoomId? }.',
        },
        dormantAgentId: {
          type: 'string',
          description:
            'For spawn_agent: re-spawn a dormant agent by ID instead of a fresh profile.',
        },
        agentId: {
          type: 'string',
          description: 'For despawn_agent: the ID of the agent to despawn.',
        },
        roomA: {
          type: 'string',
          description: 'For set_connection_state: one endpoint room ID.',
        },
        roomB: {
          type: 'string',
          description: 'For set_connection_state: the other endpoint room ID.',
        },
        action: {
          type: 'string',
          enum: ['open', 'close', 'insert', 'remove'],
          description: 'For set_connection_state: the connection action.',
        },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
];

/**
 * Converts `CognitiveTool[]` to `ToolDefinition[]` (spec 011, Req 21).
 * Each `CognitiveTool`'s `argsSchema` becomes the tool's `parameters`.
 */
export function cognitiveToolsToToolDefinitions(tools: CognitiveTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.argsSchema,
    },
  }));
}

export {};
