import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Affordance,
  PerceptionResult,
  PassivePerception,
  FormulatePlanResult,
  AgentPlan,
  AgentInternalState,
  PlanDataProvider,
} from '@evol-hive/shared';
import { formulatePlanSchema } from '@evol-hive/shared';
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

const affordances: Affordance[] = [
  {
    id: 'brew_coffee',
    label: 'Brew coffee',
    engineEffect: 'brew_coffee',
    preconditions: [],
    effects: { energy: 20 },
  },
  {
    id: 'chat',
    label: 'Chat with friend',
    engineEffect: 'chat',
    preconditions: [],
    effects: { social: 10 },
  },
];

const validPlanResult: FormulatePlanResult = {
  description: 'Brew coffee to restore energy',
  steps: [
    { description: 'Go to coffee machine', targetAffordance: 'brew_coffee' },
    { description: 'Drink coffee' },
  ],
};

const invalidPlanResult: Partial<FormulatePlanResult> = {
  description: 'Missing steps',
  // steps is missing
};

const storedPlan: AgentPlan = {
  id: `plan_${AGENT_ID}_1700000000`,
  description: validPlanResult.description,
  steps: [
    { description: 'Go to coffee machine', completed: false, targetAffordance: 'brew_coffee' },
    { description: 'Drink coffee', completed: false },
  ],
  currentStepIndex: 0,
  createdAt: 100,
};

function makePerceptionResult(overrides: Partial<PerceptionResult> = {}): PerceptionResult {
  const passive: PassivePerception = {
    roomId: ROOM_ID,
    objectsPresent: objects,
    drives,
  };
  return {
    passive,
    prunedAffordances: affordances,
    primaryDriveLabel: 'low energy, need to restore energy',
    ...overrides,
  };
}

function makeAgentState(overrides: Partial<AgentInternalState> = {}): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { ...drives },
    currentGoal: '',
    currentPlan: null,
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
    ...overrides,
  };
}

// ─── Fake LLM Client ─────────────────────────────────────────────────────────

function makeLLMClient(
  result: FormulatePlanResult | Partial<FormulatePlanResult> | Error,
): LLMClient {
  const base: LLMClient = {
    completeStructured: vi.fn().mockResolvedValue({ reasoning: '', action: '' }),
    completeReflection: vi.fn().mockResolvedValue({
      agentId: AGENT_ID,
      newMemories: [],
      consolidatedNodeIds: [],
    }),
    completePlan: vi.fn(),
  };
  if (result instanceof Error) {
    (base.completePlan as ReturnType<typeof vi.fn>).mockRejectedValue(result);
  } else {
    (base.completePlan as ReturnType<typeof vi.fn>).mockResolvedValue(result);
  }
  return base;
}

// ─── Fake PlanDataProvider ───────────────────────────────────────────────────

function makeDataProvider(overrides: Partial<PlanDataProvider> = {}): PlanDataProvider {
  return {
    getAgentState: () => makeAgentState(),
    storePlan: () => storedPlan,
    setThinking: vi.fn(),
    ...overrides,
  };
}

// ─── PlanBuilderImpl ─────────────────────────────────────────────────────────

describe('PlanBuilderImpl.build (AC-4, AC-5, AC-6, AC-7, AC-26)', () => {
  let builder: PlanBuilderImpl;

  beforeEach(() => {
    builder = new PlanBuilderImpl();
  });

  it('returns an LLMContextPayload with responseSchema = formulatePlanSchema (AC-4)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.responseSchema).toEqual(formulatePlanSchema);
    // Explicitly NOT the action response schema
    expect(payload.responseSchema).not.toHaveProperty('properties.action');
  });

  it('perceptionContext contains room name and object names (AC-5)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).toContain(ROOM_ID);
    expect(payload.perceptionContext).toContain('Coffee Machine');
    expect(payload.perceptionContext).toContain('Kettle');
  });

  it('systemPrompt instructs the LLM to formulate a plan (AC-5)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.systemPrompt.toLowerCase()).toContain('plan');
    expect(payload.systemPrompt).toContain('formulate_plan');
  });

  it('includes the primary drive label in the system prompt or perception context (AC-5)', () => {
    const result = makePerceptionResult({
      primaryDriveLabel: 'low energy, need to restore energy',
    });
    const payload = builder.build(result);
    const combinedText = payload.systemPrompt + ' ' + payload.perceptionContext;
    expect(combinedText).toContain('energy');
  });

  it('includes systemFeedback in perceptionContext when present (AC-6)', () => {
    const result = makePerceptionResult({
      passive: {
        roomId: ROOM_ID,
        objectsPresent: objects,
        drives,
        systemFeedback: 'You tried to brew coffee but the machine has no water.',
      },
    });
    const payload = builder.build(result);
    expect(payload.perceptionContext).toContain(
      'You tried to brew coffee but the machine has no water.',
    );
  });

  it('sets availableAffordances to prunedAffordances from PerceptionResult (AC-7)', () => {
    const result = makePerceptionResult({ prunedAffordances: affordances });
    const payload = builder.build(result);
    expect(payload.availableAffordances).toBe(affordances);
  });

  it('sets cognitiveTools to the default cognitive tool catalog (AC-7)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.cognitiveTools).toEqual(defaultCognitiveTools);
  });

  it('perceptionContext does not contain any SmartObject.state fields (AC-26)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).not.toContain('water_level');
    expect(payload.perceptionContext).not.toContain('bean_count');
    // The context should only have object names, not deep state
    const objectNames = objects.map((o) => o.name);
    for (const name of objectNames) {
      expect(payload.perceptionContext).toContain(name);
    }
  });
});

// ─── PlanServiceImpl ─────────────────────────────────────────────────────────

describe('PlanServiceImpl.plan (AC-9 through AC-14, AC-23, AC-24, AC-25)', () => {
  let builder: { build: ReturnType<typeof vi.fn> };
  let llmClient: LLMClient;
  let dataProvider: PlanDataProvider;

  beforeEach(() => {
    builder = { build: vi.fn().mockReturnValue({} as LLMContextPayload) };
    llmClient = makeLLMClient(validPlanResult);
    dataProvider = makeDataProvider();
  });

  it('is defined in packages/cognition/src/pper/plan-service.ts and exported (AC-9)', () => {
    expect(PlanServiceImpl).toBeDefined();
    expect(typeof PlanServiceImpl).toBe('function');
  });

  it('calls dataProvider.setThinking(agentId, true) before LLM invocation (AC-10)', async () => {
    const setThinking = vi.fn();
    const dp = makeDataProvider({ setThinking });
    const service = new PlanServiceImpl({
      planBuilder: builder as any,
      llmClient,
      dataProvider: dp,
    });
    await service.plan(AGENT_ID, makePerceptionResult());

    // setThinking(true) should have been called before setThinking(false)
    const trueCall = setThinking.mock.calls.find((c) => c[1] === true);
    const falseCall = setThinking.mock.calls.find((c) => c[1] === false);
    expect(trueCall).toBeDefined();
    expect(falseCall).toBeDefined();
    expect(setThinking.mock.calls.indexOf(trueCall!)).toBeLessThan(
      setThinking.mock.calls.indexOf(falseCall!),
    );
  });

  it('calls planBuilder.build(perceptionResult) and passes result to llmClient.completePlan (AC-11)', async () => {
    const payload = { systemPrompt: 'test' } as unknown as LLMContextPayload;
    const localBuilder = { build: vi.fn().mockReturnValue(payload) };
    const localLLM = makeLLMClient(validPlanResult);
    const service = new PlanServiceImpl({
      planBuilder: localBuilder as any,
      llmClient: localLLM,
      dataProvider,
    });
    const perceptionResult = makePerceptionResult();
    await service.plan(AGENT_ID, perceptionResult);

    expect(localBuilder.build).toHaveBeenCalledWith(perceptionResult);
    expect(localLLM.completePlan).toHaveBeenCalledWith(payload);
  });

  it('on success: stores plan, sets thinking false, returns PlanResult { success: true, plan } (AC-12)', async () => {
    const storePlan = vi.fn().mockReturnValue(storedPlan);
    const setThinking = vi.fn();
    const dp = makeDataProvider({ storePlan, setThinking });
    const service = new PlanServiceImpl({
      planBuilder: builder as any,
      llmClient,
      dataProvider: dp,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());

    expect(result.success).toBe(true);
    expect(result.plan).toEqual(storedPlan);
    expect(result.error).toBeUndefined();
    expect(storePlan).toHaveBeenCalledWith(AGENT_ID, validPlanResult);
    expect(setThinking).toHaveBeenCalledWith(AGENT_ID, false);
  });

  it('on LLM error: catches, sets thinking false, does not modify currentPlan, returns failure (AC-13, AC-25)', async () => {
    const storePlan = vi.fn();
    const setThinking = vi.fn();
    // Agent starts with NO plan (currentPlan: null) so the LLM call is attempted.
    const dp = makeDataProvider({
      getAgentState: () => makeAgentState({ currentPlan: null }),
      storePlan,
      setThinking,
    });
    const errorLLM = makeLLMClient(new Error('LLM timeout'));
    const service = new PlanServiceImpl({
      planBuilder: builder as any,
      llmClient: errorLLM,
      dataProvider: dp,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());

    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM timeout');
    expect(result.plan).toBeUndefined();
    expect(storePlan).not.toHaveBeenCalled();
    expect(setThinking).toHaveBeenCalledWith(AGENT_ID, false);
    // currentPlan should not have been changed - verify the agent state still has null
    const state = dp.getAgentState(AGENT_ID);
    expect(state?.currentPlan).toBeNull();
  });

  it('when agent already has a non-null currentPlan: returns existing plan without calling LLM (AC-14)', async () => {
    const existingPlan: AgentPlan = {
      id: 'existing-plan-1',
      description: 'Active plan',
      steps: [{ description: 'Step 1', completed: false }],
      currentStepIndex: 0,
      createdAt: 50,
    };
    const dp = makeDataProvider({
      getAgentState: () => makeAgentState({ currentPlan: existingPlan }),
    });
    const localBuilder = { build: vi.fn() };
    const localLLM = makeLLMClient(validPlanResult);
    const service = new PlanServiceImpl({
      planBuilder: localBuilder as any,
      llmClient: localLLM,
      dataProvider: dp,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());

    expect(result.success).toBe(true);
    expect(result.plan).toEqual(existingPlan);
    expect(localBuilder.build).not.toHaveBeenCalled();
    expect(localLLM.completePlan).not.toHaveBeenCalled();
  });

  it('when completePlan returns invalid data (missing steps): treats as failure (AC-23)', async () => {
    const storePlan = vi.fn();
    const dp = makeDataProvider({ storePlan });
    const invalidLLM = makeLLMClient(invalidPlanResult as FormulatePlanResult);
    const service = new PlanServiceImpl({
      planBuilder: builder as any,
      llmClient: invalidLLM,
      dataProvider: dp,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(storePlan).not.toHaveBeenCalled();
  });

  it('after a successful plan call, isThinking is false (AC-24)', async () => {
    const setThinking = vi.fn();
    const dp = makeDataProvider({ setThinking });
    const service = new PlanServiceImpl({
      planBuilder: builder as any,
      llmClient,
      dataProvider: dp,
    });
    await service.plan(AGENT_ID, makePerceptionResult());

    // The last setThinking call should be (agentId, false)
    const lastCall = setThinking.mock.calls[setThinking.mock.calls.length - 1];
    expect(lastCall).toEqual([AGENT_ID, false]);
  });

  it('after a failed plan call, isThinking is false (AC-25)', async () => {
    const setThinking = vi.fn();
    const dp = makeDataProvider({ setThinking });
    const errorLLM = makeLLMClient(new Error('connection refused'));
    const service = new PlanServiceImpl({
      planBuilder: builder as any,
      llmClient: errorLLM,
      dataProvider: dp,
    });
    await service.plan(AGENT_ID, makePerceptionResult());

    const lastCall = setThinking.mock.calls[setThinking.mock.calls.length - 1];
    expect(lastCall).toEqual([AGENT_ID, false]);
  });
});
