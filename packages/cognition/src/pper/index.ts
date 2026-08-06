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

    const passive: PassivePerception = {
      roomId,
      objectsPresent,
      drives,
      ...(systemFeedback !== undefined ? { systemFeedback } : {}),
      ...(associativeMemories !== undefined ? { associativeMemories } : {}),
    };
    return passive;
  }
}

/** Constructor options for {@link PerceptionServiceImpl}. */
export interface PerceptionServiceOptions {
  provider: PerceptionDataProvider;
  classifier: AffordanceClassifier;
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
    return { passive, prunedAffordances, primaryDriveLabel };
  }
}

export { PerceptionBuilderImpl } from './perception-builder.js';
export { PlanBuilderImpl } from './plan-builder.js';
export { PlanServiceImpl } from './plan-service.js';
export {};
