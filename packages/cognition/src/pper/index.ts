/**
 * pper/ — PPER loop orchestration — Perceive phase
 * ────────────────────────────────────────────────
 * Section 6.1: The Perceive phase is passive (System 1). It assembles a
 * PassivePerception snapshot, prunes affordances via the System 0 classifier,
 * and bundles them into a PerceptionResult. It never calls the heavy LLM.
 */

import type {
  PassivePerception,
  PerceptionResult,
  PerceptionDataProvider,
} from '@evol-hive/shared';
import type { AffordanceClassifier } from '../classifier/index.js';
import type { GuardrailEngine } from '../index.js';

/**
 * Assembles a PassivePerception from the engine-facing data provider.
 * Only carries { objectId, name, type } per object — never deep state (§6.1).
 */
export class PassivePerceptionAssembler {
  constructor(private readonly provider: PerceptionDataProvider) {}

  buildPassivePerception(agentId: string): PassivePerception {
    const roomId = this.provider.getAgentLocation(agentId);
    const summaries = this.provider.getObjectsInRoom(roomId);
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
    const allAffordances = this.options.provider.getAffordancesInRoom(passive.roomId);
    const prunedAffordances = await this.options.classifier.prune(
      primaryDriveLabel,
      allAffordances,
    );
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

    // Affordance masking (spec 016, Req 8): after classifier pruning, if a
    // guardrail engine is present, mask physical affordances when the agent
    // has no plan. Cognitive tools are never masked (handled by the builder).
    let maskedAffordances = prunedAffordances;
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

    return {
      passive,
      prunedAffordances: maskedAffordances,
      primaryDriveLabel,
      ...(stuck ? { stuck } : {}),
      ...(persona !== undefined ? { persona } : {}),
      ...(relationships !== undefined ? { relationships } : {}),
    };
  }
}

export { PerceptionBuilderImpl } from './perception-builder.js';
export { PlanBuilderImpl } from './plan-builder.js';
export { PlanServiceImpl } from './plan-service.js';
export type { PlanServiceOptions } from './plan-service.js';
export { ExecuteServiceImpl } from './execute-service.js';
export type { ExecuteServiceOptions } from './execute-service.js';
export { ReflectBuilderImpl } from './reflect-builder.js';
export { ReflectServiceImpl } from './reflect-service.js';
export type { ReflectServiceOptions } from './reflect-service.js';
export { PPEROrchestratorImpl, createPPEROrchestrator } from './orchestrator.js';
export type { PPEROrchestratorOptions } from './orchestrator.js';
export {
  ConsolidationProviderImpl,
  type ConsolidationProviderOptions,
} from './consolidation-provider.js';
export {};
