/**
 * pper/perception-builder — LLM context payload construction
 * ──────────────────────────────────────────────────────────
 * Section 6.1 / §7: Transforms a PerceptionResult into the LLMContextPayload
 * sent to the heavy LLM in the Plan phase. The perception context stays compact
 * (room name, object names, drive summary) — affordance labels/descriptions go
 * into `availableAffordances`, not the context string.
 */

import type { PerceptionResult } from '@evol-hive/shared';
import { llmActionResponseSchema, JSON_INSTRUCTION_SUFFIX } from '@evol-hive/shared';
import type { LLMContextPayload, PerceptionBuilder } from '../index.js';
import { defaultCognitiveTools } from '../tools/index.js';

const SYSTEM_PROMPT =
  [
    'You are an autonomous NPC in a deterministic simulation.',
    'You perceive your surroundings passively and choose one action per tick.',
    'Choose an affordance or a cognitive tool. Reason briefly before acting.',
  ].join(' ') +
  '\n\n' +
  JSON_INSTRUCTION_SUFFIX;

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

    return {
      systemPrompt: SYSTEM_PROMPT,
      perceptionContext,
      availableAffordances: prunedAffordances,
      cognitiveTools: defaultCognitiveTools,
      responseSchema: llmActionResponseSchema,
    };
  }
}

function formatDrives(drives: Record<string, number>): string {
  return Object.entries(drives)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ');
}

export {};
