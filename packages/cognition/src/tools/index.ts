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
