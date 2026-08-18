/**
 * perception/ — PerceptionDataProviderImpl bridge (spec 001 bridge, wired in spec 005)
 * ─────────────────────────────────────────────────────────────────────────────
 * Concrete `PerceptionDataProvider` (defined in `@evol-hive/shared`) that lets
 * the cognition layer read passive world/agent data from the engine without
 * coupling the two packages (per ADR-0001). Delegates to `AgentManager`,
 * `SmartObjectRegistry`, `DriveSystem`, and the shared `SystemFeedbackStore`.
 */

import type {
  Affordance,
  AgentProfile,
  AgentInternalState,
  SmartObjectSummary,
  PerceptionDataProvider,
} from '@evol-hive/shared';
import type { AgentManager, DriveSystem } from '../index.js';
import type { SmartObjectRegistry } from '../../world/index.js';
import type { SystemFeedbackStore } from '../feedback/index.js';

/** Constructor options for {@link PerceptionDataProviderImpl}. */
export interface PerceptionDataProviderOptions {
  agentManager: AgentManager;
  smartObjectRegistry: SmartObjectRegistry;
  driveSystem: DriveSystem;
  feedbackStore: SystemFeedbackStore;
}

/**
 * Bridge between the cognition layer and the engine for the Perceive phase.
 * Implements `PerceptionDataProvider` (defined in `@evol-hive/shared`).
 */
export class PerceptionDataProviderImpl implements PerceptionDataProvider {
  private readonly agentManager: AgentManager;
  private readonly smartObjectRegistry: SmartObjectRegistry;
  private readonly driveSystem: DriveSystem;
  private readonly feedbackStore: SystemFeedbackStore;

  constructor(
    agentManager: AgentManager,
    smartObjectRegistry: SmartObjectRegistry,
    driveSystem: DriveSystem,
    feedbackStore: SystemFeedbackStore,
  ) {
    this.agentManager = agentManager;
    this.smartObjectRegistry = smartObjectRegistry;
    this.driveSystem = driveSystem;
    this.feedbackStore = feedbackStore;
  }

  getAgentLocation(agentId: string): string {
    const state = this.agentManager.getState(agentId);
    return state?.location ?? '';
  }

  getObjectsInRoom(roomId: string): SmartObjectSummary[] {
    return this.smartObjectRegistry.getObjectsInRoom(roomId);
  }

  getAffordancesInRoom(roomId: string): Affordance[] {
    return this.smartObjectRegistry.getAffordancesInRoom(roomId);
  }

  getAgentDrives(agentId: string): Record<string, number> {
    const state = this.agentManager.getState(agentId);
    if (!state) return {};
    return { ...state.drives };
  }

  getPrimaryDriveLabel(agentId: string): string {
    const state = this.agentManager.getState(agentId);
    if (!state) return '';
    return this.driveSystem.getPrimaryDriveLabel(state);
  }

  getSystemFeedback(agentId: string): string | undefined {
    return this.feedbackStore.getSystemFeedback(agentId);
  }

  getAgentProfile(agentId: string): AgentProfile | null {
    return this.agentManager.getProfile(agentId);
  }

  getAgentState(agentId: string): AgentInternalState | null {
    return this.agentManager.getState(agentId);
  }
}

export {};
