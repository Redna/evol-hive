/**
 * pper/talk-enum — the per-cycle talk_to value space (spec 051, R1/R2 —
 * issue #186)
 * ────────────────────────────────────────────────────────────────────────────
 * The pure enum construction behind the enum-bound `talk_to` tool: the
 * per-cycle valid-target list is the present agent IDs MINUS any target past
 * the spec 047 consecutive-unanswered cap. A capped target is excluded from
 * the enum — not a valid choice, not merely un-promoted (the root cause of
 * issue #186: the LLM picked `talk_to` from the plain tool list through free
 * choice alone, so attention-level gating was never enough — the value space
 * itself had to close).
 *
 * Reuse, don't duplicate: the exclusion is `isSocialTalkCapped` — the exact
 * cap condition the urge model's `capped` classification already computes
 * (single source, no second cap arithmetic; the shared
 * `isSocialTalkGapCapped` helper carries the arithmetic). Agents present
 * without an assessment (feature off / partial coverage) stay VALID — the
 * feature-off path degrades to "every present agent is talkable", which is
 * the pre-051 free-choice space restricted to perception. Recovery is
 * mechanical (Decision 2): the target's reply raises `receivedCount`, the gap
 * drops below the cap, and the target re-enters the enum on the next cycle.
 *
 * The `[talk-enum]` diagnostic (R4) rides here too: one console line per
 * cycle whenever agents are present — the evidence base for the deferred
 * monologue-reward decision (R5) and for live validation (AC-10). Never
 * throws from the builder's perspective (the orchestrator wraps the call —
 * spec 049 discipline).
 */

import type { AgentSummary, PerceptionResult, SocialUrgeAssessment } from '@evol-hive/shared';
import { isSocialTalkCapped } from './perception-builder.js';

/** The per-cycle talk_to enum outcome (R2) — valid, excluded, and the input echo. */
export interface TalkEnumOutcome {
  /** Every present agent ID (input echo, for the telemetry counts). */
  present: string[];
  /** Present agent IDs that remain valid talk targets this cycle. */
  valid: string[];
  /** Present agent IDs excluded by the unanswered cap this cycle. */
  excluded: string[];
}

/**
 * Compute the per-cycle talk_to enum (R1/R2): present agent IDs minus capped
 * targets. Pure and deterministic over the already-assembled perception data
 * — no LLM calls, no engine access (the engine-side `enumerateTalkTargets`
 * bridge method is the runtime source of truth; this construction is what
 * the LLM sees).
 */
export function computeTalkEnum(
  agentsPresent: AgentSummary[] | undefined,
  assessments: SocialUrgeAssessment[] | undefined,
): TalkEnumOutcome {
  const present = (agentsPresent ?? []).map((a) => a.agentId);
  const valid: string[] = [];
  const excluded: string[] = [];
  for (const agentId of present) {
    const assessment = assessments?.find((u) => u.targetAgentId === agentId);
    if (assessment !== undefined && isSocialTalkCapped(assessment)) {
      excluded.push(agentId);
    } else {
      valid.push(agentId);
    }
  }
  return { present, valid, excluded };
}

/**
 * Emit the per-cycle `[talk-enum]` diagnostic line (R4). Rendered next to the
 * spec 049 `[social-urge]` line at the perceive→plan seam; no agents present
 * → no line (nothing to enumerate). Format:
 * `[talk-enum] agent=<id> present=<n> valid=<n> excluded=[id,id]`.
 */
export function logTalkEnumDiagnostic(agentId: string, perception: PerceptionResult): void {
  const agentsPresent = perception.passive.agentsPresent;
  if (agentsPresent === undefined || agentsPresent.length === 0) return;
  const outcome = computeTalkEnum(agentsPresent, perception.socialUrges);
  console.log(
    `[talk-enum] agent=${agentId}` +
      ` present=${outcome.present.length}` +
      ` valid=${outcome.valid.length}` +
      ` excluded=[${outcome.excluded.join(', ')}]`,
  );
}
