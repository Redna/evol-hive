/**
 * pper/plan-enum-diagnostic — the per-formulation `[plan-enum]` log line
 * (spec 058, R4 — issue #206)
 * ────────────────────────────────────────────────────────────────────────────
 * One `console.log` line per plan formulation at the perceive→plan seam (the
 * spec-049/052 diagnostic home). The value space offered to the LLM is the
 * eligibility-filtered `prunedAffordances` projection; the line carries the
 * agent, room, the enum ids the LLM was offered, and the chosen step
 * `targetAffordance` values. "Was `join`/`contribute`/`leave` in the enum?"
 * becomes mechanically checkable from run logs — the live evidence that the
 * issue-#206 skip storm's fuel is gone.
 *
 * Pure string arithmetic over data the orchestrator already holds; zero LLM
 * calls; no prompt changes (spec 021 KV-cache discipline untouched). Never
 * throws from the builder's perspective (the orchestrator wraps the call —
 * spec 049 discipline). No line is a failure: an empty eligible set renders
 * `enum=[]`, and a failed/absent plan renders `chosen=[none]`.
 */

import type { AgentPlan, PerceptionResult } from '@evol-hive/shared';

/**
 * Emit the per-formulation `[plan-enum]` diagnostic line. Format:
 * `[plan-enum] agent=<id> room=<roomId> enum=[a,b] chosen=[x,wait]`.
 */
export function logPlanEnumDiagnostic(
  agentId: string,
  perception: PerceptionResult,
  plan: AgentPlan | undefined,
): void {
  const enumIds = perception.prunedAffordances.map((a) => a.id);
  const chosen =
    plan !== undefined && plan.steps.length > 0
      ? plan.steps.map((s) => s.targetAffordance ?? '-').join(',')
      : 'none';
  console.log(
    `[plan-enum] agent=${agentId}` +
      ` room=${perception.passive.roomId}` +
      ` enum=[${enumIds.join(',')}]` +
      ` chosen=[${chosen}]`,
  );
}
