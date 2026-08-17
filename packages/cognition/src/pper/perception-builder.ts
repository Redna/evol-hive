/**
 * pper/perception-builder — LLM context payload construction
 * ──────────────────────────────────────────────────────────
 * Section 6.1 / §7: Transforms a PerceptionResult into the LLMContextPayload
 * sent to the heavy LLM in the Execute/Perceive phase. Uses tool calling
 * (spec 011) — sends `chooseActionTool` plus cognitive tool definitions.
 */

import type { PerceptionResult } from '@evol-hive/shared';
import { chooseActionTool } from '@evol-hive/shared';
import type { LLMContextPayload, PerceptionBuilder } from '../index.js';
import { defaultCognitiveTools, cognitiveToolsToToolDefinitions } from '../tools/index.js';

const SYSTEM_PROMPT = [
  'You are an autonomous NPC in a deterministic simulation.',
  'You perceive your surroundings passively and choose one action per tick.',
  'Choose an affordance or a cognitive tool. Reason briefly before acting.',
].join(' ');

/** Concrete PerceptionBuilder producing the LLM context payload. */
export class PerceptionBuilderImpl implements PerceptionBuilder {
  build(perceptionResult: PerceptionResult): LLMContextPayload {
    const { passive, prunedAffordances, primaryDriveLabel } = perceptionResult;
    const objectNames = passive.objectsPresent.map((o) => o.name);
    const driveSummary = formatDrives(passive.drives);

    const perceptionContext = [
      `Room: ${passive.roomId}`,
      `Objects: ${objectNames.length > 0 ? objectNames.join(', ') : 'none'}`,
      `Primary drive: ${primaryDriveLabel}`,
      `Drives: ${driveSummary}`,
    ].join('\n');

    // Build tool definitions: chooseActionTool + cognitive tools (excluding formulate_plan).
    const cognitiveTools = defaultCognitiveTools.filter((t) => t.name !== 'formulate_plan');
    const tools = [chooseActionTool, ...cognitiveToolsToToolDefinitions(cognitiveTools)];

    return {
      systemPrompt: SYSTEM_PROMPT,
      perceptionContext,
      availableAffordances: prunedAffordances,
      cognitiveTools: defaultCognitiveTools,
      tools,
    };
  }
}

function formatDrives(drives: Record<string, number>): string {
  return Object.entries(drives)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ');
}

export {};
