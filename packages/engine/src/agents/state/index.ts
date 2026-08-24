/**
 * state/ — Agent internal state management
 * ───────────────────────────────────────
 * Section 3: Each agent maintains a strict internal state object. This module
 * owns state CRUD, the `isThinking` flag, and perception tick tracking.
 */

import type { AgentInternalState, AgentProfile } from '@evol-hive/shared';
import type { AgentManager } from '../index.js';

const DEFAULT_DRIVES = {
  energy: 100,
  hunger: 100,
  social: 100,
  comfort: 100,
  curiosity: 100,
};

/** Concrete AgentManager backed by an in-memory map. */
export class AgentManagerImpl implements AgentManager {
  private readonly agents = new Map<string, AgentInternalState>();
  /** Stored agent profiles (spec 012, Req 13) — immutable after spawn. */
  private readonly profiles = new Map<string, AgentProfile>();

  spawn(profile: AgentProfile): AgentInternalState {
    const state: AgentInternalState = {
      agentId: profile.id,
      drives: { ...DEFAULT_DRIVES, ...profile.initialDrives },
      currentGoal: '',
      currentPlan: null,
      isThinking: false,
      location: '',
      lastPerceptionTick: 0,
    };

    // Seed structured relationships from profile.relationships (spec 018, Req 22).
    if (profile.relationships !== undefined && Object.keys(profile.relationships).length > 0) {
      const relationships: Record<string, import('@evol-hive/shared').Relationship> = {};
      for (const key of Object.keys(profile.relationships)) {
        relationships[key] = { trust: 50, familiarity: 0, lastInteraction: 0 };
      }
      state.relationships = relationships;
    }

    this.agents.set(profile.id, state);
    this.profiles.set(profile.id, profile);
    return state;
  }

  getState(agentId: string): AgentInternalState | null {
    return this.agents.get(agentId) ?? null;
  }

  updateState(agentId: string, updates: Partial<AgentInternalState>): void {
    const current = this.agents.get(agentId);
    if (current) {
      this.agents.set(agentId, { ...current, ...updates });
    }
  }

  getActiveAgents(): AgentInternalState[] {
    return [...this.agents.values()];
  }

  despawn(agentId: string): void {
    this.agents.delete(agentId);
    this.profiles.delete(agentId);
  }

  getProfile(agentId: string): AgentProfile | null {
    return this.profiles.get(agentId) ?? null;
  }
}

export {};
