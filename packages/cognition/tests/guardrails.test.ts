/**
 * Spec 016 — Cognitive Guardrails (Cognition Layer)
 * ==================================================
 * Acceptance Criteria: AC-7 through AC-22
 *
 * Tests for:
 *   - GuardrailEngineImpl.maskAffordances (AC-7, AC-8, AC-9)
 *   - GuardrailEngineImpl.validateAction (AC-10, AC-11, AC-12, AC-13, AC-14, AC-26)
 *   - PerceptionServiceImpl affordance masking integration (AC-15, AC-16)
 *   - PlanBuilderImpl contextual forcing (AC-17)
 *   - PerceptionBuilderImpl contextual forcing + tool masking (AC-18, AC-19)
 *   - ExecuteServiceImpl plan validation (AC-20, AC-21)
 *   - PPEROrchestratorImpl deviation routing (AC-22)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Affordance,
  AgentInternalState,
  AgentPlan,
  AffordanceResult,
  ExecuteDataProvider,
  ExecuteResult,
  GuardrailConfig,
  PerceptionDataProvider,
  PerceptionResult,
  PlanDataProvider,
  PlanStep,
  ReflectDataProvider,
} from '@evol-hive/shared';
import {
  GUARDRAIL_FORCING_DIRECTIVE,
  GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload, GuardrailEngine } from '../src/index.js';
import { GuardrailEngineImpl } from '../src/guardrails/index.js';
import { PerceptionServiceImpl } from '../src/pper/index.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { PlanServiceImpl } from '../src/pper/plan-service.js';
import { ExecuteServiceImpl } from '../src/pper/execute-service.js';
import { PPEROrchestratorImpl } from '../src/pper/orchestrator.js';
import type { AffordanceClassifier } from '../src/classifier/index.js';
import { chooseActionTool } from '@evol-hive/shared';

// ─── Test Data ───────────────────────────────────────────────────────────────

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

const affordances: Affordance[] = [
  {
    id: 'brew_coffee',
    label: 'Brew coffee',
    engineEffect: 'brew_coffee',
    preconditions: [],
    effects: { energy: 20 },
  },
  {
    id: 'sleep',
    label: 'Sleep',
    engineEffect: 'sleep',
    preconditions: [],
    effects: { energy: 30 },
  },
  { id: 'chat', label: 'Chat', engineEffect: 'chat', preconditions: [], effects: { social: 10 } },
];

function makePlan(currentStepTarget?: string): AgentPlan {
  return {
    id: 'plan-1',
    description: 'Restore energy',
    steps: [
      {
        description: 'Brew coffee',
        completed: false,
        ...(currentStepTarget !== undefined ? { targetAffordance: currentStepTarget } : {}),
      },
    ],
    currentStepIndex: 0,
    createdAt: 100,
  };
}

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

const allOnConfig: GuardrailConfig = {
  affordanceMasking: true,
  contextualForcing: true,
  planValidation: true,
};
const allOffConfig: GuardrailConfig = {
  affordanceMasking: false,
  contextualForcing: false,
  planValidation: false,
};

// ─── AC-7, AC-8, AC-9: maskAffordances ───────────────────────────────────────

describe('GuardrailEngineImpl.maskAffordances', () => {
  it('AC-7: returns [] when affordanceMasking === true and hasPlan === false', () => {
    const engine = new GuardrailEngineImpl(allOnConfig);
    const result = engine.maskAffordances(affordances, false);
    expect(result).toEqual([]);
  });

  it('AC-8: returns affordances unchanged when hasPlan === true (regardless of config)', () => {
    const engine = new GuardrailEngineImpl(allOnConfig);
    const result = engine.maskAffordances(affordances, true);
    expect(result).toBe(affordances);
  });

  it('AC-8: returns affordances unchanged when hasPlan === true even with masking on', () => {
    const engine = new GuardrailEngineImpl({
      affordanceMasking: true,
      contextualForcing: false,
      planValidation: false,
    });
    const result = engine.maskAffordances(affordances, true);
    expect(result).toEqual(affordances);
  });

  it('AC-9: returns affordances unchanged when affordanceMasking === false and hasPlan === false', () => {
    const engine = new GuardrailEngineImpl(allOffConfig);
    const result = engine.maskAffordances(affordances, false);
    expect(result).toBe(affordances);
  });
});

// ─── AC-10 through AC-14: validateAction ─────────────────────────────────────

describe('GuardrailEngineImpl.validateAction', () => {
  it('AC-10: returns { valid: true } when action matches current step targetAffordance', () => {
    const engine = new GuardrailEngineImpl(allOnConfig);
    const plan = makePlan('brew_coffee');
    const result = engine.validateAction('brew_coffee', plan);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('AC-11: returns { valid: false, reason } when action deviates from plan', () => {
    const engine = new GuardrailEngineImpl(allOnConfig);
    const plan = makePlan('brew_coffee');
    const result = engine.validateAction('sleep', plan);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe(GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE.replace('{action}', 'sleep'));
  });

  it('AC-12: returns { valid: true } for cognitive tool "formulate_plan" regardless of plan', () => {
    const engine = new GuardrailEngineImpl(allOnConfig);
    const plan = makePlan('brew_coffee');
    expect(engine.validateAction('formulate_plan', plan).valid).toBe(true);
  });

  it('AC-12: returns { valid: true } for cognitive tool "query_memory"', () => {
    const engine = new GuardrailEngineImpl(allOnConfig);
    const plan = makePlan('brew_coffee');
    expect(engine.validateAction('query_memory', plan).valid).toBe(true);
  });

  it('AC-12: returns { valid: true } for cognitive tool "update_internal_state"', () => {
    const engine = new GuardrailEngineImpl(allOnConfig);
    const plan = makePlan('brew_coffee');
    expect(engine.validateAction('update_internal_state', plan).valid).toBe(true);
  });

  it('AC-13: returns { valid: true } when plan is null (no validation)', () => {
    const engine = new GuardrailEngineImpl(allOnConfig);
    const result = engine.validateAction('brew_coffee', null);
    expect(result.valid).toBe(true);
  });

  it('AC-14: returns { valid: true } when planValidation === false', () => {
    const engine = new GuardrailEngineImpl({
      affordanceMasking: true,
      contextualForcing: true,
      planValidation: false,
    });
    const plan = makePlan('brew_coffee');
    const result = engine.validateAction('sleep', plan);
    expect(result.valid).toBe(true);
  });

  it('AC-26: all flags false — validateAction does not reject', () => {
    const engine = new GuardrailEngineImpl(allOffConfig);
    const plan = makePlan('brew_coffee');
    expect(engine.validateAction('sleep', plan).valid).toBe(true);
  });

  it('AC-26: all flags false — maskAffordances does not mask', () => {
    const engine = new GuardrailEngineImpl(allOffConfig);
    expect(engine.maskAffordances(affordances, false)).toBe(affordances);
  });

  it('deviates when current step has no targetAffordance but action is physical', () => {
    const engine = new GuardrailEngineImpl(allOnConfig);
    const plan = makePlan(undefined);
    const result = engine.validateAction('brew_coffee', plan);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('deviates');
  });
});

// ─── GuardrailEngineImpl.config ──────────────────────────────────────────────

describe('GuardrailEngineImpl.config', () => {
  it('exposes the config passed to the constructor', () => {
    const engine = new GuardrailEngineImpl(allOnConfig);
    expect(engine.config).toEqual(allOnConfig);
  });
});

// ─── AC-15, AC-16: PerceptionServiceImpl affordance masking ──────────────────

function makeClassifier(): AffordanceClassifier {
  return {
    async prune(_drive, affs) {
      return affs;
    },
  };
}

function makePerceptionProvider(
  state: AgentInternalState,
  affs: Affordance[] = affordances,
): PerceptionDataProvider {
  return {
    getAgentLocation: () => state.location,
    getObjectsInRoom: () => [{ id: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
    getAffordancesInRoom: () => affs,
    getAgentDrives: () => ({ ...state.drives }),
    getPrimaryDriveLabel: () => 'low energy',
    getSystemFeedback: () => undefined,
    getAgentState: () => state,
  };
}

describe('PerceptionServiceImpl — affordance masking (AC-15, AC-16)', () => {
  it('AC-15: prunedAffordances is [] when no plan and masking enabled', async () => {
    const state = makeAgentState({ currentPlan: null });
    const provider = makePerceptionProvider(state);
    const guardrail = new GuardrailEngineImpl(allOnConfig);
    const service = new PerceptionServiceImpl({
      provider,
      classifier: makeClassifier(),
      ...(guardrail !== undefined ? { guardrail } : {}),
    });
    const result = await service.perceive(AGENT_ID);
    expect(result.prunedAffordances).toEqual([]);
  });

  it('AC-16: prunedAffordances is unchanged when agent has a plan and masking enabled', async () => {
    const state = makeAgentState({ currentPlan: makePlan('brew_coffee') });
    const provider = makePerceptionProvider(state);
    const guardrail = new GuardrailEngineImpl(allOnConfig);
    const service = new PerceptionServiceImpl({
      provider,
      classifier: makeClassifier(),
      guardrail,
    });
    const result = await service.perceive(AGENT_ID);
    expect(result.prunedAffordances).toEqual(affordances);
  });

  it('without guardrail: prunedAffordances unchanged (backward compat)', async () => {
    const state = makeAgentState({ currentPlan: null });
    const provider = makePerceptionProvider(state);
    const service = new PerceptionServiceImpl({
      provider,
      classifier: makeClassifier(),
    });
    const result = await service.perceive(AGENT_ID);
    expect(result.prunedAffordances).toEqual(affordances);
  });

  it('masking disabled: prunedAffordances unchanged even without plan', async () => {
    const state = makeAgentState({ currentPlan: null });
    const provider = makePerceptionProvider(state);
    const guardrail = new GuardrailEngineImpl(allOffConfig);
    const service = new PerceptionServiceImpl({
      provider,
      classifier: makeClassifier(),
      guardrail,
    });
    const result = await service.perceive(AGENT_ID);
    expect(result.prunedAffordances).toEqual(affordances);
  });
});

// ─── AC-17: PlanBuilderImpl contextual forcing ───────────────────────────────

function makePerceptionResult(hasPlan: boolean): PerceptionResult {
  return {
    passive: {
      roomId: ROOM_ID,
      objectsPresent: [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
      drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    },
    prunedAffordances: affordances,
    primaryDriveLabel: 'low energy',
  };
}

describe('PlanBuilderImpl — contextual forcing (AC-17)', () => {
  it('AC-17: systemPrompt contains GUARDRAIL_FORCING_DIRECTIVE when no plan and forcing enabled', () => {
    const builder = new PlanBuilderImpl();
    const payload = builder.build(makePerceptionResult(false), {
      hasPlan: false,
      forcingEnabled: true,
    });
    expect(payload.systemPrompt).toContain(GUARDRAIL_FORCING_DIRECTIVE);
  });

  it('does not contain forcing directive when hasPlan is true', () => {
    const builder = new PlanBuilderImpl();
    const payload = builder.build(makePerceptionResult(true), {
      hasPlan: true,
      forcingEnabled: true,
    });
    expect(payload.systemPrompt).not.toContain(GUARDRAIL_FORCING_DIRECTIVE);
  });

  it('does not contain forcing directive when forcingEnabled is false', () => {
    const builder = new PlanBuilderImpl();
    const payload = builder.build(makePerceptionResult(false), {
      hasPlan: false,
      forcingEnabled: false,
    });
    expect(payload.systemPrompt).not.toContain(GUARDRAIL_FORCING_DIRECTIVE);
  });

  it('does not contain forcing directive when options are omitted (backward compat)', () => {
    const builder = new PlanBuilderImpl();
    const payload = builder.build(makePerceptionResult(false));
    expect(payload.systemPrompt).not.toContain(GUARDRAIL_FORCING_DIRECTIVE);
  });
});

// ─── AC-18, AC-19: PerceptionBuilderImpl contextual forcing + tool masking ──

describe('PerceptionBuilderImpl — contextual forcing + tool masking (AC-18, AC-19)', () => {
  it('AC-18: systemPrompt contains GUARDRAIL_FORCING_DIRECTIVE when no plan and forcing enabled', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult(false), {
      hasPlan: false,
      forcingEnabled: true,
    });
    expect(payload.systemPrompt).toContain(GUARDRAIL_FORCING_DIRECTIVE);
  });

  it('AC-19: tools contain only cognitive tool definitions (no chooseActionTool) when no plan and masking enabled', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult(false), {
      hasPlan: false,
      maskingEnabled: true,
    });
    expect(payload.tools).toBeDefined();
    expect(payload.tools.some((t) => t.function.name === 'choose_action')).toBe(false);
    // Cognitive tools should still be present.
    expect(payload.tools.some((t) => t.function.name === 'formulate_plan')).toBe(true);
  });

  it('AC-19: availableAffordances is [] when no plan and masking enabled', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult(false), {
      hasPlan: false,
      maskingEnabled: true,
    });
    expect(payload.availableAffordances).toEqual([]);
  });

  it('tools include chooseActionTool when hasPlan is true', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult(true), {
      hasPlan: true,
      maskingEnabled: true,
    });
    expect(payload.tools.some((t) => t.function.name === 'choose_action')).toBe(true);
  });

  it('tools include chooseActionTool when masking is disabled and no plan', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult(false), {
      hasPlan: false,
      maskingEnabled: false,
    });
    expect(payload.tools.some((t) => t.function.name === 'choose_action')).toBe(true);
  });

  it('backward compat: no options — tools include chooseActionTool', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult(false));
    expect(payload.tools.some((t) => t.function.name === 'choose_action')).toBe(true);
  });
});

// ─── AC-20, AC-21: ExecuteServiceImpl plan validation ────────────────────────

class FakeExecuteProvider implements ExecuteDataProvider {
  agentState: AgentInternalState | null = makeAgentState({ currentPlan: makePlan('brew_coffee') });
  currentStep: PlanStep | null = {
    description: 'Brew',
    completed: false,
    targetAffordance: 'brew_coffee',
  };
  resolvedAffordance: { objectId: string; affordance: Affordance } | null = {
    objectId: 'coffee-1',
    affordance: affordances[0]!,
  };
  preconditionResult = { satisfied: true, failed: [] as string[] };
  affordanceResult: AffordanceResult = { success: true, driveChanges: { energy: 20 } };
  planComplete = false;

  executeAffordanceCalls: { objectId: string; affordanceId: string; agentId: string }[] = [];
  setSystemFeedbackCalls: { agentId: string; feedback: string }[] = [];
  setThinkingCalls: { agentId: string; isThinking: boolean }[] = [];
  advanceStepCalls: string[] = [];

  getAgentState(): AgentInternalState | null {
    return this.agentState;
  }
  getCurrentStep(): PlanStep | null {
    return this.currentStep;
  }
  isPlanComplete(): boolean {
    return this.planComplete;
  }
  resolveAffordance(): { objectId: string; affordance: Affordance } | null {
    return this.resolvedAffordance;
  }
  checkPreconditions(): { satisfied: boolean; failed: string[] } {
    return this.preconditionResult;
  }
  async executeAffordance(
    objectId: string,
    affordanceId: string,
    agentId: string,
  ): Promise<AffordanceResult> {
    this.executeAffordanceCalls.push({ objectId, affordanceId, agentId });
    return this.affordanceResult;
  }
  advanceStep(agentId: string): void {
    this.advanceStepCalls.push(agentId);
  }
  applyDriveChanges(): void {}
  setSystemFeedback(agentId: string, feedback: string): void {
    this.setSystemFeedbackCalls.push({ agentId, feedback });
  }
  setThinking(agentId: string, isThinking: boolean): void {
    this.setThinkingCalls.push({ agentId, isThinking });
  }
}

describe('ExecuteServiceImpl — plan validation (AC-20, AC-21)', () => {
  let provider: FakeExecuteProvider;

  beforeEach(() => {
    provider = new FakeExecuteProvider();
  });

  it('AC-20: deviation returns { success: false, deviationRejected: true, error with feedback }', async () => {
    // Override current step to target a different affordance than the action.
    // In the deterministic flow, validateAction is called with step.targetAffordance vs currentPlan.
    // We make the plan's current step target 'brew_coffee' but the guardrail validates
    // against a mismatched action. Since execute reads step.targetAffordance, we need
    // the step target to differ from what the plan's current step "should" be.
    // Actually validateAction(step.targetAffordance, agentState.currentPlan) —
    // the plan's current step targetAffordance should match step.targetAffordance normally.
    // To create a deviation, we make the plan's current step have a different target.
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan-1',
        description: 'Sleep plan',
        steps: [{ description: 'Sleep', completed: false, targetAffordance: 'sleep' }],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.currentStep = {
      description: 'Brew',
      completed: false,
      targetAffordance: 'brew_coffee',
    };
    const guardrail = new GuardrailEngineImpl(allOnConfig);
    const service = new ExecuteServiceImpl({ dataProvider: provider, guardrail });
    const result = await service.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.deviationRejected).toBe(true);
    expect(result.error).toContain('deviates');
  });

  it('AC-21: setSystemFeedback called with deviation reason and affordance NOT executed', async () => {
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan-1',
        description: 'Sleep plan',
        steps: [{ description: 'Sleep', completed: false, targetAffordance: 'sleep' }],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.currentStep = {
      description: 'Brew',
      completed: false,
      targetAffordance: 'brew_coffee',
    };
    const guardrail = new GuardrailEngineImpl(allOnConfig);
    const service = new ExecuteServiceImpl({ dataProvider: provider, guardrail });
    await service.execute(AGENT_ID);

    expect(provider.setSystemFeedbackCalls).toHaveLength(1);
    expect(provider.setSystemFeedbackCalls[0]!.feedback).toContain('deviates');
    expect(provider.executeAffordanceCalls).toHaveLength(0);
  });

  it('AC-21: setThinking(false) called on deviation rejection', async () => {
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan-1',
        description: 'Sleep plan',
        steps: [{ description: 'Sleep', completed: false, targetAffordance: 'sleep' }],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.currentStep = {
      description: 'Brew',
      completed: false,
      targetAffordance: 'brew_coffee',
    };
    const guardrail = new GuardrailEngineImpl(allOnConfig);
    const service = new ExecuteServiceImpl({ dataProvider: provider, guardrail });
    await service.execute(AGENT_ID);
    expect(provider.setThinkingCalls).toContainEqual({ agentId: AGENT_ID, isThinking: false });
  });

  it('no guardrail: normal execution proceeds (backward compat)', async () => {
    provider.agentState = makeAgentState({ currentPlan: makePlan('brew_coffee') });
    provider.currentStep = {
      description: 'Brew',
      completed: false,
      targetAffordance: 'brew_coffee',
    };
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);
    expect(result.success).toBe(true);
    expect(result.deviationRejected).toBeUndefined();
    expect(provider.executeAffordanceCalls).toHaveLength(1);
  });

  it('planValidation disabled: action proceeds even if it deviates', async () => {
    provider.agentState = makeAgentState({
      currentPlan: {
        id: 'plan-1',
        description: 'Sleep plan',
        steps: [{ description: 'Sleep', completed: false, targetAffordance: 'sleep' }],
        currentStepIndex: 0,
        createdAt: 100,
      },
    });
    provider.currentStep = {
      description: 'Brew',
      completed: false,
      targetAffordance: 'brew_coffee',
    };
    const guardrail = new GuardrailEngineImpl({
      affordanceMasking: true,
      contextualForcing: true,
      planValidation: false,
    });
    const service = new ExecuteServiceImpl({ dataProvider: provider, guardrail });
    const result = await service.execute(AGENT_ID);
    expect(result.success).toBe(true);
    expect(result.deviationRejected).toBeUndefined();
  });
});

// ─── AC-22: PPEROrchestratorImpl deviation routing ───────────────────────────

function makePlanProvider(state: AgentInternalState): PlanDataProvider {
  return {
    getAgentState: () => state,
    storePlan: (_id, result) => {
      const plan: AgentPlan = {
        id: 'plan-1',
        description: result.description,
        steps: result.steps.map((s) => ({
          description: s.description,
          completed: false,
          ...(s.targetAffordance !== undefined ? { targetAffordance: s.targetAffordance } : {}),
        })),
        currentStepIndex: 0,
        createdAt: 0,
      };
      state.currentPlan = plan;
      return plan;
    },
    setThinking: (_id, v) => {
      state.isThinking = v;
    },
  };
}

function makeReflectProvider(state: AgentInternalState): ReflectDataProvider {
  return {
    getAgentState: () => state,
    applyDriveChanges: () => {},
    updateGoal: (_id, goal) => {
      state.currentGoal = goal;
    },
    storeMemory: async () => {},
    clearPlanIfComplete: () => {
      state.currentPlan = null;
      return true;
    },
    setThinking: (_id, v) => {
      state.isThinking = v;
    },
  };
}

function makeMockLLM(): LLMClient {
  return {
    completeStructured: vi.fn().mockResolvedValue({ reasoning: 'r', action: 'brew_coffee' }),
    completeReflection: vi
      .fn()
      .mockResolvedValue({ agentId: AGENT_ID, newMemories: [], consolidatedNodeIds: [] }),
    completePlan: vi.fn().mockResolvedValue({
      description: 'Brew coffee',
      steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
    }),
    completeReflect: vi
      .fn()
      .mockResolvedValue({ memoryEntry: { content: 'reflected', importance: 5, type: 'action' } }),
  };
}

describe('PPEROrchestratorImpl — deviation routing (AC-22)', () => {
  it('AC-22: routes to Reflect phase when deviationRejected === true (no cycle failure recorded)', async () => {
    const state = makeAgentState({ currentPlan: null });
    const reflectProvider = makeReflectProvider(state);
    let reflectCalled = false;
    const reflectSpy: ReflectDataProvider = {
      ...reflectProvider,
      storeMemory: async () => {
        reflectCalled = true;
      },
    };

    // Plan provider stores a plan whose step targets 'sleep'.
    const planProvider = makePlanProvider(state);
    planProvider.storePlan = (_id, _result) => {
      const plan: AgentPlan = {
        id: 'plan-1',
        description: 'Sleep plan',
        steps: [{ description: 'Sleep', completed: false, targetAffordance: 'sleep' }],
        currentStepIndex: 0,
        createdAt: 0,
      };
      state.currentPlan = plan;
      return plan;
    };

    // Execute provider: current step targets 'brew_coffee' (deviates from plan's 'sleep').
    const executeProvider: ExecuteDataProvider = {
      getAgentState: () => state,
      getCurrentStep: () => ({
        description: 'Brew',
        completed: false,
        targetAffordance: 'brew_coffee',
      }),
      isPlanComplete: () => false,
      resolveAffordance: () => ({ objectId: 'coffee-1', affordance: affordances[0]! }),
      checkPreconditions: () => ({ satisfied: true, failed: [] }),
      executeAffordance: async () => ({ success: true, driveChanges: { energy: 20 } }),
      advanceStep: () => {},
      applyDriveChanges: () => {},
      setSystemFeedback: () => {},
      setThinking: (_id, v) => {
        state.isThinking = v;
      },
    };

    const perceptionProvider = makePerceptionProvider(state);
    const guardrail = new GuardrailEngineImpl(allOnConfig);
    const llm = makeMockLLM();

    const orch = new PPEROrchestratorImpl({
      perceptionProvider,
      planProvider,
      executeProvider,
      reflectProvider: reflectSpy,
      classifier: makeClassifier(),
      llmClient: llm,
      guardrail,
    });

    await orch.runCycle(AGENT_ID);

    // Reflect must have been called.
    expect(reflectCalled).toBe(true);
    // No cycle failure recorded — consecutiveFailures should be 0.
    const status = orch.getCycleStatus(AGENT_ID);
    expect(status.consecutiveFailures).toBe(0);
  });

  it('AC-22: non-deviation execute failure still records a cycle failure', async () => {
    const state = makeAgentState({ currentPlan: null });
    const reflectProvider = makeReflectProvider(state);

    const planProvider = makePlanProvider(state);
    // Make execute return a generic failure (not deviation).
    const executeProvider: ExecuteDataProvider = {
      getAgentState: () => state,
      getCurrentStep: () => ({
        description: 'Brew',
        completed: false,
        targetAffordance: 'brew_coffee',
      }),
      isPlanComplete: () => false,
      resolveAffordance: () => null, // unresolvable → skipped, not deviation
      checkPreconditions: () => ({ satisfied: false, failed: ['has_water'] }),
      executeAffordance: async () => ({ success: false, failureReason: 'broken' }),
      advanceStep: () => {},
      applyDriveChanges: () => {},
      setSystemFeedback: () => {},
      setThinking: (_id, v) => {
        state.isThinking = v;
      },
    };

    // Force precondition failure by making resolveAffordance return an object but preconditions fail.
    executeProvider.resolveAffordance = () => ({
      objectId: 'coffee-1',
      affordance: affordances[0]!,
    });
    executeProvider.checkPreconditions = () => ({ satisfied: false, failed: ['has_water'] });

    const perceptionProvider = makePerceptionProvider(state);
    const guardrail = new GuardrailEngineImpl(allOnConfig);
    const llm = makeMockLLM();

    const orch = new PPEROrchestratorImpl({
      perceptionProvider,
      planProvider,
      executeProvider,
      reflectProvider,
      classifier: makeClassifier(),
      llmClient: llm,
      guardrail,
    });

    await orch.runCycle(AGENT_ID);

    const status = orch.getCycleStatus(AGENT_ID);
    expect(status.consecutiveFailures).toBe(1);
  });

  it('without guardrail: orchestrator still works (backward compat)', async () => {
    const state = makeAgentState({ currentPlan: null });
    const planProvider = makePlanProvider(state);
    const executeProvider: ExecuteDataProvider = {
      getAgentState: () => state,
      getCurrentStep: () => ({
        description: 'Brew',
        completed: false,
        targetAffordance: 'brew_coffee',
      }),
      isPlanComplete: () => false,
      resolveAffordance: () => ({ objectId: 'coffee-1', affordance: affordances[0]! }),
      checkPreconditions: () => ({ satisfied: true, failed: [] }),
      executeAffordance: async () => ({ success: true, driveChanges: { energy: 20 } }),
      advanceStep: () => {},
      applyDriveChanges: () => {},
      setSystemFeedback: () => {},
      setThinking: (_id, v) => {
        state.isThinking = v;
      },
    };
    const reflectProvider = makeReflectProvider(state);
    const perceptionProvider = makePerceptionProvider(state);
    const llm = makeMockLLM();

    const orch = new PPEROrchestratorImpl({
      perceptionProvider,
      planProvider,
      executeProvider,
      reflectProvider,
      classifier: makeClassifier(),
      llmClient: llm,
    });

    await orch.runCycle(AGENT_ID);
    expect(orch.getCycleStatus(AGENT_ID).consecutiveFailures).toBe(0);
  });
});
