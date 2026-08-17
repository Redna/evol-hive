/**
 * pper/perception-builder — LLM context payload construction
 * ──────────────────────────────────────────────────────────
 * Section 6.1 / §7: Transforms a PerceptionResult into the LLMContextPayload
 * sent to the heavy LLM in the Execute/Perceive phase. Uses tool calling
 * (spec 011) — sends `chooseActionTool` plus cognitive tool definitions.
 *
 * Persona injection (spec 012, Req 7): When `perceptionResult.persona` is
 * present and non-null, the system prompt is prefixed with the agent's persona
 * text (produced by `formatPersona`) and the perception context includes the
 * agent's name and behavioral tendencies.
 */

import type { AgentProfile, PerceptionResult } from '@evol-hive/shared';
import {
  chooseActionTool,
  formatPersona,
  queryMemoryTool,
  updateInternalStateTool,
} from '@evol-hive/shared';
import type { LLMContextPayload, PerceptionBuilder } from '../index.js';
import { defaultCognitiveTools } from '../tools/index.js';

const GENERIC_SYSTEM_PROMPT = [
  'You are an autonomous NPC in a deterministic simulation.',
  'You perceive your surroundings passively and choose one action per tick.',
  'Choose an affordance or a cognitive tool. Reason briefly before acting.',
].join(' ');

/** Concrete PerceptionBuilder producing the LLM context payload. */
export class PerceptionBuilderImpl implements PerceptionBuilder {
  build(perceptionResult: PerceptionResult): LLMContextPayload {
    const { passive, prunedAffordances, primaryDriveLabel, persona } = perceptionResult;
    const objectNames = passive.objectsPresent.map((o) => o.name);
    const driveSummary = formatDrives(passive.drives);

    const contextLines: string[] = [];

    // Persona context lines (spec 012, Req 7, Req 16).
    if (persona) {
      contextLines.push(`Name: ${persona.name}`);
      if (persona.behavioralTendencies !== undefined && persona.behavioralTendencies.length > 0) {
        contextLines.push(`Tendencies: ${persona.behavioralTendencies.join(', ')}`);
      }
    }

    contextLines.push(
      `Room: ${passive.roomId}`,
      `Objects: ${objectNames.length > 0 ? objectNames.join(', ') : 'none'}`,
      `Primary drive: ${primaryDriveLabel}`,
      `Drives: ${driveSummary}`,
    );

    // Build tool definitions: chooseActionTool + cognitive tools (excluding formulate_plan).
    // Spec 015, Req 19: use dedicated tool constants instead of cognitiveToolsToToolDefinitions.
    const tools = [chooseActionTool, queryMemoryTool, updateInternalStateTool];

    // System prompt: persona-prefixed or generic (spec 012, Req 7).
    const systemPrompt = buildSystemPrompt(persona);

    return {
      systemPrompt,
      perceptionContext: contextLines.join('\n'),
      availableAffordances: prunedAffordances,
      cognitiveTools: defaultCognitiveTools,
      tools,
    };
  }
}

function buildSystemPrompt(persona: AgentProfile | null | undefined): string {
  if (persona) {
    const personaText = formatPersona(persona);
    return [
      `You are ${persona.name}, ${personaText}.`,
      'You perceive your surroundings passively and choose one action per tick.',
      'Choose an affordance or a cognitive tool. Reason briefly before acting.',
    ].join(' ');
  }
  return GENERIC_SYSTEM_PROMPT;
}

function formatDrives(drives: Record<string, number>): string {
  return Object.entries(drives)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ');
}

export {};
