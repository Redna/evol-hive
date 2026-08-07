/**
 * Tests for the Reflect phase — ReflectBuilderImpl and ReflectServiceImpl.
 * Covers acceptance criteria AC-10 through AC-26, AC-35, AC-36, AC-38.
 * Also covers AC-14 (completeReflect called with built payload).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  AffordanceResult,
  AgentInternalState,
  ExecuteResult,
  MemoryEntryInput,
  ReflectDataProvider,
  ReflectLLMResponse,
  ReflectResult,
} from '@evol-hive/shared';
import { reflectSchema } from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload, ReflectBuilder, ReflectService } from '../src/index.js';
import { ReflectBuilderImpl } from '../src/pper/reflect-builder.js';
import { ReflectServiceImpl } from '../src/pper/reflect-service.js';
import type { ReflectServiceOptions } from '../src/pper/reflect-service.js';
import { defaultCognitiveTools } from '../src/tools/index.js';

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

const drives = { energy: 50, hunger: 30, social: 80, comfort: 60, curiosity: 40 };

function makeAgentState(overrides: Partial<AgentInternalState> = {}): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { energy: 50, hunger: 30, social: 80, comfort: 60, curiosity: 40 },
    currentGoal: 'Stay alive',
    currentPlan: null,
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
    ...overrides,
  };
}

function makeExecuteResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    success: true,
    planComplete: false,
    ...overrides,
  };
}

// ─── ReflectBuilderImpl (AC-12, AC-13, AC-35, AC-36) ──────────────────────────

describe('ReflectBuilderImpl.build (AC-12, AC-13, AC-35, AC-36)', () => {
  const builder = new ReflectBuilderImpl();
  const agentState = makeAgentState();
  const executeResult = makeExecuteResult();

  it('returns an LLMContextPayload whose responseSchema is reflectSchema (AC-12)', () => {
    const payload = builder.build(AGENT_ID, agentState, executeResult);
    expect(payload.responseSchema).toEqual(reflectSchema);
  });

  it('sets availableAffordances to an empty array (AC-12)', () => {
    const payload = builder.build(AGENT_ID, agentState, executeResult);
    expect(payload.availableAffordances).toEqual([]);
  });

  it('sets cognitiveTools to only the update_internal_state tool (AC-12)', () => {
    const payload = builder.build(AGENT_ID, agentState, executeResult);
    expect(payload.cognitiveTools).toHaveLength(1);
    expect(payload.cognitiveTools[0]!.name).toBe('update_internal_state');
  });

  it('does not include all default cognitive tools (AC-12)', () => {
    const payload = builder.build(AGENT_ID, agentState, executeResult);
    expect(payload.cognitiveTools).not.toEqual(defaultCognitiveTools);
  });

  it('systemPrompt mentions reflection and the update_internal_state tool (AC-12)', () => {
    const payload = builder.build(AGENT_ID, agentState, executeResult);
    expect(payload.systemPrompt.toLowerCase()).toContain('reflect');
    expect(payload.systemPrompt).toContain('update_internal_state');
  });

  it('perceptionContext includes the execution result status (success) (AC-13)', () => {
    const payload = builder.build(AGENT_ID, agentState, makeExecuteResult({ success: true }));
    expect(payload.perceptionContext.toLowerCase()).toContain('success');
  });

  it('perceptionContext includes the execution result status (failure) (AC-13)', () => {
    const payload = builder.build(
      AGENT_ID,
      agentState,
      makeExecuteResult({ success: false, error: 'Preconditions not met' }),
    );
    expect(payload.perceptionContext.toLowerCase()).toContain('fail');
  });

  it('perceptionContext includes the agent current drives (AC-13)', () => {
    const payload = builder.build(AGENT_ID, agentState, executeResult);
    expect(payload.perceptionContext).toContain('energy');
    expect(payload.perceptionContext).toContain('hunger');
  });

  it('perceptionContext includes the agent current goal (AC-13)', () => {
    const payload = builder.build(AGENT_ID, agentState, executeResult);
    expect(payload.perceptionContext).toContain('Stay alive');
  });

  it('perceptionContext includes the plan status (complete) (AC-13)', () => {
    const payload = builder.build(AGENT_ID, agentState, makeExecuteResult({ planComplete: true }));
    expect(payload.perceptionContext.toLowerCase()).toContain('complete');
  });

  it('perceptionContext includes the plan status (in-progress) (AC-13)', () => {
    const payload = builder.build(AGENT_ID, agentState, makeExecuteResult({ planComplete: false }));
    expect(payload.perceptionContext.toLowerCase()).toContain('in-progress');
  });

  it('includes stepSkipped info when stepSkipped is true (AC-35)', () => {
    const payload = builder.build(AGENT_ID, agentState, makeExecuteResult({ stepSkipped: true }));
    expect(payload.perceptionContext.toLowerCase()).toContain('skip');
  });

  it('includes the failure reason when execution failed (AC-36)', () => {
    const payload = builder.build(
      AGENT_ID,
      agentState,
      makeExecuteResult({ success: false, error: 'Preconditions not met: has_water' }),
    );
    expect(payload.perceptionContext).toContain('Preconditions not met: has_water');
  });
});

// ─── ReflectService / ReflectBuilder interfaces (AC-10, AC-11) ──────────────

describe('ReflectService and ReflectBuilder interfaces (AC-10, AC-11)', () => {
  it('ReflectService has reflect(agentId, executeResult): Promise<ReflectResult> (AC-10)', async () => {
    const service: ReflectService = {
      async reflect(_agentId: string, _executeResult: ExecuteResult): Promise<ReflectResult> {
        return {
          success: true,
          cycleComplete: true,
          memoryStored: false,
          goalUpdated: false,
          drivesUpdated: false,
        };
      },
    };
    await expect(service.reflect('a1', makeExecuteResult())).resolves.toBeDefined();
  });

  it('ReflectBuilder has build(agentId, agentState, executeResult): LLMContextPayload (AC-11)', () => {
    const builder: ReflectBuilder = {
      build(
        _agentId: string,
        _agentState: AgentInternalState,
        _executeResult: ExecuteResult,
      ): LLMContextPayload {
        return {
          systemPrompt: 'test',
          perceptionContext: 'test',
          availableAffordances: [],
          cognitiveTools: [],
          responseSchema: {},
        };
      },
    };
    const payload = builder.build('a1', makeAgentState(), makeExecuteResult());
    expect(payload.systemPrompt).toBe('test');
  });
});

// ─── ReflectServiceOptions (AC-38) ───────────────────────────────────────────

describe('ReflectServiceOptions (AC-38)', () => {
  it('has fields reflectBuilder, llmClient, dataProvider', () => {
    const options: ReflectServiceOptions = {
      reflectBuilder: new ReflectBuilderImpl(),
      llmClient: {} as LLMClient,
      dataProvider: {} as ReflectDataProvider,
    };
    expect(options.reflectBuilder).toBeDefined();
    expect(options.llmClient).toBeDefined();
    expect(options.dataProvider).toBeDefined();
  });
});

// ─── ReflectServiceImpl ──────────────────────────────────────────────────────

/** Fake ReflectDataProvider that records all calls. */
class FakeReflectDataProvider implements ReflectDataProvider {
  getAgentStateCalls: string[] = [];
  applyDriveChangesCalls: { agentId: string; changes: Partial<Record<string, number>> }[] = [];
  updateGoalCalls: { agentId: string; goal: string }[] = [];
  storeMemoryCalls: { agentId: string; entry: MemoryEntryInput }[] = [];
  clearPlanIfCompleteCalls: string[] = [];
  setThinkingCalls: { agentId: string; isThinking: boolean }[] = [];

  agentState: AgentInternalState | null = makeAgentState();
  clearPlanReturn: boolean = false;
  storeMemoryShouldThrow: Error | null = null;

  getAgentState(agentId: string): AgentInternalState | null {
    this.getAgentStateCalls.push(agentId);
    return this.agentState;
  }
  applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void {
    this.applyDriveChangesCalls.push({ agentId, changes });
  }
  updateGoal(agentId: string, goal: string): void {
    this.updateGoalCalls.push({ agentId, goal });
  }
  async storeMemory(agentId: string, entry: MemoryEntryInput): Promise<void> {
    this.storeMemoryCalls.push({ agentId, entry });
    if (this.storeMemoryShouldThrow) {
      throw this.storeMemoryShouldThrow;
    }
  }
  clearPlanIfComplete(agentId: string): boolean {
    this.clearPlanIfCompleteCalls.push(agentId);
    return this.clearPlanReturn;
  }
  setThinking(agentId: string, isThinking: boolean): void {
    this.setThinkingCalls.push({ agentId, isThinking });
    if (this.agentState) {
      this.agentState = { ...this.agentState, isThinking };
    }
  }
}

/** Fake LLMClient for reflect testing. */
class FakeLLMClient implements LLMClient {
  completeStructured = vi.fn();
  completeReflection = vi.fn();
  completePlan = vi.fn();
  completeReflect = vi.fn();

  constructor(private readonly reflectResponse: ReflectLLMResponse | Error) {}
}

function makeService(
  provider: FakeReflectDataProvider,
  reflectResponse: ReflectLLMResponse | Error = {},
): { service: ReflectServiceImpl; llm: FakeLLMClient } {
  const llm = new FakeLLMClient(reflectResponse);
  if (reflectResponse instanceof Error) {
    llm.completeReflect = vi.fn().mockRejectedValue(reflectResponse);
  } else {
    llm.completeReflect = vi.fn().mockResolvedValue(reflectResponse);
  }
  const service = new ReflectServiceImpl({
    reflectBuilder: new ReflectBuilderImpl(),
    llmClient: llm,
    dataProvider: provider,
  });
  return { service, llm };
}

describe('ReflectServiceImpl.reflect (AC-15 through AC-26)', () => {
  let provider: FakeReflectDataProvider;

  beforeEach(() => {
    provider = new FakeReflectDataProvider();
  });

  // AC-16: Agent not found
  it('returns failure when agent does not exist (AC-16)', async () => {
    provider.agentState = null;
    const { service, llm } = makeService(provider);
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result).toEqual({
      success: false,
      error: 'Agent not found',
      cycleComplete: false,
      memoryStored: false,
      goalUpdated: false,
      drivesUpdated: false,
    });
    expect(llm.completeReflect).not.toHaveBeenCalled();
  });

  // AC-17: isThinking safety
  it('sets isThinking=true before LLM call and isThinking=false in finally (AC-17)', async () => {
    const { service, llm } = makeService(provider, {});
    llm.completeReflect = vi.fn().mockImplementation(async () => {
      // While LLM is in-flight, isThinking should be true.
      expect(provider.setThinkingCalls.some((c) => c.isThinking === true)).toBe(true);
      return {};
    });
    await service.reflect(AGENT_ID, makeExecuteResult());

    const firstTrueIdx = provider.setThinkingCalls.findIndex((c) => c.isThinking === true);
    expect(firstTrueIdx).toBe(0);
    // Must end with isThinking=false.
    expect(provider.setThinkingCalls[provider.setThinkingCalls.length - 1]).toEqual({
      agentId: AGENT_ID,
      isThinking: false,
    });
    expect(provider.agentState?.isThinking).toBe(false);
  });

  it('does not set isThinking=true when agent not found (AC-16, AC-17)', async () => {
    provider.agentState = null;
    const { service } = makeService(provider);
    await service.reflect(AGENT_ID, makeExecuteResult());
    expect(provider.setThinkingCalls).toHaveLength(0);
  });

  // AC-18: Full success with all updates
  it('applies drives, goal, memory, clears plan, returns all-true on full LLM response (AC-18)', async () => {
    const response: ReflectLLMResponse = {
      newGoal: 'Find food',
      driveOverrides: { hunger: 30 },
      memoryEntry: {
        content: 'Ate snacks from the fridge',
        importance: 5,
        type: 'action',
      },
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result).toEqual({
      success: true,
      cycleComplete: true,
      memoryStored: true,
      goalUpdated: true,
      drivesUpdated: true,
    });
    expect(provider.applyDriveChangesCalls).toEqual([
      { agentId: AGENT_ID, changes: { hunger: 30 } },
    ]);
    expect(provider.updateGoalCalls).toEqual([{ agentId: AGENT_ID, goal: 'Find food' }]);
    expect(provider.storeMemoryCalls).toHaveLength(1);
    expect(provider.storeMemoryCalls[0]!.agentId).toBe(AGENT_ID);
    expect(provider.storeMemoryCalls[0]!.entry.content).toBe('Ate snacks from the fridge');
    expect(provider.clearPlanIfCompleteCalls).toEqual([AGENT_ID]);
  });

  // AC-19: Empty response
  it('on empty LLM response: no updates, clears plan, returns success with all-false (AC-19)', async () => {
    const { service } = makeService(provider, {});
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result).toEqual({
      success: true,
      cycleComplete: true,
      memoryStored: false,
      goalUpdated: false,
      drivesUpdated: false,
    });
    expect(provider.applyDriveChangesCalls).toHaveLength(0);
    expect(provider.updateGoalCalls).toHaveLength(0);
    expect(provider.storeMemoryCalls).toHaveLength(0);
    expect(provider.clearPlanIfCompleteCalls).toEqual([AGENT_ID]);
  });

  // AC-20: Empty string newGoal
  it('on newGoal="" : does not call updateGoal, goalUpdated=false (AC-20)', async () => {
    const { service } = makeService(provider, { newGoal: '' });
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result.goalUpdated).toBe(false);
    expect(provider.updateGoalCalls).toHaveLength(0);
  });

  // AC-21: Empty driveOverrides
  it('on driveOverrides={}: does not call applyDriveChanges, drivesUpdated=false (AC-21)', async () => {
    const { service } = makeService(provider, { driveOverrides: {} });
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result.drivesUpdated).toBe(false);
    expect(provider.applyDriveChangesCalls).toHaveLength(0);
  });

  // AC-22: Empty content in memoryEntry
  it('on memoryEntry with empty content: returns failure, no partial updates (AC-22)', async () => {
    const response: ReflectLLMResponse = {
      newGoal: 'New goal',
      driveOverrides: { hunger: 20 },
      memoryEntry: { content: '', importance: 5, type: 'action' },
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result.success).toBe(false);
    expect(result.cycleComplete).toBe(false);
    expect(result.error).toContain('Invalid memory entry from LLM');
    expect(result.error).toContain('content');
    expect(result.memoryStored).toBe(false);
    expect(result.goalUpdated).toBe(false);
    expect(result.drivesUpdated).toBe(false);
    // No partial updates applied.
    expect(provider.applyDriveChangesCalls).toHaveLength(0);
    expect(provider.updateGoalCalls).toHaveLength(0);
    expect(provider.storeMemoryCalls).toHaveLength(0);
  });

  // AC-23: Importance out of range
  it('on memoryEntry with importance > 10: returns failure mentioning importance (AC-23)', async () => {
    const response: ReflectLLMResponse = {
      memoryEntry: { content: 'Did something', importance: 15, type: 'action' },
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid memory entry from LLM');
    expect(result.error.toLowerCase()).toContain('importance');
  });

  it('on memoryEntry with importance < 1: returns failure mentioning importance (AC-23)', async () => {
    const response: ReflectLLMResponse = {
      memoryEntry: { content: 'Did something', importance: 0, type: 'action' },
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result.success).toBe(false);
    expect(result.error.toLowerCase()).toContain('importance');
  });

  // AC-24: Invalid type
  it('on memoryEntry with invalid type: returns failure mentioning type (AC-24)', async () => {
    const response: ReflectLLMResponse = {
      memoryEntry: {
        content: 'Did something',
        importance: 5,
        type: 'invalid_type' as never,
      },
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid memory entry from LLM');
    expect(result.error.toLowerCase()).toContain('type');
  });

  // AC-25: LLM throws
  it('on LLM throw: catches, sets isThinking=false, returns failure without re-throwing (AC-25)', async () => {
    const { service } = makeService(provider, new Error('LLM connection refused'));
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result).toEqual({
      success: false,
      error: 'LLM connection refused',
      cycleComplete: false,
      memoryStored: false,
      goalUpdated: false,
      drivesUpdated: false,
    });
    expect(provider.agentState?.isThinking).toBe(false);
  });

  // AC-26: storeMemory throws after drives and goal applied
  it('on storeMemory throw after drives/goal applied: returns failure with partial flags (AC-26)', async () => {
    provider.storeMemoryShouldThrow = new Error('Vector store offline');
    const response: ReflectLLMResponse = {
      newGoal: 'Find food',
      driveOverrides: { hunger: 30 },
      memoryEntry: {
        content: 'Ate snacks',
        importance: 5,
        type: 'action',
      },
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to store memory');
    expect(result.error).toContain('Vector store offline');
    expect(result.cycleComplete).toBe(false);
    expect(result.memoryStored).toBe(false);
    expect(result.goalUpdated).toBe(true);
    expect(result.drivesUpdated).toBe(true);
  });

  // AC-37: isThinking always false after any exit
  it('isThinking is false after success path (AC-37)', async () => {
    const { service } = makeService(provider, {});
    await service.reflect(AGENT_ID, makeExecuteResult());
    expect(provider.agentState?.isThinking).toBe(false);
  });

  it('isThinking is false after validation failure path (AC-37)', async () => {
    const response: ReflectLLMResponse = {
      memoryEntry: { content: '', importance: 5, type: 'action' },
    };
    const { service } = makeService(provider, response);
    await service.reflect(AGENT_ID, makeExecuteResult());
    expect(provider.agentState?.isThinking).toBe(false);
  });

  it('calls clearPlanIfComplete even on empty response (AC-19)', async () => {
    const { service } = makeService(provider, {});
    await service.reflect(AGENT_ID, makeExecuteResult());
    expect(provider.clearPlanIfCompleteCalls).toEqual([AGENT_ID]);
  });

  it('does not call clearPlanIfComplete when agent not found (AC-16)', async () => {
    provider.agentState = null;
    const { service } = makeService(provider);
    await service.reflect(AGENT_ID, makeExecuteResult());
    expect(provider.clearPlanIfCompleteCalls).toHaveLength(0);
  });

  // AC-14: completeReflect is called with the payload built by ReflectBuilder.build()
  it('calls llmClient.completeReflect with the payload from ReflectBuilder.build() (AC-14)', async () => {
    const { service, llm } = makeService(provider, {});
    await service.reflect(AGENT_ID, makeExecuteResult());

    expect(llm.completeReflect).toHaveBeenCalledTimes(1);
    const payload = llm.completeReflect.mock.calls[0]![0] as LLMContextPayload;
    // The payload should have the reflectSchema as its responseSchema.
    expect(payload.responseSchema).toEqual(reflectSchema);
    // The payload should include the agent's current goal in the perception context.
    expect(payload.perceptionContext).toContain('Stay alive');
    // The payload should include the execution result status.
    expect(payload.perceptionContext.toLowerCase()).toContain('success');
  });

  it('handles null/undefined LLM response as empty object (AC-15)', async () => {
    const { service, llm } = makeService(provider);
    llm.completeReflect = vi.fn().mockResolvedValue(null);
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result.success).toBe(true);
    expect(result.cycleComplete).toBe(true);
    expect(result.memoryStored).toBe(false);
    expect(result.goalUpdated).toBe(false);
    expect(result.drivesUpdated).toBe(false);
  });
});
