/**
 * Spec 041 — Applied-DriveChanges label signal: orchestrator side
 * (issue #152, R2 / AC-2, AC-3).
 *
 * `PPEROrchestratorImpl.runCycle` must return a `PPERCycleOutcome` computed
 * from what the phases DID, not from diffed state:
 *   appliedDriveChanges = execute.result.driveChanges non-empty (the
 *   compound-action once-applied merged map included) OR reflect
 *   reports `drivesUpdated === true` (sanitized driveOverrides — the
 *   deviation-rejected reflect branch included).
 * Every early-return path returns `appliedDriveChanges: false` unless a
 * phase actually applied drive changes (R2.2). No drive-change semantics
 * inside execute/reflect change (R2.3 — covered by the existing spec-025 /
 * spec-028 suites).
 */
import { describe, it, expect } from 'vitest';
import type {
  PerceptionDataProvider,
  PlanDataProvider,
  ExecuteDataProvider,
  ReflectDataProvider,
  ExecuteResult,
  ReflectLLMResponse,
  AgentInternalState,
  AgentPlan,
  Affordance,
  FormulatePlanResult,
} from '@evol-hive/shared';
import type { LLMClient, PPEROrchestrator } from '../src/index.js';
import type { AffordanceClassifier } from '../src/classifier/index.js';
import { PPEROrchestratorImpl } from '../src/pper/orchestrator.js';
import { GuardrailEngineImpl } from '../src/guardrails/index.js';
import { defaultPPERErrorConfig } from '@evol-hive/shared';

// ─── Fakes ───────────────────────────────────────────────────────────────────

function makeState(agentId = 'a1'): AgentInternalState {
  return {
    agentId,
    drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
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
      const plan: AgentPlan = {
        id: 'plan-1',
        description: result.description,
        steps: result.steps.map((s) => ({ description: s.description, completed: false })),
        currentStepIndex: 0,
        createdAt: 0,
      };
      state.currentPlan = plan;
      return plan;
    },
    setThinking: (id, v) => {
      state.isThinking = v;
    },
  };
}

interface ExecuteScript {
  result?: ExecuteResult;
}

function makeExecuteProvider(
  state: AgentInternalState,
  script: ExecuteScript,
): ExecuteDataProvider {
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
        effects: {},
      },
    }),
    checkPreconditions: () => ({ satisfied: true, failed: [] }),
    executeAffordance: async () => script.result ?? { success: true },
    advanceStep: () => {
      if (state.currentPlan) {
        state.currentPlan = {
          ...state.currentPlan,
          currentStepIndex: state.currentPlan.currentStepIndex + 1,
        };
      }
    },
    applyDriveChanges: () => {},
    setSystemFeedback: () => {},
    setThinking: (id, v) => {
      state.isThinking = v;
    },
  };
}

interface ReflectScript {
  /** The ReflectLLMResponse the mock LLM returns (scriptable). */
  response: ReflectLLMResponse;
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

function makeMockLLM(reflectScript: ReflectScript): LLMClient {
  return {
    async completeStructured() {
      return { reasoning: 'r', action: 'brew_coffee' };
    },
    async completeReflection() {
      return { agentId: 'a1', newMemories: [], consolidatedNodeIds: [] };
    },
    async completePlan(): Promise<FormulatePlanResult> {
      return {
        description: 'Brew coffee to restore energy',
        steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
      };
    },
    async completeReflect(): Promise<ReflectLLMResponse> {
      return reflectScript.response;
    },
  };
}

function makeOrchestrator(
  state: AgentInternalState,
  script: ExecuteScript,
  reflectScript: ReflectScript,
): PPEROrchestrator {
  return new PPEROrchestratorImpl({
    perceptionProvider: makePerceptionProvider(state),
    planProvider: makePlanProvider(state),
    executeProvider: makeExecuteProvider(state, script),
    reflectProvider: makeReflectProvider(state),
    classifier: makeClassifier(),
    llmClient: makeMockLLM(reflectScript),
  });
}

const NO_REFLECT: ReflectLLMResponse = {};

describe('Spec 041 — orchestrator computes appliedDriveChanges (R2.1 / AC-2, AC-3)', () => {
  it('a 1-point affordance driveChange labels the cycle as drive-changing (AC-2)', async () => {
    const state = makeState();
    const orch = makeOrchestrator(
      state,
      { result: { success: true, driveChanges: { energy: 1 } } },
      { response: {} },
    );
    const outcome = await orch.runCycle('a1');
    expect(outcome).toEqual({ appliedDriveChanges: true });
  });

  it('larger multi-drive affordance deltas label the cycle drive-changing', async () => {
    const state = makeState();
    const orch = makeOrchestrator(
      state,
      { result: { success: true, driveChanges: { energy: 20, comfort: 5 } } },
      { response: {} },
    );
    const outcome = await orch.runCycle('a1');
    expect(outcome.appliedDriveChanges).toBe(true);
  });

  it('a successful execute WITHOUT driveChanges is not drive-changing (no diff-based label)', async () => {
    const state = makeState();
    const orch = makeOrchestrator(
      state,
      { result: { success: true } },
      { response: { memoryContent: 'did a thing', memoryImportance: 5, memoryType: 'action' } },
    );
    const outcome = await orch.runCycle('a1');
    expect(outcome).toEqual({ appliedDriveChanges: false });
  });

  it('reflect-applied sanitized driveOverrides (drivesUpdated: true) label the cycle drive-changing (AC-3)', async () => {
    const state = makeState();
    // Execute succeeds WITHOUT driveChanges; the LLM reflect supplies an override.
    const orch = makeOrchestrator(
      state,
      { result: { success: true } },
      { response: { driveOverrides: { energy: 5 } } },
    );
    const outcome = await orch.runCycle('a1');
    expect(outcome).toEqual({ appliedDriveChanges: true });
  });

  it('execute driveChanges and reflect overrides both present → drive-changing', async () => {
    const state = makeState();
    const orch = makeOrchestrator(
      state,
      { result: { success: true, driveChanges: { curiosity: 3 } } },
      { response: { driveOverrides: { social: 2 } } },
    );
    const outcome = await orch.runCycle('a1');
    expect(outcome).toEqual({ appliedDriveChanges: true });
  });
});

describe('Spec 041 — early-return paths report what actually ran (R2.2)', () => {
  it('plan failure aborts before execute → appliedDriveChanges: false', async () => {
    const state = makeState();
    const planProvider: PlanDataProvider = {
      ...makePlanProvider(state),
    };
    // The LLM plan call fails → plan.success = false → cycle aborts.
    const failingLLM: LLMClient = {
      ...makeMockLLM({ response: {} }),
      completePlan: async () => {
        throw new Error('LLM unavailable');
      },
    };
    const orch = new PPEROrchestratorImpl({
      perceptionProvider: makePerceptionProvider(state),
      planProvider,
      executeProvider: makeExecuteProvider(state, {
        result: { success: true, driveChanges: { energy: 20 } },
      }),
      reflectProvider: makeReflectProvider(state),
      classifier: makeClassifier(),
      llmClient: failingLLM,
    });
    const outcome = await orch.runCycle('a1');
    expect(outcome).toEqual({ appliedDriveChanges: false });
  });

  it('execute failure (no phase applied anything) → appliedDriveChanges: false', async () => {
    const state = makeState();
    const orch = makeOrchestrator(
      state,
      { result: { success: false, error: 'Affordance execution failed.', planComplete: false } },
      { response: {} },
    );
    const outcome = await orch.runCycle('a1');
    expect(outcome).toEqual({ appliedDriveChanges: false });
  });

  it('execute failure never reports applied changes even with a driveChanges payload (success-gated)', async () => {
    // In production the execute phase never attaches `result` to a failed
    // ExecuteResult — drive changes are applied only on success — so the
    // orchestrator must gate the execute signal on execute.success: a failed
    // result's driveChanges (if any) were NOT applied.
    const state = makeState();
    const orch = makeOrchestrator(
      state,
      { result: { success: false, error: 'partial', driveChanges: { energy: 3 } } },
      { response: {} },
    );
    const outcome = await orch.runCycle('a1');
    expect(outcome).toEqual({ appliedDriveChanges: false });
  });

  it('"No active plan" early return (expected idle state) → appliedDriveChanges: false', async () => {
    const state = makeState();
    const orch = makeOrchestrator(
      state,
      { result: { success: false, error: 'No active plan', planComplete: true } },
      { response: {} },
    );
    const outcome = await orch.runCycle('a1');
    expect(outcome).toEqual({ appliedDriveChanges: false });
  });

  it('cooldown skip (spec 008) returns early → appliedDriveChanges: false', async () => {
    const state = makeState();
    const errorConfig = {
      ...defaultPPERErrorConfig(),
      maxConsecutiveFailures: 1,
      failureCooldownMs: 60_000,
    };
    // Force a failure first via a plan throw, so the next call is in cooldown.
    const failingLLM: LLMClient = {
      ...makeMockLLM({ response: {} }),
      completePlan: async () => {
        throw new Error('LLM unavailable');
      },
    };
    const orch = new PPEROrchestratorImpl({
      perceptionProvider: makePerceptionProvider(state),
      planProvider: makePlanProvider(state),
      executeProvider: makeExecuteProvider(state, {
        result: { success: true, driveChanges: { energy: 20 } },
      }),
      reflectProvider: makeReflectProvider(state),
      classifier: makeClassifier(),
      llmClient: failingLLM,
      errorConfig,
    });
    await orch.runCycle('a1'); // failure #1 → cooldown entered (max=1)
    expect(orch.getCycleStatus('a1').coolingDown).toBe(true);

    const outcome = await orch.runCycle('a1'); // skipped entirely
    expect(outcome).toEqual({ appliedDriveChanges: false });
  });

  it('deviation-rejected execute → reflect runs; reflect without overrides → false', async () => {
    // Real deviation harness (spec-016 AC-20/AC-22 pattern): the plan's step
    // targets 'sleep' but the current step targets 'brew_coffee' — the
    // guardrail's plan validation rejects the action (deviationRejected).
    const state = makeState();
    const planProvider: PlanDataProvider = {
      ...makePlanProvider(state),
      storePlan: (_id, _result) => {
        const plan: AgentPlan = {
          id: 'plan-1',
          description: 'Sleep plan',
          steps: [{ description: 'Sleep', completed: false, targetAffordance: 'sleep' }],
          currentStepIndex: 0,
          createdAt: 0,
        };
        state.currentPlan = plan;
        return plan;
      },
    };
    const executeProvider: ExecuteDataProvider = {
      ...makeExecuteProvider(state, { result: { success: true } }),
      resolveAffordance: () => ({
        objectId: 'coffee-1',
        affordance: {
          id: 'brew_coffee',
          label: 'Brew coffee',
          engineEffect: 'brew_coffee',
          preconditions: [],
          effects: {},
        },
      }),
    };
    const orch = new PPEROrchestratorImpl({
      perceptionProvider: makePerceptionProvider(state),
      planProvider,
      executeProvider,
      reflectProvider: makeReflectProvider(state),
      classifier: makeClassifier(),
      llmClient: makeMockLLM({
        response: {
          memoryContent: 'reflected on deviation',
          memoryImportance: 4,
          memoryType: 'observation',
        },
      }),
      guardrail: new GuardrailEngineImpl({
        affordanceMasking: true,
        contextualForcing: true,
        planValidation: true,
      }),
    });
    const outcome = await orch.runCycle('a1');
    expect(outcome).toEqual({ appliedDriveChanges: false });
  });

  it('deviation-rejected execute → reflect applies driveOverrides → true (the deviation branch included)', async () => {
    const state = makeState();
    const planProvider: PlanDataProvider = {
      ...makePlanProvider(state),
      storePlan: (_id, _result) => {
        const plan: AgentPlan = {
          id: 'plan-1',
          description: 'Sleep plan',
          steps: [{ description: 'Sleep', completed: false, targetAffordance: 'sleep' }],
          currentStepIndex: 0,
          createdAt: 0,
        };
        state.currentPlan = plan;
        return plan;
      },
    };
    const executeProvider: ExecuteDataProvider = {
      ...makeExecuteProvider(state, { result: { success: true } }),
      resolveAffordance: () => ({
        objectId: 'coffee-1',
        affordance: {
          id: 'brew_coffee',
          label: 'Brew coffee',
          engineEffect: 'brew_coffee',
          preconditions: [],
          effects: {},
        },
      }),
    };
    const orch = new PPEROrchestratorImpl({
      perceptionProvider: makePerceptionProvider(state),
      planProvider,
      executeProvider,
      reflectProvider: makeReflectProvider(state),
      classifier: makeClassifier(),
      llmClient: makeMockLLM({ response: { driveOverrides: { comfort: 8 } } }),
      guardrail: new GuardrailEngineImpl({
        affordanceMasking: true,
        contextualForcing: true,
        planValidation: true,
      }),
    });
    const outcome = await orch.runCycle('a1');
    expect(outcome).toEqual({ appliedDriveChanges: true });
  });

  it('reflect failure after execute applied driveChanges → still true (the changes WERE applied)', async () => {
    const state = makeState();
    // Reflect throws (LLM down) — but the Execute phase already applied its
    // drive changes. The outcome must report what the cycle did (R2.2:
    // "false unless a phase applied drive changes").
    const reflectProvider: ReflectDataProvider = {
      ...makeReflectProvider(state),
      storeMemory: async () => {
        throw new Error('memory backend down');
      },
    };
    const orch = new PPEROrchestratorImpl({
      perceptionProvider: makePerceptionProvider(state),
      planProvider: makePlanProvider(state),
      executeProvider: makeExecuteProvider(state, {
        result: { success: true, driveChanges: { energy: 20 } },
      }),
      reflectProvider,
      classifier: makeClassifier(),
      llmClient: makeMockLLM({ response: {} }),
    });
    const outcome = await orch.runCycle('a1');
    expect(outcome).toEqual({ appliedDriveChanges: true });
  });
});
