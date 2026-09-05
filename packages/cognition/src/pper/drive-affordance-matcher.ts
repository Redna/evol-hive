/**
 * pper/drive-affordance-matcher — Drive→Affordance Matching Hints (spec 034)
 * ──────────────────────────────────────────────────────────────────────────
 * Binds urgent drives to the affordances in the current perception whose
 * declared `effects` positively restore them (issue #130). The mapping is
 * computed purely from `Affordance.effects` — there is NO hardcoded
 * drive→tool table (spec 034, Req 3). The matcher is a pure function of
 * (drives, perceived affordances), O(drives × affordances) per PPER cycle,
 * with no caching and no async work.
 *
 * Hint suppression (Req 4 — no phantom remedies): an urgent drive with no
 * restoring affordance in perception produces NO hint; the LLM's free-form
 * search remains the fallback for genuinely unsatisfiable drives.
 *
 * The `social` drive is excluded — the spec-018/024 social-hint system owns
 * it (injecting a second social hint would duplicate their directives).
 *
 * Object attribution: an affordance MAY carry optional `objectId` /
 * `objectName` properties (stamped by scene factories, e.g. the dynamic-world
 * demo). When present they are surfaced in the rendered hints so the LLM can
 * tie an affordance to the object that offers it; when absent the hints
 * degrade gracefully to affordance IDs only.
 */

import type { Affordance } from '@evol-hive/shared';

/**
 * Urgency threshold on the 0–100 drive scale (spec 034, Req 1): a drive below
 * this value is urgent. Single shared constant — both the perception and plan
 * builders import it from here (spec 034, Constraints).
 */
export const DRIVE_URGENCY_THRESHOLD = 40;

/** Maximum affordance mentions rendered per urgent drive (spec 034, Req 1). */
export const MAX_DRIVE_HINT_AFFORDANCES = 3;

/**
 * Drives eligible for drive→affordance hints, in deterministic render order.
 * Matches the `AgentDrives` keys (spec 034, Req 3) minus `social` — the
 * spec-018/024 social-hint system owns that drive.
 */
export const HINTABLE_DRIVES: readonly string[] = ['energy', 'hunger', 'comfort', 'curiosity'];

/**
 * An `Affordance` optionally annotated with its owning object. Scene factories
 * (e.g. the dynamic-world demo's `makeObject`) stamp these fields so the
 * drive→affordance hints can name the object that offers each affordance.
 * Plain affordances without the annotation are matched identically — only the
 * rendered hint text degrades (no object prefix).
 */
export type AttributedAffordance = Affordance & {
  /** Optional ID of the smart object that exposes this affordance. */
  objectId?: string;
  /** Optional display name of the smart object that exposes this affordance. */
  objectName?: string;
};

/** One affordance that restores an urgent drive, with optional object attribution. */
export interface DriveAffordanceRef {
  readonly affordanceId: string;
  readonly objectId?: string;
  readonly objectName?: string;
}

/** The drives→affordances match for a single urgent drive. */
export interface DriveAffordanceMatch {
  /** The drive name — one of the `AgentDrives` keys (never `social`). */
  readonly drive: string;
  /** The drive's current value (unrounded — rendering rounds for display). */
  readonly driveValue: number;
  /** Restoring affordances in perception order, capped at {@link MAX_DRIVE_HINT_AFFORDANCES}. */
  readonly affordances: readonly DriveAffordanceRef[];
}

/**
 * Match urgent drives to the affordances in the current perception that
 * positively restore them (spec 034, Req 1–4). Pure and synchronous.
 *
 * - A drive is urgent when its value is strictly below
 *   {@link DRIVE_URGENCY_THRESHOLD} (half-scale on 0–100).
 * - An affordance restores a drive when its declared `effects` contain a
 *   strictly positive entry for that drive (spec 032's declared-effects
 *   convention — no other source of truth).
 * - The `social` drive never produces a match (spec 018/024 own it).
 * - Drives without a restoring affordance in perception are omitted entirely
 *   (Req 4 — no phantom remedies).
 * - At most {@link MAX_DRIVE_HINT_AFFORDANCES} affordances are reported per
 *   drive, in perception order (the LLM's existing tool order).
 *
 * @param drives      The agent's current drive snapshot (`passive.drives`).
 * @param affordances The affordances in the current perception (the builder's
 *                    tool-list source: `maskedAffordances ?? prunedAffordances`).
 */
export function matchDrivesToAffordances(
  drives: Record<string, number>,
  affordances: readonly Affordance[],
): DriveAffordanceMatch[] {
  const matches: DriveAffordanceMatch[] = [];
  for (const drive of HINTABLE_DRIVES) {
    const value = drives[drive];
    if (value === undefined || !(value < DRIVE_URGENCY_THRESHOLD)) continue;

    const restoring: DriveAffordanceRef[] = [];
    for (const affordance of affordances) {
      if (restoring.length >= MAX_DRIVE_HINT_AFFORDANCES) break;
      // Some legacy Affordance fixtures omit `effects` entirely — treat as no
      // declared impact (spec 034 Req 3: only declared `effects` bind).
      const delta = affordance.effects?.[drive];
      if (delta === undefined || !(delta > 0)) continue;
      const attributed = affordance as AttributedAffordance;
      restoring.push({
        affordanceId: affordance.id,
        ...(attributed.objectId !== undefined ? { objectId: attributed.objectId } : {}),
        ...(attributed.objectName !== undefined ? { objectName: attributed.objectName } : {}),
      });
    }

    if (restoring.length > 0) {
      matches.push({ drive, driveValue: value, affordances: restoring });
    }
  }
  return matches;
}

/**
 * Render the suggestion-form hint line for one urgent drive (Perception
 * builder, spec 034, Req 1):
 *
 *   `Your energy is low (23). Here, you can restore it: garden-bench-1 "sit_outside" (restores energy), garden-bench-1 "relax" (restores energy).`
 *
 * Affordances without object attribution render as `"sit_outside" (restores energy)`.
 * The drive value is rounded to the nearest integer (spec 021's KV-cache
 * rounding convention for user-message drive values).
 */
export function formatPerceptionDriveHint(match: DriveAffordanceMatch): string {
  const mentions = match.affordances
    .map((a) =>
      a.objectId !== undefined
        ? `${a.objectId} "${a.affordanceId}" (restores ${match.drive})`
        : `"${a.affordanceId}" (restores ${match.drive})`,
    )
    .join(', ');
  return `Your ${match.drive} is low (${Math.round(match.driveValue)}). Here, you can restore it: ${mentions}.`;
}

/**
 * Render the imperative-form hint line for one urgent drive (Plan builder,
 * spec 034, Req 2 — the spec-024 social-hint pattern):
 *
 *   `Your energy is low (23). The affordances in your tool list restore it directly (e.g., sit_outside at the Garden Bench). Call such an affordance NOW — do not formulate a search plan.`
 *
 * The example affordance is the first match in perception order. Affordances
 * without object attribution render as `(e.g., sit_outside)`.
 */
export function formatPlanDriveHint(match: DriveAffordanceMatch): string {
  const first = match.affordances[0]!;
  const example =
    first.objectName !== undefined
      ? `${first.affordanceId} at the ${first.objectName}`
      : first.affordanceId;
  return `Your ${match.drive} is low (${Math.round(match.driveValue)}). The affordances in your tool list restore it directly (e.g., ${example}). Call such an affordance NOW — do not formulate a search plan.`;
}