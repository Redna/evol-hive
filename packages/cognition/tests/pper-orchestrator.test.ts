/**
 * Tests for the PPEROrchestratorImpl and its factory.
 * Covers AC-14, AC-15, AC-16, AC-17.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  PerceptionDataProvider,
  PlanDataProvider,
  ExecuteDataProvider,
  ReflectDataProvider,
  PerceptionResult,
  PlanResult,
  ExecuteResult,
  ReflectResult,
  AgentInternalState,
  AgentPlan,
  Affordance,
  FormulatePlanResult,
  ReflectLLMResponse,
  LLMActionResponse,
  ReflectionResult,
  MemorySnippet,
  PPERPhase,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '../src/index.js';
import type { AffordanceClassifier } from '../src/classifier/index.js';
import { PPEROrchestratorImpl, createPPEROrchestrator } from '../src/pper/orchestrator.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

function makeState(agentId = 'a1'): AgentInternalState {
  return {
    agentId,
    drives: { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    currentGoal: '',
    currentPlan: null,
    isThinking: false,
    location: 'kitchen',
    lastPerceptionTick: 0,
  };
}

function makePerceptionProvider(state: AgentInternalState): PerceptionDataProvider {
  return {
    getAgentLocation: () => state.location,
    getObjectsInRoom: () => [{ id: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
    getAffordancesInRoom: () => [] as Affordance[],
    getAgentDrives: () => ({ ...state.drives }),
    getPrimaryDriveLabel: () => 'low energy, need to restore energy',
    getSystemFeedback: () => undefined,
  };
}

function makePlanProvider(state: AgentInternalState): PlanDataProvider {
  return {
    getAgentState: () => state,
    storePlan: (_id, result) => {
      const plan = {
        id: 'plan-1',
        description: result.description,
        steps: result.steps.map((s) => ({ description: s.description, completed: false })),
        currentStepIndex: 0,
        createdAt: 0,
      } as AgentPlan;
      state.currentPlan = plan;
      return plan;
    },
    setThinking: (id, v) => {
      state.isThinking = v;
    },
  };
}

function makeExecuteProvider(state: AgentInternalState): ExecuteDataProvider {
  return {
    getAgentState: () => state,
    getCurrentStep: () => ({
      description: 'brew',
      completed: false,
      targetAffordance: 'brew_coffee',
    }),
    isPlanComplete: () => false,
    resolveAffordance: () => ({
      objectId: 'coffee-1',
      affordance: {
        id: 'brew_coffee',
        label: 'Brew coffee',
        engineEffect: 'brew_coffee',
        preconditions: [],
        effects: { energy: 20 },
      },
    }),
    checkPreconditions: () => ({ satisfied: true, failed: [] }),
    executeAffordance: async () => ({ success: true, driveChanges: { energy: 20 } }),
    advanceStep: () => {
      state.currentPlan = state.currentPlan
        ? { ...state.currentPlan, currentStepIndex: state.currentPlan.steps.length }
        : null;
    },
    applyDriveChanges: () => {},
    setSystemFeedback: () => {},
    setThinking: (id, v) => {
      state.isThinking = v;
    },
  };
}

function makeReflectProvider(state: AgentInternalState): ReflectDataProvider {
  return {
    getAgentState: () => state,
    applyDriveChanges: () => {},
    updateGoal: (id, goal) => {
      state.currentGoal = goal;
    },
    storeMemory: async () => {},
    clearPlanIfComplete: () => {
      state.currentPlan = null;
      return true;
    },
    setThinking: (id, v) => {
      state.isThinking = v;
    },
  };
}

function makeClassifier(): AffordanceClassifier {
  return {
    async prune(_drive, affordances) {
      return affordances;
    },
  };
}

function makeMockLLM(): LLMClient {
  return {
    async completeStructured(_payload: LLMContextPayload): Promise<LLMActionResponse> {
      return { reasoning: 'r', action: 'brew_coffee' };
    },
    async completeReflection(_system, _mem): Promise<ReflectionResult> {
      return { agentId: 'a1', newMemories: [], consolidatedNodeIds: [] };
    },
    async completePlan(_payload: LLMContextPayload): Promise<FormulatePlanResult> {
      return {
        description: 'Brew coffee to restore energy',
        steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
      };
    },
    async completeReflect(_payload: LLMContextPayload): Promise<ReflectLLMResponse> {
      return {
        memoryEntry: { content: 'Brewed coffee', importance: 5, type: 'action' },
      };
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PPEROrchestratorImpl — phase sequence (AC-14)', () => {
  it('calls perceive → plan → execute → reflect in order', async () => {
    const state = makeState();
    const calls: string[] = [];
    const perceptionProvider: PerceptionDataProvider = {
      ...makePerceptionProvider(state),
    };
    const planProvider: PlanDataProvider = {
      ...makePlanProvider(state),
      storePlan: (id, result) => {
        calls.push('plan');
        return makePlanProvider(state).storePlan(id, result);
      },
    };
    const executeProvider: ExecuteDataProvider = {
      ...makeExecuteProvider(state),
      executeAffordance: async () => {
        calls.push('execute');
        return { success: true, driveChanges: { energy: 20 } };
      },
    };
    const reflectProvider: ReflectDataProvider = {
      ...makeReflectProvider(state),
      storeMemory: async () => {
        calls.push('reflect');
      },
    };

    // Track perceive via the classifier being called.
    const classifier = makeClassifier();
    const origPrune = classifier.prune.bind(classifier);
    classifier.prune = async (d, a) => {
      calls.push('perceive');
      return origPrune(d, a);
    };

    const orch = new PPEROrchestratorImpl({
      perceptionProvider,
      planProvider,
      executeProvider,
      reflectProvider,
      classifier,
      llmClient: makeMockLLM(),
    });

    await orch.runCycle('a1');
    expect(calls).toEqual(['perceive', 'plan', 'execute', 'reflect']);
  });

  it('aborts early when plan returns success: false — execute and reflect not called', async () => {
    const state = makeState();
    let executeCalled = false;
    let reflectCalled = false;
    const planProvider: PlanDataProvider = {
      ...makePlanProvider(state),
    };
    const executeProvider: ExecuteDataProvider = {
      ...makeExecuteProvider(state),
      executeAffordance: async () => {
        executeCalled = true;
        return { success: true };
      },
    };
    const reflectProvider: ReflectDataProvider = {
      ...makeReflectProvider(state),
      storeMemory: async () => {
        reflectCalled = true;
      },
    };

    const llm = makeMockLLM();
    // Force plan to fail.
    llm.completePlan = async () => {
      // Return invalid result → PlanService returns success:false
      return { description: '', steps: [] };
    };

    const orch = new PPEROrchestratorImpl({
      perceptionProvider: makePerceptionProvider(state),
      planProvider,
      executeProvider,
      reflectProvider,
      classifier: makeClassifier(),
      llmClient: llm,
    });

    await orch.runCycle('a1');
    expect(executeCalled).toBe(false);
    expect(reflectCalled).toBe(false);
  });
});

describe('PPEROrchestratorImpl — phase tracking (AC-15)', () => {
  it('returns "perceive" when idle (no cycle in progress)', () => {
    const state = makeState();
    const orch = new PPEROrchestratorImpl({
      perceptionProvider: makePerceptionProvider(state),
      planProvider: makePlanProvider(state),
      executeProvider: makeExecuteProvider(state),
      reflectProvider: makeReflectProvider(state),
      classifier: makeClassifier(),
      llmClient: makeMockLLM(),
    });
    expect(orch.getPhase('a1')).toBe('perceive');
  });

  it('tracks the current phase during a cycle', async () => {
    const state = makeState();
    const observedPhases: PPERPhase[] = [];
    let resolvePerceive: () => void;
    const perceptionProvider: PerceptionDataProvider = {
      ...makePerceptionProvider(state),
    };
    const classifier = makeClassifier();
    const origPrune = classifier.prune.bind(classifier);
    classifier.prune = async (d, a) => {
      observedPhases.push(orch.getPhase('a1'));
      return origPrune(d, a);
    };
    const planProvider: PlanDataProvider = {
      ...makePlanProvider(state),
      storePlan: (id, r) => {
        observedPhases.push(orch.getPhase('a1'));
        return makePlanProvider(state).storePlan(id, r);
      },
    };
    const executeProvider: ExecuteDataProvider = {
      ...makeExecuteProvider(state),
      executeAffordance: async () => {
        observedPhases.push(orch.getPhase('a1'));
        return { success: true, driveChanges: { energy: 20 } };
      },
    };
    const reflectProvider: ReflectDataProvider = {
      ...makeReflectProvider(state),
      storeMemory: async () => {
        observedPhases.push(orch.getPhase('a1'));
      },
    };

    const orch = new PPEROrchestratorImpl({
      perceptionProvider,
      planProvider,
      executeProvider,
      reflectProvider,
      classifier,
      llmClient: makeMockLLM(),
    });

    await orch.runCycle('a1');
    expect(observedPhases).toEqual(['perceive', 'plan', 'execute', 'reflect']);
    // After cycle completes, back to idle perceive.
    expect(orch.getPhase('a1')).toBe('perceive');
  });
});

describe('PPEROrchestratorImpl — isThinking after cycle (AC-16)', () => {
  it('isThinking is false after a successful full cycle', async () => {
    const state = makeState();
    const orch = new PPEROrchestratorImpl({
      perceptionProvider: makePerceptionProvider(state),
      planProvider: makePlanProvider(state),
      executeProvider: makeExecuteProvider(state),
      reflectProvider: makeReflectProvider(state),
      classifier: makeClassifier(),
      llmClient: makeMockLLM(),
    });
    await orch.runCycle('a1');
    expect(state.isThinking).toBe(false);
  });

  it('isThinking is false after a failed cycle', async () => {
    const state = makeState();
    const llm = makeMockLLM();
    llm.completePlan = async () => ({ description: '', steps: [] }); // invalid → failure
    const orch = new PPEROrchestratorImpl({
      perceptionProvider: makePerceptionProvider(state),
      planProvider: makePlanProvider(state),
      executeProvider: makeExecuteProvider(state),
      reflectProvider: makeReflectProvider(state),
      classifier: makeClassifier(),
      llmClient: llm,
    });
    await orch.runCycle('a1');
    expect(state.isThinking).toBe(false);
  });
});

describe('createPPEROrchestrator factory (AC-17)', () => {
  it('constructs an orchestrator from the data-provider bridges and LLM client that can run a full cycle', async () => {
    const state = makeState();
    const orch = createPPEROrchestrator({
      perceptionProvider: makePerceptionProvider(state),
      planProvider: makePlanProvider(state),
      executeProvider: makeExecuteProvider(state),
      reflectProvider: makeReflectProvider(state),
      classifier: makeClassifier(),
      llmClient: makeMockLLM(),
    });
    await orch.runCycle('a1');
    expect(state.isThinking).toBe(false);
    expect(orch.getPhase('a1')).toBe('perceive');
  });
});
