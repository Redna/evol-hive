/**
 * pper/social-urge-diagnostic — the per-cycle `[social-urge]` log line
 * (spec 049, R1 — issue #167)
 * ────────────────────────────────────────────────────────────────────────────
 * One `console.log` line per cycle (whenever the perception includes at least
 * one present agent), emitted at the perceive→plan seam in the orchestrator —
 * the established home of console diagnostics (`[plan-failed]`,
 * `[PPERScheduler]`). The line makes the reply-rate diagnosis auditable from
 * run logs: "the hint never rendered" becomes distinguishable from "the hint
 * rendered and the LLM chose silence".
 *
 * The line carries: agent id, current tick, the derived persona seed, each
 * pending-address entry (conversation id, from-agent, age in ticks, fresh
 * flag per R3), and each per-target urge with its four-factor breakdown
 * (persona, drive, novelty, reciprocity) plus the rendered-line
 * classification (`surfaced` / `decayed-hint` / `capped` / `none`) — exactly
 * what the perception-builder rendered for that target, including spec 047's
 * SOCIAL_TALK_CAP exclusion.
 *
 * Constraints (R1): zero LLM calls, one line, never dumps the full LLM
 * context, never throws (the orchestrator wraps the call — a logging failure
 * can never break a cycle). Pure formatting over the already-assembled
 * `PerceptionResult` — no re-computation, no extra state.
 */

import type { PerceptionResult } from '@evol-hive/shared';
import {
  DEFAULT_SOCIAL_TALKATIVENESS,
  deriveSocialTalkativenessSeed,
  isPendingAddressFresh,
} from '@evol-hive/shared';
import { classifySocialUrgeLine } from './perception-builder.js';

/**
 * Emit the per-cycle `[social-urge]` diagnostic line (R1). Returns without
 * logging when the perception includes no present agents — "no agents" is not
 * a diagnosable social situation (AC-2). Everything else logs, even when
 * nothing renders (classification `none`, `pending=[]`), so absence of output
 * is itself meaningful.
 */
export function logSocialUrgeDiagnostic(
  agentId: string,
  perception: PerceptionResult,
  currentTick: number | undefined,
): void {
  const agentsPresent = perception.passive.agentsPresent;
  if (agentsPresent === undefined || agentsPresent.length === 0) return;

  const personaSeed =
    perception.persona !== undefined && perception.persona !== null
      ? deriveSocialTalkativenessSeed(perception.persona)
      : DEFAULT_SOCIAL_TALKATIVENESS;

  // Pending-address entries: conversation id, from-agent, age in ticks, fresh
  // flag per R3. Entries without tick data (legacy providers) report
  // `age=unknown` and `fresh=false` — auditable as "freshness unknowable".
  const pendingPart = (perception.pendingAddresses ?? []).map((pending) => {
    const age =
      pending.currentTick !== undefined && pending.lastTurnTick !== undefined
        ? String(pending.currentTick - pending.lastTurnTick)
        : 'unknown';
    return `${pending.conversationId}|from=${pending.fromAgentId}|age=${age}|fresh=${isPendingAddressFresh(pending)}`;
  });

  // Per-target urge entries: value, four-factor breakdown, and the
  // rendered-line classification mirroring the perception-builder (R1).
  const urgesPart = (perception.socialUrges ?? []).map((assessment) => {
    const factors = assessment.result.factors;
    return (
      `target=${assessment.targetAgentId}` +
      `|urge=${assessment.result.urge.toFixed(3)}` +
      `|persona=${factors.personaSeed}` +
      `|drive=${factors.socialDriveFactor}` +
      `|novelty=${factors.noveltyFactor}` +
      `|reciprocity=${factors.reciprocityFactor}` +
      `|line=${classifySocialUrgeLine(assessment)}`
    );
  });

  console.log(
    `[social-urge] agent=${agentId}` +
      ` tick=${currentTick ?? 'unknown'}` +
      ` seed=${personaSeed}` +
      ` pending=[${pendingPart.join(', ')}]` +
      ` urges=[${urgesPart.join(', ')}]`,
  );
}