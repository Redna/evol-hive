/**
 * execute/ — ExecuteDataProviderImpl bridge (spec 003, Req 9)
 * ─────────────────────────────────────────────────────────────────────
 * Concrete `ExecuteDataProvider` (defined in `@evol-hive/shared`) that lets
 * the cognition layer drive the Execute phase via the engine without coupling
 * the two packages (per ADR-0001). Delegates to `AgentManager`, `PlanManager`,
 * `DriveSystem`, `SmartObjectRegistry`, `AffordanceRegistry`, `PhysicsSystem`,
 * and the shared `SystemFeedbackStore`.
 */

import type {
  AgentInternalState,
  Affordance,
  AffordanceResult,
  ExecuteDataProvider,
  PlanStep,
} from '@evol-hive/shared';
import type { AgentManager, DriveSystem, PlanManager } from '../index.js';
import type { SmartObjectRegistry } from '../../world/index.js';
import type { AffordanceRegistryImpl } from '../../world/affordances/index.js';
import type { PhysicsSystemImpl } from '../../physics/index.js';
import type { SystemFeedbackStore } from '../feedback/index.js';

/** Constructor options for {@link ExecuteDataProviderImpl}. */
export interface ExecuteDataProviderOptions {
  agentManager: AgentManager;
  planManager: PlanManager;
  driveSystem: DriveSystem;
  smartRegistry: SmartObjectRegistry;
  affordanceRegistry: AffordanceRegistryImpl;
  physics: PhysicsSystemImpl;
  feedbackStore: SystemFeedbackStore;
}

/**
 * Bridge between the cognition layer and the engine for the Execute phase.
 * Implements `ExecuteDataProvider` (defined in `@evol-hive/shared`).
 */
export class ExecuteDataProviderImpl implements ExecuteDataProvider {
  private readonly agentManager: AgentManager;
  private readonly planManager: PlanManager;
  private readonly driveSystem: DriveSystem;
  private readonly smartRegistry: SmartObjectRegistry;
  private readonly affordanceRegistry: AffordanceRegistryImpl;
  private readonly physics: PhysicsSystemImpl;
  private readonly feedbackStore: SystemFeedbackStore;

  constructor(options: ExecuteDataProviderOptions) {
    this.agentManager = options.agentManager;
    this.planManager = options.planManager;
    this.driveSystem = options.driveSystem;
    this.smartRegistry = options.smartRegistry;
    this.affordanceRegistry = options.affordanceRegistry;
    this.physics = options.physics;
    this.feedbackStore = options.feedbackStore;
  }

  getAgentState(agentId: string): AgentInternalState | null {
    return this.agentManager.getState(agentId);
  }

  getCurrentStep(agentId: string): PlanStep | null {
    return this.planManager.getCurrentStep(agentId);
  }

  isPlanComplete(agentId: string): boolean {
    return this.planManager.isComplete(agentId);
  }

  resolveAffordance(
    roomId: string,
    affordanceId: string,
  ): { objectId: string; affordance: Affordance } | null {
    const objects = this.smartRegistry.getByRoom(roomId);
    for (const object of objects) {
      const affordance = object.affordances.find((a: Affordance) => a.id === affordanceId);
      if (affordance) {
        return { objectId: object.id, affordance };
      }
    }
    return null;
  }

  checkPreconditions(
    affordanceId: string,
    objectId: string,
  ): { satisfied: boolean; failed: string[] } {
    return this.affordanceRegistry.checkPreconditions(affordanceId, objectId);
  }

  async executeAffordance(
    objectId: string,
    affordanceId: string,
    agentId: string,
  ): Promise<AffordanceResult> {
    return this.physics.executeAffordance(objectId, affordanceId, agentId);
  }

  advanceStep(agentId: string): void {
    this.planManager.advanceStep(agentId);
  }

  applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void {
    this.driveSystem.applyChanges(agentId, changes);
  }

  setSystemFeedback(agentId: string, feedback: string): void {
    this.feedbackStore.setSystemFeedback(agentId, feedback);
  }

  setThinking(agentId: string, isThinking: boolean): void {
    this.agentManager.updateState(agentId, { isThinking });
  }
}

export {};
