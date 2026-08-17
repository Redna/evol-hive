/**
 * tools/ — Cognitive tool registry & execution
 * ──────────────────────────────────────────
 * Section 8: Intrinsic cognitive tools the LLM may invoke instead of a
 * physical affordance. This module provides the default tool catalog surfaced
 * to the LLM via the perception context payload.
 */

import type { CognitiveTool, ToolDefinition } from '@evol-hive/shared';

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
        query: { type: 'string', description: 'The recall query.' },
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
