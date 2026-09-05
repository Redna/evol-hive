/**
 * agents/state/self-model-manager — Guarded identity self-model (spec 033, R11–R13)
 * ─────────────────────────────────────────────────────────────────────────────
 * Owns the *live* self-model record per agent (the persona's spawn-time
 * `AgentProfile` stays immutable). Implements the shared `SelfModelBridge`
 * (ADR-0001): cognition only *proposes* deltas — this manager validates,
 * bounds, applies, and audits them deterministically.
 *
 * Guards (R13 / AC-8):
 * - max {@link IDENTITY_MAX_DELTAS_PER_UPDATE} deltas per apply call;
 * - max {@link IDENTITY_MAX_DELTAS_PER_SESSION} deltas per session per agent;
 * - rate-limited: at most one apply per `minApplyIntervalTicks` per agent;
 * - every applied batch is recorded as an auditable `identity_change` event
 *   with before/after snapshots.
 *
 * Prompt injection resistance: nothing here reads conversation message text —
 * the only write path is `applySelfModelDeltas` with typed deltas.
 */

import type {
  AgentProfile,
  IdentityChangeAudit,
  IdentityChangeDelta,
  SelfModel,
  SelfModelApplyResult,
} from '@evol-hive/shared';
import {
  applySelfModelDeltas,
  IDENTITY_MAX_DELTAS_PER_SESSION,
  IDENTITY_MAX_DELTAS_PER_UPDATE,
  selfModelFromProfile,
  validateSelfModelDeltas,
} from '@evol-hive/shared';

/** Constructor/config options for {@link SelfModelManager}. */
export interface SelfModelManagerOptions {
  /** Minimum engine ticks between applies per agent (rate limit). Default 20. */
  minApplyIntervalTicks?: number;
  /** Max deltas per session per agent. Default {@link IDENTITY_MAX_DELTAS_PER_SESSION}. */
  maxDeltasPerSession?: number;
}

/**
 * The guarded identity self-model store. Deterministic — no LLM anywhere
 * (AC-14); the LLM proposes deltas through the cognition layer.
 */
export class SelfModelManager {
  private readonly models = new Map<string, SelfModel>();
  /** Append-only `identity_change` audit trail, per agent (R13). */
  private readonly auditLog = new Map<string, IdentityChangeAudit[]>();
  /** Session delta budget consumed, per agent (R13). */
  private readonly sessionBudget = new Map<string, number>();
  /** Last apply tick, per agent (rate limit). */
  private readonly lastApplyTick = new Map<string, number>();
  private readonly minApplyIntervalTicks: number;
  private readonly maxDeltasPerSession: number;

  constructor(options: SelfModelManagerOptions = {}) {
    this.minApplyIntervalTicks = options.minApplyIntervalTicks ?? 20;
    this.maxDeltasPerSession = options.maxDeltasPerSession ?? IDENTITY_MAX_DELTAS_PER_SESSION;
  }

  /** The agent's self-model, or `null` (persona fallback — backward compat). */
  getSelfModel(agentId: string): SelfModel | null {
    return this.models.get(agentId) ?? null;
  }

  /** Seed a self-model from the immutable spawn profile (idempotent). */
  seedFromProfile(profile: AgentProfile, tick: number): SelfModel {
    const existing = this.models.get(profile.id);
    if (existing !== undefined) return existing;
    const model = selfModelFromProfile(profile, tick);
    this.models.set(profile.id, model);
    return model;
  }

  /**
   * Validate, bound (per-update + per-session + rate limit), apply, and audit
   * identity deltas — the ONLY write path to identity (R13 / AC-8).
   */
  applySelfModelDeltas(
    agentId: string,
    deltas: IdentityChangeDelta[],
    tick: number = 0,
    maxPerUpdate: number = IDENTITY_MAX_DELTAS_PER_UPDATE,
  ): SelfModelApplyResult {
    const before = this.models.get(agentId);
    if (before === undefined) {
      return {
        success: false,
        applied: 0,
        rejected: deltas.length,
        message: 'No self-model exists for this agent yet — identity updates are unavailable.',
      };
    }

    // Rate limit (R13): at most one apply per interval per agent.
    const lastTick = this.lastApplyTick.get(agentId);
    if (lastTick !== undefined && tick - lastTick < this.minApplyIntervalTicks) {
      return {
        success: false,
        applied: 0,
        rejected: deltas.length,
        message: `Rate limit: the self-model may only be updated once every ${this.minApplyIntervalTicks} ticks. Reflect first.`,
      };
    }

    // Session budget (R13 / AC-8): max-N deltas per session.
    const used = this.sessionBudget.get(agentId) ?? 0;
    const remaining = this.maxDeltasPerSession - used;
    if (remaining <= 0) {
      return {
        success: false,
        applied: 0,
        rejected: deltas.length,
        message: `Rate limit: at most ${this.maxDeltasPerSession} identity change(s) per session (used ${used}).`,
      };
    }

    // Validation guard: drop malformed deltas before bounding.
    const valid = validateSelfModelDeltas(deltas);
    const bound = Math.min(maxPerUpdate, remaining);
    const outcome = applySelfModelDeltas(before, valid, bound);

    if (outcome.applied.length === 0) {
      return {
        success: false,
        applied: 0,
        rejected: deltas.length,
        message: 'No valid identity changes proposed.',
      };
    }

    const after: SelfModel = { ...outcome.model, updatedAt: tick };
    this.models.set(agentId, after);
    this.lastApplyTick.set(agentId, tick);
    this.sessionBudget.set(agentId, used + outcome.applied.length);

    // Auditable `identity_change` event (R13).
    const audit: IdentityChangeAudit = {
      agentId,
      appliedAt: tick,
      deltas: outcome.applied,
      before: structuredCloneSafe(before),
      after: structuredCloneSafe(after),
      revision: after.revision,
    };
    const log = this.auditLog.get(agentId) ?? [];
    log.push(audit);
    this.auditLog.set(agentId, log);

    return {
      success: true,
      applied: outcome.applied.length,
      rejected: valid.length - outcome.applied.length + (deltas.length - valid.length),
      message: `Applied ${outcome.applied.length} identity change(s) — revision ${after.revision}.`,
      audit,
    };
  }

  /** The agent's `identity_change` audit trail (R13). */
  getIdentityAuditLog(agentId: string): IdentityChangeAudit[] {
    return [...(this.auditLog.get(agentId) ?? [])];
  }

  /** Reset per-session budgets/limits for an agent (new session). */
  resetSessionBudget(agentId: string): void {
    this.sessionBudget.delete(agentId);
    this.lastApplyTick.delete(agentId);
  }

  /** Whether any self-model is tracked for the agent. */
  has(agentId: string): boolean {
    return this.models.has(agentId);
  }

  // ── Persistence / dormancy (R14 / AC-9) ──────────────────────────────────

  /** Serializable copy for `AgentSnapshot.selfModel` / dormant snapshots. */
  exportForDespawn(agentId: string): SelfModel | null {
    const model = this.models.get(agentId);
    return model !== undefined ? structuredCloneSafe(model) : null;
  }

  /** Restore a self-model (load / dormant respawn). */
  restore(agentId: string, model: SelfModel): void {
    this.models.set(agentId, structuredCloneSafe(model));
  }

  /** Drop the agent's self-model (used when the agent is fully removed). */
  remove(agentId: string): void {
    this.models.delete(agentId);
  }
}

/** JSON-safe deep copy for plain data. */
function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export {};