/**
 * Spec 040 — Idle-Tick Memory Suppression (issue #149)
 * Wait-only cycles store nothing: the third System 1 label domino.
 *
 * Covers:
 *   - R1 (AC-3): the `WAIT_AFFORDANCE` Execute branch reports `stepSkipped: true`;
 *     the no-`targetAffordance` branch keeps its existing `stepSkipped: true`.
 *   - R2 (AC-1, AC-2): `resolveMemoryEntry` suppresses the auto-fallback idle
 *     memory on skipped cycles (no LLM memory → nothing stored, `memoryStored
 *     === false`); explicit LLM memories (flattened + legacy) are still stored.
 *   - R3 (AC-6): non-skipped fallback paths are unchanged — success and failed
 *     actions keep their auto-fallback memories (regression guard).
 *   - End-to-end within cognition: an Execute → Reflect chain over a wait-only
 *     plan stores no memory when the LLM provides none (the `memoryWritten`
 *     signal the System 1 outcome recorder reads is no longer fired by idle
 *     ticks).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Affordance,
  AgentInternalState,
  ExecuteDataProvider,
  ExecuteResult,
  MemoryEntryInput,
  PlanStep,
  ReflectDataProvider,
  ReflectLLMResponse,
} from '@evol-hive/shared';
import { WAIT_AFFORDANCE } from '@evol-hive/shared';
import type { LLMClient } from '../src/index.js';
import { ReflectBuilderImpl } from '../src/pper/reflect-builder.js';
import { ReflectServiceImpl } from '../src/pper/reflect-service.js';
import { ExecuteServiceImpl } from '../src/pper/execute-service.js';

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

// ─── Fakes ───────────────────────────────────────────────────────────────────

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

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    description: 'Wait a moment',
    completed: false,
    ...overrides,
  };
}

class FakeExecuteDataProvider implements ExecuteDataProvider {
  agentState: AgentInternalState = makeAgentState({
    currentPlan: {
      id: 'plan_wait',
      description: 'Wait out the noise',
      steps: [makeStep({ targetAffordance: WAIT_AFFORDANCE })],
      currentStepIndex: 0,
      createdAt: 100,
    },
  });
  currentStep: PlanStep = makeStep({ targetAffordance: WAIT_AFFORDANCE });
  planComplete = false;
  resolvedAffordance: { objectId: string; affordance: Affordance } | null = null;

  advanceStepCalls: string[] = [];
  setSystemFeedbackCalls: { agentId: string; feedback: string }[] = [];

  getAgentState(agentId: string): AgentInternalState {
    return this.agentState;
  }
  isPlanComplete(_agentId: string): boolean {
    return this.planComplete;
  }
  getCurrentStep(_agentId: string): PlanStep {
    return this.currentStep;
  }
  resolveAffordance(
    _roomId: string,
    _affordanceId: string,
  ): { objectId: string; affordance: Affordance } | null {
    return this.resolvedAffordance;
  }
  checkPreconditions(_affordanceId: string, _objectId: string): { satisfied: boolean; failed: string[] } {
    return { satisfied: true, failed: [] };
  }
  async executeAffordance(_objectId: string, _affordanceId: string, _agentId: string) {
    return { success: true };
  }
  advanceStep(agentId: string): void {
    this.advanceStepCalls.push(agentId);
  }
  applyDriveChanges(_agentId: string, _changes: Partial<Record<string, number>>): void {}
  setSystemFeedback(agentId: string, feedback: string): void {
    this.setSystemFeedbackCalls.push({ agentId, feedback });
  }
  setThinking(_agentId: string, _isThinking: boolean): void {}
}

class FakeReflectDataProvider implements ReflectDataProvider {
  getAgentStateCalls: string[] = [];
  applyDriveChangesCalls: { agentId: string; changes: Partial<Record<string, number>> }[] = [];
  updateGoalCalls: { agentId: string; goal: string }[] = [];
  storeMemoryCalls: { agentId: string; entry: MemoryEntryInput }[] = [];
  clearPlanIfCompleteCalls: string[] = [];

  agentState: AgentInternalState = makeAgentState();

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
  }
  clearPlanIfComplete(agentId: string): boolean {
    this.clearPlanIfCompleteCalls.push(agentId);
    return false;
  }
  setThinking(_agentId: string, _isThinking: boolean): void {}
}

class FakeLLMClient implements LLMClient {
  completeStructured = vi.fn();
  completeReflection = vi.fn();
  completePlan = vi.fn();
  completeReflect = vi.fn();
}

function makeReflectService(
  provider: FakeReflectDataProvider,
  reflectResponse: ReflectLLMResponse = {},
): { service: ReflectServiceImpl; llm: FakeLLMClient } {
  const llm = new FakeLLMClient();
  llm.completeReflect = vi.fn().mockResolvedValue(reflectResponse);
  const service = new ReflectServiceImpl({
    reflectBuilder: new ReflectBuilderImpl(),
    llmClient: llm,
    dataProvider: provider,
  });
  return { service, llm };
}

// ─── R1: WAIT steps report stepSkipped (AC-3) ────────────────────────────────

describe('ExecuteServiceImpl — WAIT_AFFORDANCE branch (R1, AC-3)', () => {
  let provider: FakeExecuteDataProvider;
  let service: ExecuteServiceImpl;

  beforeEach(() => {
    provider = new FakeExecuteDataProvider();
    service = new ExecuteServiceImpl({ dataProvider: provider });
  });

  // AC-3 / R1.1: the wait escape hatch is an intentional no-op that reports
  // stepSkipped so Reflect suppresses the idle-tick fallback memory.
  it("a step with targetAffordance 'wait' returns stepSkipped: true (R1.1, AC-3)", async () => {
    provider.currentStep = makeStep({ targetAffordance: WAIT_AFFORDANCE });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.planComplete).toBe(false);
    expect(result.stepSkipped).toBe(true);
  });

  it("a 'wait' step advances the plan and touches nothing else (R1.1)", async () => {
    provider.currentStep = makeStep({ targetAffordance: WAIT_AFFORDANCE });
    const result = await service.execute(AGENT_ID);

    expect(provider.advanceStepCalls).toEqual([AGENT_ID]);
    // No feedback, no world interaction — a pure no-op.
    expect(provider.setSystemFeedbackCalls).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it("a final 'wait' step reports planComplete alongside stepSkipped (R1.1)", async () => {
    provider.currentStep = makeStep({ targetAffordance: WAIT_AFFORDANCE });
    provider.planComplete = true;
    const result = await service.execute(AGENT_ID);

    expect(result.stepSkipped).toBe(true);
    expect(result.planComplete).toBe(true);
  });

  // R1.2: the no-targetAffordance branch keeps its existing stepSkipped: true.
  it('a narrative step without targetAffordance still returns stepSkipped: true (R1.2)', async () => {
    provider.currentStep = makeStep({ targetAffordance: undefined, description: 'Ponder life' });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.stepSkipped).toBe(true);
  });

  // Regression guard: a physical step is NOT skipped.
  it('a physical affordance step does not set stepSkipped (regression guard)', async () => {
    const coffee: Affordance = {
      id: 'brew_coffee',
      label: 'Brew coffee',
      engineEffect: 'brew_coffee',
      preconditions: [],
      effects: { energy: 5 },
    };
    provider.currentStep = makeStep({ targetAffordance: 'brew_coffee' });
    provider.resolvedAffordance = { objectId: 'coffee-1', affordance: coffee };
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.stepSkipped).toBeUndefined();
  });
});

// ─── R2: auto-fallback suppression on skipped cycles (AC-1, AC-2) ────────────

describe('ReflectServiceImpl — idle-tick memory suppression (R2, AC-1, AC-2)', () => {
  let provider: FakeReflectDataProvider;

  beforeEach(() => {
    provider = new FakeReflectDataProvider();
  });

  // AC-1 / R2.1: a skipped cycle with no LLM memory stores NOTHING.
  it('stores no memory on a skipped cycle with no LLM memory (AC-1, R2.1)', async () => {
    const { service } = makeReflectService(provider, {});
    const result = await service.reflect(AGENT_ID, { success: true, planComplete: false, stepSkipped: true });

    expect(result.success).toBe(true);
    expect(result.memoryStored).toBe(false);
    expect(provider.storeMemoryCalls).toHaveLength(0);
  });

  // R2.2: memoryStored is false (not undefined) when suppressed.
  it('reports memoryStored === false when suppression applies (R2.2)', async () => {
    const { service } = makeReflectService(provider, {});
    const result = await service.reflect(AGENT_ID, { success: true, planComplete: true, stepSkipped: true });

    expect(result.memoryStored).toBe(false);
    expect(result.cycleComplete).toBe(true);
  });

  // Spec 025 semantics: empty/whitespace memoryContent counts as absent —
  // suppression still applies on a skipped cycle.
  it('suppresses on a skipped cycle with empty-string memoryContent (R2.1)', async () => {
    const { service } = makeReflectService(provider, { memoryContent: '' });
    const result = await service.reflect(AGENT_ID, { success: true, planComplete: false, stepSkipped: true });

    expect(result.memoryStored).toBe(false);
    expect(provider.storeMemoryCalls).toHaveLength(0);
  });

  it('suppresses on a skipped cycle with whitespace-only memoryContent (R2.1)', async () => {
    const { service } = makeReflectService(provider, { memoryContent: '   ' });
    const result = await service.reflect(AGENT_ID, { success: true, planComplete: false, stepSkipped: true });

    expect(result.memoryStored).toBe(false);
    expect(provider.storeMemoryCalls).toHaveLength(0);
  });

  // The idle fallback content must never be written on a skipped cycle —
  // this is the exact node the spec removes from memory hygiene.
  it('never writes the "Idle tick" fallback content on a skipped cycle (R2.1)', async () => {
    const { service } = makeReflectService(provider, {});
    await service.reflect(AGENT_ID, { success: true, planComplete: false, stepSkipped: true });

    for (const call of provider.storeMemoryCalls) {
      expect(call.entry.content.toLowerCase()).not.toContain('idle tick');
    }
    expect(provider.storeMemoryCalls).toHaveLength(0);
  });

  // AC-2 / R2.3: an explicit flattened LLM memory on a skipped cycle IS stored.
  it('stores an explicit memoryContent on a skipped cycle (R2.3, AC-2)', async () => {
    const { service } = makeReflectService(provider, {
      memoryContent: 'Noticed the coffee machine humming while waiting',
      memoryImportance: 6,
      memoryType: 'observation',
    });
    const result = await service.reflect(AGENT_ID, { success: true, planComplete: false, stepSkipped: true });

    expect(result.success).toBe(true);
    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
    expect(provider.storeMemoryCalls[0]!.entry.content).toBe(
      'Noticed the coffee machine humming while waiting',
    );
    expect(provider.storeMemoryCalls[0]!.entry.importance).toBe(6);
    expect(provider.storeMemoryCalls[0]!.entry.type).toBe('observation');
  });

  // AC-2 / R2.3: the legacy memoryEntry on a skipped cycle IS stored.
  it('stores a legacy memoryEntry on a skipped cycle (R2.3, AC-2)', async () => {
    const { service } = makeReflectService(provider, {
      memoryEntry: { content: 'Legacy note while waiting', importance: 4, type: 'observation' },
    });
    const result = await service.reflect(AGENT_ID, { success: true, planComplete: false, stepSkipped: true });

    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
    expect(provider.storeMemoryCalls[0]!.entry.content).toBe('Legacy note while waiting');
  });

  // R2.3: precedence is unchanged — flattened beats legacy on skipped cycles.
  it('flattened memoryContent takes precedence over legacy memoryEntry on a skipped cycle (R2.3)', async () => {
    const { service } = makeReflectService(provider, {
      memoryContent: 'Flattened while waiting',
      memoryEntry: { content: 'Legacy', importance: 3, type: 'action' },
    });
    await service.reflect(AGENT_ID, { success: true, planComplete: false, stepSkipped: true });

    expect(provider.storeMemoryCalls).toHaveLength(1);
    expect(provider.storeMemoryCalls[0]!.entry.content).toBe('Flattened while waiting');
  });

  // Suppression is only keyed on stepSkipped — not on drive state, plan
  // identity, or anything else (constraint).
  it('suppression is keyed only on the stepSkipped flag, nothing else (constraint)', async () => {
    const { service } = makeReflectService(provider, {});
    // A non-skipped success cycle still auto-falls back (see R3 tests for
    // content). Here: the same empty response, but success=false (failed
    // execution, stepSkipped absent) — the fallback MUST still fire.
    const result = await service.reflect(AGENT_ID, {
      success: false,
      error: 'Affordance execution failed',
      planComplete: false,
    });

    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
    expect(provider.storeMemoryCalls[0]!.entry.content).toContain('Action failed');
  });
});

// ─── R3: non-skipped fallback paths unchanged (AC-6 regression guard) ────────

describe('Auto-fallback preserved for non-skipped cycles (R3, AC-6)', () => {
  let provider: FakeReflectDataProvider;

  beforeEach(() => {
    provider = new FakeReflectDataProvider();
  });

  it('a successful action still auto-generates "Action succeeded: …" (R3.1)', async () => {
    provider.agentState = makeAgentState({ currentGoal: 'Brew coffee' });
    const { service } = makeReflectService(provider, {});
    const result = await service.reflect(AGENT_ID, {
      success: true,
      planComplete: false,
      result: { success: true, driveChanges: { energy: 5 } },
    });

    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
    const entry = provider.storeMemoryCalls[0]!.entry;
    expect(entry.content).toContain('Action succeeded');
    expect(entry.content).toContain('Brew coffee');
    expect(entry.importance).toBe(3);
    expect(entry.type).toBe('action');
  });

  it('a failed action still auto-generates "Action failed: …" (R3.2, AC-6)', async () => {
    provider.agentState = makeAgentState({ currentGoal: 'Brew coffee' });
    const { service } = makeReflectService(provider, {});
    const result = await service.reflect(AGENT_ID, {
      success: false,
      error: 'No water in machine',
      planComplete: false,
    });

    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
    const entry = provider.storeMemoryCalls[0]!.entry;
    expect(entry.content).toContain('Action failed: No water in machine');
    expect(entry.content).toContain('Brew coffee');
    expect(entry.importance).toBe(3);
    expect(entry.type).toBe('observation');
  });

  it('a failed action keeps its fallback memory even when stepSkipped is false explicitly (R3.2)', async () => {
    const { service } = makeReflectService(provider, {});
    const result = await service.reflect(AGENT_ID, {
      success: false,
      error: 'Preconditions not met',
      planComplete: false,
      stepSkipped: false,
    });

    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
    expect(provider.storeMemoryCalls[0]!.entry.content).toContain('Action failed');
  });

  it('a non-skipped cycle with stepSkipped absent still auto-falls back (R3.1)', async () => {
    const { service } = makeReflectService(provider, {});
    const result = await service.reflect(AGENT_ID, { success: true, planComplete: false });

    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
  });
});

// ─── End-to-end within cognition: Execute(wait) → Reflect stores nothing ─────

describe('Execute→Reflect chain — wait-only cycle stores nothing (end-to-end)', () => {
  it('a wait-only cycle feeds stepSkipped into Reflect and stores no memory', async () => {
    const execProvider = new FakeExecuteDataProvider();
    execProvider.currentStep = makeStep({ targetAffordance: WAIT_AFFORDANCE });
    const executeService = new ExecuteServiceImpl({ dataProvider: execProvider });

    const reflectProvider = new FakeReflectDataProvider();
    const { service: reflectService } = makeReflectService(reflectProvider, {});

    // Execute: the wait step advances the plan and reports the skip.
    const executeResult = await executeService.execute(AGENT_ID);
    expect(executeResult.stepSkipped).toBe(true);

    // Reflect: the same cycle — no LLM memory → nothing stored.
    const reflectResult = await reflectService.reflect(AGENT_ID, executeResult);

    expect(reflectResult.success).toBe(true);
    expect(reflectResult.memoryStored).toBe(false);
    expect(reflectProvider.storeMemoryCalls).toHaveLength(0);
    // Goal/drive updates from the LLM still apply normally.
    expect(reflectResult.goalUpdated).toBe(false);
  });

  it('a wait-only cycle with an explicit LLM memory stores exactly that memory', async () => {
    const execProvider = new FakeExecuteDataProvider();
    execProvider.currentStep = makeStep({ targetAffordance: WAIT_AFFORDANCE });
    const executeService = new ExecuteServiceImpl({ dataProvider: execProvider });

    const reflectProvider = new FakeReflectDataProvider();
    const { service: reflectService } = makeReflectService(reflectProvider, {
      memoryContent: 'Waiting for the rain to stop — noted the time',
    });

    const executeResult = await executeService.execute(AGENT_ID);
    const reflectResult = await reflectService.reflect(AGENT_ID, executeResult);

    expect(reflectResult.memoryStored).toBe(true);
    expect(reflectProvider.storeMemoryCalls).toHaveLength(1);
    expect(reflectProvider.storeMemoryCalls[0]!.entry.content).toBe(
      'Waiting for the rain to stop — noted the time',
    );
  });

  it('goal updates on a skipped cycle still apply (suppression is memory-only)', async () => {
    const reflectProvider = new FakeReflectDataProvider();
    const { service } = makeReflectService(reflectProvider, { newGoal: 'Head to the garden' });
    const result = await service.reflect(AGENT_ID, { success: true, planComplete: false, stepSkipped: true });

    expect(result.success).toBe(true);
    expect(result.goalUpdated).toBe(true);
    expect(reflectProvider.updateGoalCalls).toEqual([{ agentId: AGENT_ID, goal: 'Head to the garden' }]);
    expect(reflectProvider.storeMemoryCalls).toHaveLength(0);
  });
});