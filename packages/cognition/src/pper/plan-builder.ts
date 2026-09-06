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
  affordancesToToolDefinitions,
} from '@evol-hive/shared';
import type { LLMContextPayload, PlanBuilder } from '../index.js';
import { defaultCognitiveTools } from '../tools/index.js';
import { matchDrivesToAffordances, formatPlanDriveHint } from './drive-affordance-matcher.js';

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

    // ── Social context (spec 018, Req 38) ────────────────────────────────────
    const hasAgentsPresent =
      passive.agentsPresent !== undefined && passive.agentsPresent.length > 0;

    // Spec 021, Req 1: The system prompt no longer contains the dynamic
    // `primaryDriveLabel` — it is frozen for a given persona so the KV cache
    // can hit across ticks.
    //
    // Spec 024, Req 7: When agents are present, a conditional social directive
    // is appended to the system prompt. This breaks the KV cache prefix, but
    // only on room-entry events (which already break the cache via the user
    // message's "Agents present: ..." lines).
    let systemPrompt = buildSystemPrompt(persona, hasAgentsPresent);

    // Contextual forcing directive (spec 016, Req 9).
    const hasPlan = guardrailOptions?.hasPlan ?? true;
    const forcingEnabled = guardrailOptions?.forcingEnabled ?? false;
    if (!hasPlan && forcingEnabled) {
      systemPrompt = `${systemPrompt} ${GUARDRAIL_FORCING_DIRECTIVE}`;
    }

    // Spec 021, Req 2: Stable content first (deterministic for a given room +
    // object set), dynamic content last (separated by `---`).
    const stableLines: string[] = [
      `Room: ${passive.roomId}`,
      `Objects: ${objectNames.length > 0 ? objectNames.join(', ') : 'none'}`,
    ];

    if (hasAgentsPresent) {
      const agentsStr = passive
        .agentsPresent!.map((a) => `${a.name} (${a.currentActivity})`)
        .join(', ');
      stableLines.push(`Agents present: ${agentsStr}`);
      stableLines.push(
        'You can call talk_to, observe_agent, help, or ignore directly to interact with other agents.',
      );
    }

    // Relationship context (spec 018, Req 35) — stable for a given room state.
    if (hasAgentsPresent && perceptionResult.relationships !== undefined) {
      for (const agent of passive.agentsPresent!) {
        const rel = perceptionResult.relationships[agent.agentId];
        if (rel !== undefined) {
          stableLines.push(...buildRelationshipContextLines(agent.name, rel));
        }
      }
    }

    // Compound actions in LLM context (spec 018, Req 25) — stable for a given room state.
    if (perceptionResult.compoundActions && perceptionResult.compoundActions.length > 0) {
      const summary = perceptionResult.compoundActions
        .map((ca) => `${ca.label} (${ca.steps.length} steps)`)
        .join(', ');
      stableLines.push(`Multi-step actions available: ${summary}`);
    }

    // Object dependencies in LLM context (spec 018, Req 26) — stable for a given room state.
    if (perceptionResult.objectDependencies && perceptionResult.objectDependencies.length > 0) {
      const summary = perceptionResult.objectDependencies.map((dep) => dep.description).join(', ');
      stableLines.push(`Object dependencies: ${summary}`);
    }

    // ── Dynamic content (changes per tick) ──────────────────────────────────
    const dynamicLines: string[] = [
      `Primary drive: ${primaryDriveLabel}`,
      `Drives: ${driveSummary}`,
    ];

    // Social context messages are dynamic (incoming messages change per tick).
    if (passive.socialContext !== undefined && passive.socialContext.length > 0) {
      for (const msg of passive.socialContext) {
        dynamicLines.push(`Message from ${msg.fromName}: "${msg.content}"`);
      }
    }

    // Social drive prompt hint (spec 018, Req 39; spec 024, Req 4).
    // When agents are present AND social is the primary drive, a stronger
    // imperative hint replaces the original hedging hint (spec 024, Req 4).
    const isSocialPrimary = hasAgentsPresent && primaryDriveLabel.toLowerCase().includes('social');
    if (isSocialPrimary) {
      dynamicLines.push(
        'Your social drive is your most urgent need. Call talk_to or help NOW to interact with another agent in this room. Do not formulate a plan first.',
      );
    }

    // Stronger social directive (spec 024, Req 3): added to the dynamic section
    // whenever agents are present (regardless of primary drive). This is an
    // imperative that counters the system prompt's "You must formulate a plan".
    if (hasAgentsPresent) {
      dynamicLines.push(
        'IMPORTANT: Other agents are present. Call talk_to, observe_agent, help, or ignore directly to interact with them. Do not use formulate_plan for social actions.',
      );
    }

    // Drive→affordance matching hints, imperative form (spec 034, Req 2): the
    // same match as the perception builder (same threshold, same data source —
    // the plan tool list), phrased as an imperative per the spec-024 pattern.
    // Supplements (never replaces) the social directive logic above; social is
    // excluded from matching (spec 018/024 own it). Dynamic section only
    // (KV-cache safety, spec 021); no matching affordance → no hint (Req 4).
    for (const match of matchDrivesToAffordances(passive.drives, prunedAffordances)) {
      dynamicLines.push(formatPlanDriveHint(match));
    }

    // Append system feedback (prior action failures) per §9.2.
    if (passive.systemFeedback !== undefined) {
      dynamicLines.push(`System feedback: ${passive.systemFeedback}`);
    }

    // Append stuck directive when no physical actions are available (spec 008, Req 5.3, AC-16).
    if (perceptionResult.stuck === true) {
      dynamicLines.push(
        '\n\nWARNING: No physical actions are available in this room. You may need to move or use a cognitive tool.',
      );
    }

    const contextLines = [...stableLines, '---', ...dynamicLines];

    // Affordance tools are included so the LLM sees exact affordance IDs as tool
    // names when formulating a plan (spec 019, Req 8).
    const affordanceTools = affordancesToToolDefinitions(prunedAffordances);

    return {
      systemPrompt,
      perceptionContext: contextLines.join('\n'),
      availableAffordances: prunedAffordances,
      cognitiveTools: defaultCognitiveTools,
      tools: buildPlanTools(hasAgentsPresent, affordanceTools, isSocialPrimary),
    };
  }
}

function buildSystemPrompt(
  persona: AgentProfile | null | undefined,
  hasAgentsPresent = false,
): string {
  // Spec 021, Req 1: No dynamic primaryDriveLabel — the system prompt is fully
  // stable for a given persona so the KV cache prefix can hit.
  //
  // Spec 024, Req 7: When `hasAgentsPresent` is true, a conditional social
  // directive is appended after the "You must formulate a plan" sentence,
  // creating a conditional override. When false/undefined, the prompt is
  // byte-identical to the pre-spec-024 implementation (KV cache preserved).
  const socialDirective =
    'When other agents are present and your social drive is urgent, call talk_to, observe_agent, help, or ignore directly — do not use formulate_plan for social actions.';
  if (persona) {
    const personaText = formatPersona(persona);
    const base = [
      `You are ${persona.name}, ${personaText}.`,
      'You must formulate a plan to satisfy your most urgent drive.',
      'Use the formulate_plan cognitive tool to break your goal into a sequence of actionable steps.',
      'EVERY step in your plan MUST set targetAffordance to one of the affordance IDs available to you. ' +
        'Steps without targetAffordance are discarded — you cannot act by describing intentions alone.',
      'Each step should map to an available affordance when possible.',
    ].join(' ');
    return hasAgentsPresent ? `${base} ${socialDirective}` : base;
  }
  const base = [
    'You are an autonomous NPC in a deterministic simulation.',
    'You must formulate a plan to satisfy your most urgent drive.',
    'Use the formulate_plan cognitive tool to break your goal into a sequence of actionable steps.',
    'EVERY step in your plan MUST set targetAffordance to one of the affordance IDs available to you. ' +
      'Steps without targetAffordance are discarded — you cannot act by describing intentions alone.',
    'Each step should map to an available affordance when possible.',
  ].join(' ');
  return hasAgentsPresent ? `${base} ${socialDirective}` : base;
}

function formatDrives(drives: Record<string, number>): string {
  // Spec 021, Req 3: Round drive values to the nearest integer in the user
  // message so the KV cache prefix is stable across ticks. Internal state and
  // engine computations continue to use full-precision floats.
  return Object.entries(drives)
    .map(([name, value]) => `${name}=${Math.round(value)}`)
    .join(', ');
}

/**
 * Build tool definitions for the Plan phase, including social tools when agents are present
 * (spec 018, Req 38).
 */
function buildPlanTools(
  hasAgentsPresent: boolean,
  affordanceTools: import('@evol-hive/shared').ToolDefinition[] = [],
  isSocialPrimary = false,
) {
  // Spec 024, Req 1 & Req 2: When agents are present, social tools are placed
  // FIRST in the tools array to leverage the positional bias of smaller LLMs
  // toward first-listed tools. When social is the primary drive, `formulate_plan`
  // is demoted to the very end of the array (after all other tools) to make it
  // the least likely choice.
  if (!hasAgentsPresent) {
    return [formulatePlanTool, queryMemoryTool, updateInternalStateTool, ...affordanceTools];
  }
  const socialTools = [talkToTool, observeAgentTool, helpTool, ignoreTool];
  if (isSocialPrimary) {
    // Req 2: social first, cognitive + affordance next, formulate_plan LAST.
    return [
      ...socialTools,
      queryMemoryTool,
      updateInternalStateTool,
      ...affordanceTools,
      formulatePlanTool,
    ];
  }
  // Req 1: social first, then formulate_plan, cognitive, affordance.
  return [
    ...socialTools,
    formulatePlanTool,
    queryMemoryTool,
    updateInternalStateTool,
    ...affordanceTools,
  ];
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
