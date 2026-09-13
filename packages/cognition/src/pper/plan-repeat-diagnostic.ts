/**
 * pper/plan-repeat-diagnostic — the per-cycle `[plan-repeat]` log line
 * (spec 055, Req 7 — issue #198)
 * ────────────────────────────────────────────────────────────────────────────
 * Following the spec-049 discipline (orchestrator owns diagnostics; zero LLM
 * calls; never breaks a cycle), ONE `console.error` (stderr) line per cycle
 * whenever the agent's plan fingerprint matches the previous cycle's
 * FORMULATED plan, carrying the consecutive-identical count. This makes the
 * #191 signature (356× identical plans) auditable from run logs, and the
 * live-run bound (AC-8: ≤ 5 consecutive) judgeable from `[plan-repeat]`
 * lines rather than inference.
 *
 * The fingerprint is the agent's plan identity per the spec: the SORTED
 * `targetAffordance` sequence plus a description hash — order-insensitive
 * over steps, sensitive to the plan's description.
 *
 * Counting semantics (pinned by tests): only FORMULATIONS count. A cycle
 * where the plan service short-circuits on the still-active plan (same plan
 * id) is a continuation, not a re-formulation — it never increments the
 * counter. A changed fingerprint resets the count to 1 silently. The first
 * formulation emits no line (nothing to compare against); the second
 * identical formulation emits `count=2`, and so on — one line per cycle on
 * every matching cycle thereafter.
 *
 * Pure bookkeeping over data the orchestrator already holds (the stored
 * plan). Tick arithmetic and strings only; zero LLM calls; no prompt changes
 * (spec 021 KV-cache discipline untouched). The orchestrator wraps the call
 * so a logging failure can never break the cycle (spec 049 discipline).
 */

import type { AgentPlan } from '@evol-hive/shared';

/** Internal per-agent repeat state. */
interface PlanRepeatState {
  fingerprint: string;
  /** The plan id whose fingerprint this is — short-circuit continuations skip. */
  planId: string;
  count: number;
}

/**
 * Deterministic small hash for the plan description (djb2, base36) — stable
 * across processes, short enough for a log line, never used for control flow
 * beyond fingerprint equality.
 */
export function hashPlanDescription(description: string): string {
  let hash = 5381;
  for (let i = 0; i < description.length; i++) {
    hash = ((hash << 5) + hash + description.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * The plan fingerprint (spec 055, Req 7): sorted per-step identity (the
 * step's `targetAffordance` when bound, else its description) plus the
 * description hash. Two formulations are "identical" iff both match.
 */
export function planFingerprint(plan: {
  description: string;
  steps: { targetAffordance?: string; description: string }[];
}): string {
  const stepIds = plan.steps.map((s) => s.targetAffordance ?? s.description);
  return `${[...stepIds].sort().join(',')}#${hashPlanDescription(plan.description)}`;
}

/**
 * Tracks consecutive-identical plan formulations per agent and emits the
 * `[plan-repeat]` line on every matching re-formulation. Instantiated by the
 * orchestrator (the established home of console diagnostics).
 */
export class PlanRepeatTracker {
  private readonly last = new Map<string, PlanRepeatState>();

  record(agentId: string, plan: AgentPlan): void {
    const prev = this.last.get(agentId);
    // The plan service short-circuits on a still-active plan (same plan id) —
    // a continuation, not a re-formulation. Never counts.
    if (prev !== undefined && prev.planId === plan.id) return;

    const fingerprint = planFingerprint(plan);
    if (prev !== undefined && prev.fingerprint === fingerprint) {
      const count = prev.count + 1;
      this.last.set(agentId, { fingerprint, planId: plan.id, count });
      console.error(
        `[plan-repeat] agent=${agentId} count=${count} fingerprint=${fingerprint} plan="${plan.description}"`,
      );
      return;
    }
    // Changed plan (or first cycle) — reset silently to count 1.
    this.last.set(agentId, { fingerprint, planId: plan.id, count: 1 });
  }
}

export {};
