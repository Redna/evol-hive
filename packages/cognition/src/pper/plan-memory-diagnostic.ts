/**
 * pper/plan-memory-diagnostic — the per-formulation `[plan-memory]` log line
 * (spec 056 follow-up — issue #201)
 * ────────────────────────────────────────────────────────────────────────────
 * The spec-055 plan-memory line (`Your last plan was "…" — …`) lives in the
 * PLAN PROMPT, and the prompt is never logged — so "did plan memory render?"
 * was unanswerable from run logs (the #201 "0 renders" reading was a
 * measurement artifact, not a signal). This diagnostic makes the render
 * observable: ONE `console.error` (stderr) line whenever the plan service
 * builds a payload that carries a `lastPlanOutcome` — i.e. exactly when the
 * builder will push the last-plan line.
 *
 * Spec-049 discipline: zero LLM calls, pure string arithmetic, one line per
 * formulation (never per cycle — the stickiness short-circuit returns before
 * the payload is built, so continuations emit nothing), and the caller wraps
 * the call so a logging failure can never break a cycle.
 *
 * The verdict vocabulary mirrors the builder's rendering exactly:
 * `superseded` (spec 056) / `skipped` (spec 057) / `succeeded` / `failed`
 * (spec 055) — including the empty-`steps` fallback the builder applies, so a
 * `0 of 0` skip line is never fabricated.
 */

import type { LastPlanOutcome } from '@evol-hive/shared';

/**
 * The rendered verdict of a last-plan outcome — the builder's own vocabulary.
 *
 * `skipped` (spec 057 addendum): a plan that reached its end by advancing past
 * failed steps drops the success/failure word in the prompt, so the diagnostic
 * must too — `verdict=succeeded skipped=2` reads as exactly the unqualified
 * success the spec repaired. Precedence mirrors `plan-builder.ts` exactly:
 * supersession (spec 056) > skipped (spec 057) > succeeded / failed (spec 055).
 */
export function planMemoryVerdict(
  outcome: LastPlanOutcome,
): 'superseded' | 'skipped' | 'succeeded' | 'failed' {
  if (outcome.superseded === true) return 'superseded';
  if ((outcome.stepsSkipped ?? 0) > 0 && outcome.steps.length > 0) return 'skipped';
  return outcome.success ? 'succeeded' : 'failed';
}

/**
 * The one-line diagnostic (pure — tests assert on the exact string):
 * `[plan-memory] agent=<id> verdict=<v> steps=<N>/<M> reflected=<bool>`
 *
 * `steps` carries `N/M` only for superseded outcomes (the only verdict with a
 * step count, spec 056 Req 1); completion/failure stamps render `steps=-`.
 */
export function planMemoryDiagnosticLine(agentId: string, outcome: LastPlanOutcome): string {
  const verdict = planMemoryVerdict(outcome);
  const steps =
    outcome.superseded === true ? `${outcome.stepsCompleted ?? 0}/${outcome.stepsTotal ?? 0}` : '-';
  // Spec 057 (R5 — issue #204): the per-plan skip total is exposed only when
  // stamped, so pre-spec-056 lines stay byte-identical and `grep 'skipped='`
  // is a direct live signal for skip frequency.
  const skipped = outcome.stepsSkipped !== undefined ? ` skipped=${outcome.stepsSkipped}` : '';
  return (
    `[plan-memory] agent=${agentId} verdict=${verdict} ` +
    `steps=${steps}${skipped} reflected=${outcome.reflected === true}`
  );
}

/**
 * Emit the diagnostic when — and only when — a last-plan line will be
 * rendered. `undefined` (cycle 1, legacy saves) emits nothing: the builder
 * pushes no line, so there is nothing to report.
 */
export function logPlanMemory(agentId: string, outcome: LastPlanOutcome | undefined): void {
  if (outcome === undefined) return;
  console.error(planMemoryDiagnosticLine(agentId, outcome));
}
