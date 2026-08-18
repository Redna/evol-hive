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
  queryMemoryTool,
  updateInternalStateTool,
  formatPersona,
  GUARDRAIL_FORCING_DIRECTIVE,
} from '@evol-hive/shared';
import type { LLMContextPayload, PerceptionBuilder } from '../index.js';
import { defaultCognitiveTools, cognitiveToolsToToolDefinitions } from '../tools/index.js';

const GENERIC_SYSTEM_PROMPT = [
  'You are an autonomous NPC in a deterministic simulation.',
  'You perceive your surroundings passively and choose one action per tick.',
  'Choose an affordance or a cognitive tool. Reason briefly before acting.',
].join(' ');

/** Options for contextual forcing and affordance masking in the Perception builder (spec 016, Req 10). */
export interface PerceptionBuilderGuardrailOptions {
  /** Whether the agent has an active plan. */
  hasPlan?: boolean;
  /** Whether contextual forcing is enabled. */
  forcingEnabled?: boolean;
  /** Whether affordance masking is enabled. */
  maskingEnabled?: boolean;
}

/** Concrete PerceptionBuilder producing the LLM context payload. */
export class PerceptionBuilderImpl implements PerceptionBuilder {
  build(
    perceptionResult: PerceptionResult,
    guardrailOptions?: PerceptionBuilderGuardrailOptions,
  ): LLMContextPayload {
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

    // Guardrail options (spec 016, Req 10).
    const hasPlan = guardrailOptions?.hasPlan ?? true;
    const forcingEnabled = guardrailOptions?.forcingEnabled ?? false;
    const maskingEnabled = guardrailOptions?.maskingEnabled ?? false;
    const noPlan = !hasPlan;

    // Build tool definitions: chooseActionTool + cognitive tools (excluding formulate_plan).
    // When no plan and masking enabled, hide chooseActionTool — only cognitive tools
    // remain, and ALL cognitive tools (including formulate_plan) are available so the
    // agent can create a plan (spec 016, Req 10: cognitive tools are never masked).
    let tools;
    if (noPlan && maskingEnabled) {
      tools = cognitiveToolsToToolDefinitions(defaultCognitiveTools);
    } else {
      tools = [chooseActionTool, queryMemoryTool, updateInternalStateTool];
    }

    // System prompt: persona-prefixed or generic (spec 012, Req 7).
    let systemPrompt = buildSystemPrompt(persona);

    // Contextual forcing directive (spec 016, Req 10).
    if (noPlan && forcingEnabled) {
      systemPrompt = `${systemPrompt} ${GUARDRAIL_FORCING_DIRECTIVE}`;
    }

    // Affordance masking: set availableAffordances to [] when no plan and masking enabled (Req 10).
    const availableAffordances = noPlan && maskingEnabled ? [] : prunedAffordances;

    return {
      systemPrompt,
      perceptionContext: contextLines.join('\n'),
      availableAffordances,
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
