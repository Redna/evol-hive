/**
 * tools/cognitive-tool-executor — Concrete CognitiveToolExecutor (spec 015, §8)
 * ────────────────────────────────────────────────────────────────────────────
 * Executes `query_memory` and `update_internal_state` mid-loop during the LLM
 * tool call loop (spec 015, Req 9–11). Wired at the application entry point
 * with a `MemoryInjector` (for active recall) and a `CognitiveToolDataProvider`
 * (for goal/drive updates). Both dependencies are optional — when absent, the
 * methods return safe, non-error results so the LLM can proceed.
 *
 * Per ADR-0001, this class imports from `@evol-hive/shared` (bridge interfaces
 * and result types) and `@evol-hive/memory` (`MemoryInjector` type). It does
 * NOT import from `@evol-hive/engine`.
 */

import type {
  CognitiveToolDataProvider,
  CognitiveToolExecutor,
  QueryMemoryToolResult,
  UpdateStateToolResult,
  SocialActionBridge,
  SocialToolResult,
  SceneMutationPort,
  SceneMutationProposal,
  SceneMutationType,
  ModifySceneToolResult,
} from '@evol-hive/shared';
import type { MemoryInjector } from '@evol-hive/memory';

/** Constructor options for {@link CognitiveToolExecutorImpl}. */
export interface CognitiveToolExecutorOptions {
  /** Optional memory injector for active recall (query_memory). */
  memoryInjector?: MemoryInjector;
  /** Optional state data provider for goal/drive updates (update_internal_state). */
  stateDataProvider?: CognitiveToolDataProvider;
  /** Optional social bridge for agent-to-agent social tools (spec 018, Req 24). */
  socialBridge?: SocialActionBridge;
  /** Optional current simulation tick for relationship timestamps (spec 018, Req 41). */
  currentTick?: number;
  /**
   * Optional mutation port for the modify_scene tool (spec 030, Req 13).
   * Implemented by the engine (`SceneMutationService`); per ADR-0001 the
   * tool layer only *proposes* — validation happens engine-side.
   */
  mutationPort?: SceneMutationPort;
  /**
   * Max modify_scene proposals per agent per PPER cycle (spec 030, Req 14a).
   * Default 1. Wired from `GuardrailConfig.maxSceneMutationsPerCycle`.
   */
  maxSceneMutationsPerCycle?: number;
}

/**
 * Concrete `CognitiveToolExecutor` that wires `MemoryInjector.activeRecall` and
 * the state data provider methods to the cognitive tool execution loop.
 *
 * Error-resilient: `executeQueryMemory` catches `activeRecall` errors and
 * returns `{ memories: [] }` (a memory query failure never aborts the LLM
 * interaction). `executeUpdateInternalState` reports partial success when one
 * update throws after the other succeeded.
 */
export class CognitiveToolExecutorImpl implements CognitiveToolExecutor {
  private readonly memoryInjector: MemoryInjector | undefined;
  private readonly stateDataProvider: CognitiveToolDataProvider | undefined;
  private readonly socialBridge: SocialActionBridge | undefined;
  private readonly currentTick: number;
  private readonly mutationPort: SceneMutationPort | undefined;
  private readonly maxSceneMutationsPerCycle: number;
  /** modify_scene proposals used this cycle, per agent (spec 030, Req 14a). */
  private readonly sceneMutationBudget = new Map<string, number>();

  constructor(options: CognitiveToolExecutorOptions = {}) {
    this.memoryInjector = options.memoryInjector;
    this.stateDataProvider = options.stateDataProvider;
    this.socialBridge = options.socialBridge;
    this.currentTick = options.currentTick ?? Date.now();
    this.mutationPort = options.mutationPort;
    this.maxSceneMutationsPerCycle = options.maxSceneMutationsPerCycle ?? 1;
  }

  async executeQueryMemory(
    agentId: string,
    query: string,
    topK: number,
  ): Promise<QueryMemoryToolResult> {
    if (this.memoryInjector === undefined) {
      return { memories: [] };
    }
    try {
      const snippets = await this.memoryInjector.activeRecall(agentId, query, topK);
      return { memories: snippets };
    } catch {
      // A memory query failure must not abort the LLM interaction (Req 10).
      return { memories: [] };
    }
  }

  async executeUpdateInternalState(
    agentId: string,
    newGoal?: string,
    driveOverrides?: Partial<Record<string, number>>,
  ): Promise<UpdateStateToolResult> {
    if (this.stateDataProvider === undefined) {
      return {
        success: false,
        goalUpdated: false,
        drivesUpdated: false,
        message: 'State update not available.',
      };
    }

    let goalUpdated = false;
    let drivesUpdated = false;
    let failed = false;
    let failMessage = '';

    if (newGoal !== undefined && newGoal.length > 0) {
      try {
        this.stateDataProvider.updateGoal(agentId, newGoal);
        goalUpdated = true;
      } catch (err) {
        failed = true;
        failMessage = err instanceof Error ? err.message : String(err);
      }
    }

    if (driveOverrides !== undefined && Object.keys(driveOverrides).length > 0) {
      try {
        this.stateDataProvider.applyDriveChanges(agentId, driveOverrides);
        drivesUpdated = true;
      } catch (err) {
        failed = true;
        failMessage = err instanceof Error ? err.message : String(err);
      }
    }

    if (failed) {
      return {
        success: goalUpdated || drivesUpdated,
        goalUpdated,
        drivesUpdated,
        message: `State update failed: ${failMessage}.`,
      };
    }

    const messageParts: string[] = [];
    if (goalUpdated) {
      messageParts.push(`Goal updated to: ${newGoal}.`);
    }
    if (drivesUpdated) {
      const driveSummary = Object.entries(driveOverrides!)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      messageParts.push(`Drives updated: ${driveSummary}.`);
    }
    if (messageParts.length === 0) {
      messageParts.push('No state changes requested.');
    }

    return {
      success: true,
      goalUpdated,
      drivesUpdated,
      message: messageParts.join(' '),
    };
  }

  // ── Social cognitive tool methods (spec 018, Req 25–28) ─────────────────────

  async executeTalkTo(
    agentId: string,
    targetAgentId: string,
    message: string,
  ): Promise<SocialToolResult> {
    if (this.socialBridge === undefined) {
      return {
        success: false,
        message: 'Social actions not available.',
        relationshipUpdated: false,
      };
    }
    try {
      this.socialBridge.queueMessage(agentId, targetAgentId, message);
      this.socialBridge.updateRelationship(agentId, targetAgentId, {
        familiarity: 5,
        trust: 2,
        lastInteraction: this.currentTick,
      });
      this.socialBridge.updateRelationship(targetAgentId, agentId, {
        familiarity: 5,
        trust: 2,
        lastInteraction: this.currentTick,
      });
      if (this.stateDataProvider !== undefined) {
        this.stateDataProvider.applyDriveChanges(agentId, { social: 10 });
      }
      const targetName = this.socialBridge.getAgentSummary(targetAgentId)?.name ?? targetAgentId;
      return {
        success: true,
        message: `Message sent to ${targetName}.`,
        relationshipUpdated: true,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to send message: ${errMsg}.`,
        relationshipUpdated: false,
      };
    }
  }

  async executeObserveAgent(agentId: string, targetAgentId: string): Promise<SocialToolResult> {
    if (this.socialBridge === undefined) {
      return {
        success: false,
        message: 'Social actions not available.',
        relationshipUpdated: false,
      };
    }
    try {
      const summary = this.socialBridge.getAgentSummary(targetAgentId);
      if (summary === null) {
        return { success: false, message: 'Agent not found.', relationshipUpdated: false };
      }
      const drives = this.socialBridge.getAgentDrives(targetAgentId);
      this.socialBridge.updateRelationship(agentId, targetAgentId, {
        familiarity: 1,
        lastInteraction: this.currentTick,
      });
      return {
        success: true,
        message: `Observed ${summary.name}.`,
        relationshipUpdated: true,
        observedAgent: {
          name: summary.name,
          currentActivity: summary.currentActivity,
          isThinking: summary.isThinking,
          drives,
        },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to observe agent: ${errMsg}.`,
        relationshipUpdated: false,
      };
    }
  }

  async executeHelp(agentId: string, targetAgentId: string): Promise<SocialToolResult> {
    if (this.socialBridge === undefined) {
      return {
        success: false,
        message: 'Social actions not available.',
        relationshipUpdated: false,
      };
    }
    try {
      this.socialBridge.updateRelationship(agentId, targetAgentId, {
        familiarity: 10,
        trust: 5,
        lastInteraction: this.currentTick,
      });
      this.socialBridge.updateRelationship(targetAgentId, agentId, {
        familiarity: 10,
        trust: 5,
        lastInteraction: this.currentTick,
      });
      if (this.stateDataProvider !== undefined) {
        this.stateDataProvider.applyDriveChanges(agentId, { social: 15 });
      }
      // Determine target's primary drive (lowest value) and boost it by 10.
      const targetDrives = this.socialBridge.getAgentDrives(targetAgentId);
      let primaryDrive: string | undefined;
      let lowestValue = Infinity;
      for (const [name, value] of Object.entries(targetDrives)) {
        if (value < lowestValue) {
          lowestValue = value;
          primaryDrive = name;
        }
      }
      if (primaryDrive !== undefined && this.stateDataProvider !== undefined) {
        this.stateDataProvider.applyDriveChanges(targetAgentId, { [primaryDrive]: 10 });
      }
      const targetName = this.socialBridge.getAgentSummary(targetAgentId)?.name ?? targetAgentId;
      const driveLabel = primaryDrive ?? 'primary';
      return {
        success: true,
        message: `You helped ${targetName}. Their ${driveLabel} improved.`,
        relationshipUpdated: true,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to help agent: ${errMsg}.`,
        relationshipUpdated: false,
      };
    }
  }

  async executeIgnore(agentId: string, targetAgentId: string): Promise<SocialToolResult> {
    if (this.socialBridge === undefined) {
      return {
        success: false,
        message: 'Social actions not available.',
        relationshipUpdated: false,
      };
    }
    try {
      this.socialBridge.updateRelationship(agentId, targetAgentId, {
        familiarity: -2,
        trust: -1,
        lastInteraction: this.currentTick,
      });
      if (this.stateDataProvider !== undefined) {
        this.stateDataProvider.applyDriveChanges(agentId, { social: -5 });
      }
      const targetName = this.socialBridge.getAgentSummary(targetAgentId)?.name ?? targetAgentId;
      return {
        success: true,
        message: `You chose to ignore ${targetName}.`,
        relationshipUpdated: true,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to ignore agent: ${errMsg}.`,
        relationshipUpdated: false,
      };
    }
  }

  /**
   * Execute modify_scene: enqueue a scene mutation proposal through the
   * engine's mutation port (spec 030, Req 13). The LLM can only propose —
   * validation happens engine-side, and the actionable rejection message is
   * returned as tool feedback so the LLM can self-correct (Req 14b).
   *
   * Guardrail (Req 14a): at most `maxSceneMutationsPerCycle` proposals per
   * agent per PPER cycle. The budget is reset at cycle start via
   * {@link resetSceneMutationBudget} (wired from the orchestrator's
   * `onCycleStart` hook).
   */
  async executeModifyScene(
    agentId: string,
    args: Record<string, unknown>,
  ): Promise<ModifySceneToolResult> {
    if (this.mutationPort === undefined) {
      return { success: false, error: 'Scene mutation is not available in this environment.' };
    }

    // Rate limit (Req 14a / AC-9).
    const used = this.sceneMutationBudget.get(agentId) ?? 0;
    if (used >= this.maxSceneMutationsPerCycle) {
      return {
        success: false,
        error: `Rate limit: at most ${this.maxSceneMutationsPerCycle} modify_scene proposal(s) per agent per PPER cycle (used ${used}). Reflect and retry next cycle.`,
      };
    }

    // Map flat tool args to a validated proposal (Req 13).
    const op = typeof args['op'] === 'string' ? (args['op'] as string) : '';
    const proposal = this.buildProposal(op, args);
    if (proposal === null) {
      return {
        success: false,
        error: `Unknown or incomplete modify_scene op '${op}'. Valid ops: add_object, remove_object, move_object, spawn_agent, despawn_agent, set_connection_state.`,
      };
    }

    const result = this.mutationPort.propose(proposal);
    if (!result.accepted) {
      return { success: false, error: result.error ?? 'Mutation proposal rejected.' };
    }

    this.sceneMutationBudget.set(agentId, used + 1);
    return { success: true, ...(result.seq !== undefined ? { seq: result.seq } : {}) };
  }

  /** Reset the per-cycle modify_scene budget for an agent (Req 14a). */
  resetSceneMutationBudget(agentId: string): void {
    this.sceneMutationBudget.delete(agentId);
  }

  /** Build a SceneMutationProposal from flat tool args, or `null` for unknown ops. */
  private buildProposal(op: string, args: Record<string, unknown>): SceneMutationProposal | null {
    const str = (key: string): string | undefined => {
      const value = args[key];
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    };

    const proposalFor = (
      type: SceneMutationType,
      payload: SceneMutationProposal['payload'],
    ): SceneMutationProposal => ({ type, payload, source: 'llm' });

    switch (op) {
      case 'add_object':
        if (typeof args['object'] !== 'object' || args['object'] === null) return null;
        return proposalFor('add_object', { object: args['object'] as never });
      case 'remove_object': {
        const objectId = str('objectId');
        return objectId === undefined ? null : proposalFor('remove_object', { objectId });
      }
      case 'move_object': {
        const objectId = str('objectId');
        const toRoomId = str('toRoomId');
        if (objectId === undefined || toRoomId === undefined) return null;
        return proposalFor('move_object', { objectId, toRoomId });
      }
      case 'spawn_agent': {
        const dormantAgentId = str('dormantAgentId');
        if (dormantAgentId !== undefined) {
          return proposalFor('spawn_agent', { dormantAgentId });
        }
        if (typeof args['profile'] !== 'object' || args['profile'] === null) return null;
        return proposalFor('spawn_agent', { profile: args['profile'] as never });
      }
      case 'despawn_agent': {
        const agentId = str('agentId');
        return agentId === undefined ? null : proposalFor('despawn_agent', { agentId });
      }
      case 'set_connection_state': {
        const roomA = str('roomA');
        const roomB = str('roomB');
        const action = str('action');
        if (roomA === undefined || roomB === undefined) return null;
        if (action !== 'open' && action !== 'close' && action !== 'insert' && action !== 'remove') {
          return null;
        }
        return proposalFor('set_connection_state', { roomA, roomB, action });
      }
      default:
        return null;
    }
  }
}

export {};
