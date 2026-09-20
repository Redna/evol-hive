/**
 * pper/plan-builder — LLM context payload construction for the Plan phase
 * ─────────────────────────────────────────────────────────────────────
 * Section 6.2 / §7 / §8.1: Transforms a PerceptionResult into the
 * LLMContextPayload sent to the heavy LLM during plan formulation. Uses
 * tool calling (spec 011) — sends `formulatePlanTool`.
 *
 * Persona injection (spec 012, Req 8): When `perceptionResult.persona` is
 * present and non-null, the system prompt starts with the persona text.
 *
 * Spec 061 (R2, issue #219): the perception context is assembled as an ordered
 * `PlanContextBlock[]` and bounded by `budgetPlanContext` to the headroom left
 * by the constant prefix. `systemPrompt` and `tools` are computed first and are
 * never budgeted, reordered, truncated or regenerated — the `formulate_plan`
 * enum is plan legality (spec 037/058) and the stable prefix is spec 021. Under
 * budget the assembled context is byte-identical to the pre-change builder.
 */

import type { AgentProfile, PerceptionResult, Relationship } from '@evol-hive/shared';
import {
  formulatePlanToolFor,
  queryMemoryTool,
  updateInternalStateTool,
  talkToToolFor,
  observeAgentTool,
  helpTool,
  ignoreTool,
  formatPersona,
  GUARDRAIL_FORCING_DIRECTIVE,
  affordancesToToolDefinitions,
} from '@evol-hive/shared';
import type { LLMContextPayload, PlanBuilder } from '../index.js';
import { defaultCognitiveTools } from '../tools/index.js';
import { computeTalkEnum } from './talk-enum.js';
import {
  matchDrivesToAffordances,
  formatPlanDriveHint,
  formatPlanChainHint,
} from './drive-affordance-matcher.js';
import type { PlanContextBlock } from './plan-context-budget.js';
import {
  budgetPlanContext,
  capRecallBlocks,
  planPromptMaxChars,
  planRecallMaxChars,
  planRecallMaxLines,
} from './plan-context-budget.js';
import type { PlanContextDiagnostic } from './plan-shape-diagnostic.js';

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

    // Social drive prompt hint (spec 018, Req 39; spec 024, Req 4).
    // When agents are present AND social is the primary drive, a stronger
    // imperative hint replaces the original hedging hint (spec 024, Req 4).
    const isSocialPrimary = hasAgentsPresent && primaryDriveLabel.toLowerCase().includes('social');

    // Spec 039, R1: known areas feed both the `targetArea` enum and the
    // `Known areas` context line; they are read once so both agree.
    const { knownAreas, unexploredAreas } = perceptionResult;

    // ── Constant prefix: never budgeted, reordered, truncated or regenerated ─
    // (spec 061, R2; the tool enum is plan legality — spec 037/058).
    const affordanceTools = affordancesToToolDefinitions(prunedAffordances);
    const planTool = formulatePlanToolFor(
      prunedAffordances.map((a) => a.id),
      knownAreas,
    );
    const tools = buildPlanTools(
      hasAgentsPresent,
      affordanceTools,
      isSocialPrimary,
      planTool,
      // Spec 051 (R1/R2): the plan-phase talk_to is enum-bound per cycle to
      // the present, uncapped agent IDs — same construction as the
      // perception builder; omitted entirely when nothing is valid.
      computeTalkEnum(passive.agentsPresent, perceptionResult.socialUrges).valid,
    );

    // ── Ordered context blocks (spec 061, R2) ─────────────────────────────────
    // Spec 021, Req 2: Stable content first (deterministic for a given room +
    // object set), dynamic content last (separated by `---`). The `---`
    // separator is a required block in the stream (spec 061, R2).
    const blocks: PlanContextBlock[] = [
      { id: 'room', text: `Room: ${passive.roomId}`, required: true },
      {
        id: 'objects',
        text: `Objects: ${objectNames.length > 0 ? objectNames.join(', ') : 'none'}`,
        required: true,
      },
    ];

    if (hasAgentsPresent) {
      // Spec 046 (R4): agent IDs rendered alongside display names (see
      // perception-builder) so plan-phase tool calls can target real IDs.
      const agentsStr = passive
        .agentsPresent!.map((a) => `${a.name} (${a.agentId}) (${a.currentActivity})`)
        .join(', ');
      blocks.push({
        id: 'agents-present',
        text: [
          `Agents present: ${agentsStr}`,
          'You can call talk_to, observe_agent, help, or ignore directly to interact with other agents.',
        ].join('\n'),
      });
    }

    // Relationship context (spec 018, Req 35) — stable for a given room state.
    if (hasAgentsPresent && perceptionResult.relationships !== undefined) {
      const relationshipLines: string[] = [];
      for (const agent of passive.agentsPresent!) {
        const rel = perceptionResult.relationships[agent.agentId];
        if (rel !== undefined) {
          relationshipLines.push(...buildRelationshipContextLines(agent.name, rel));
        }
      }
      if (relationshipLines.length > 0) {
        blocks.push({ id: 'relationships', text: relationshipLines.join('\n') });
      }
    }

    // Compound actions in LLM context (spec 018, Req 25) — stable for a given room state.
    if (perceptionResult.compoundActions && perceptionResult.compoundActions.length > 0) {
      const summary = perceptionResult.compoundActions
        .map((ca) => `${ca.label} (${ca.steps.length} steps)`)
        .join(', ');
      blocks.push({ id: 'compound-actions', text: `Multi-step actions available: ${summary}` });
    }

    // Object dependencies in LLM context (spec 018, Req 26) — stable for a given room state.
    if (perceptionResult.objectDependencies && perceptionResult.objectDependencies.length > 0) {
      const summary = perceptionResult.objectDependencies.map((dep) => dep.description).join(', ');
      blocks.push({ id: 'object-dependencies', text: `Object dependencies: ${summary}` });
    }

    // ── Dynamic content (changes per tick) ──────────────────────────────────
    blocks.push({ id: 'separator', text: '---', required: true });
    blocks.push({
      id: 'primary-drive',
      text: `Primary drive: ${primaryDriveLabel}`,
      required: true,
    });
    blocks.push({ id: 'drives', text: `Drives: ${driveSummary}`, required: true });

    // Plan memory (spec 055, Req 4 — issue #198): the agent's last plan + its
    // outcome — the self-visibility defense against the #191 356× identical
    // -plan signature. Dynamic section only (spec 021 KV-cache discipline);
    // absent record → no lines (never fabricate history on cycle 1).
    if (perceptionResult.lastPlanOutcome !== undefined) {
      const outcome = perceptionResult.lastPlanOutcome;
      const stepList = outcome.steps.join(', ');
      const deltas = formatDriveDeltas(outcome.driveChanges);
      // Spec 056 (Req 3 — issue #201): a superseded outcome renders the
      // abandonment verdict — the engine stamped the plan as replaced
      // mid-flight. stepsCompleted/stepsTotal are only read when superseded
      // (they are always stamped together, Req 1); outcomes without
      // `superseded` render exactly as before (spec 055).
      // Spec 057 (R4 — issue #204): a plan that reached its end by advancing
      // past failed steps (the spec-037 guard) drops the success/failure word —
      // an unqualified "it succeeded" is the lie being repaired — and reports
      // the skip count. An empty step list falls back to the spec-055 verdict
      // so a `0 of 0` line is never fabricated.
      const skipCount = outcome.stepsSkipped ?? 0;
      const skipped = skipCount > 0 && outcome.steps.length > 0;
      const verdict = outcome.superseded
        ? `superseded after ${outcome.stepsCompleted ?? 0} of ${outcome.stepsTotal ?? 0} steps${deltas}`
        : skipped
          ? `${skipCount} of ${outcome.steps.length} steps were skipped${deltas}`
          : outcome.success
            ? `it succeeded${deltas}`
            : `it failed${deltas}`;
      blocks.push({ id: 'last-plan', text: `Your last plan was "${stepList}" — ${verdict}.` });
      if (outcome.reflected) {
        blocks.push({
          id: 'last-plan-reflection',
          text: 'You already reflected on that plan — what you learned is in your memory.',
        });
      }
    }

    // Social context messages are dynamic (incoming messages change per tick).
    if (passive.socialContext !== undefined && passive.socialContext.length > 0) {
      blocks.push({
        id: 'social-messages',
        text: passive.socialContext
          .map((msg) => `Message from ${msg.fromName}: "${msg.content}"`)
          .join('\n'),
      });
    }

    if (isSocialPrimary) {
      blocks.push({
        id: 'social-primary-hint',
        text: 'Your social drive is your most urgent need. Make interacting with another agent in this room the FIRST step of your plan (targetAffordance: talk_to or help).',
        required: true,
      });
    }

    // Stronger social directive (spec 024, Req 3; issue #212): added to the
    // dynamic section whenever agents are present. The wording is PLAN-shaped
    // on purpose — the plan phase accepts only a `formulate_plan` call, so an
    // imperative to "call talk_to directly / do not use formulate_plan" is a
    // contradiction the model obeys and the phase then scores as a malformed
    // plan. Measured: that contradiction was 1,002/1,446 (69%) of a run's
    // `[plan-invalid]` lines.
    if (hasAgentsPresent) {
      blocks.push({
        id: 'social-directive',
        text: 'IMPORTANT: Other agents are present. If you want to interact with them, make it a plan step whose targetAffordance is talk_to, observe_agent, help, or ignore.',
        required: true,
      });
    }

    // Drive→affordance matching hints, imperative form (spec 034, Req 2): the
    // same match as the perception builder (same threshold, same data source —
    // the plan tool list), phrased as an imperative per the spec-024 pattern.
    // Supplements (never replaces) the social directive logic above; social is
    // excluded from matching (spec 018/024 own it). Dynamic section only
    // (KV-cache safety, spec 021); no matching affordance → no hint (Req 4).
    const driveHintLines: string[] = [];
    for (const match of matchDrivesToAffordances(passive.drives, prunedAffordances)) {
      if (match.affordances.length > 0) {
        driveHintLines.push(formatPlanDriveHint(match));
      }
      // Chain-progress hints (spec 048, Req 3): imperative secondary line
      // AFTER the direct-restoration imperative for the same drive; emitted
      // for chain-only matches too (the gated-restorer case).
      if ((match.chainProgress ?? []).length > 0) {
        driveHintLines.push(formatPlanChainHint(match));
      }
    }
    if (driveHintLines.length > 0) {
      blocks.push({ id: 'drive-hints', text: driveHintLines.join('\n'), required: true });
    }

    // Known-map summary + unknown markers (spec 039, R1/R4). DYNAMIC section
    // only — the spec-021 stable prefix stays byte-identical. Known areas are
    // the exact targetArea enum values; unexplored-but-known doors/areas are
    // rendered as explicit markers ("a door to 'workshop' — unexplored") so
    // the LLM can plan exploration without perceiving the unknown side.
    if (knownAreas !== undefined && knownAreas.length > 0) {
      blocks.push({ id: 'known-areas', text: `Known areas: ${knownAreas.join(', ')}` });
      blocks.push({
        id: 'known-areas-directive',
        text: 'Set targetArea on a step to navigate to a known area first — the engine walks you there and the affordance executes on arrival.',
      });
    }
    if (unexploredAreas !== undefined) {
      const unexploredLines = unexploredAreas.map((area) => `a door to '${area}' — unexplored`);
      if (unexploredLines.length > 0) {
        blocks.push({ id: 'unexplored-areas', text: unexploredLines.join('\n') });
      }
    }

    // Hours-horizon directive (spec 055, Req 5 — issue #198): plans may chain
    // several steps and connect to what the agent intends over the coming
    // hours. Horizon FRAMING, not a forced schedule — the LLM keeps the
    // decision. Dynamic section only (spec 021).
    blocks.push({
      id: 'horizon',
      text: 'Horizon: your plan may chain several steps toward what you intend over the coming hours — e.g. a morning of watering, harvesting and trading, an afternoon of rest and talk. This is framing, not a schedule: the choice stays yours.',
    });

    // Append system feedback (prior action failures) per §9.2.
    if (passive.systemFeedback !== undefined) {
      blocks.push({
        id: 'system-feedback',
        text: [
          `System feedback: ${passive.systemFeedback}`,
          // Spec 038 (replan quality): a bare failure report does not stop the
          // model from planning the identical action again (observed live:
          // 108 failed plant_seeds re-plannings against a full planter). Make
          // the anti-repeat instruction explicit, referencing the failure text.
          'IMPORTANT: Do NOT plan an action that just failed. Choose a DIFFERENT affordance — ' +
            'for example, if the planter is full, plan harvest or eat instead of planting more seeds; ' +
            'if a resource is exhausted, look for another object or move to another room.',
        ].join('\n'),
        required: true,
      });
    }

    // Append stuck directive when no physical actions are available (spec 008, Req 5.3, AC-16).
    if (perceptionResult.stuck === true) {
      blocks.push({
        id: 'stuck-warning',
        text: '\n\nWARNING: No physical actions are available in this room. You may need to move or use a cognitive tool.',
        required: true,
      });
    }

    // Spec 061 (R3, defensive): cap any reserved recall block with the
    // env-derived caps, preserving the provider's ranked order. No recall
    // block is rendered today (`associativeMemories` wiring is Deferred), so
    // this is inert until a future wiring adds one.
    const cappedBlocks = capRecallBlocks(blocks, planRecallMaxLines(), planRecallMaxChars());

    // Spec 061 (R2): `headroom` is what remains of the ceiling after the
    // constant prefix. `budgetPlanContext` bounds only the perception context.
    const headroom = planPromptMaxChars() - systemPrompt.length - JSON.stringify(tools).length;
    const budgetedContext = budgetPlanContext(cappedBlocks, Math.max(0, headroom));

    // Spec 061 (R4): attach the budget breakdown so the client can emit
    // `[plan-context]` alongside `[plan-prompt]`. `top` names the largest
    // surviving block (the grower) from logs alone; `budget` is the ceiling
    // applied, `orig`/`kept` are the pre-/post-budget context chars.
    const droppedSet = new Set(budgetedContext.droppedBlockIds);
    let topBlockId = 'none';
    let topBlockChars = 0;
    for (const block of cappedBlocks) {
      if (!droppedSet.has(block.id) && block.text.length > topBlockChars) {
        topBlockId = block.id;
        topBlockChars = block.text.length;
      }
    }
    const planContextDiagnostic: PlanContextDiagnostic = {
      originalChars: budgetedContext.originalChars,
      budgetChars: Math.max(0, headroom),
      keptChars: budgetedContext.chars,
      droppedBlockIds: budgetedContext.droppedBlockIds,
      ...(budgetedContext.truncatedBlockId !== undefined
        ? { truncatedBlockId: budgetedContext.truncatedBlockId }
        : {}),
      topBlockId,
      topBlockChars,
    };

    return {
      systemPrompt,
      perceptionContext: budgetedContext.perceptionContext,
      availableAffordances: prunedAffordances,
      cognitiveTools: defaultCognitiveTools,
      // Spec 039, R1: the known-area value space rides with the payload so
      // the plan validator can enforce area-bound steps.
      ...(knownAreas !== undefined ? { knownAreas } : {}),
      tools,
      planContextDiagnostic,
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
    'When other agents are present and your social drive is urgent, make the social action the first step of your plan (targetAffordance: talk_to, observe_agent, help, or ignore).';
  if (persona) {
    const personaText = formatPersona(persona);
    // Spec 055, Req 5 (issue #198): the Aspirations line renders immediately
    // after the persona text. The system prompt is already stable per persona
    // (spec 021, Req 1) and goals are persona-stable, so the KV-cache prefix
    // still hits per persona — the stable line is persona-adjacent by
    // construction. Agents without goals render byte-identical prompts.
    const aspirationsLine =
      persona.longTermGoals !== undefined && persona.longTermGoals.length > 0
        ? ` Aspirations: ${persona.longTermGoals.join('; ')}.`
        : '';
    const base = [
      `You are ${persona.name}, ${personaText}.${aspirationsLine}`,
      'You must formulate a plan to satisfy your most urgent drive.',
      'Use the formulate_plan cognitive tool to break your goal into a sequence of actionable steps.',
      'EVERY step in your plan MUST set targetAffordance to one of the enum values in the formulate_plan tool schema (the affordances available to you right now). ' +
        'Use "wait" when no affordance is relevant. Steps without a valid targetAffordance are rejected — you cannot act by describing intentions alone.',
      'Each step should map to an available affordance when possible.',
    ].join(' ');
    return hasAgentsPresent ? `${base} ${socialDirective}` : base;
  }
  const base = [
    'You are an autonomous NPC in a deterministic simulation.',
    'You must formulate a plan to satisfy your most urgent drive.',
    'Use the formulate_plan cognitive tool to break your goal into a sequence of actionable steps.',
    'EVERY step in your plan MUST set targetAffordance to one of the enum values in the formulate_plan tool schema (the affordances available to you right now). ' +
      'Use "wait" when no affordance is relevant. Steps without a valid targetAffordance are rejected — you cannot act by describing intentions alone.',
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
 * Render drive deltas for the last-plan line (spec 055, Req 4): explicit
 * signs, `curiosity +10, comfort +5` — or the empty string when the outcome
 * carried no deltas.
 */
function formatDriveDeltas(driveChanges: Record<string, number> | undefined): string {
  if (driveChanges === undefined) return '';
  const entries = Object.entries(driveChanges);
  if (entries.length === 0) return '';
  const rendered = entries
    .map(([name, value]) => `${name} ${value >= 0 ? '+' : ''}${value}`)
    .join(', ');
  return ` (${rendered})`;
}

/**
 * Build tool definitions for the Plan phase, including social tools when agents are present
 * (spec 018, Req 38).
 *
 * Spec 051 (R1/R2 — issue #186): `talk_to` is enum-bound per cycle — built
 * from the per-cycle valid-target list (present, uncapped agent IDs) via
 * `talkToToolFor`; the tool is omitted when nothing is valid, while
 * observe_agent/help/ignore render as today.
 */
function buildPlanTools(
  hasAgentsPresent: boolean,
  affordanceTools: import('@evol-hive/shared').ToolDefinition[] = [],
  isSocialPrimary = false,
  /** Spec 037: the per-cycle enum-bound formulate_plan tool. */
  planTool: import('@evol-hive/shared').ToolDefinition = formulatePlanToolFor([]),
  /** Spec 051: per-cycle valid talk_to targets (empty → talk_to omitted). */
  talkValidTargets: string[] = [],
) {
  // Spec 024, Req 1 & Req 2: When agents are present, social tools are placed
  // FIRST in the tools array to leverage the positional bias of smaller LLMs
  // toward first-listed tools. When social is the primary drive, `formulate_plan`
  // is demoted to the very end of the array (after all other tools) to make it
  // the least likely choice.
  if (!hasAgentsPresent) {
    return [planTool, queryMemoryTool, updateInternalStateTool, ...affordanceTools];
  }
  const talkTool = talkValidTargets.length > 0 ? [talkToToolFor(talkValidTargets)] : [];
  const socialTools = [...talkTool, observeAgentTool, helpTool, ignoreTool];
  if (isSocialPrimary) {
    // Req 2: social first, cognitive + affordance next, formulate_plan LAST.
    return [...socialTools, queryMemoryTool, updateInternalStateTool, ...affordanceTools, planTool];
  }
  // Req 1: social first, then formulate_plan, cognitive, affordance.
  return [...socialTools, planTool, queryMemoryTool, updateInternalStateTool, ...affordanceTools];
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
