/**
 * guardrails/wait-guard — critical-drive wait suppression (spec 052, Req 3 —
 * issue #183)
 * ────────────────────────────────────────────────────────────────────────────
 * A plan-level guardrail check (§10 mechanism family, spec 016 pattern):
 * when (a) a hintable drive is below the critical threshold
 * (`DRIVE_CRITICAL_THRESHOLD`, default 10) and (b) a directly-restoring
 * affordance for that drive is present in the current post-prune enum, a plan
 * whose steps' `targetAffordance` values are ALL `wait` is rejected with an
 * actionable reason. The existing plan-failure recovery path re-prompts; the
 * strengthened imperative hint (`formatPlanDriveHint`'s "Call such an
 * affordance NOW") already tells the LLM what to do.
 *
 * `wait` stays in the enum — mid-chain agents legitimately wait for ripening
 * states (spec 034's gated `eat`); only total passivity under a critical,
 * directly-restorable drive is rejected. No phantom forcing: when the enum
 * carries no direct restorer for the starving drive, an all-wait plan passes
 * (the LLM's free-form search remains the fallback for unsatisfiable drives).
 *
 * The `social` drive never triggers the guard — social restoration is owned
 * by the spec-018/024/047 cognitive-tool path, not the affordance enum.
 *
 * Gated by the `GuardrailConfig.waitSuppression` flag (default `true`): only
 * an explicit `false` disables the guard. The check is pure and synchronous —
 * no LLM calls, no engine access.
 */

import type { Affordance, FormulatePlanResult } from '@evol-hive/shared';
import { WAIT_AFFORDANCE } from '@evol-hive/shared';
import { HINTABLE_DRIVES } from '../pper/drive-affordance-matcher.js';

/**
 * Critical threshold on the 0–100 drive scale (spec 052, Req 3): a hintable
 * drive below this value is starving. Env-overridable via
 * `DRIVE_CRITICAL_THRESHOLD` (default 10).
 */
export const DRIVE_CRITICAL_THRESHOLD = Number(process.env['DRIVE_CRITICAL_THRESHOLD'] ?? 10);

/** Verdict of the critical-drive wait guard (spec 052, Req 3). */
export interface WaitGuardVerdict {
  /** True when the plan must not be stored. */
  rejected: boolean;
  /** Actionable rejection reason — names the drive and the available restorer. */
  reason?: string;
}

/**
 * Plan-level wait-guard check (spec 052, Req 3). Pure and synchronous over
 * (drives, post-prune enum, plan).
 *
 * - Rejected only when the plan is non-empty and EVERY step targets `wait`,
 *   a hintable drive is strictly below {@link DRIVE_CRITICAL_THRESHOLD}, and
 *   a directly-restoring affordance for that drive (declared `effects` with a
 *   strictly positive entry — spec 034 Req 3's source of truth) is present in
 *   the enum.
 * - `waitSuppression === false` disables the guard entirely (an omitted flag
 *   keeps the spec's default: enabled).
 * - Chain-progress declarations do NOT count as direct restoration (a
 *   mid-chain step cannot be forced as an immediate remedy — no phantom
 *   forcing).
 */
export function checkWaitSuppression(
  drives: Record<string, number>,
  availableAffordances: readonly Affordance[],
  plan: FormulatePlanResult,
  waitSuppression?: boolean,
): WaitGuardVerdict {
  if (waitSuppression === false) return { rejected: false };

  // Only TOTAL passivity is rejected: every step targets the wait escape. A
  // step that ALSO carries a targetArea binding is a navigation step (spec
  // 039, R1) — movement toward (potential) restoration, never passive — so it
  // breaks the all-wait pattern exactly like a physical affordance would.
  const allWait =
    plan.steps.length > 0 &&
    plan.steps.every(
      (s) =>
        s.targetAffordance === WAIT_AFFORDANCE &&
        (s.targetArea === undefined || s.targetArea.length === 0),
    );
  if (!allWait) return { rejected: false };

  for (const drive of HINTABLE_DRIVES) {
    const value = drives[drive];
    if (value === undefined || !(value < DRIVE_CRITICAL_THRESHOLD)) continue;

    const restorer = availableAffordances.find((a) => {
      const delta = a.effects?.[drive];
      return delta !== undefined && delta > 0;
    });
    if (restorer !== undefined) {
      return {
        rejected: true,
        reason: `critical drive ${drive} is starving and "${restorer.id}" is available — plan a restoring step`,
      };
    }
  }
  return { rejected: false };
}