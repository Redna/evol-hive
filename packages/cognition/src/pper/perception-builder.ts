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

import type { AgentProfile, PerceptionResult, Relationship, SelfModel } from '@evol-hive/shared';
import {
  queryMemoryTool,
  updateInternalStateTool,
  talkToTool,
  observeAgentTool,
  helpTool,
  ignoreTool,
  formatPersona,
  selfModelToPromptText,
  GUARDRAIL_FORCING_DIRECTIVE,
  affordancesToToolDefinitions,
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
    const { passive, primaryDriveLabel, persona } = perceptionResult;
    const objectNames = passive.objectsPresent.map((o) => o.name);
    const driveSummary = formatDrives(passive.drives);

    // Spec 021, Req 2: Stable content first (deterministic for a given room +
    // object set), dynamic content last (separated by `---`).
    const stableLines: string[] = [];

    // Persona context lines (spec 012, Req 7, Req 16).
    if (persona) {
      stableLines.push(`Name: ${persona.name}`);
      if (persona.behavioralTendencies !== undefined && persona.behavioralTendencies.length > 0) {
        stableLines.push(`Tendencies: ${persona.behavioralTendencies.join(', ')}`);
      }
    }

    stableLines.push(
      `Room: ${passive.roomId}`,
      `Objects: ${objectNames.length > 0 ? objectNames.join(', ') : 'none'}`,
    );

    // ── Social context (spec 018, Req 34) ────────────────────────────────────
    const hasAgentsPresent =
      passive.agentsPresent !== undefined && passive.agentsPresent.length > 0;

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

    // Social drive prompt hint (spec 018, Req 39).
    if (hasAgentsPresent && primaryDriveLabel.toLowerCase().includes('social')) {
      dynamicLines.push(
        'You feel a strong need for social interaction. Consider using talk_to or help to engage with other agents in the room.',
      );
    }

    // Stronger social directive (spec 024, Req 6): added to the dynamic
    // section whenever agents are present. The Perception/Action phase does
    // not include formulate_plan by default, so this directive omits the
    // "do not use formulate_plan" clause and focuses on encouraging direct
    // social tool use.
    if (hasAgentsPresent) {
      dynamicLines.push(
        'IMPORTANT: Other agents are present. Call talk_to, observe_agent, help, or ignore directly to interact with them.',
      );
    }

    const contextLines = [...stableLines, '---', ...dynamicLines];

    // Guardrail options (spec 016, Req 10; spec 020, Req 4).
    const hasPlan = guardrailOptions?.hasPlan ?? true;
    const forcingEnabled = guardrailOptions?.forcingEnabled ?? false;
    const maskingEnabled = guardrailOptions?.maskingEnabled ?? false;
    const noPlan = !hasPlan;

    // Build tool definitions: affordance tools + cognitive tools (excluding formulate_plan).
    // Affordances are now registered as individual tools (spec 019) — the LLM
    // calls the affordance tool directly instead of choose_action.
    //
    // Spec 020, Req 4: the Perception/Action-choice builder reads the masked
    // affordances (`maskedAffordances`) — falling back to `prunedAffordances`
    // when no guardrail was applied (no `maskedAffordances` field). The
    // `noPlan && maskingEnabled` check is retained as defense-in-depth: it
    // handles the case where `maskedAffordances` is `undefined` (no guardrail
    // configured) but the builder is invoked with `maskingEnabled: true`.
    const sourceAffordances =
      perceptionResult.maskedAffordances ?? perceptionResult.prunedAffordances;
    // When no plan and masking enabled, hide ALL affordance tools — only cognitive
    // tools remain, and ALL cognitive tools (including formulate_plan) are available so the
    // agent can create a plan (spec 016, Req 10: cognitive tools are never masked).
    const availableAffordances = noPlan && maskingEnabled ? [] : sourceAffordances;
    let tools;
    if (noPlan && maskingEnabled) {
      tools = cognitiveToolsToToolDefinitions(defaultCognitiveTools);
    } else {
      const affordanceTools = affordancesToToolDefinitions(availableAffordances);
      tools = [queryMemoryTool, updateInternalStateTool, ...affordanceTools];
    }

    // Social tools are included only when other agents are present (spec 018,
    // Req 34). Spec 024, Req 5: when agents are present, social tools are
    // placed FIRST in the tools array (before cognitive and affordance tools)
    // to leverage the positional bias of smaller LLMs toward first-listed
    // tools. This applies to both the normal and masked paths.
    if (hasAgentsPresent) {
      tools = [talkToTool, observeAgentTool, helpTool, ignoreTool, ...tools];
    }

    // Phase-aware tool pruning (spec 022, Req 11, AC-10): the formulate_plan
    // tool is only relevant when the agent has no plan. Exclude it
    // defensively when the agent already has an active plan to reduce tool
    // definition tokens. (In the normal `hasPlan` path it is already absent;
    // this guarantees it never leaks into the masked/no-plan-with-plan edge.)
    if (hasPlan) {
      tools = tools.filter((t) => t.function.name !== 'formulate_plan');
    }

    // System prompt: persona-prefixed or generic (spec 012, Req 7). Spec 033
    // (R11/AC-13): when an evolved self-model exists, its narrative/traits/
    // goals are appended AFTER the spawn persona so the LLM sees the live,
    // evolved identity (the profile stays the immutable seed/fallback).
    let systemPrompt = buildSystemPrompt(persona, perceptionResult.selfModel);

    // Contextual forcing directive (spec 016, Req 10).
    if (noPlan && forcingEnabled) {
      systemPrompt = `${systemPrompt} ${GUARDRAIL_FORCING_DIRECTIVE}`;
    }

    return {
      systemPrompt,
      perceptionContext: contextLines.join('\n'),
      availableAffordances,
      cognitiveTools: defaultCognitiveTools,
      tools,
    };
  }
}

function buildSystemPrompt(
  persona: AgentProfile | null | undefined,
  selfModel?: SelfModel,
): string {
  const parts: string[] = [];
  if (persona) {
    const personaText = formatPersona(persona);
    parts.push(`You are ${persona.name}, ${personaText}.`);
  } else {
    parts.push(GENERIC_SYSTEM_PROMPT);
  }
  // Evolved self-model (spec 033, R11/AC-13) — deterministic rendering for a
  // given model (KV-cache friendly, spec 021). Only rendered when present;
  // absent → persona-only prompt (backward compat).
  if (selfModel !== undefined) {
    const text = selfModelToPromptText(selfModel);
    if (text.length > 0) {
      parts.push(`Your self-model (evolved — trust this over the spawn seed): ${text}`);
    }
  }
  parts.push(
    'You perceive your surroundings passively and choose one action per tick.',
    'Choose an affordance or a cognitive tool. Reason briefly before acting.',
  );
  return parts.join(' ');
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
