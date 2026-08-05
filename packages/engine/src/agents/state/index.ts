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
    this.agents.set(profile.id, state);
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
  }
}

export {};
