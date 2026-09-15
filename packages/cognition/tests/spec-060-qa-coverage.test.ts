/**
 * Spec 060 — QA coverage additions (issue #214, PR #218)
 * ═══════════════════════════════════════════════════════════════════════════
 * QA-verification pass over spec 060's acceptance criteria. These tests close
 * the gaps the implementation suite left; they add no new production surface.
 *
 * Gaps closed:
 *
 * - AC-3: `[plan-invalid]` must name the failing reason for **every** shape
 *   failure. The implementation suite asserted only `empty-step-description`
 *   at the client seam and `missing-description` at the service backstop;
 *   this file pins all three reasons through the client.
 * - AC-3: `[plan-prompt]` size units must be the same as `estimatePlanPrompt`'s,
 *   and the line is emitted **once per `completePlan` call** (the documented
 *   pre-repair denominator — AC-8 — even when a repair follows).
 * - AC-5: the floor must make at most `N` LLM attempts before flooring and add
 *   **zero** LLM calls for the floor itself; the counter reset must bound the
 *   budget over many cycles.
 * - R4 (AC-5 discipline): a `[plan-floor]` writer that throws never propagates;
 *   a `[plan-repair]` writer that throws never breaks the repair (spec 049).
 * - AC-6: the default (legacy) client round-trips a valid multi-step plan
 *   byte-identically after the decode-before-classify restructure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Affordance,
  AgentInternalState,
  AgentPlan,
  FormulatePlanResult,
  LLMActionResponse,
  PerceptionResult,
  PlanDataProvider,
  ReflectionResult,
} from '@evol-hive/shared';
import { formulatePlanTool } from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '../src/index.js';
import { PlanServiceImpl } from '../src/pper/plan-service.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { decodeFormulatePlanArgs, OpenAICompatibleLLMClient } from '../src/llm/openai-client.js';
import { estimatePlanPrompt } from '../src/pper/plan-shape-diagnostic.js';

const AGENT_ID = 'qa-agent';
const ROOM_ID = 'kitchen';

const brew: Affordance = {
  id: 'brew_coffee',
  label: 'Brew coffee',
  engineEffect: 'brew_coffee',
  preconditions: [],
  effects: { energy: 20 },
};

const openGate: Affordance = {
  id: 'open_gate',
  label: 'Open the gate',
  engineEffect: 'open_gate',
  preconditions: [],
  effects: {},
};

const validPlan: FormulatePlanResult = {
  description: 'Restore energy',
  steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
};

const calmDrives = { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 };

function makePerception(affordances: Affordance[] = [brew, openGate]): PerceptionResult {
  return {
    passive: { roomId: ROOM_ID, objectsPresent: [], drives: calmDrives },
    prunedAffordances: affordances,
    primaryDriveLabel: 'content',
  } as unknown as PerceptionResult;
}

const invalidPlan: FormulatePlanResult = {
  description: '',
  steps: [{ description: 'x' }],
} as FormulatePlanResult;

// ─── AC-3: client-seam `[plan-invalid]` for EVERY reason ─────────────────────

const BASE_URL = 'http://localhost:8080/v1';
const MODEL = 'llama3.1';

function toolCallResponse(toolName: string, argumentsObj: unknown): Response {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: toolName, arguments: JSON.stringify(argumentsObj) },
            },
          ],
        },
      },
    ],
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function makePayload(overrides: Partial<LLMContextPayload> = {}): LLMContextPayload {
  return {
    systemPrompt: 'You are an agent.',
    perceptionContext: 'You are in a kitchen.',
    availableAffordances: [brew, openGate],
    cognitiveTools: [],
    tools: [formulatePlanTool],
    agentId: AGENT_ID,
    ...overrides,
  };
}

describe('QA — client-seam diagnostics name every shape reason (spec 060, AC-3)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    errSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function lines(): string[] {
    return errSpy.mock.calls.map((c) => String(c[0]));
  }

  const cases: { name: string; bad: Record<string, unknown> }[] = [
    {
      name: 'missing-description',
      bad: { description: '', steps: [{ description: 'x', targetAffordance: 'brew_coffee' }] },
    },
    { name: 'missing-steps', bad: { description: 'd', steps: [] } },
    {
      name: 'empty-step-description',
      bad: {
        description: 'd',
        steps: [
          { description: 'ok', targetAffordance: 'brew_coffee' },
          { description: '', targetAffordance: 'open_gate' },
        ],
      },
    },
  ];

  for (const { name, bad } of cases) {
    it(`emits [plan-invalid] reason=${name} (and repairs in exactly one retry)`, async () => {
      fetchMock
        .mockResolvedValueOnce(toolCallResponse('formulate_plan', bad))
        .mockResolvedValueOnce(toolCallResponse('formulate_plan', validPlan));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const result = await client.completePlan(makePayload());
      expect(result).toMatchObject({ description: 'Restore energy' });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const invalid = lines().filter((l) => l.includes('[plan-invalid]'));
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).toContain(`reason=${name}`);
      expect(invalid[0]).toMatch(/chars=\d+ estTokens=\d+/);
      // [llm-raw] fires for every reason too (AC-3).
      expect(lines().some((l) => l.includes('[llm-raw]'))).toBe(true);
    });
  }

  it('[plan-prompt] carries the estimatePlanPrompt units and fires once per completePlan call', async () => {
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('formulate_plan', cases[2]!.bad))
      .mockResolvedValueOnce(toolCallResponse('formulate_plan', validPlan));
    const payload = makePayload();
    const expected = estimatePlanPrompt(payload);
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await client.completePlan(payload);

    const prompts = lines().filter((l) => l.includes('[plan-prompt]'));
    // One line for the call even though a repair request followed — the
    // pre-repair denominator AC-8 measures against.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`chars=${expected.chars}`);
    expect(prompts[0]).toContain(`estTokens=${expected.estTokens}`);
  });

  it('a throwing [plan-repair] writer never propagates (spec 049)', async () => {
    errSpy.mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('[plan-repair]')) throw new Error('diag boom');
    });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('formulate_plan', cases[2]!.bad))
      .mockResolvedValueOnce(toolCallResponse('formulate_plan', validPlan));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await expect(client.completePlan(makePayload())).resolves.toMatchObject({
      description: 'Restore energy',
    });
  });
});

// ─── AC-6: byte-identical valid-plan round-trip on the default client ────────

describe('QA — default client decodes a valid plan byte-identically (spec 060, AC-6)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('deep-equals the decoded object for a valid multi-step plan (aliases + bare string)', async () => {
    const raw = {
      description: 'A full plan',
      steps: [
        { description: 'Brew', targetAffordance: 'brew_coffee' },
        'open_gate',
        { reason: 'go', action: 'open_gate' },
      ],
    };
    fetchMock.mockResolvedValue(toolCallResponse('formulate_plan', raw));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completePlan(makePayload());
    expect(result).toEqual({
      description: 'A full plan',
      steps: [
        { description: 'Brew', targetAffordance: 'brew_coffee' },
        { description: 'open_gate', targetAffordance: 'open_gate' },
        { description: 'go', targetAffordance: 'open_gate' },
      ],
    });
    // Decoding is exactly what the exported helper produces — no drift.
    expect(result).toEqual(decodeFormulatePlanArgs(raw));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-5: precise floor LLM budget + diagnostic discipline ──────────────────

class FakeDataProvider implements PlanDataProvider {
  agentState: AgentInternalState;
  storePlanCalls: FormulatePlanResult[] = [];

  constructor() {
    this.agentState = {
      agentId: AGENT_ID,
      drives: calmDrives,
      currentGoal: '',
      currentPlan: null,
      isThinking: false,
      location: ROOM_ID,
      lastPerceptionTick: 0,
    } as unknown as AgentInternalState;
  }

  getAgentState(): AgentInternalState {
    return this.agentState;
  }
  storePlan(_agentId: string, result: FormulatePlanResult): AgentPlan {
    this.storePlanCalls.push(result);
    return {
      id: `plan-${this.storePlanCalls.length}`,
      description: result.description,
      steps: result.steps.map((s) => ({ description: s.description, completed: false })),
      currentStepIndex: 0,
      createdAt: 0,
    };
  }
  setThinking(_agentId: string, isThinking: boolean): void {
    this.agentState = { ...this.agentState, isThinking };
  }
}

class CountingInvalidClient implements LLMClient {
  calls = 0;
  async completeStructured(): Promise<LLMActionResponse> {
    return { reasoning: 'r', action: 'wait' };
  }
  async completeReflection(): Promise<ReflectionResult> {
    return { agentId: AGENT_ID, newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(): Promise<FormulatePlanResult> {
    this.calls += 1;
    return invalidPlan;
  }
  async completeReflect() {
    return { memoryContent: 'x' };
  }
}

describe('QA — floor LLM budget is exactly N for the first floor (spec 060, AC-5)', () => {
  beforeEach(() => {
    vi.stubEnv('PLAN_FLOOR_AFTER_FAILURES', '3');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('makes exactly N plan attempts before the Nth cycle floors, and the floor itself adds zero', async () => {
    const provider = new FakeDataProvider();
    const llm = new CountingInvalidClient();
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });

    for (let i = 0; i < 2; i++) {
      const r = await service.plan(AGENT_ID, makePerception());
      expect(r.success).toBe(false);
    }
    expect(llm.calls).toBe(2);
    expect(provider.storePlanCalls).toHaveLength(0);

    const floored = await service.plan(AGENT_ID, makePerception());
    expect(floored.success).toBe(true);
    // The floor is synthesized locally — the Nth attempt floored, no extra call.
    expect(llm.calls).toBe(3);
    expect(provider.storePlanCalls).toHaveLength(1);

    // Reset bounds the budget over many cycles: 3 more failures then another floor.
    for (let i = 0; i < 2; i++) {
      expect((await service.plan(AGENT_ID, makePerception())).success).toBe(false);
    }
    expect((await service.plan(AGENT_ID, makePerception())).success).toBe(true);
    expect(llm.calls).toBe(6);
    expect(provider.storePlanCalls).toHaveLength(2);
  });

  it('a throwing [plan-floor] writer never propagates (spec 049)', async () => {
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('[plan-floor]')) throw new Error('diag boom');
    });
    const provider = new FakeDataProvider();
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: new CountingInvalidClient(),
      dataProvider: provider,
    });
    await service.plan(AGENT_ID, makePerception());
    await service.plan(AGENT_ID, makePerception());
    const floored = await service.plan(AGENT_ID, makePerception());
    expect(floored.success).toBe(true);
    expect(provider.storePlanCalls).toHaveLength(1);
  });
});
