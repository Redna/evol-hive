/**
 * identity/identity-consolidation — Session-end identity consolidation (spec 033, R13/R15)
 * ─────────────────────────────────────────────────────────────────────────────
 * On despawn/save, a guarded LLM pass reviews the session's memories AND the
 * conversation threads (sentiment aggregates + derived roles — R15: social
 * influence is real) and PROPOSES identity deltas. The deltas are bounded
 * (max-N per session), rate-limited (max consolidation passes per session),
 * and every applied delta lands in the engine's auditable `identity_change`
 * trail via the `SelfModelBridge`.
 *
 * The LLM is behind an injected {@link IdentityProposalProvider} interface
 * (ADR-0001 — mirrors `ConsolidationProvider` from spec 014, reversed: here
 * the cognition package owns the service and tests inject a fake provider).
 * No LLM call happens on any deterministic path — the service is only invoked
 * at session end (despawn/save boundary).
 */

import type {
  IdentityChangeDelta,
  MemorySnippet,
  SelfModelBridge,
} from '@evol-hive/shared';

/** Per-participant view of a conversation thread for consolidation (R15). */
export interface ConversationThreadParticipantSummary {
  agentId: string;
  /** Derived role (initiator / active contributor / listener) — R4. */
  role: string;
  /** Per-participant sentiment tally — R4. */
  sentiment: { positive: number; neutral: number; negative: number };
}

/** A conversation thread summary consumed by the consolidation pass (R15). */
export interface ConversationThreadSummary {
  conversationId: string;
  /** LLM-derived topic. */
  topic: string;
  /** Total turns the agent exchanged in this thread. */
  turnCount: number;
  /** The consolidating agent's derived role in the thread. */
  myRole: string;
  participants: ConversationThreadParticipantSummary[];
  /** Dominant thread sentiment. */
  dominantSentiment: 'positive' | 'neutral' | 'negative';
}

/** The context handed to the LLM proposal provider (memories + threads, R15). */
export interface IdentityConsolidationContext {
  agentId: string;
  /** The session's memories (what happened this session). */
  memories: MemorySnippet[];
  /** The session's conversation threads (who said what, with what sentiment). */
  threads: ConversationThreadSummary[];
}

/** The LLM proposal provider interface (injected; the only non-determinism). */
export interface IdentityProposalProvider {
  /** Propose identity deltas from the session context. */
  proposeIdentityDeltas(context: IdentityConsolidationContext): Promise<{
    deltas: IdentityChangeDelta[];
  }>;
}

/** Bounding configuration (spec 033, R13 / AC-8). */
export interface IdentityConsolidationConfig {
  /** Max identity deltas applied per session (across all passes). */
  maxDeltasPerSession: number;
  /** Max consolidation passes per session (rate limit). */
  maxConsolidationsPerSession: number;
}

/** Default bounding config (spec 033, R13). */
export function defaultIdentityConsolidationConfig(): IdentityConsolidationConfig {
  return { maxDeltasPerSession: 10, maxConsolidationsPerSession: 1 };
}

/** The consolidation result (AC-11). */
export interface IdentityConsolidationResult {
  success: boolean;
  /** Deltas applied in this pass. */
  applied: number;
  /** Deltas proposed but dropped by the session bound. */
  rejected: number;
  /** Actionable message (also the tool-style feedback). */
  message: string;
}

/** Constructor dependencies for {@link IdentityConsolidationServiceImpl}. */
export interface IdentityConsolidationOptions {
  /** The guarded, audited engine-side self-model bridge (R13). */
  selfModelBridge: SelfModelBridge;
  /** The LLM proposal provider (the only injected non-determinism). */
  provider: IdentityProposalProvider;
  /** Bounding config. Defaults to {@link defaultIdentityConsolidationConfig}. */
  config?: IdentityConsolidationConfig;
}

/**
 * Session-end identity consolidation service (spec 033, R13/AC-11).
 * Deterministic given the provider: bounding, budgeting, and auditing are
 * pure bookkeeping around the bridge call.
 */
export class IdentityConsolidationServiceImpl {
  private readonly selfModelBridge: SelfModelBridge;
  private readonly provider: IdentityProposalProvider;
  private readonly config: IdentityConsolidationConfig;
  /** Per-agent session budget bookkeeping (R13). */
  private readonly sessionDeltasUsed = new Map<string, number>();
  private readonly sessionPassesUsed = new Map<string, number>();

  constructor(options: IdentityConsolidationOptions) {
    this.selfModelBridge = options.selfModelBridge;
    this.provider = options.provider;
    this.config = options.config ?? defaultIdentityConsolidationConfig();
  }

  /** Run one consolidation pass for an agent at session end. */
  async consolidate(
    agentId: string,
    sessionMemories: MemorySnippet[],
    conversationThreads: ConversationThreadSummary[],
  ): Promise<IdentityConsolidationResult> {
    // Rate limit (R13 / AC-8): max consolidation passes per session.
    const passesUsed = this.sessionPassesUsed.get(agentId) ?? 0;
    if (passesUsed >= this.config.maxConsolidationsPerSession) {
      return {
        success: false,
        applied: 0,
        rejected: 0,
        message: `Rate limit: at most ${this.config.maxConsolidationsPerSession} identity consolidation pass(es) per session.`,
      };
    }

    // Feed memories + conversation threads (sentiment/roles) to the provider (R15).
    const context: IdentityConsolidationContext = {
      agentId,
      memories: sessionMemories,
      threads: conversationThreads,
    };
    const proposal = await this.provider.proposeIdentityDeltas(context);

    // Session budget (R13 / AC-8): at most maxDeltasPerSession per session.
    const used = this.sessionDeltasUsed.get(agentId) ?? 0;
    const remaining = this.config.maxDeltasPerSession - used;
    if (remaining <= 0) {
      this.sessionPassesUsed.set(agentId, passesUsed + 1);
      return {
        success: false,
        applied: 0,
        rejected: proposal.deltas.length,
        message: `Rate limit: at most ${this.config.maxDeltasPerSession} identity change(s) per session.`,
      };
    }
    const bounded = proposal.deltas.slice(0, remaining);

    if (bounded.length === 0) {
      this.sessionPassesUsed.set(agentId, passesUsed + 1);
      return {
        success: true,
        applied: 0,
        rejected: proposal.deltas.length,
        message: 'No identity changes proposed this session.',
      };
    }

    // The audited, guarded application path (R13). The bridge validates,
    // bounds per-update, applies, and records the `identity_change` event.
    const result = this.selfModelBridge.applySelfModelDeltas(agentId, bounded);
    this.sessionDeltasUsed.set(agentId, used + result.applied);
    this.sessionPassesUsed.set(agentId, passesUsed + 1);

    return {
      success: result.success,
      applied: result.applied,
      rejected: bounded.length - result.applied + (proposal.deltas.length - bounded.length),
      message: result.message,
    };
  }

  /** Reset per-session bookkeeping for an agent (new session). */
  resetSession(agentId: string): void {
    this.sessionDeltasUsed.delete(agentId);
    this.sessionPassesUsed.delete(agentId);
  }
}

export {};