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

import type {
  AgentProfile,
  PerceptionResult,
  Relationship,
  SelfModel,
  SocialUrgeAssessment,
} from '@evol-hive/shared';
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
  SOCIAL_URGE_SURFACE_THRESHOLD,
  SOCIAL_URGE_RECIPROCITY_DECAYED,
  SOCIAL_TALK_CAP,
  isPendingAddressFresh,
} from '@evol-hive/shared';
import type { LLMContextPayload, PerceptionBuilder } from '../index.js';
import { defaultCognitiveTools, cognitiveToolsToToolDefinitions } from '../tools/index.js';
import {
  matchDrivesToAffordances,
  formatPerceptionDriveHint,
  formatPerceptionChainHint,
} from './drive-affordance-matcher.js';

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
      // Spec 046 (R4): agent IDs are rendered alongside display names so the
      // LLM can pass real IDs to talk_to and duplicate display names stay
      // unambiguous. The line remains a pure function of room membership +
      // activity, in the stable (above `---`) section (spec 021 rules).
      const agentsStr = passive
        .agentsPresent!.map((a) => `${a.name} (${a.agentId}) (${a.currentActivity})`)
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

    // Pending-address INFORMATION lines (spec 044, R4a): an agent who owes a
    // reply sees who addressed them and the actual message. Per-agent
    // dynamic state → dynamic section only (spec 021 KV-cache rules). Never
    // a trigger; the LLM keeps the decision (R5).
    //
    // Spec 049 (R3 — issue #167) fresh-address salience: a pending address
    // whose addressing turn is younger than SOCIAL_PENDING_FRESH_TICKS is
    // promoted to the FIRST dynamic line with a `FRESH:` prefix — the line
    // otherwise competes with farming drives in a long context. Still
    // information, never a trigger (spec 044 R5); the promotion is a pure
    // reordering INSIDE the dynamic section (spec 021 discipline untouched).
    // Entries without tick data (legacy providers) or past the freshness
    // window render today's line in today's position.
    if (perceptionResult.pendingAddresses !== undefined) {
      const freshLines: string[] = [];
      const positionedEntries: typeof perceptionResult.pendingAddresses = [];
      for (const pending of perceptionResult.pendingAddresses) {
        if (isPendingAddressFresh(pending)) {
          const freshName = resolvePresentName(passive.agentsPresent, pending.fromAgentId);
          freshLines.push(
            `FRESH: INFORMATION: ${freshName} addressed you, awaiting response: "${pending.content}"`,
          );
        } else {
          positionedEntries.push(pending);
        }
      }
      // Fresh lines render first, ahead of the drive lines (dynamic-section
      // reordering only — nothing above the `---` separator changes).
      if (freshLines.length > 0) dynamicLines.unshift(...freshLines);
      for (const pending of positionedEntries) {
        const name = resolvePresentName(passive.agentsPresent, pending.fromAgentId);
        dynamicLines.push(
          `INFORMATION: ${name} addressed you, awaiting response: "${pending.content}"`,
        );
      }
    }

    // Social urge hint lines (spec 044, R4b): a high urge toward a present
    // agent renders the approach hint; a decayed urge (learned non-responsiveness)
    // renders the let-them-be hint instead. Dynamic section only (spec 021).
    // Spec 047 (R4 — issue #176): a target past the consecutive-unanswered cap
    // (SOCIAL_TALK_CAP) is excluded from the social-urgency hint — per-target;
    // other targets are unaffected (influence, not force).
    if (perceptionResult.socialUrges !== undefined) {
      for (const urge of perceptionResult.socialUrges) {
        const name = resolvePresentName(passive.agentsPresent, urge.targetAgentId);
        if (urge.result.urge >= SOCIAL_URGE_SURFACE_THRESHOLD && !isSocialTalkCapped(urge)) {
          dynamicLines.push(`You feel like talking to ${name}.`);
        } else if (
          urge.sentCount > 0 &&
          urge.result.factors.reciprocityFactor < SOCIAL_URGE_RECIPROCITY_DECAYED
        ) {
          dynamicLines.push(`${name} rarely answers — maybe let them be.`);
        }
      }
    }

    // Spec 047 (R1/R2 — issue #176): when the urge model has computed urges
    // for EVERY present agent and every such urge is reciprocity-decayed
    // (below the surface threshold specifically because of learned
    // non-responsiveness), the social urgency has no outlet here: the 024
    // directive and the 018 social-drive hint are suppressed in favor of the
    // no-outlet line (rendered in the directive's dynamic position below —
    // KV-cache, spec 021). No urges computed → today's behavior (feature-off
    // backward compat); a mixed room keeps the directive.
    const urgesAllDecayed = allPresentUrgesDecayed(
      passive.agentsPresent,
      perceptionResult.socialUrges,
    );

    // Social drive prompt hint (spec 018, Req 39). Spec 047 (R2): governed by
    // the same all-decayed gate as the 024 directive — suppressed when no
    // present target is responsive (the no-outlet line stands in).
    if (
      hasAgentsPresent &&
      primaryDriveLabel.toLowerCase().includes('social') &&
      !urgesAllDecayed
    ) {
      dynamicLines.push(
        'You feel a strong need for social interaction. Consider using talk_to or help to engage with other agents in the room.',
      );
    }

    // Stronger social directive (spec 024, Req 6): added to the dynamic
    // section whenever agents are present. The Perception/Action phase does
    // not include formulate_plan by default, so this directive omits the
    // "do not use formulate_plan" clause and focuses on encouraging direct
    // social tool use.
    // Spec 047 (R1 — issue #176): when the urge toward every present agent is
    // reciprocity-decayed, the imperative is replaced by the no-outlet line —
    // the urgency path finally consults the urge model.
    if (hasAgentsPresent) {
      if (urgesAllDecayed) {
        dynamicLines.push(NO_SOCIAL_OUTLET_LINE);
      } else {
        dynamicLines.push(
          'IMPORTANT: Other agents are present. Call talk_to, observe_agent, help, or ignore directly to interact with them.',
        );
      }
    }

    // Drive→affordance matching hints (spec 034, Req 1): when a drive is below
    // the urgency threshold AND the current perception contains affordances
    // whose declared `effects` positively restore it, suggest them by name.
    // Dynamic section only (KV-cache safety, spec 021). Social is excluded —
    // the spec-018/024 social hints above own that drive. Drives without a
    // restoring affordance here get NO hint (no phantom remedies, Req 4).
    const sourceAffordancesForHints =
      perceptionResult.maskedAffordances ?? perceptionResult.prunedAffordances;
    for (const match of matchDrivesToAffordances(passive.drives, sourceAffordancesForHints)) {
      if (match.affordances.length > 0) {
        dynamicLines.push(formatPerceptionDriveHint(match));
      }
      // Chain-progress hints (spec 048, Req 3): secondary line AFTER the
      // direct-restoration hint for the same drive. Emitted even when the
      // direct list is empty (chain-only match — the hunger-chain stall fix:
      // the mid-chain step surfaces while the gated restorer is invisible).
      if ((match.chainProgress ?? []).length > 0) {
        dynamicLines.push(formatPerceptionChainHint(match));
      }
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

    // talk_to ranking shift (spec 044, R4c / Decision 5): when the urge
    // toward a present agent is at or above the surface threshold, talk_to
    // moves to the front of the tool list (stable order otherwise) — the
    // cheapest deterministic attention shift without new ranking machinery.
    // Spec 047 (R3/R4 — issue #176): the shift fires only when some present
    // target actually requests the promotion (urge surfaced and not past the
    // consecutive-unanswered cap) AND not every present urge is decayed — the
    // social-urgency answer has no outlet in an all-decayed room. talk_to
    // itself is never removed (influence, not force).
    if (talkToPromotionRequested(perceptionResult.socialUrges ?? []) && !urgesAllDecayed) {
      tools = moveTalkToFirst(tools);
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
 * The no-outlet perception line (spec 047, R1/R2 — issue #176): rendered in
 * place of the spec 024 directive (and in place of the spec 018 social-drive
 * hint's urgency) when the urge toward every present agent is reciprocity-
 * decayed. Dynamic section only (KV-cache, spec 021).
 */
export const NO_SOCIAL_OUTLET_LINE =
  'No one in the room is responsive — consider another activity or help.';

/**
 * One urge assessment is reciprocity-decayed (spec 047, R1 gate unit):
 * at least one message sent and the reciprocity factor below the spec 044
 * decayed threshold — i.e. the urge is low specifically because of learned
 * non-responsiveness, not because the pair is fresh.
 */
export function isSocialUrgeDecayed(assessment: SocialUrgeAssessment): boolean {
  return (
    assessment.sentCount > 0 &&
    assessment.result.factors.reciprocityFactor < SOCIAL_URGE_RECIPROCITY_DECAYED
  );
}

/**
 * One (agent, target) pair is past the consecutive-unanswered cap (spec 047,
 * R4 / AC-5): `sentCount − receivedCount ≥ SOCIAL_TALK_CAP` for that
 * relationship — the same counters the urge model consumes (single source of
 * truth, no second reciprocity computation).
 */
export function isSocialTalkCapped(assessment: SocialUrgeAssessment): boolean {
  return assessment.sentCount - assessment.receivedCount >= SOCIAL_TALK_CAP;
}

/**
 * The rendered-line classification of one urge assessment (spec 049, R1 —
 * issue #167): exactly what the perception-builder rendered for that target,
 * as one of `surfaced` (the approach hint), `decayed-hint` (the
 * let-them-be hint — including when a capped target still renders it),
 * `capped` (urge at/above the surface threshold but excluded by the spec 047
 * SOCIAL_TALK_CAP — nothing rendered), or `none` (nothing rendered, no
 * pending diagnosis). Pure mirror of the builder's hint branch order —
 * consumed by the orchestrator's `[social-urge]` diagnostic so run logs
 * carry the same classification the LLM context actually showed.
 */
export function classifySocialUrgeLine(
  assessment: SocialUrgeAssessment,
): 'surfaced' | 'decayed-hint' | 'capped' | 'none' {
  if (assessment.result.urge >= SOCIAL_URGE_SURFACE_THRESHOLD && !isSocialTalkCapped(assessment)) {
    return 'surfaced';
  }
  if (isSocialUrgeDecayed(assessment)) return 'decayed-hint';
  if (assessment.result.urge >= SOCIAL_URGE_SURFACE_THRESHOLD && isSocialTalkCapped(assessment)) {
    return 'capped';
  }
  return 'none';
}

/**
 * The full R1 gate (spec 047, R1): agents are present AND the urge model has
 * computed an assessment for EVERY present agent AND every such urge is
 * reciprocity-decayed. `undefined` assessments (feature unwired, legacy
 * providers, perceptive failure) or partial coverage → false — the directive
 * and hint render exactly as before (feature-off backward compat).
 */
export function allPresentUrgesDecayed(
  agentsPresent: import('@evol-hive/shared').AgentSummary[] | undefined,
  assessments: SocialUrgeAssessment[] | undefined,
): boolean {
  if (agentsPresent === undefined || agentsPresent.length === 0) return false;
  if (assessments === undefined || assessments.length === 0) return false;
  return agentsPresent.every((agent) => {
    const assessment = assessments.find((u) => u.targetAgentId === agent.agentId);
    return assessment !== undefined && isSocialUrgeDecayed(assessment);
  });
}

/**
 * Whether any present target requests the spec 044 `talk_to` promotion
 * (Decision 5), under the spec 047 R4 cap: urge at/above the surface
 * threshold AND the pair not past the consecutive-unanswered cap. Pure —
 * the all-decayed room gate (R3) is applied by the caller.
 */
export function talkToPromotionRequested(assessments: SocialUrgeAssessment[]): boolean {
  return assessments.some(
    (u) => u.result.urge >= SOCIAL_URGE_SURFACE_THRESHOLD && !isSocialTalkCapped(u),
  );
}

/**
 * Resolve a present agent's display name by ID; falls back to the raw ID
 * when the addressee is not co-present (the line still renders — the reply
 * is owed regardless of the addresser's current room).
 */
function resolvePresentName(
  agentsPresent: import('@evol-hive/shared').AgentSummary[] | undefined,
  agentId: string,
): string {
  return agentsPresent?.find((a) => a.agentId === agentId)?.name ?? agentId;
}

/**
 * Move the `talk_to` tool definition to the front of the list, preserving
 * the relative order of everything else (stable — spec 044 Decision 5). A
 * no-op when talk_to is absent (no agents present).
 */
function moveTalkToFirst(tools: LLMContextPayload['tools']): LLMContextPayload['tools'] {
  const index = tools.findIndex((t) => t.function.name === 'talk_to');
  if (index <= 0) return tools;
  const talkTo = tools[index]!;
  return [talkTo, ...tools.slice(0, index), ...tools.slice(index + 1)];
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
