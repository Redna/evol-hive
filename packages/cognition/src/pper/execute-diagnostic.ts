/**
 * pper/execute-diagnostic — the per-cycle `[execute]` log line (issue #206
 * follow-up — the 058 live-run stall)
 * ────────────────────────────────────────────────────────────────────────────
 * The Execute phase is the one PPER seam with SILENT return paths: a
 * completed-but-uncleared plan returns `{success: true, planComplete: true}`
 * with no line, a multi-tick navigation returns `{navigating: true}`, and a
 * first precondition/execution failure returns `{success: false}` without
 * reaching the step-skip guard's `[step-skip]`. A 40-minute live run (issue
 * #206 AC-7) stalled at ~t+3min with 4,365 plan cycles, 34 affordance
 * executions and ZERO lines explaining the gap — the stall was invisible.
 *
 * This diagnostic makes every Execute outcome observable: ONE `console.error`
 * line per `ExecuteService.execute()` call, carrying the plan the engine
 * believed was active (id + step index/total), the step's target, and the
 * outcome kind. Spec-049 discipline: zero LLM calls, pure string arithmetic,
 * and the caller wraps it so a logging failure can never break a cycle.
 */

import type { ExecuteResult } from '@evol-hive/shared';

/** The plan shape the diagnostic reads (structural — no engine dependency). */
export interface ExecuteDiagnosticPlan {
  id: string;
  steps: readonly unknown[];
  currentStepIndex: number;
}

/** The outcome vocabulary — one word per silent path this line exists for. */
export function executeOutcome(result: ExecuteResult): string {
  if (result.error !== undefined && result.error.length > 0) {
    if (result.error === 'No active plan') return 'no-plan';
    // A guardrail deviation (spec 016 R11/12) is its own vocabulary: it is the
    // one failure that neither advances nor skips the step, so a repeating
    // `deviation:` on the same plan/step is the stale-plan livelock signature.
    if (result.deviationRejected === true) return `deviation:${oneLine(result.error, 80)}`;
    return `error:${oneLine(result.error, 80)}`;
  }
  if (result.navigating === true) return 'navigating';
  if (result.planComplete === true) return 'complete';
  if (result.stepSkipped === true) return 'step-skipped';
  return 'step-ok';
}

/**
 * The one-line diagnostic (pure — tests assert on the exact string):
 * `[execute] agent=<id> plan=<id|none> step=<i>/<N> outcome=<kind> skipped=<N|->`
 *
 * `step` is the plan's index AFTER the phase ran (the advance is visible in
 * the line); `skipped` carries the per-plan cumulative total only when the
 * result stamped one (spec 057 — otherwise `-`, so the line stays stable).
 */
export function executeDiagnosticLine(
  agentId: string,
  plan: ExecuteDiagnosticPlan | null,
  result: ExecuteResult,
): string {
  const planId = plan === null ? 'none' : plan.id;
  const step = plan === null ? '-' : `${plan.currentStepIndex + 1}/${plan.steps.length}`;
  const skipped = result.stepsSkipped === undefined ? '-' : String(result.stepsSkipped);
  return (
    `[execute] agent=${agentId} plan=${planId} step=${step} ` +
    `outcome=${executeOutcome(result)} skipped=${skipped}`
  );
}

/**
 * Emit the diagnostic. Never throws (spec 049 / spec 056 discipline): the
 * caller is the Execute phase, and a logging failure must not cost a cycle.
 */
export function logExecuteOutcome(
  agentId: string,
  plan: ExecuteDiagnosticPlan | null,
  result: ExecuteResult,
): void {
  try {
    console.error(executeDiagnosticLine(agentId, plan, result));
  } catch {
    // Diagnostics must never break a cycle.
  }
}

/** Collapse whitespace so one outcome can never split the line. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * pper/reflect-diagnostic — the per-cycle `[reflect]` log line.
 *
 * The Reflect phase is the second silent seam: it clears the active plan only
 * on a SUCCESSFUL reflect (`reflect-service.ts`), so a failing reflect leaves
 * a completed plan uncleared — and the next cycle's Execute returns the silent
 * `planComplete: true`. Without a line per reflect, that loop is invisible in
 * run logs (the 058 stall: no `[plan-memory]`, no `[plan-failed]`, no skips).
 * One line per Reflect call, zero LLM calls, pure strings.
 */
export function reflectDiagnosticLine(
  agentId: string,
  success: boolean,
  error: string | undefined,
  flags: { drivesUpdated?: boolean; memoryStored?: boolean },
): string {
  const outcome = success ? 'ok' : `error:${oneLine(error ?? 'unknown', 80)}`;
  return (
    `[reflect] agent=${agentId} outcome=${outcome} ` +
    `drives=${flags.drivesUpdated === true} memory=${flags.memoryStored === true}`
  );
}

/** Emit the reflect diagnostic. Never throws (spec 049 discipline). */
export function logReflectOutcome(
  agentId: string,
  success: boolean,
  error: string | undefined,
  flags: { drivesUpdated?: boolean; memoryStored?: boolean },
): void {
  try {
    console.error(reflectDiagnosticLine(agentId, success, error, flags));
  } catch {
    // Diagnostics must never break a cycle.
  }
}
