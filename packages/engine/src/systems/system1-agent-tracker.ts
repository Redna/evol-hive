/**
 * systems/system1-agent-tracker — Per-agent last-completed-cycle state
 * (spec 035, Req 1/7)
 * ────────────────────────────────────────────────────────────────────────────
 * Tracks, per agent, the drive snapshot + engine tick + mutation-log seq of
 * the last COMPLETED PPER cycle. The trigger source needs it for drive
 * threshold crossings (drives now vs. at the last completed cycle), the
 * ticks-since-last-cycle flag, and the "mutations since my last cycle"
 * window. The outcome recorder updates it when a cycle settles.
 */

import type { AgentDrives } from '@evol-hive/shared';

interface CycleRecord {
  drives: AgentDrives;
  /** Engine tick at which the cycle settled. */
  tickNumber: number;
  /** The highest scene-mutation seq visible when the cycle settled. */
  mutationSeq: number;
}

export class System1AgentTracker {
  private readonly records = new Map<string, CycleRecord>();
  /** The latest engine tick seen per agent (drives the since counter). */
  private readonly currentTick = new Map<string, number>();

  /** Record a completed cycle (drive snapshot + tick + mutation seq). */
  recordCycleCompleted(
    agentId: string,
    drives: AgentDrives,
    tickNumber: number,
    mutationSeq: number,
  ): void {
    this.records.set(agentId, { drives: { ...drives }, tickNumber, mutationSeq });
    this.currentTick.set(agentId, tickNumber);
  }

  /** Drive values at the agent's last completed cycle, or `null`. */
  getDrivesAtLastCycle(agentId: string): AgentDrives | null {
    return this.records.get(agentId)?.drives ?? null;
  }

  /** Ticks since the agent's last completed cycle (∞ when it never cycled). */
  getTicksSinceLastCycle(agentId: string): number {
    const record = this.records.get(agentId);
    if (!record) return Number.POSITIVE_INFINITY;
    const current = this.currentTick.get(agentId) ?? record.tickNumber;
    return Math.max(0, current - record.tickNumber);
  }

  /** Note the current engine tick for an agent (drives the since counter). */
  noteTick(agentId: string, tickNumber: number): number {
    this.currentTick.set(agentId, tickNumber);
    return this.getTicksSinceLastCycle(agentId);
  }

  /** The mutation-log seq at the agent's last completed cycle (0 = never). */
  getLastMutationSeq(agentId: string): number {
    return this.records.get(agentId)?.mutationSeq ?? 0;
  }

  /** Drop all bookkeeping for an agent (despawn). */
  forget(agentId: string): void {
    this.records.delete(agentId);
    this.currentTick.delete(agentId);
  }
}
