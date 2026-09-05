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
  AgentSummary,
  CompoundAction,
  ObjectDependency,
  Relationship,
  SmartObjectSummary,
  SelfModel,
  SocialMessage,
  PerceptionDataProvider,
} from '@evol-hive/shared';
import type { AgentManager, DriveSystem } from '../index.js';
import type { SmartObjectRegistry } from '../../world/index.js';
import type { SystemFeedbackStore } from '../feedback/index.js';
import type { SocialManager } from '../../social/social-manager.js';
import type { ConversationManagerImpl } from '../../social/conversation-manager.js';
import type { SelfModelManager } from '../state/self-model-manager.js';

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
  private socialManager: SocialManager | undefined;
  /** Conversation lifecycle engine (spec 033) — affordance eligibility filtering. */
  private conversationManager: ConversationManagerImpl | undefined;
  /** Guarded identity self-model store (spec 033) — prompt injection source. */
  private selfModelManager: SelfModelManager | undefined;

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

  // ── Object interaction methods (spec 018, Req 22) ─────────────────────────

  /** Only affordances whose conditions are currently met (spec 018, Req 22). */
  getAvailableAffordancesInRoom(roomId: string): Affordance[] {
    return this.smartObjectRegistry.getAvailableAffordancesInRoom(roomId);
  }

  /** All compound actions in a room (spec 018, Req 22). */
  getCompoundActionsInRoom(roomId: string): CompoundAction[] {
    return this.smartObjectRegistry.getCompoundActionsInRoom(roomId);
  }

  /** All object dependencies in a room (spec 018, Req 22). */
  getObjectDependenciesInRoom(roomId: string): ObjectDependency[] {
    return this.smartObjectRegistry.getObjectDependenciesInRoom(roomId);
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

  // ── Social perception methods (spec 018, Req 21) ───────────────────────────

  /** Inject the SocialManager for social perception queries (spec 018, Req 21). */
  setSocialManager(socialManager: SocialManager): void {
    this.socialManager = socialManager;
  }

  getAgentsInRoom(roomId: string, excludingAgentId: string): AgentSummary[] {
    return this.socialManager?.getAgentsInRoom(roomId, excludingAgentId) ?? [];
  }

  dequeueSocialMessages(agentId: string): SocialMessage[] {
    return this.socialManager?.dequeueSocialMessages(agentId) ?? [];
  }

  getRelationships(agentId: string): Record<string, Relationship> {
    return this.socialManager?.getRelationships(agentId) ?? {};
  }

  // ── Conversation + self-model perception (spec 033) ─────────────────────

  /** Wire the conversation manager for affordance eligibility filtering (R3/R8). */
  setConversationManager(conversationManager: ConversationManagerImpl): void {
    this.conversationManager = conversationManager;
  }

  /** Wire the self-model store (R11/AC-13). */
  setSelfModelManager(selfModelManager: SelfModelManager): void {
    this.selfModelManager = selfModelManager;
  }

  /**
   * Available affordances in a room with conversation-eligibility applied
   * (AC-2): conversation objects expose join/observe to co-located
   * non-participants and contribute/leave to participants. Non-conversation
   * objects pass through unchanged.
   */
  getEligibleAffordancesInRoom(roomId: string, agentId: string): Affordance[] {
    const base = this.smartObjectRegistry.getAvailableAffordancesInRoom(roomId);
    if (this.conversationManager === undefined) return base;
    return base.filter((affordance) => {
      const objects = this.smartObjectRegistry.getByRoom(roomId);
      const owner = objects.find((o) => o.affordances.some((a) => a.id === affordance.id));
      if (owner === undefined || owner.type !== 'conversation') return true;
      return this.conversationManager!.getEligibleAffordances(owner.id, agentId).includes(
        affordance.id,
      );
    });
  }

  /** The agent's evolved self-model, or `null` (persona fallback) — R11/AC-13. */
  getSelfModel(agentId: string): SelfModel | null {
    return this.selfModelManager?.getSelfModel(agentId) ?? null;
  }
}

export {};
