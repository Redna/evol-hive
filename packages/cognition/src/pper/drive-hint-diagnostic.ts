/**
 * pper/drive-hint-diagnostic — the per-cycle `[drive-hint]` log line
 * (spec 052, R1 — issue #183)
 * ────────────────────────────────────────────────────────────────────────────
 * One `console.log` line per cycle whenever any hintable drive
 * (`HINTABLE_DRIVES`) is below `DRIVE_URGENCY_THRESHOLD`, emitted at the
 * perceive→plan seam in the orchestrator — the established home of console
 * diagnostics (`[social-urge]`, `[talk-enum]`, `[plan-failed]`). The line
 * makes the drive-hint diagnosis auditable from run logs — the exact gap
 * spec 049 closed for social urges, extended to drives: "the restorer was
 * pruned away" becomes distinguishable from "the hint rendered and the LLM
 * chose wait".
 *
 * The line carries:
 * - agent id, room id, the primary drive label (the classifier's pruning
 *   query);
 * - the pruning funnel: affordances in room → after pruning → after masking
 *   (counts + the final enum IDs the builders saw);
 * - per urgent drive: value, whether a perception/plan drive hint rendered,
 *   and the restoring-affordance IDs that exist IN THE ROOM but were dropped
 *   by pruning (the "rendered vs pruned-away" distinction);
 * - the plan's `targetAffordance` choices after the plan phase completes —
 *   "rendered but not chosen" vs "not rendered" vs "not present" is
 *   mechanically distinguishable from logs alone (AC-6).
 *
 * Pure bookkeeping over data the orchestrator already holds (perception
 * result, drive snapshot, plan) — the only provider read is the room's
 * affordance list (same precedence as the perceive path: visible → available
 * → plain), needed for the funnel's first stage. Tick arithmetic and strings
 * only; zero LLM calls; no prompt changes (spec 021 KV-cache discipline
 * untouched); never throws from the builder's perspective (the orchestrator
 * wraps the call — spec 049 discipline).
 */

import type {
  Affordance,
  PerceptionDataProvider,
  PerceptionResult,
  AgentPlan,
} from '@evol-hive/shared';
import {
  DRIVE_URGENCY_THRESHOLD,
  HINTABLE_DRIVES,
  matchDrivesToAffordances,
} from './drive-affordance-matcher.js';

/**
 * Emit the per-cycle `[drive-hint]` diagnostic line (R1). Returns without
 * logging when no hintable drive is below the urgency threshold — "nothing
 * urgent" is not a diagnosable drive situation (AC-3: no line when all
 * hintable drives ≥ 40). `plan` is the stored plan when the plan phase
 * succeeded (the chosen targetAffordance side); when it failed, `undefined`
 * renders `chosen=[none]` so a guard rejection is visible as
 * `[plan-failed] … critical drive …` + `chosen=[none]` on the same cycle.
 */
export function logDriveHintDiagnostic(
  agentId: string,
  perception: PerceptionResult,
  provider: PerceptionDataProvider | undefined,
  plan: AgentPlan | undefined,
): void {
  const drives = perception.passive.drives;
  const urgent = HINTABLE_DRIVES.filter((drive) => {
    const value = drives[drive];
    return value !== undefined && value < DRIVE_URGENCY_THRESHOLD;
  });
  if (urgent.length === 0) return;

  // Funnel stage 1 — the affordances in the room, read with the same
  // precedence the perceive path used (visible → available → room). Legacy
  // providers may not expose any of these beyond the required room read; a
  // failure here degrades the count to `unknown` instead of throwing.
  let roomAffordances: Affordance[] | undefined;
  try {
    if (provider !== undefined) {
      const roomId = perception.passive.roomId;
      roomAffordances =
        typeof provider.getVisibleAffordancesInRoom === 'function'
          ? provider.getVisibleAffordancesInRoom(agentId, roomId)
          : typeof provider.getAvailableAffordancesInRoom === 'function'
            ? provider.getAvailableAffordancesInRoom(roomId)
            : provider.getAffordancesInRoom(roomId);
    }
  } catch {
    roomAffordances = undefined;
  }

  // Funnel stages 2 and 3 — the perception result already holds both.
  const pruned = perception.prunedAffordances;
  const masked = perception.maskedAffordances;
  const enumSource = masked ?? pruned;
  const prunedIds = new Set(pruned.map((a) => a.id));

  // Which urgent drives had a drive hint rendered this cycle? The perception
  // builder matches over `maskedAffordances ?? prunedAffordances`, the plan
  // builder over `prunedAffordances` — a hint rendered when the respective
  // matcher found a DIRECT restorer for the drive (chain-only matches render
  // a different line). Union over both sources = one boolean per drive.
  const perceptionHinted = new Set(
    matchDrivesToAffordances(drives, enumSource)
      .filter((m) => m.affordances.length > 0)
      .map((m) => m.drive),
  );
  const planHinted = new Set(
    matchDrivesToAffordances(drives, pruned)
      .filter((m) => m.affordances.length > 0)
      .map((m) => m.drive),
  );

  // Per urgent drive: value, hint flag, and the restorers the room offered
  // that the funnel dropped (in room, restoring, absent from the pruned set).
  const urgentPart = urgent.map((drive) => {
    const rendered = perceptionHinted.has(drive) || planHinted.has(drive);
    const prunedAway = (roomAffordances ?? [])
      .filter((a) => {
        const delta = a.effects?.[drive];
        return delta !== undefined && delta > 0 && !prunedIds.has(a.id);
      })
      .map((a) => a.id);
    return (
      `${drive}=${Math.round(drives[drive]!)}` +
      `|hint=${rendered}` +
      `|prunedAway=[${prunedAway.join(',')}]`
    );
  });

  // The choice side (R3) — the stored plan's targetAffordance values, after
  // the plan phase. A failed plan phase renders `none` (no choices made).
  const chosen =
    plan !== undefined ? plan.steps.map((s) => s.targetAffordance ?? '-').join(',') : 'none';

  console.log(
    `[drive-hint] agent=${agentId}` +
      ` room=${perception.passive.roomId}` +
      ` primary=${perception.primaryDriveLabel}` +
      ` inRoom=${roomAffordances !== undefined ? roomAffordances.length : 'unknown'}` +
      ` afterPrune=${pruned.length}` +
      ` afterMask=${masked !== undefined ? masked.length : pruned.length}` +
      ` enum=[${enumSource.map((a) => a.id).join(',')}]` +
      ` urgent=[${urgentPart.join(', ')}]` +
      ` chosen=[${chosen}]`,
  );
}
