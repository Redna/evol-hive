/**
 * Tests for the Plan phase — PlanBuilderImpl and PlanServiceImpl.
 * Covers acceptance criteria AC-3 through AC-14, AC-23, AC-24, AC-25, AC-26.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Affordance,
  PassivePerception,
  PerceptionResult,
  AgentInternalState,
  AgentPlan,
  FormulatePlanResult,
  PlanDataProvider,
} from '@evol-hive/shared';
import { formulatePlanSchema, llmActionResponseSchema } from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '../src/index.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { PlanServiceImpl } from '../src/pper/plan-service.js';
import { defaultCognitiveTools } from '../src/tools/index.js';

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

const drives = { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 };

const objects = [
  { objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' },
  { objectId: 'kettle-1', name: 'Kettle', type: 'appliance' },
];

const prunedAffordances: Affordance[] = [
  {
    id: 'brew_coffee',
    label: 'Brew coffee',
    engineEffect: 'brew_coffee',
    preconditions: [],
    effects: { energy: 20 },
  },
];

function makePerceptionResult(
  overrides: Partial<PerceptionResult> = {},
  passiveOverrides: Partial<PassivePerception> = {},
): PerceptionResult {
  const passive: PassivePerception = {
    roomId: ROOM_ID,
    objectsPresent: objects,
    drives,
    ...passiveOverrides,
  };
  return {
    passive,
    prunedAffordances,
    primaryDriveLabel: 'low energy, need to restore energy',
    ...overrides,
  };
}

// ─── PlanBuilderImpl ──────────────────────────────────────────────────────────

describe('PlanBuilderImpl.build (AC-4, AC-5, AC-6, AC-7, AC-26)', () => {
  const builder = new PlanBuilderImpl();

  it('returns an LLMContextPayload whose responseSchema is formulatePlanSchema (AC-4)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.responseSchema).toEqual(formulatePlanSchema);
    expect(payload.responseSchema).not.toEqual(llmActionResponseSchema);
  });

  it('perceptionContext contains the room name and object names (AC-5)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).toContain(ROOM_ID);
    expect(payload.perceptionContext).toContain('Coffee Machine');
    expect(payload.perceptionContext).toContain('Kettle');
  });

  it('systemPrompt instructs the LLM to formulate a plan (AC-5)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.systemPrompt.toLowerCase()).toContain('plan');
  });

  it('systemPrompt references the primary drive label (AC-5)', () => {
    const payload = builder.build(
      makePerceptionResult({ primaryDriveLabel: 'low energy, need to restore energy' }),
    );
    expect(payload.systemPrompt).toContain('energy');
  });

  it('systemPrompt references the formulate_plan cognitive tool (AC-5)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.systemPrompt).toContain('formulate_plan');
  });

  it('includes systemFeedback in perceptionContext when present (AC-6)', () => {
    const payload = builder.build(
      makePerceptionResult(
        {},
        { systemFeedback: 'You tried to brew coffee but the machine has no water.' },
      ),
    );
    expect(payload.perceptionContext).toContain(
      'You tried to brew coffee but the machine has no water.',
    );
  });

  it('does not include systemFeedback when absent', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).not.toContain('systemFeedback');
  });

  it('sets availableAffordances to prunedAffordances from the PerceptionResult (AC-7)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.availableAffordances).toEqual(prunedAffordances);
  });

  it('sets cognitiveTools to the default cognitive tool catalog (AC-7)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.cognitiveTools).toEqual(defaultCognitiveTools);
  });

  it('perceptionContext does not contain any SmartObject.state fields (AC-26)', () => {
    const payload = builder.build(makePerceptionResult());
    // The perception context should only have room, objects, drives — no "water_level" etc.
    expect(payload.perceptionContext).not.toContain('water_level');
    expect(payload.perceptionContext).not.toContain('bean_count');
    // Verify objects only carry names, not state.
    expect(payload.perceptionContext).toContain('Coffee Machine');
    expect(payload.perceptionContext).not.toMatch(/state\s*[:=]/i);
  });
});

// ─── PlanServiceImpl ──────────────────────────────────────────────────────────

function makeAgentState(overrides: Partial<AgentInternalState> = {}): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    currentGoal: 'stay alive',
    currentPlan: null,
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
    ...overrides,
  };
}

function makeFormulatePlanResult(): FormulatePlanResult {
  return {
    description: 'Restore energy by brewing coffee',
    steps: [
      { description: 'Go to the coffee machine', targetAffordance: 'brew_coffee' },
      { description: 'Brew coffee and drink it' },
    ],
  };
}

function makeStoredPlan(): AgentPlan {
  return {
    id: `plan_${AGENT_ID}_123`,
    description: 'Restore energy by brewing coffee',
    steps: [
      {
        description: 'Go to the coffee machine',
        targetAffordance: 'brew_coffee',
        completed: false,
      },
      { description: 'Brew coffee and drink it', completed: false },
    ],
    currentStepIndex: 0,
    createdAt: 100,
  };
}

/** Fake PlanDataProvider that records calls and returns configurable state. */
class FakeDataProvider implements PlanDataProvider {
  getStateCalls: string[] = [];
  storePlanCalls: { agentId: string; result: FormulatePlanResult }[] = [];
  setThinkingCalls: { agentId: string; isThinking: boolean }[] = [];
  agentState: AgentInternalState | null = makeAgentState();
  storedPlan: AgentPlan = makeStoredPlan();

  getAgentState(agentId: string): AgentInternalState | null {
    this.getStateCalls.push(agentId);
    return this.agentState;
  }
  storePlan(agentId: string, result: FormulatePlanResult): AgentPlan {
    this.storePlanCalls.push({ agentId, result });
    return this.storedPlan;
  }
  setThinking(agentId: string, isThinking: boolean): void {
    this.setThinkingCalls.push({ agentId, isThinking });
    if (this.agentState) {
      this.agentState = { ...this.agentState, isThinking };
    }
  }
}

/** Fake LLMClient for plan testing. */
class FakeLLMClient implements LLMClient {
  completeStructured = vi.fn();
  completeReflection = vi.fn();
  completePlan = vi.fn();

  constructor(private readonly planResult: FormulatePlanResult | Error) {}

  async completePlanImpl(payload: LLMContextPayload): Promise<FormulatePlanResult> {
    if (this.planResult instanceof Error) {
      throw this.planResult;
    }
    return this.planResult;
  }
}

describe('PlanServiceImpl.plan (AC-9 through AC-14, AC-23, AC-24, AC-25)', () => {
  let provider: FakeDataProvider;

  beforeEach(() => {
    provider = new FakeDataProvider();
  });

  it('sets isThinking=true before calling completePlan (AC-10)', async () => {
    const llm = new FakeLLMClient(makeFormulatePlanResult());
    llm.completePlan = vi.fn().mockImplementation(async (payload: LLMContextPayload) => {
      // While the LLM is in-flight, isThinking should be true.
      expect(provider.setThinkingCalls.some((c) => c.isThinking === true)).toBe(true);
      expect(payload.responseSchema).toEqual(formulatePlanSchema);
      return makeFormulatePlanResult();
    });
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    await service.plan(AGENT_ID, makePerceptionResult());

    // isThinking=true must have been called before completePlan was invoked.
    const firstTrueIdx = provider.setThinkingCalls.findIndex((c) => c.isThinking === true);
    expect(firstTrueIdx).toBe(0);
  });

  it('builds the context payload and passes it to completePlan (AC-11)', async () => {
    const llm = new FakeLLMClient(makeFormulatePlanResult());
    llm.completePlan = vi.fn().mockResolvedValue(makeFormulatePlanResult());
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    await service.plan(AGENT_ID, makePerceptionResult());

    expect(llm.completePlan).toHaveBeenCalledTimes(1);
    const payload = llm.completePlan.mock.calls[0]![0] as LLMContextPayload;
    expect(payload.responseSchema).toEqual(formulatePlanSchema);
    expect(payload.perceptionContext).toContain(ROOM_ID);
  });

  it('on success: stores plan, sets isThinking=false, returns success (AC-12, AC-24)', async () => {
    const llm = new FakeLLMClient(makeFormulatePlanResult());
    llm.completePlan = vi.fn().mockResolvedValue(makeFormulatePlanResult());
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());

    expect(result.success).toBe(true);
    expect(result.plan).toEqual(makeStoredPlan());
    expect(provider.storePlanCalls).toHaveLength(1);
    expect(provider.storePlanCalls[0]!.agentId).toBe(AGENT_ID);
    // isThinking must be set to false after success.
    expect(provider.setThinkingCalls).toContainEqual({ agentId: AGENT_ID, isThinking: false });
    // Final agent state should have isThinking=false.
    expect(provider.agentState?.isThinking).toBe(false);
  });

  it('on LLM throw: catches, sets isThinking=false, does not modify currentPlan, returns failure (AC-13, AC-25)', async () => {
    const llm = new FakeLLMClient(new Error('LLM connection refused'));
    llm.completePlan = vi.fn().mockRejectedValue(new Error('LLM connection refused'));
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());

    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM connection refused');
    expect(result.plan).toBeUndefined();
    // Must not have stored a plan.
    expect(provider.storePlanCalls).toHaveLength(0);
    // isThinking must be reset to false.
    expect(provider.setThinkingCalls).toContainEqual({ agentId: AGENT_ID, isThinking: false });
    expect(provider.agentState?.isThinking).toBe(false);
    // currentPlan must remain unchanged (null in this case).
    expect(provider.agentState?.currentPlan).toBeNull();
  });

  it('on LLM throw: currentPlan remains unchanged when it was null before (AC-25)', async () => {
    const llm = new FakeLLMClient(new Error('LLM connection refused'));
    llm.completePlan = vi.fn().mockRejectedValue(new Error('LLM connection refused'));
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());

    expect(result.success).toBe(false);
    // currentPlan was null before and must remain null — no plan created on failure.
    expect(provider.agentState?.currentPlan).toBeNull();
    // isThinking must be reset to false after failure.
    expect(provider.agentState?.isThinking).toBe(false);
  });

  it('when agent already has a non-null currentPlan: returns it without calling LLM (AC-14)', async () => {
    const existingPlan = makeStoredPlan();
    provider.agentState = makeAgentState({ currentPlan: existingPlan });
    const llm = new FakeLLMClient(makeFormulatePlanResult());
    llm.completePlan = vi.fn().mockResolvedValue(makeFormulatePlanResult());
    const builder = new PlanBuilderImpl();
    const builderSpy = vi.spyOn(builder, 'build');
    const service = new PlanServiceImpl({
      planBuilder: builder,
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());

    expect(result.success).toBe(true);
    expect(result.plan).toBe(existingPlan);
    // Must NOT have called the LLM or the builder.
    expect(llm.completePlan).not.toHaveBeenCalled();
    expect(builderSpy).not.toHaveBeenCalled();
    // Must NOT have toggled isThinking.
    expect(provider.setThinkingCalls).toHaveLength(0);
  });

  it('when completePlan returns invalid data (missing description): treats as failure (AC-23)', async () => {
    const invalid = { steps: [{ description: 'do something' }] } as unknown as FormulatePlanResult;
    const llm = new FakeLLMClient(invalid);
    llm.completePlan = vi.fn().mockResolvedValue(invalid);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // Must not have stored a plan.
    expect(provider.storePlanCalls).toHaveLength(0);
    // isThinking must be reset.
    expect(provider.agentState?.isThinking).toBe(false);
  });

  it('when completePlan returns invalid data (missing steps): treats as failure (AC-23)', async () => {
    const invalid = { description: 'a plan' } as unknown as FormulatePlanResult;
    const llm = new FakeLLMClient(invalid);
    llm.completePlan = vi.fn().mockResolvedValue(invalid);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(provider.storePlanCalls).toHaveLength(0);
    expect(provider.agentState?.isThinking).toBe(false);
  });
});
