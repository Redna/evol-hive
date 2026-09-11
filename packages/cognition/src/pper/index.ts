/**
 * pper/ — PPER loop orchestration — Perceive phase
 * ────────────────────────────────────────────────
 * Section 6.1: The Perceive phase is passive (System 1). It assembles a
 * PassivePerception snapshot, prunes affordances via the System 0 classifier,
 * and bundles them into a PerceptionResult. It never calls the heavy LLM.
 */

import type {
  Affordance,
  PassivePerception,
  PerceptionResult,
  PerceptionDataProvider,
  CompoundAction,
  ObjectDependency,
  PendingAddressInfo,
  SocialUrgeAssessment,
} from '@evol-hive/shared';
import {
  computeSocialUrge,
  DEFAULT_SOCIAL_TALKATIVENESS,
  deriveSocialTalkativenessSeed,
} from '@evol-hive/shared';
import type { AffordanceClassifier } from '../classifier/index.js';
import type { GuardrailEngine } from '../index.js';
import { DRIVE_URGENCY_THRESHOLD, HINTABLE_DRIVES } from './drive-affordance-matcher.js';

/**
 * Assembles a PassivePerception from the engine-facing data provider.
 * Only carries { objectId, name, type } per object — never deep state (§6.1).
 *
 * Spec 039 (R3): when the provider implements the fog-filtered
 * `getVisibleObjectsInRoom`, the object list is limited to the agent's
 * explored area — objects in never-visited rooms / unobserved anchors do
 * not surface. Legacy providers (method absent) fall back unchanged.
 */
export class PassivePerceptionAssembler {
  constructor(private readonly provider: PerceptionDataProvider) {}

  buildPassivePerception(agentId: string): PassivePerception {
    const roomId = this.provider.getAgentLocation(agentId);
    const summaries =
      typeof this.provider.getVisibleObjectsInRoom === 'function'
        ? this.provider.getVisibleObjectsInRoom(agentId, roomId)
        : this.provider.getObjectsInRoom(roomId);
    const objectsPresent = summaries.map((s) => ({
      objectId: s.id,
      name: s.name,
      type: s.type,
    }));
    const drives = this.provider.getAgentDrives(agentId);

    const systemFeedback = this.provider.getSystemFeedback(agentId);
    const associativeMemories = this.provider.getAssociativeMemories?.(agentId);

    // Social context (spec 018, Req 32).
    const agentsPresent = this.provider.getAgentsInRoom?.(roomId, agentId);
    const socialContext = this.provider.dequeueSocialMessages?.(agentId);

    const passive: PassivePerception = {
      roomId,
      objectsPresent,
      drives,
      ...(systemFeedback !== undefined ? { systemFeedback } : {}),
      ...(associativeMemories !== undefined ? { associativeMemories } : {}),
      ...(agentsPresent !== undefined && agentsPresent.length > 0 ? { agentsPresent } : {}),
      ...(socialContext !== undefined && socialContext.length > 0 ? { socialContext } : {}),
    };
    return passive;
  }
}

/** Constructor options for {@link PerceptionServiceImpl}. */
export interface PerceptionServiceOptions {
  provider: PerceptionDataProvider;
  classifier: AffordanceClassifier;
  /** Optional guardrail engine for affordance masking (spec 016, Req 8). */
  guardrail?: GuardrailEngine;
}

/**
 * Orchestrates the Perceive phase: passive perception → classifier pruning →
 * PerceptionResult. Pure System 1 — no LLM invocation.
 */
export class PerceptionServiceImpl {
  private readonly assembler: PassivePerceptionAssembler;

  constructor(private readonly options: PerceptionServiceOptions) {
    this.assembler = new PassivePerceptionAssembler(options.provider);
  }

  async perceive(agentId: string): Promise<PerceptionResult> {
    const passive = this.assembler.buildPassivePerception(agentId);
    const primaryDriveLabel = this.options.provider.getPrimaryDriveLabel(agentId);
    // Spec 039 (R3): fog-filtered affordances when the provider offers them
    // (explored-area gate + door-sighting gate for go_to destinations);
    // legacy providers fall back to the room-scoped path unchanged.
    const allAffordances =
      typeof this.options.provider.getVisibleAffordancesInRoom === 'function'
        ? this.options.provider.getVisibleAffordancesInRoom(agentId, passive.roomId)
        : typeof this.options.provider.getAvailableAffordancesInRoom === 'function'
          ? this.options.provider.getAvailableAffordancesInRoom(passive.roomId)
          : this.options.provider.getAffordancesInRoom(passive.roomId);
    // Spec 052 (Req 2): the agent's urgent HINTABLE drives ride into the
    // classifier so a declared restorer for one of them survives the funnel
    // (the greenhouse fix — `rest_among_seedlings`/`eat_herbs` were pruned
    // away exactly when energy/hunger were urgent). The options object is
    // omitted entirely when no hintable drive is urgent — the legacy call
    // path stays byte-identical. `social` is never included: the spec-
    // 018/024/047 social-hint system owns that drive.
    const urgentDrives = HINTABLE_DRIVES.filter((drive) => {
      const value = passive.drives[drive];
      return value !== undefined && value < DRIVE_URGENCY_THRESHOLD;
    });
    const prunedAffordances =
      urgentDrives.length > 0
        ? await this.options.classifier.prune(primaryDriveLabel, allAffordances, { urgentDrives })
        : await this.options.classifier.prune(primaryDriveLabel, allAffordances);
    // Stuck detection (spec 008, Req 5.1, AC-14): no actionable affordances.
    const stuck = prunedAffordances.length === 0;

    // Persona population (spec 012, Req 11): call getAgentProfile gracefully.
    let persona: import('@evol-hive/shared').AgentProfile | null | undefined;
    try {
      const provider = this.options.provider;
      if (typeof provider.getAgentProfile === 'function') {
        persona = provider.getAgentProfile(agentId);
      } else {
        persona = undefined;
      }
    } catch {
      persona = undefined;
    }

    // Relationship population (spec 018, Req 37).
    let relationships: Record<string, import('@evol-hive/shared').Relationship> | undefined;
    try {
      const provider = this.options.provider;
      if (typeof provider.getRelationships === 'function') {
        const rels = provider.getRelationships(agentId);
        if (rels !== undefined && Object.keys(rels).length > 0) {
          relationships = rels;
        }
      }
    } catch {
      relationships = undefined;
    }

    // Compound actions and object dependencies (spec 018, Req 10).
    let compoundActions: CompoundAction[] | undefined;
    let objectDependencies: ObjectDependency[] | undefined;
    try {
      const provider = this.options.provider;
      if (typeof provider.getCompoundActionsInRoom === 'function') {
        const actions = provider.getCompoundActionsInRoom(passive.roomId);
        if (actions.length > 0) compoundActions = actions;
      }
      if (typeof provider.getObjectDependenciesInRoom === 'function') {
        const deps = provider.getObjectDependenciesInRoom(passive.roomId);
        if (deps.length > 0) objectDependencies = deps;
      }
    } catch {
      compoundActions = undefined;
      objectDependencies = undefined;
    }

    // Affordance masking (spec 016, Req 8; spec 020, Req 3): after classifier
    // pruning, if a guardrail engine is present, mask physical affordances when
    // the agent has no plan. The masked result is stored in `maskedAffordances`
    // (for the Perception/Action-choice builder); `prunedAffordances` retains the
    // UNMASKED classifier output for the Plan builder so the LLM can reference
    // exact affordance IDs in plan steps (spec 020, Req 3, 5). Cognitive tools
    // are never masked (handled by the builder).
    let maskedAffordances: Affordance[] | undefined;
    const guardrail = this.options.guardrail;
    if (guardrail !== undefined) {
      let hasPlan = false;
      try {
        if (typeof this.options.provider.getAgentState === 'function') {
          const agentState = this.options.provider.getAgentState(agentId);
          hasPlan = agentState?.currentPlan !== null && agentState?.currentPlan !== undefined;
        }
      } catch {
        hasPlan = false;
      }
      maskedAffordances = guardrail.maskAffordances(prunedAffordances, hasPlan);
    }

    // Known areas + unexplored markers (spec 039, R1/R4). Populated from
    // the provider when implemented; `undefined` keeps legacy behavior.
    let knownAreas: string[] | undefined;
    let unexploredAreas: string[] | undefined;
    try {
      if (typeof this.options.provider.getKnownAreas === 'function') {
        knownAreas = this.options.provider.getKnownAreas(agentId);
        if (knownAreas !== undefined && knownAreas.length === 0) knownAreas = undefined;
      }
      if (typeof this.options.provider.getUnexploredAreas === 'function') {
        const unexplored = this.options.provider.getUnexploredAreas(agentId);
        if (unexplored !== undefined && unexplored.length > 0) unexploredAreas = unexplored;
      }
    } catch {
      knownAreas = undefined;
      unexploredAreas = undefined;
    }

    // Social urge model (spec 044, R3/R4). Both surfaces are optional
    // provider extensions — legacy providers keep `undefined` (no lines
    // rendered, no ranking shift) and never break the perceive path.
    let pendingAddresses: PendingAddressInfo[] | undefined;
    let socialUrges: SocialUrgeAssessment[] | undefined;
    try {
      const provider = this.options.provider;
      // Spec 049 (R3): the current tick feeds BOTH the pending-address age
      // fields (freshness) and the urge scene-novelty input — one read.
      const currentTick =
        typeof provider.getCurrentTick === 'function' ? provider.getCurrentTick() : undefined;
      // R4a: conversations where the agent owes a reply (Decision 4 query).
      if (typeof provider.getConversationsAwaitingAgentReply === 'function') {
        const awaiting = provider.getConversationsAwaitingAgentReply(agentId);
        if (awaiting.length > 0) {
          pendingAddresses = awaiting.map((conversation) => {
            const last = conversation.turns[conversation.turns.length - 1];
            // Spec 049 (R3): the addressing turn's tick + the perception tick
            // ride along as optional fields — pure data, same pattern as the
            // urge inputs. The perception-builder's fresh-address promotion
            // and the orchestrator's [social-urge] diagnostic consume them;
            // without both (legacy providers) freshness is never claimed.
            return {
              conversationId: conversation.id,
              fromAgentId: last!.agentId,
              content: last!.content,
              ...(last !== undefined && currentTick !== undefined
                ? { lastTurnTick: last.tick, currentTick }
                : {}),
            };
          });
        }
      }

      // R4b/R4c: per-present-agent urge assessment via the pure shared
      // computation (no LLM, no async — same standard as the spec-034 matcher).
      const agentsPresent = passive.agentsPresent;
      if (agentsPresent !== undefined && agentsPresent.length > 0) {
        const personaSeed =
          persona !== undefined && persona !== null
            ? deriveSocialTalkativenessSeed(persona)
            : DEFAULT_SOCIAL_TALKATIVENESS;
        const socialDrive = passive.drives['social'];
        const spawnTick =
          typeof provider.getAgentState === 'function'
            ? provider.getAgentState(agentId)?.spawnTick
            : undefined;
        socialUrges = agentsPresent.map((agent) => {
          const rel = relationships?.[agent.agentId];
          const result = computeSocialUrge({
            personaSeed,
            ...(socialDrive !== undefined ? { socialDrive } : {}),
            ...(spawnTick !== undefined ? { spawnTick } : {}),
            ...(currentTick !== undefined ? { currentTick } : {}),
            ...(rel !== undefined
              ? {
                  relationship: {
                    ...(rel.sentCount !== undefined ? { sentCount: rel.sentCount } : {}),
                    ...(rel.receivedCount !== undefined
                      ? { receivedCount: rel.receivedCount }
                      : {}),
                    trust: rel.trust,
                    familiarity: rel.familiarity,
                  },
                }
              : {}),
          });
          return {
            targetAgentId: agent.agentId,
            result,
            sentCount: rel?.sentCount ?? 0,
            receivedCount: rel?.receivedCount ?? 0,
          };
        });
      }
    } catch {
      // The urge path must never break perception (influence, not force).
      pendingAddresses = undefined;
      socialUrges = undefined;
    }

    return {
      passive,
      prunedAffordances,
      ...(maskedAffordances !== undefined ? { maskedAffordances } : {}),
      primaryDriveLabel,
      ...(stuck ? { stuck } : {}),
      ...(persona !== undefined ? { persona } : {}),
      ...(relationships !== undefined ? { relationships } : {}),
      ...(compoundActions ? { compoundActions } : {}),
      ...(objectDependencies ? { objectDependencies } : {}),
      ...(knownAreas !== undefined ? { knownAreas } : {}),
      ...(unexploredAreas !== undefined ? { unexploredAreas } : {}),
      ...(pendingAddresses !== undefined ? { pendingAddresses } : {}),
      ...(socialUrges !== undefined ? { socialUrges } : {}),
    };
  }
}

export { PerceptionBuilderImpl } from './perception-builder.js';
export { PlanBuilderImpl } from './plan-builder.js';
export {
  matchDrivesToAffordances,
  formatPerceptionDriveHint,
  formatPlanDriveHint,
  formatPerceptionChainHint,
  formatPlanChainHint,
  DRIVE_URGENCY_THRESHOLD,
  MAX_DRIVE_HINT_AFFORDANCES,
  HINTABLE_DRIVES,
} from './drive-affordance-matcher.js';
export type {
  AttributedAffordance,
  DriveAffordanceRef,
  DriveAffordanceMatch,
} from './drive-affordance-matcher.js';
export { PlanServiceImpl } from './plan-service.js';
export type { PlanServiceOptions } from './plan-service.js';
export { ExecuteServiceImpl } from './execute-service.js';
export type { ExecuteServiceOptions } from './execute-service.js';
export { ReflectBuilderImpl } from './reflect-builder.js';
export type {
  ReflectBuilderOptions,
  DriveChangeHistory,
  DriveChangeHistoryEntry,
} from './reflect-builder.js';
export { ReflectServiceImpl } from './reflect-service.js';
export type { ReflectServiceOptions } from './reflect-service.js';
export { PPEROrchestratorImpl, createPPEROrchestrator } from './orchestrator.js';
export type { PPEROrchestratorOptions } from './orchestrator.js';
export { logSocialUrgeDiagnostic } from './social-urge-diagnostic.js';
export { logDriveHintDiagnostic } from './drive-hint-diagnostic.js';
export { classifySocialUrgeLine } from './perception-builder.js';
export { computeTalkEnum, logTalkEnumDiagnostic } from './talk-enum.js';
export type { TalkEnumOutcome } from './talk-enum.js';
export {
  BatchPlanService,
  type BatchPlanServiceOptions,
  type BatchPlanEntry,
  type BatchPlanLLMClient,
} from './batch-plan-service.js';
export {
  ConsolidationProviderImpl,
  type ConsolidationProviderOptions,
} from './consolidation-provider.js';
export {};
