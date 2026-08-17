/**
 * reflect/ — ReflectDataProviderImpl bridge (spec 004, Req 22-23)
 * ─────────────────────────────────────────────────────────────────────
 * Concrete `ReflectDataProvider` (defined in `@evol-hive/shared`) that lets
 * the cognition layer drive the Reflect phase via the engine without coupling
 * the two packages (per ADR-0001). Delegates to `AgentManager`, `DriveSystem`,
 * `PlanManager`, and `MemoryStore`.
 */

import type {
  AgentInternalState,
  AgentProfile,
  MemoryEntryInput,
  ReflectDataProvider,
} from '@evol-hive/shared';
import type { MemoryStore } from '@evol-hive/memory';
import type { AgentManager, DriveSystem, PlanManager } from '../index.js';
import type { SimulationClock } from '../plans/index.js';

/**
 * Bridge between the cognition layer and the engine for the Reflect phase.
 * Implements `ReflectDataProvider` (defined in `@evol-hive/shared`).
 */
export class ReflectDataProviderImpl implements ReflectDataProvider {
  constructor(
    private readonly agentManager: AgentManager,
    private readonly driveSystem: DriveSystem,
    private readonly planManager: PlanManager,
    private readonly memoryStore: MemoryStore,
    private readonly clock: SimulationClock,
  ) {}

  getAgentState(agentId: string): AgentInternalState | null {
    return this.agentManager.getState(agentId);
  }

  applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void {
    this.driveSystem.applyChanges(agentId, changes);
  }

  updateGoal(agentId: string, goal: string): void {
    this.agentManager.updateState(agentId, { currentGoal: goal });
  }

  async storeMemory(agentId: string, entry: MemoryEntryInput): Promise<void> {
    const timestamp = this.clock();
    await this.memoryStore.store(agentId, entry, timestamp);
  }

  clearPlanIfComplete(agentId: string): boolean {
    if (this.planManager.isComplete(agentId)) {
      this.planManager.clearPlan(agentId);
      return true;
    }
    return false;
  }

  setThinking(agentId: string, isThinking: boolean): void {
    this.agentManager.updateState(agentId, { isThinking });
  }

  getAgentProfile(agentId: string): AgentProfile | null {
    return this.agentManager.getProfile(agentId);
  }
}

export {};
