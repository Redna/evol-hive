/**
 * pper/plan-builder — LLM context payload construction for the Plan phase
 * ─────────────────────────────────────────────────────────────────────
 * Section 6.2 / §7 / §8.1: Transforms a PerceptionResult into the
 * LLMContextPayload sent to the heavy LLM during plan formulation. Uses
 * tool calling (spec 011) — sends `formulatePlanTool`.
 *
 * Persona injection (spec 012, Req 8): When `perceptionResult.persona` is
 * present and non-null, the system prompt starts with the persona text.
 */

import type { AgentProfile, PerceptionResult } from '@evol-hive/shared';
import { formulatePlanTool, formatPersona } from '@evol-hive/shared';
import type { LLMContextPayload, PlanBuilder } from '../index.js';
import { defaultCognitiveTools } from '../tools/index.js';

/** Concrete PlanBuilder producing the LLM context payload for plan formulation. */
export class PlanBuilderImpl implements PlanBuilder {
  build(perceptionResult: PerceptionResult): LLMContextPayload {
    const { passive, prunedAffordances, primaryDriveLabel, persona } = perceptionResult;
    const objectNames = passive.objectsPresent.map((o) => o.name);
    const driveSummary = formatDrives(passive.drives);

    const systemPrompt = buildSystemPrompt(persona, primaryDriveLabel);

    const contextLines = [
      `Room: ${passive.roomId}`,
      `Objects: ${objectNames.length > 0 ? objectNames.join(', ') : 'none'}`,
      `Primary drive: ${primaryDriveLabel}`,
      `Drives: ${driveSummary}`,
    ];

    // Append system feedback (prior action failures) per §9.2.
    if (passive.systemFeedback !== undefined) {
      contextLines.push(`System feedback: ${passive.systemFeedback}`);
    }

    // Append stuck directive when no physical actions are available (spec 008, Req 5.3, AC-16).
    if (perceptionResult.stuck === true) {
      contextLines.push(
        '\n\nWARNING: No physical actions are available in this room. You may need to move or use a cognitive tool.',
      );
    }

    return {
      systemPrompt,
      perceptionContext: contextLines.join('\n'),
      availableAffordances: prunedAffordances,
      cognitiveTools: defaultCognitiveTools,
      tools: [formulatePlanTool],
    };
  }
}

function buildSystemPrompt(
  persona: AgentProfile | null | undefined,
  primaryDriveLabel: string,
): string {
  if (persona) {
    const personaText = formatPersona(persona);
    return [
      `You are ${persona.name}, ${personaText}.`,
      'You must formulate a plan to satisfy your most urgent drive.',
      `Your primary drive is: ${primaryDriveLabel}.`,
      'Use the formulate_plan cognitive tool to break your goal into a sequence of actionable steps.',
      'Each step should map to an available affordance when possible.',
    ].join(' ');
  }
  return [
    'You are an autonomous NPC in a deterministic simulation.',
    'You must formulate a plan to satisfy your most urgent drive.',
    `Your primary drive is: ${primaryDriveLabel}.`,
    'Use the formulate_plan cognitive tool to break your goal into a sequence of actionable steps.',
    'Each step should map to an available affordance when possible.',
  ].join(' ');
}

function formatDrives(drives: Record<string, number>): string {
  return Object.entries(drives)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ');
}

export {};
