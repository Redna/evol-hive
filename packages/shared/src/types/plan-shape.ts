/**
 * Plan-shape classification (spec 060, R1 — issue #214).
 * ──────────────────────────────────────────────────────
 * A single, pure decision point over an already-decoded
 * {@link FormulatePlanResult}. Both the LLM client (after decoding raw tool
 * arguments) and the plan service (the §7 shape backstop) classify through
 * this function, so client and service can never drift on what counts as a
 * well-formed plan.
 *
 * Returns `null` when the shape is valid; otherwise the FIRST failing
 * condition in the fixed order `missing-description` → `missing-steps` →
 * `empty-step-description`. The order is deterministic so the emitted reason
 * code (`[plan-invalid] reason=…`) is stable and comparable across runs.
 *
 * The input is typed as `FormulatePlanResult` but is defensively checked —
 * the client decodes untrusted tool-call arguments before calling this, so a
 * non-array `steps` or a non-string `description` must classify rather than
 * throw.
 */

import type { FormulatePlanResult } from './cognition.js';

/** The reason a decoded plan fails the §7 shape check (spec 060, R1). */
export type PlanShapeReason = 'missing-description' | 'missing-steps' | 'empty-step-description';

/**
 * Classify the shape of a decoded plan. Pure and synchronous — no LLM, no
 * I/O. Returns `null` for a valid shape.
 */
export function classifyPlanShape(result: FormulatePlanResult): PlanShapeReason | null {
  if (typeof result?.description !== 'string' || result.description.length === 0) {
    return 'missing-description';
  }
  if (!Array.isArray(result.steps) || result.steps.length === 0) {
    return 'missing-steps';
  }
  for (const step of result.steps) {
    if (step === null || typeof step !== 'object') {
      return 'empty-step-description';
    }
    const description = (step as { description?: unknown }).description;
    if (typeof description !== 'string' || description.length === 0) {
      return 'empty-step-description';
    }
  }
  return null;
}
