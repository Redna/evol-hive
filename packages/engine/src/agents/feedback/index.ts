/**
 * feedback/ — System feedback store (Section 9.2 Action Feedback Loop)
 * ─────────────────────────────────────────────────────────────────────
 * A per-agent transient feedback store shared between `ExecuteDataProviderImpl`
 * (writer — on failure) and `PerceptionDataProviderImpl` (reader — during the
 * next Perceive tick). Feedback is overwritten on each failure; it is not
 * accumulated. After being consumed by the Perceive phase, `clearSystemFeedback`
 * should be called to prevent stale feedback on subsequent ticks (spec 003, Req 8).
 */

/** Per-agent system feedback store. */
export class SystemFeedbackStore {
  private readonly feedback = new Map<string, string>();

  /** Store feedback for an agent, overwriting any previous value. */
  setSystemFeedback(agentId: string, feedback: string): void {
    this.feedback.set(agentId, feedback);
  }

  /** Retrieve the current feedback for an agent, or `undefined` if none. */
  getSystemFeedback(agentId: string): string | undefined {
    return this.feedback.get(agentId);
  }

  /** Remove any stored feedback for the agent (called after Perceive consumes it). */
  clearSystemFeedback(agentId: string): void {
    this.feedback.delete(agentId);
  }
}

export {};
