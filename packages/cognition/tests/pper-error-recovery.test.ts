/**
 * Tests for PPER Error Recovery — cognition layer (spec 008, issue #23).
 * Covers AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-10, AC-11,
 * AC-12, AC-13, AC-14, AC-16, AC-17, AC-25, AC-26, AC-27.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  PerceptionDataProvider,
  PlanDataProvider,
  ExecuteDataProvider,
  ReflectDataProvider,
  PerceptionResult,
  AgentInternalState,
  AgentPlan,
  Affordance,
  FormulatePlanResult,
  ReflectLLMResponse,
  LLMActionResponse,
  ReflectionResult,
  MemorySnippet,
  AgentDrives,
  PPERErrorConfig,
  PPERCycleStatus,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload, AffordanceClassifier } from '../src/index.js';
import { PPEROrchestratorImpl } from '../src/pper/orchestrator.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { PlanServiceImpl } from '../src/pper/plan-service.js';
import { ReflectServiceImpl } from '../src/pper/reflect-service.js';
import { PerceptionServiceImpl } from '../src/pper/index.js';
import {
  OpenAICompatibleLLMClient,
  LLMError,
  LLMTimeoutError,
  LLMHTTPError,
  LLMRateLimitError,
  LLMResponseError,
} from '../src/llm/openai-client.js';

// ═════════════════════════════════════════════════════════════════════════════
// Section 1: LLM Client Retry (AC-1, AC-2, AC-3, AC-4)
// ═════════════════════════════════════════════════════════════════════════════

const BASE_URL = 'http://localhost:11434/v1';
const MODEL = 'llama3.1';
const CHAT_URL = `${BASE_URL}/chat/completions`;

function chatResponse(content: string, status = 200): Response {
  const body = JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenAICompatibleLLMClient — retry on timeout (AC-1)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('retries on LLMTimeoutError up to maxRetries times with exponential backoff, then throws (AC-1)', async () => {
    // Every fetch call aborts (timeout).
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted') as Error & { name: string };
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      timeoutMs: 10,
      maxRetries: 2,
      retryDelayMs: 1,
    });

    await expect(
      client.completeStructured({
        systemPrompt: 's',
        perceptionContext: 'p',
        availableAffordances: [],
        cognitiveTools: [],
        responseSchema: {},
      }),
    ).rejects.toThrow(LLMTimeoutError);

    // 1 initial + 2 retries = 3 total calls
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('succeeds after a transient timeout (retry then success)', async () => {
    let callCount = 0;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // First call: timeout
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('Aborted') as Error & { name: string };
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      // Second call: succeed
      return Promise.resolve(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
    });

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      timeoutMs: 10,
      maxRetries: 3,
      retryDelayMs: 1,
    });

    const result = await client.completeStructured({
      systemPrompt: 's',
      perceptionContext: 'p',
      availableAffordances: [],
      cognitiveTools: [],
      responseSchema: {},
    });

    expect(result.action).toBe('a');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('OpenAICompatibleLLMClient — retry on fetch errors (AC-2)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('retries on non-Abort fetch errors (connection refused) up to maxRetries times, then throws LLMError (AC-2)', async () => {
    const connError = new TypeError('fetch failed: Connection refused');
    fetchMock.mockRejectedValue(connError);

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      maxRetries: 2,
      retryDelayMs: 1,
    });

    await expect(
      client.completeStructured({
        systemPrompt: 's',
        perceptionContext: 'p',
        availableAffordances: [],
        cognitiveTools: [],
        responseSchema: {},
      }),
    ).rejects.toThrow(LLMError);

    // 1 initial + 2 retries = 3 total calls
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('succeeds after a transient fetch error (retry then success)', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed: DNS error'))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      maxRetries: 3,
      retryDelayMs: 1,
    });

    const result = await client.completeStructured({
      systemPrompt: 's',
      perceptionContext: 'p',
      availableAffordances: [],
      cognitiveTools: [],
      responseSchema: {},
    });

    expect(result.action).toBe('a');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('OpenAICompatibleLLMClient — retryOnTimeout=false (AC-3)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws LLMTimeoutError immediately without retry when retryOnTimeout is false (AC-3)', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted') as Error & { name: string };
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      timeoutMs: 10,
      maxRetries: 3,
      retryDelayMs: 1,
      retryOnTimeout: false,
    });

    await expect(
      client.completeStructured({
        systemPrompt: 's',
        perceptionContext: 'p',
        availableAffordances: [],
        cognitiveTools: [],
        responseSchema: {},
      }),
    ).rejects.toThrow(LLMTimeoutError);

    // Should NOT have retried — only 1 call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Error exports from cognition barrel (AC-4)', () => {
  it('LLMTimeoutError, LLMHTTPError, LLMRateLimitError, LLMResponseError, LLMError are all exported from @evol-hive/cognition', async () => {
    const mod = await import('../src/index.js');
    expect(mod.LLMError).toBeDefined();
    expect(mod.LLMTimeoutError).toBeDefined();
    expect(mod.LLMHTTPError).toBeDefined();
    expect(mod.LLMRateLimitError).toBeDefined();
    expect(mod.LLMResponseError).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 2: Fakes for Orchestrator Tests
// ═════════════════════════════════════════════════════════════════════════════

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
    setThinking: (_id, v) => {
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

function makeOrchestrator(
  state: AgentInternalState,
  overrides: {
    llm?: LLMClient;
    perceptionProvider?: PerceptionDataProvider;
    planProvider?: PlanDataProvider;
    executeProvider?: ExecuteDataProvider;
    reflectProvider?: ReflectDataProvider;
    errorConfig?: PPERErrorConfig;
  } = {},
) {
  return new PPEROrchestratorImpl({
    perceptionProvider: overrides.perceptionProvider ?? makePerceptionProvider(state),
    planProvider: overrides.planProvider ?? makePlanProvider(state),
    executeProvider: overrides.executeProvider ?? makeExecuteProvider(state),
    reflectProvider: overrides.reflectProvider ?? makeReflectProvider(state),
    classifier: makeClassifier(),
    llmClient: overrides.llm ?? makeMockLLM(),
    errorConfig: overrides.errorConfig,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 3: Orchestrator Failure Tracking (AC-5, AC-6, AC-7, AC-8, AC-11, AC-17, AC-25)
// ═════════════════════════════════════════════════════════════════════════════

describe('PPEROrchestratorImpl — consecutive failure tracking (AC-5)', () => {
  it('increments consecutiveFailures when plan phase returns success: false', async () => {
    const state = makeState();
    const llm = makeMockLLM();
    llm.completePlan = async () => ({ description: '', steps: [] }); // invalid → failure
    const orch = makeOrchestrator(state, { llm });

    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(1);

    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(2);
  });

  it('resets consecutiveFailures to 0 on a successful full cycle', async () => {
    const state = makeState();
    const llm = makeMockLLM();
    let callCount = 0;
    llm.completePlan = async () => {
      callCount++;
      if (callCount <= 2) {
        return { description: '', steps: [] }; // first 2 fail
      }
      return {
        description: 'Brew coffee',
        steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
      };
    };
    const orch = makeOrchestrator(state, { llm });

    await orch.runCycle('a1'); // fail
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(1);

    await orch.runCycle('a1'); // fail
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(2);

    await orch.runCycle('a1'); // success → reset
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(0);
  });

  it('records the last error message on failure', async () => {
    const state = makeState();
    const llm = makeMockLLM();
    llm.completePlan = async () => {
      throw new Error('LLM connection refused');
    };
    const orch = makeOrchestrator(state, { llm });

    await orch.runCycle('a1');
    const status = orch.getCycleStatus('a1');
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastError).toContain('LLM connection refused');
  });
});

describe('PPEROrchestratorImpl — skip cycle after threshold (AC-6)', () => {
  it('skips cycle when consecutiveFailures reaches maxConsecutiveFailures (default 3)', async () => {
    const state = makeState();
    const llm = makeMockLLM();
    llm.completePlan = async () => ({ description: '', steps: [] }); // always fail
    const orch = makeOrchestrator(state, { llm });

    // 3 failures to reach threshold
    await orch.runCycle('a1');
    await orch.runCycle('a1');
    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(3);

    // Track whether plan was called (it should not be on skip)
    let planCalled = false;
    llm.completePlan = async () => {
      planCalled = true;
      return { description: '', steps: [] };
    };

    await orch.runCycle('a1'); // should skip
    expect(planCalled).toBe(false);
    // Counter does not increment during skip.
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(3);
  });

  it('respects custom maxConsecutiveFailures from errorConfig', async () => {
    const state = makeState();
    const llm = makeMockLLM();
    llm.completePlan = async () => ({ description: '', steps: [] }); // always fail
    const orch = makeOrchestrator(state, {
      llm,
      errorConfig: { maxConsecutiveFailures: 2, failureCooldownMs: 5000 },
    });

    await orch.runCycle('a1');
    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(2);

    // Next cycle should be skipped.
    let planCalled = false;
    llm.completePlan = async () => {
      planCalled = true;
      return { description: '', steps: [] };
    };
    await orch.runCycle('a1');
    expect(planCalled).toBe(false);
  });
});

describe('PPEROrchestratorImpl — cooldown timer (AC-7, AC-27)', () => {
  it('enters cooldown after reaching maxConsecutiveFailures', async () => {
    const state = makeState();
    const llm = makeMockLLM();
    llm.completePlan = async () => ({ description: '', steps: [] }); // always fail
    const orch = makeOrchestrator(state, {
      llm,
      errorConfig: { maxConsecutiveFailures: 3, failureCooldownMs: 10000 },
    });

    await orch.runCycle('a1');
    await orch.runCycle('a1');
    await orch.runCycle('a1');

    expect(orch.getCycleStatus('a1').coolingDown).toBe(true);
  });

  it('after cooldown elapses, runCycle proceeds and resets counter to 0 on success', async () => {
    const state = makeState();
    const llm = makeMockLLM();
    let planCallCount = 0;
    llm.completePlan = async () => {
      planCallCount++;
      if (planCallCount <= 3) {
        return { description: '', steps: [] }; // first 3 fail
      }
      return {
        description: 'Brew coffee',
        steps: [{ description: 'Brew', targetAffordance: 'brew_coffee' }],
      };
    };
    const orch = makeOrchestrator(state, {
      llm,
      errorConfig: { maxConsecutiveFailures: 3, failureCooldownMs: 50 },
    });

    // 3 failures → enter cooldown
    await orch.runCycle('a1');
    await orch.runCycle('a1');
    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').coolingDown).toBe(true);

    // Wait for cooldown to elapse.
    await new Promise((r) => setTimeout(r, 60));

    // Now the cycle should proceed and succeed.
    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(0);
    expect(orch.getCycleStatus('a1').coolingDown).toBe(false);
  });
});

describe('PPEROrchestratorImpl — getCycleStatus (AC-8)', () => {
  it('returns { consecutiveFailures: 0, coolingDown: false } for an unknown agent', () => {
    const orch = makeOrchestrator(makeState());
    const status = orch.getCycleStatus('unknown');
    expect(status.consecutiveFailures).toBe(0);
    expect(status.coolingDown).toBe(false);
    expect(status.lastError).toBeUndefined();
  });

  it('returns { coolingDown: true } during the cooldown period', async () => {
    const state = makeState();
    const llm = makeMockLLM();
    llm.completePlan = async () => ({ description: '', steps: [] });
    const orch = makeOrchestrator(state, {
      llm,
      errorConfig: { maxConsecutiveFailures: 2, failureCooldownMs: 10000 },
    });

    await orch.runCycle('a1');
    await orch.runCycle('a1');

    const status = orch.getCycleStatus('a1');
    expect(status.consecutiveFailures).toBe(2);
    expect(status.coolingDown).toBe(true);
    expect(status.lastError).toBeDefined();
  });
});

describe('PPEROrchestratorImpl — "No active plan" is not a failure (AC-11)', () => {
  it('does NOT increment consecutiveFailures when execute returns "No active plan" with planComplete: true', async () => {
    const state = makeState();
    // Override execute provider to always return "No active plan"
    const executeProvider: ExecuteDataProvider = {
      ...makeExecuteProvider(state),
      getAgentState: () => ({ ...state, currentPlan: null }),
      isPlanComplete: () => true,
      getCurrentStep: () => null,
    };
    const orch = makeOrchestrator(state, { executeProvider });

    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(0);
  });
});

describe('PPEROrchestratorImpl — stuck cycle does not increment failures (AC-17)', () => {
  it('does NOT increment consecutiveFailures when perceptionResult.stuck is true', async () => {
    const state = makeState();
    // Make a classifier that returns empty affordances → stuck
    const classifier: AffordanceClassifier = {
      async prune() {
        return []; // empty → stuck
      },
    };
    const orch = new PPEROrchestratorImpl({
      perceptionProvider: makePerceptionProvider(state),
      planProvider: makePlanProvider(state),
      executeProvider: makeExecuteProvider(state),
      reflectProvider: makeReflectProvider(state),
      classifier,
      llmClient: makeMockLLM(),
    });

    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(0);
  });
});

describe('PPEROrchestratorImpl — errorConfig in options (AC-25)', () => {
  it('accepts optional errorConfig in PPEROrchestratorOptions', async () => {
    const state = makeState();
    const errorConfig: PPERErrorConfig = {
      maxConsecutiveFailures: 5,
      failureCooldownMs: 3000,
    };
    const orch = makeOrchestrator(state, { errorConfig });

    // Verify by checking that 5 failures are needed (not the default 3).
    const llm = makeMockLLM();
    llm.completePlan = async () => ({ description: '', steps: [] });
    const orch2 = makeOrchestrator(state, { llm, errorConfig });

    for (let i = 0; i < 5; i++) {
      await orch2.runCycle('a1');
    }
    expect(orch2.getCycleStatus('a1').consecutiveFailures).toBe(5);
    expect(orch2.getCycleStatus('a1').coolingDown).toBe(true);
  });

  it('uses defaultPPERErrorConfig when errorConfig is omitted', async () => {
    const state = makeState();
    const llm = makeMockLLM();
    llm.completePlan = async () => ({ description: '', steps: [] });
    const orch = makeOrchestrator(state, { llm });

    // Default maxConsecutiveFailures = 3
    await orch.runCycle('a1');
    await orch.runCycle('a1');
    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').coolingDown).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 4: Plan/Reflect Service Error Prefix (AC-10, AC-13)
// ═════════════════════════════════════════════════════════════════════════════

describe('PlanServiceImpl — LLMResponseError prefix (AC-10)', () => {
  it('prefixes error message with "LLM response error: " when LLMResponseError is caught', async () => {
    const state = makeState();
    const provider = makePlanProvider(state);
    const llm = makeMockLLM();
    // Throw an LLMResponseError from completePlan
    llm.completePlan = async () => {
      throw new LLMResponseError('Invalid JSON structure', 'raw content');
    };
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan('a1', {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: state.drives,
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy, need to restore energy',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM response error:');
  });

  it('does NOT prefix non-LLMResponseError errors (e.g., generic errors)', async () => {
    const state = makeState();
    const provider = makePlanProvider(state);
    const llm = makeMockLLM();
    llm.completePlan = async () => {
      throw new Error('Connection refused');
    };
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan('a1', {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: state.drives,
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy, need to restore energy',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection refused');
    expect(result.error).not.toContain('LLM response error:');
  });
});

describe('PlanServiceImpl — zero steps plan (AC-13)', () => {
  it('returns { success: false, error: "LLM returned an invalid plan: missing description or steps" } when LLM returns zero steps', async () => {
    const state = makeState();
    const provider = makePlanProvider(state);
    const llm = makeMockLLM();
    llm.completePlan = async () => ({ description: 'A plan with no steps', steps: [] });
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan('a1', {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: state.drives,
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy, need to restore energy',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('LLM returned an invalid plan: missing description or steps');
  });
});

describe('ReflectServiceImpl — LLMResponseError prefix (AC-10)', () => {
  it('prefixes error message with "LLM response error: " when LLMResponseError is caught', async () => {
    const state = makeState();
    const provider = makeReflectProvider(state);
    const llm = makeMockLLM();
    // Throw an LLMResponseError from completeReflect
    llm.completeReflect = async () => {
      throw new LLMResponseError('Invalid JSON structure', 'raw content');
    };
    const { ReflectBuilderImpl } = await import('../src/pper/reflect-builder.js');
    const service = new ReflectServiceImpl({
      reflectBuilder: new ReflectBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.reflect('a1', { success: true, planComplete: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM response error:');
  });

  it('does NOT prefix non-LLMResponseError errors', async () => {
    const state = makeState();
    const provider = makeReflectProvider(state);
    const llm = makeMockLLM();
    llm.completeReflect = async () => {
      throw new Error('Connection refused');
    };
    const { ReflectBuilderImpl } = await import('../src/pper/reflect-builder.js');
    const service = new ReflectServiceImpl({
      reflectBuilder: new ReflectBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.reflect('a1', { success: true, planComplete: true });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection refused');
    expect(result.error).not.toContain('LLM response error:');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 5: Stuck Detection (AC-14, AC-16)
// ═════════════════════════════════════════════════════════════════════════════

describe('PerceptionServiceImpl — stuck detection (AC-14)', () => {
  it('sets stuck: true when prunedAffordances is empty', async () => {
    const state = makeState();
    const classifier: AffordanceClassifier = {
      async prune() {
        return []; // empty → stuck
      },
    };
    const provider = makePerceptionProvider(state);
    const service = new PerceptionServiceImpl({
      provider,
      classifier,
    });
    const result = await service.perceive('a1');
    expect(result.stuck).toBe(true);
  });

  it('sets stuck: false (or undefined) when prunedAffordances is non-empty', async () => {
    const state = makeState();
    const classifier: AffordanceClassifier = {
      async prune() {
        return [
          {
            id: 'brew_coffee',
            label: 'Brew coffee',
            engineEffect: 'brew_coffee',
            preconditions: [],
            effects: { energy: 20 },
          },
        ];
      },
    };
    const provider = makePerceptionProvider(state);
    const service = new PerceptionServiceImpl({
      provider,
      classifier,
    });
    const result = await service.perceive('a1');
    expect(result.stuck).toBeFalsy();
  });
});

describe('PlanBuilderImpl — stuck directive (AC-16)', () => {
  it('includes the stuck warning directive in perceptionContext when perceptionResult.stuck is true', () => {
    const builder = new PlanBuilderImpl();
    const result = builder.build({
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy, need to restore energy',
      stuck: true,
    });
    expect(result.perceptionContext).toContain(
      'WARNING: No physical actions are available in this room. You may need to move or use a cognitive tool.',
    );
  });

  it('does NOT include the stuck warning when stuck is false/undefined', () => {
    const builder = new PlanBuilderImpl();
    const result = builder.build({
      passive: {
        roomId: 'kitchen',
        objectsPresent: [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
        drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      },
      prunedAffordances: [
        {
          id: 'brew_coffee',
          label: 'Brew coffee',
          engineEffect: 'brew_coffee',
          preconditions: [],
          effects: { energy: 20 },
        },
      ],
      primaryDriveLabel: 'low energy, need to restore energy',
    });
    expect(result.perceptionContext).not.toContain('WARNING: No physical actions');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 6: Integration Tests (AC-26, AC-27)
// ═════════════════════════════════════════════════════════════════════════════

describe('Integration: kill LLM mid-cycle (AC-26)', () => {
  it('game loop does not crash, isThinking resets, agent available next tick, consecutiveFailures increments', async () => {
    const state = makeState();
    const llm = makeMockLLM();
    // completePlan rejects on every call (simulates dead LLM)
    llm.completePlan = async () => {
      throw new Error('LLM server exploded');
    };
    const orch = makeOrchestrator(state, {
      llm,
      errorConfig: { maxConsecutiveFailures: 3, failureCooldownMs: 50 },
    });

    // First failed cycle
    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(1);
    // isThinking should be false (plan service finally block).
    expect(state.isThinking).toBe(false);

    // Second failed cycle
    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(2);

    // Third failed cycle — reaches threshold
    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(3);
    expect(orch.getCycleStatus('a1').coolingDown).toBe(true);

    // The agent is available (isThinking=false) even during cooldown.
    expect(state.isThinking).toBe(false);

    // Fourth cycle — skipped (in cooldown), should not throw.
    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(3); // unchanged
  });
});

describe('Integration: agent recovers after cooldown (AC-27)', () => {
  it('after maxConsecutiveFailures and cooldown, a successful cycle resets counter to 0', async () => {
    const state = makeState();
    const llm = makeMockLLM();
    let callCount = 0;
    llm.completePlan = async () => {
      callCount++;
      if (callCount <= 3) {
        throw new Error('LLM down');
      }
      return {
        description: 'Brew coffee',
        steps: [{ description: 'Brew', targetAffordance: 'brew_coffee' }],
      };
    };
    const orch = makeOrchestrator(state, {
      llm,
      errorConfig: { maxConsecutiveFailures: 3, failureCooldownMs: 50 },
    });

    // 3 failures → cooldown
    for (let i = 0; i < 3; i++) {
      await orch.runCycle('a1');
    }
    expect(orch.getCycleStatus('a1').coolingDown).toBe(true);

    // Wait for cooldown.
    await new Promise((r) => setTimeout(r, 60));

    // Successful cycle → reset.
    await orch.runCycle('a1');
    expect(orch.getCycleStatus('a1').consecutiveFailures).toBe(0);
    expect(orch.getCycleStatus('a1').coolingDown).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 7: System Feedback After Missing Affordance (AC-12)
// ═════════════════════════════════════════════════════════════════════════════

describe('Execute → Perceive system feedback flow (AC-12)', () => {
  it('when execute fails due to missing affordance, the next PerceptionResult.passive.systemFeedback contains the failure message', async () => {
    const state = makeState();
    // Give the agent a plan that references an affordance not available in the room.
    state.currentPlan = {
      id: 'plan-1',
      description: 'Brew coffee',
      steps: [{ description: 'Brew coffee', completed: false, targetAffordance: 'nonexistent_action' }],
      currentStepIndex: 0,
      createdAt: 0,
    } as AgentPlan;

    // Shared feedback store between execute and perception providers.
    let feedbackStore: string | undefined = undefined;

    // Execute provider that cannot resolve the affordance.
    const executeProvider: ExecuteDataProvider = {
      ...makeExecuteProvider(state),
      getCurrentStep: () => ({
        description: 'Do nonexistent action',
        completed: false,
        targetAffordance: 'nonexistent_action',
      }),
      resolveAffordance: () => null, // affordance not found in room
      setSystemFeedback: (_id, msg) => {
        feedbackStore = msg;
      },
    };

    // Perception provider that reads the stored feedback.
    const perceptionProvider: PerceptionDataProvider = {
      ...makePerceptionProvider(state),
      getSystemFeedback: () => feedbackStore,
    };

    // Run execute → should fail and set systemFeedback.
    const { ExecuteServiceImpl } = await import('../src/pper/execute-service.js');
    const execService = new ExecuteServiceImpl({ dataProvider: executeProvider });
    const execResult = await execService.execute('a1');
    expect(execResult.success).toBe(false);
    expect(execResult.error).toContain('nonexistent_action');
    // Verify feedback was set.
    expect(feedbackStore).toContain("Cannot find object with affordance 'nonexistent_action'");

    // Run perceive → passive.systemFeedback should contain the failure message.
    const service = new PerceptionServiceImpl({
      provider: perceptionProvider,
      classifier: makeClassifier(),
    });
    const perception = await service.perceive('a1');
    expect(perception.passive.systemFeedback).toBeDefined();
    expect(perception.passive.systemFeedback).toContain('nonexistent_action');
  });
});
