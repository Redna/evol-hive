/**
 * pper/overheard-diagnostic — the per-cycle `[overheard]` log line
 * (spec 053, R6 — issue #192)
 * ────────────────────────────────────────────────────────────────────────────
 * One `console.log` line per cycle (whenever the agent's perception includes
 * at least one overheard line), emitted at the perceive→plan seam in the
 * orchestrator — the established home of console diagnostics (`[social-urge]`,
 * `[talk-enum]`, `[drive-hint]`). The line makes overhearing auditable from
 * run logs: "the conversation rendered" is distinguishable from "the agent
 * never joined despite overhearing", and the rendered/available pair exposes
 * the ≤3-per-cycle cap (R2) in evidence.
 *
 * The line carries: agent id, current tick, and per-conversation
 * `conversationId|lines-rendered|lines-available`.
 *
 * Constraints inherited from the spec 049 R1 skeleton: zero LLM calls, exactly
 * one console.log line, never dumps the LLM context, never throws (the
 * orchestrator wraps the call AND the function is internally guarded — a
 * logging failure can never break a cycle). Pure formatting over the
 * already-assembled `PerceptionResult` — no re-computation, no extra state.
 * Absence of the line when nothing is overheard is itself meaningful.
 */

import type { PerceptionResult } from '@evol-hive/shared';

/**
 * Emit the per-cycle `[overheard]` diagnostic line (R6). Returns without
 * logging when the perception includes no overheard lines at all — "nothing
 * overheard" is the meaningful absence (AC-7), not a diagnosable event.
 */
export function logOverheardDiagnostic(
  agentId: string,
  perception: PerceptionResult | undefined,
  currentTick: number | undefined,
): void {
  try {
    const conversations = perception?.overheard;
    if (conversations === undefined || conversations.length === 0) return;
    // Only conversations with at least one rendered line count — an entry
    // with empty lines contributes nothing and logs nothing.
    const rendered = conversations.filter((c) => c.lines !== undefined && c.lines.length > 0);
    if (rendered.length === 0) return;
    const parts = rendered.map((conversation) => {
      const available = conversation.availableLines ?? conversation.lines.length;
      return `${conversation.conversationId}|rendered=${conversation.lines.length}|available=${available}`;
    });
    console.log(
      `[overheard] agent=${agentId}` +
        ` tick=${currentTick ?? 'unknown'}` +
        ` conversations=[${parts.join(', ')}]`,
    );
  } catch {
    // Diagnostics must never break a cycle (spec 049 Constraints pattern).
  }
}
