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

import type { AgentProfile, PerceptionResult, Relationship } from '@evol-hive/shared';
import {
  formulatePlanTool,
  queryMemoryTool,
  updateInternalStateTool,
  talkToTool,
  observeAgentTool,
  helpTool,
  ignoreTool,
  formatPersona,
  GUARDRAIL_FORCING_DIRECTIVE,
} from '@evol-hive/shared';
import type { LLMContextPayload, PlanBuilder } from '../index.js';
import { defaultCognitiveTools } from '../tools/index.js';

/** Options for contextual forcing in the Plan builder (spec 016, Req 9). */
export interface PlanBuilderGuardrailOptions {
  /** Whether the agent has an active plan. */
  hasPlan?: boolean;
  /** Whether contextual forcing is enabled. */
  forcingEnabled?: boolean;
}

/** Concrete PlanBuilder producing the LLM context payload for plan formulation. */
export class PlanBuilderImpl implements PlanBuilder {
  build(
    perceptionResult: PerceptionResult,
    guardrailOptions?: PlanBuilderGuardrailOptions,
  ): LLMContextPayload {
    const { passive, prunedAffordances, primaryDriveLabel, persona } = perceptionResult;
    const objectNames = passive.objectsPresent.map((o) => o.name);
    const driveSummary = formatDrives(passive.drives);

    let systemPrompt = buildSystemPrompt(persona, primaryDriveLabel);

    // Contextual forcing directive (spec 016, Req 9).
    const hasPlan = guardrailOptions?.hasPlan ?? true;
    const forcingEnabled = guardrailOptions?.forcingEnabled ?? false;
    if (!hasPlan && forcingEnabled) {
      systemPrompt = `${systemPrompt} ${GUARDRAIL_FORCING_DIRECTIVE}`;
    }

    const contextLines = [
      `Room: ${passive.roomId}`,
      `Objects: ${objectNames.length > 0 ? objectNames.join(', ') : 'none'}`,
      `Primary drive: ${primaryDriveLabel}`,
      `Drives: ${driveSummary}`,
    ];

    // ── Social context (spec 018, Req 38) ────────────────────────────────────
    const hasAgentsPresent =
      passive.agentsPresent !== undefined && passive.agentsPresent.length > 0;

    if (hasAgentsPresent) {
      const agentsStr = passive
        .agentsPresent!.map((a) => `${a.name} (${a.currentActivity})`)
        .join(', ');
      contextLines.push(`Agents present: ${agentsStr}`);
    }

    if (passive.socialContext !== undefined && passive.socialContext.length > 0) {
      for (const msg of passive.socialContext) {
        contextLines.push(`Message from ${msg.fromName}: "${msg.content}"`);
      }
    }

    // Relationship context (spec 018, Req 35).
    if (hasAgentsPresent && perceptionResult.relationships !== undefined) {
      for (const agent of passive.agentsPresent!) {
        const rel = perceptionResult.relationships[agent.agentId];
        if (rel !== undefined) {
          contextLines.push(...buildRelationshipContextLines(agent.name, rel));
        }
      }
    }

    // Social drive prompt hint (spec 018, Req 39).
    if (hasAgentsPresent && primaryDriveLabel.toLowerCase().includes('social')) {
      contextLines.push(
        'You feel a strong need for social interaction. Consider using talk_to or help to engage with other agents in the room.',
      );
    }

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

    // Compound actions in LLM context (spec 018, Req 25).
    if (perceptionResult.compoundActions && perceptionResult.compoundActions.length > 0) {
      const summary = perceptionResult.compoundActions
        .map((ca) => `${ca.label} (${ca.steps.length} steps)`)
        .join(', ');
      contextLines.push(`Multi-step actions available: ${summary}`);
    }

    // Object dependencies in LLM context (spec 018, Req 26).
    if (perceptionResult.objectDependencies && perceptionResult.objectDependencies.length > 0) {
      const summary = perceptionResult.objectDependencies.map((dep) => dep.description).join(', ');
      contextLines.push(`Object dependencies: ${summary}`);
    }

    return {
      systemPrompt,
      perceptionContext: contextLines.join('\n'),
      availableAffordances: prunedAffordances,
      cognitiveTools: defaultCognitiveTools,
      tools: buildPlanTools(hasAgentsPresent),
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

/**
 * Build tool definitions for the Plan phase, including social tools when agents are present
 * (spec 018, Req 38).
 */
function buildPlanTools(hasAgentsPresent: boolean) {
  const base = [formulatePlanTool, queryMemoryTool, updateInternalStateTool];
  if (hasAgentsPresent) {
    return [...base, talkToTool, observeAgentTool, helpTool, ignoreTool];
  }
  return base;
}

/**
 * Build relationship context lines from trust and familiarity values
 * (spec 018, Req 35).
 */
function buildRelationshipContextLines(name: string, rel: Relationship): string[] {
  const lines: string[] = [];
  const { trust, familiarity } = rel;

  if (trust > 70) {
    lines.push(`You trust ${name} deeply`);
  } else if (trust >= 55) {
    lines.push(`You know ${name} well and trust them`);
  } else if (trust > 45) {
    lines.push(`You are neutral about ${name}`);
  } else if (trust >= 30) {
    lines.push(`You distrust ${name}`);
  } else {
    lines.push(`You deeply distrust ${name}`);
  }

  if (familiarity > 60) {
    lines.push(`You know ${name} very well`);
  } else if (familiarity >= 30) {
    lines.push(`You know ${name} somewhat`);
  } else {
    lines.push(`You barely know ${name}`);
  }

  return lines;
}

export {};
