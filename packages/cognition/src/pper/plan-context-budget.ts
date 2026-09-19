/**
 * pper/plan-context-budget — the plan prompt's perception-context ceiling
 * (spec 061, R1/R3 — issue #219)
 * ────────────────────────────────────────────────────────────────────────────
 * The spec-060 live run named the mechanism behind the rising shape-invalid
 * rate: the plan prompt's per-cycle perception context grows monotonically
 * (avg 9,435 → 17,783 chars across tick quintiles) and the provider's
 * invalid rate tracked it (2.1% → 89.2%). `budgetPlanContext` bounds that
 * context to the headroom left by the constant prefix, dropping whole
 * optional blocks from the lowest priority (highest tier) upward (never a
 * `required` block; truncating the last `required` block only as a last
 * resort).
 *
 * Two hard constraints from the spec govern this module:
 *
 * - **Byte-identity under budget.** When the joined context is at or below
 *   `maxChars`, the result is exactly `blocks.map((b) => b.text).join('\n')` —
 *   no reordering, no dedup, no whitespace change (spec 021 stable prefix +
 *   spec 055 goldens pass unmodified).
 * - **Purity.** `budgetPlanContext` reads no clock, no I/O and no env. The
 *   env-derived ceiling is passed in by the caller (`planPromptMaxChars`), and
 *   the env-derived recall caps are applied by the caller (`capRecallBlocks`)
 *   so equal inputs always yield equal outputs.
 *
 * The `systemPrompt` and the `formulate_plan` tool definitions are NEVER passed
 * to this module: the targetAffordance/targetArea enums are plan *legality*
 * (spec 037/058), not prompt text (spec 061 Decision 3).
 */

/** A stable, grep-able id per rendered block (spec 061, R1). */
export type PlanContextBlockId = string;

/**
 * A block is a contiguous run of one or more already-rendered lines. `text`
 * never contains the join separator (`'\n'`) — except the spec-008 stuck
 * warning, whose historical leading `'\\n\\n'` is preserved for byte-identity.
 */
export interface PlanContextBlock {
  id: PlanContextBlockId;
  text: string;
  /** A `required` block is never dropped; it can only be truncated last. */
  required?: boolean;
}

/** The budgeter's result (spec 061, R1). */
export interface BudgetedPlanContext {
  perceptionContext: string;
  originalChars: number;
  chars: number;
  budgeted: boolean;
  /** Dropped optional block ids, in drop order. */
  droppedBlockIds: string[];
  /** Set when the last required block had to be truncated. */
  truncatedBlockId?: string;
}

/** Conservative starting ceiling, below the measured knee (spec 061, R1). */
export const DEFAULT_PLAN_PROMPT_MAX_CHARS = 10_000;

/** Default long-term-recall caps (spec 061, R3). */
export const DEFAULT_PLAN_RECALL_MAX_LINES = 3;
export const DEFAULT_PLAN_RECALL_MAX_CHARS = 400;

/**
 * The explicit truncation marker appended to the last required block when the
 * required set alone exceeds the budget (spec 061, R1). The marker counts
 * toward the budget.
 */
const TRUNCATION_MARKER = '…[truncated]';

/**
 * Priority table (spec 061, R2): highest tier survives longest. The budgeter
 * drops optional blocks from the lowest tier upward; a `required` block is
 * never in the drop set. Tiers 0–1 are required by construction, tiers 2–5
 * are optional, and `recall` is the reserved Tier 3.5 (spec 061, R3).
 */
const TIER_BY_BLOCK_ID: Readonly<Record<string, number>> = {
  // Tier 0 — required: what the agent must know to act at all.
  room: 0,
  objects: 0,
  'primary-drive': 0,
  drives: 0,
  // Tier 1 — required: hints, directives and failure feedback.
  'system-feedback': 1,
  'stuck-warning': 1,
  'social-directive': 1,
  'social-primary-hint': 1,
  'drive-hints': 1,
  // Tier 2 — optional: spatial value space.
  'known-areas': 2,
  'unexplored-areas': 2,
  'known-areas-directive': 2,
  'agents-present': 2,
  // Tier 3 — optional: plan memory.
  'last-plan': 3,
  'last-plan-reflection': 3,
  // Tier 3.5 — optional: reserved long-term recall (spec 061, R3).
  recall: 3.5,
  // Tier 4 — optional: social history and stable detail.
  'social-messages': 4,
  relationships: 4,
  'compound-actions': 4,
  'object-dependencies': 4,
  // Tier 5 — optional: always-on boilerplate (drop first).
  horizon: 5,
};

/**
 * Unknown optional ids (a future block that forgot the table) are treated as
 * Tier 4 — mid-priority, so a new block is never silently pinned forever or
 * silently dropped before the boilerplate.
 */
const FALLBACK_TIER = 4;

function tierOf(block: PlanContextBlock): number {
  return TIER_BY_BLOCK_ID[block.id] ?? FALLBACK_TIER;
}

/** Length of `blocks.map((b) => b.text).join('\n')` without building it. */
function joinedLength(blocks: readonly PlanContextBlock[]): number {
  if (blocks.length === 0) return 0;
  let total = 0;
  for (const block of blocks) total += block.text.length;
  return total + (blocks.length - 1);
}

function joined(blocks: readonly PlanContextBlock[]): string {
  return blocks.map((b) => b.text).join('\n');
}

/**
 * Bound the assembled plan context to `maxChars` (spec 061, R1). Pure and
 * synchronous.
 *
 * - At or under budget: byte-identical to `blocks.map((b) => b.text).join('\n')`.
 * - Over budget: drop whole optional blocks from the lowest priority (highest
 *   tier) upward until the total fits, reporting ids in `droppedBlockIds` in
 *   drop order.
 * - Required-only overflow: keep every required block and truncate the LAST
 *   required block at the char boundary that fits, appending `…[truncated]`.
 *   Never throws on a negative/zero budget; the result is then the required
 *   blocks truncated to `max(0, maxChars)`.
 *
 * Within one tier, blocks are dropped from last to first in the input order,
 * so the earliest-rendered (stable-prefix-adjacent) content survives longest.
 */
export function budgetPlanContext(
  blocks: readonly PlanContextBlock[],
  maxChars: number,
): BudgetedPlanContext {
  const original = joined(blocks);
  const originalChars = original.length;
  const ceiling = Number.isFinite(maxChars)
    ? Math.max(0, Math.floor(maxChars))
    : maxChars === Infinity
      ? originalChars
      : 0;

  if (ceiling >= originalChars) {
    return {
      perceptionContext: original,
      originalChars,
      chars: originalChars,
      budgeted: false,
      droppedBlockIds: [],
    };
  }

  // Drop whole optional blocks, lowest priority (highest tier) first; within a
  // tier, later blocks first. Stop as soon as the remaining join fits.
  const droppedBlockIds: string[] = [];
  let kept: PlanContextBlock[] = blocks.slice();
  const droppable = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.required !== true)
    .sort((a, b) => {
      // Tier 5 is the lowest priority and drops before Tier 4, Tier 3, …
      const tierDelta = tierOf(b.block) - tierOf(a.block);
      return tierDelta !== 0 ? tierDelta : b.index - a.index;
    });

  for (const { block } of droppable) {
    if (joinedLength(kept) <= ceiling) break;
    kept = kept.filter((candidate) => candidate !== block);
    droppedBlockIds.push(block.id);
  }

  if (joinedLength(kept) <= ceiling) {
    const perceptionContext = joined(kept);
    return {
      perceptionContext,
      originalChars,
      chars: perceptionContext.length,
      budgeted: perceptionContext !== original,
      droppedBlockIds,
    };
  }

  // Required-only overflow: truncate the last required block. `kept` contains
  // no optional blocks at this point.
  const last = kept[kept.length - 1];
  if (last === undefined) {
    // No blocks at all and an over-budget ceiling can only mean ceiling < 0,
    // which is clamped to 0 above — so this is unreachable; return empty.
    return {
      perceptionContext: '',
      originalChars,
      chars: 0,
      budgeted: originalChars !== 0,
      droppedBlockIds,
    };
  }

  const prefix = kept.slice(0, -1);
  let prefixSum = 0;
  for (const block of prefix) prefixSum += block.text.length;
  const prefixLength = prefixSum + prefix.length;
  const allowedLast = ceiling - prefixLength;
  let lastText: string;
  if (allowedLast >= TRUNCATION_MARKER.length) {
    lastText = last.text.slice(0, allowedLast - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
  } else if (allowedLast > 0) {
    // No room for the marker — keep the char boundary that fits.
    lastText = last.text.slice(0, allowedLast);
  } else {
    lastText = '';
  }

  let perceptionContext = joined([...prefix, { id: last.id, text: lastText }]);
  if (perceptionContext.length > ceiling) {
    // Pathological: the prefix alone exceeds the budget (tiny/zero ceiling).
    // Never throw; clamp to the hard bound.
    perceptionContext = perceptionContext.slice(0, ceiling);
  }

  return {
    perceptionContext,
    originalChars,
    chars: perceptionContext.length,
    budgeted: perceptionContext !== original,
    droppedBlockIds,
    truncatedBlockId: last.id,
  };
}

/**
 * The effective plan-prompt ceiling from `PLAN_PROMPT_MAX_CHARS` at call time
 * (spec 061, R1), using the existing `planFloorAfterFailures` env pattern:
 * absent/empty/non-finite/non-positive → {@link DEFAULT_PLAN_PROMPT_MAX_CHARS}.
 */
export function planPromptMaxChars(): number {
  return parsePositiveEnvInt('PLAN_PROMPT_MAX_CHARS', DEFAULT_PLAN_PROMPT_MAX_CHARS);
}

/**
 * `PLAN_RECALL_MAX_LINES` (default 3) — the recall tier's snippet cap
 * (spec 061, R3). Env-overridable with the same validation pattern.
 */
export function planRecallMaxLines(): number {
  return parsePositiveEnvInt('PLAN_RECALL_MAX_LINES', DEFAULT_PLAN_RECALL_MAX_LINES);
}

/**
 * `PLAN_RECALL_MAX_CHARS` (default 400) — the recall tier's char cap
 * (spec 061, R3). Env-overridable with the same validation pattern.
 */
export function planRecallMaxChars(): number {
  return parsePositiveEnvInt('PLAN_RECALL_MAX_CHARS', DEFAULT_PLAN_RECALL_MAX_CHARS);
}

function parsePositiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Cap one recall block's text to `maxLines` lines and `maxChars` chars,
 * preserving the provider's existing weighted-retrieval order (spec 061, R3 —
 * no new ranking: the first entries of the already-ranked list are kept).
 */
export function capRecallText(text: string, maxLines: number, maxChars: number): string {
  const lineCap = Math.max(0, Math.floor(maxLines));
  const charCap = Math.max(0, Math.floor(maxChars));
  const capped = text.split('\n').slice(0, lineCap).join('\n');
  return capped.length > charCap ? capped.slice(0, charCap) : capped;
}

/**
 * Apply the recall caps to every `recall` block (spec 061, R3). Pure: the caps
 * are passed in by the caller from `planRecallMaxLines()`/`planRecallMaxChars()`
 * so the budgeter itself stays env-free. Non-recall blocks pass through
 * unchanged, and the block count/order is preserved. Inert today because the
 * builder does not render `associativeMemories` (Deferred) — this is the
 * defensive guard that bounds the tier before a future wiring can.
 */
export function capRecallBlocks(
  blocks: readonly PlanContextBlock[],
  maxLines: number,
  maxChars: number,
): PlanContextBlock[] {
  return blocks.map((block) =>
    block.id === 'recall'
      ? { ...block, text: capRecallText(block.text, maxLines, maxChars) }
      : block,
  );
}
