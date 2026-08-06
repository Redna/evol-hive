/**
 * pper/plan-builder — LLM context payload construction for plan formulation
 * ──────────────────────────────────────────────────────────────────────────
 * Section 6 (Plan) / §7 / §8.1: Transforms a PerceptionResult into an
 * LLMContextPayload specifically for the Plan phase. Uses formulatePlanSchema
 * as the responseSchema (NOT llmActionResponseSchema). The system prompt
 * instructs the LLM to formulate a plan using the formulate_plan cognitive tool.
 *
 * The perception context stays compact (room name, object names, drive summary)
 * — it reuses the same compact object names from PerceptionResult.passive.
 * Deep SmartObject.state is never included (§6.1, Req 17).
 */

import type { PerceptionResult } from '@evol-hive/shared';
import { formulatePlanSchema } from '@evol-hive/shared';
import type { LLMContextPayload, PlanBuilder } from '../index.js';
import { defaultCognitiveTools } from '../tools/index.js';

const PLAN_SYSTEM_PROMPT = [
  'You are an autonomous NPC in a deterministic simulation.',
  'You must formulate a plan to satisfy your most urgent drive.',
  'Use the formulate_plan cognitive tool to break down your goal into actionable steps.',
  'Each step should have a description and optionally reference a target affordance.',
  'Do not execute actions — only plan.',
].join(' ');

/** Concrete PlanBuilder producing the LLM context payload for plan formulation. */
export class PlanBuilderImpl implements PlanBuilder {
  build(perceptionResult: PerceptionResult): LLMContextPayload {
    const { passive, prunedAffordances, primaryDriveLabel } = perceptionResult;
    const objectNames = passive.objectsPresent.map((o) => o.name);
    const driveSummary = formatDrives(passive.drives);

    const contextLines = [
      `Room: ${passive.roomId}`,
      `Objects: ${objectNames.length > 0 ? objectNames.join(', ') : 'none'}`,
      `Primary drive: ${primaryDriveLabel}`,
      `Drives: ${driveSummary}`,
    ];

    // Append system feedback when present so the LLM is aware of prior action failures (§9.2).
    if (passive.systemFeedback !== undefined) {
      contextLines.push(`System feedback: ${passive.systemFeedback}`);
    }

    return {
      systemPrompt: PLAN_SYSTEM_PROMPT,
      perceptionContext: contextLines.join('\n'),
      availableAffordances: prunedAffordances,
      cognitiveTools: defaultCognitiveTools,
      responseSchema: formulatePlanSchema,
    };
  }
}

function formatDrives(drives: Record<string, number>): string {
  return Object.entries(drives)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ');
}

export {};
