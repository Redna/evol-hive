/**
 * Spec 060 — R1/R2/R3: shape classifier, zero-LLM diagnostics, bounded
 * client-seam repair (issue #214).
 *
 * Covers:
 * - AC-1: `checkPlanBinding` surfaces the additive-optional `shapeReason`
 *   while `violations` stays byte-identical.
 * - AC-2: `isValidFormulatePlanResult` and the client decode agree with
 *   `classifyPlanShape` — including bare-string steps and field aliases.
 * - AC-3: `[plan-invalid]` / `[plan-prompt]` / `[plan-repair]` / `[llm-raw]`
 *   fire with the right reason and sizes; a throwing writer never propagates;
 *   no extra LLM calls.
 * - AC-4: the client repairs an empty-step-description exactly once and throws
 *   after exactly two requests when the repair is still shape-invalid.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Affordance,
  AgentInternalState,
  AgentPlan,
  FormulatePlanResult,
  PerceptionResult,
  PlanDataProvider,
} from '@evol-hive/shared';
import { classifyPlanShape, formulatePlanTool } from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '../src/index.js';
import {
  checkPlanBinding,
  isValidFormulatePlanResult,
  PlanServiceImpl,
} from '../src/pper/plan-service.js';
import {
  decodeFormulatePlanArgs,
  OpenAICompatibleLLMClient,
  LLMResponseError,
} from '../src/llm/openai-client.js';
import { estimatePlanPrompt } from '../src/pper/plan-shape-diagnostic.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';
const IDS = ['brew_coffee', 'open_gate'];

const observe: Affordance = {
  id: 'observe',
  label: 'Observe',
  engineEffect: 'observe',
  preconditions: [],
  effects: {},
};

const brew: Affordance = {
  id: 'brew_coffee',
  label: 'Brew coffee',
  engineEffect: 'brew_coffee',
  preconditions: [],
  effects: { energy: 20 },
};

const validPlan: FormulatePlanResult = {
  description: 'Restore energy',
  steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
};

function emptyStepPlan(): Record<string, unknown> {
  return {
    description: 'Restore energy',
    steps: [
      { description: 'Brew coffee', targetAffordance: 'brew_coffee' },
      { description: '', targetAffordance: 'open_gate' },
    ],
  };
}

function makePerception(affordances: Affordance[] = [brew, observe]): PerceptionResult {
  return {
    passive: {
      roomId: ROOM_ID,
      objectsPresent: [],
      drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    },
    prunedAffordances: affordances,
    primaryDriveLabel: 'content',
  } as unknown as PerceptionResult;
}

// ─── AC-1: checkPlanBinding shapeReason ──────────────────────────────────────

describe('checkPlanBinding shapeReason (spec 060, R1 / AC-1)', () => {
  it('surfaces missing-description while violations stays byte-identical', () => {
    const v = checkPlanBinding({ description: '', steps: [{ description: 'x' }] }, IDS);
    expect(v.valid).toBe(false);
    expect(v.shapeValid).toBe(false);
    expect(v.shapeReason).toBe('missing-description');
    expect(v.violations).toEqual(['missing description or steps']);
    expect(v.feedback).toContain('not a valid plan');
  });

  it('surfaces missing-steps', () => {
    const v = checkPlanBinding({ description: 'd', steps: [] }, IDS);
    expect(v.shapeReason).toBe('missing-steps');
    expect(v.violations).toEqual(['missing description or steps']);
  });

  it('surfaces empty-step-description', () => {
    const v = checkPlanBinding(
      { description: 'd', steps: [{ description: '' }, { description: 'ok' }] },
      IDS,
    );
    expect(v.shapeReason).toBe('empty-step-description');
    expect(v.violations).toEqual(['missing description or steps']);
  });

  it('omits shapeReason on a valid plan and on a binding-only violation', () => {
    expect(checkPlanBinding(validPlan, IDS).shapeReason).toBeUndefined();
    const bindingOnly = checkPlanBinding(
      { description: 'd', steps: [{ description: 'narrative' }] },
      IDS,
    );
    expect(bindingOnly.shapeValid).toBe(true);
    expect(bindingOnly.shapeReason).toBeUndefined();
  });
});

// ─── AC-2: classifier agreement + decode ─────────────────────────────────────

describe('classifier agreement and client decode (spec 060, R1 / AC-2)', () => {
  const cases: FormulatePlanResult[] = [
    validPlan,
    { description: '', steps: [{ description: 'x' }] },
    { description: 'd', steps: [] },
    { description: 'd', steps: [{ description: '' }] },
    { description: 'd', steps: [{ description: 'ok' }] },
  ];

  it('isValidFormulatePlanResult is exactly classifyPlanShape === null', () => {
    for (const plan of cases) {
      expect(isValidFormulatePlanResult(plan)).toBe(classifyPlanShape(plan) === null);
    }
  });

  it('decodes a bare string step as both description and targetAffordance', () => {
    const decoded = decodeFormulatePlanArgs({
      description: 'd',
      steps: ['brew_coffee'],
    });
    expect(decoded.steps[0]).toEqual({
      description: 'brew_coffee',
      targetAffordance: 'brew_coffee',
    });
    expect(classifyPlanShape(decoded)).toBeNull();
  });

  it('applies the alias map: reason→description, action/affordance/tool/target→targetAffordance', () => {
    const decoded = decodeFormulatePlanArgs({
      description: 'd',
      steps: [
        { reason: 'rest', target: 'observe' },
        { description: 'go', action: 'open_gate' },
        { description: 'x', affordance: 'brew_coffee' },
        { description: 'y', tool: 'wait' },
      ],
    });
    expect(decoded.steps[0]).toEqual({ description: 'rest', targetAffordance: 'observe' });
    expect(decoded.steps[1]).toEqual({ description: 'go', targetAffordance: 'open_gate' });
    expect(decoded.steps[2]).toEqual({ description: 'x', targetAffordance: 'brew_coffee' });
    expect(decoded.steps[3]).toEqual({ description: 'y', targetAffordance: 'wait' });
  });

  it('decodes a non-array steps defensively to [] so classification is stable', () => {
    const decoded = decodeFormulatePlanArgs({ description: 'd', steps: 'nope' });
    expect(decoded.steps).toEqual([]);
    expect(classifyPlanShape(decoded)).toBe('missing-steps');
  });

  it('decodes a missing description to "" (missing-description, not a throw)', () => {
    const decoded = decodeFormulatePlanArgs({ steps: [{ description: 'x' }] });
    expect(decoded.description).toBe('');
    expect(classifyPlanShape(decoded)).toBe('missing-description');
  });

  it('still treats an aliased step without description as described (decode-before-classify)', () => {
    const decoded = decodeFormulatePlanArgs({ description: 'd', steps: [{ action: 'brew' }] });
    expect(classifyPlanShape(decoded)).toBeNull();
  });

  it('classifies a step object with no description at all as empty-step-description', () => {
    const decoded = decodeFormulatePlanArgs({
      description: 'd',
      steps: [{ targetAffordance: 'brew' }],
    });
    expect(classifyPlanShape(decoded)).toBe('empty-step-description');
  });

  it('decodes null/primitive steps without throwing', () => {
    const decoded = decodeFormulatePlanArgs({ description: 'd', steps: [null, 7] });
    expect(decoded.steps).toHaveLength(2);
    expect(classifyPlanShape(decoded)).toBe('empty-step-description');
  });
});

// ─── AC-3: estimatePlanPrompt ────────────────────────────────────────────────

describe('estimatePlanPrompt (spec 060, R2 / AC-3)', () => {
  it('is deterministic string arithmetic over system + context + serialized tools', () => {
    const tools = [formulatePlanTool];
    const size = estimatePlanPrompt({
      systemPrompt: 'abc',
      perceptionContext: 'defg',
      tools,
    });
    const expectedChars = 3 + 4 + JSON.stringify(tools).length;
    expect(size.chars).toBe(expectedChars);
    expect(size.estTokens).toBe(Math.ceil(expectedChars / 4));
  });

  it('handles empty strings and an empty tool list', () => {
    const size = estimatePlanPrompt({ systemPrompt: '', perceptionContext: '', tools: [] });
    expect(size).toEqual({ chars: 2, estTokens: 1 });
  });
});

// ─── AC-3/AC-4: client repair + diagnostics (mocked fetch) ───────────────────

const BASE_URL = 'http://localhost:8080/v1';
const MODEL = 'llama3.1';

function toolCallResponse(toolName: string, argumentsObj: unknown, status = 200): Response {
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
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function makePayload(overrides: Partial<LLMContextPayload> = {}): LLMContextPayload {
  return {
    systemPrompt: 'You are an agent.',
    perceptionContext: 'You are in a kitchen.',
    availableAffordances: [brew],
    cognitiveTools: [],
    tools: [formulatePlanTool],
    agentId: AGENT_ID,
    ...overrides,
  };
}

describe('client-seam shape repair + diagnostics (spec 060, R2/R3 / AC-3, AC-4)', () => {
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

  it('emits [plan-prompt] once per completePlan call with chars/estTokens', async () => {
    fetchMock.mockResolvedValue(toolCallResponse('formulate_plan', validPlan));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await client.completePlan(makePayload());
    const prompts = lines().filter((l) => l.includes('[plan-prompt]'));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/\[plan-prompt\] agent=a1 chars=\d+ estTokens=\d+/);
  });

  it('emits [llm-raw] for every shape reason', async () => {
    const bads: Record<string, unknown>[] = [
      { description: '', steps: [{ description: 'x' }] },
      { description: 'd', steps: [] },
      emptyStepPlan(),
    ];
    for (const bad of bads) {
      errSpy.mockClear();
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(toolCallResponse('formulate_plan', bad))
        .mockResolvedValueOnce(toolCallResponse('formulate_plan', validPlan));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await client.completePlan(makePayload());
      expect(lines().some((l) => l.includes('[llm-raw]'))).toBe(true);
    }
  });

  it('repairs an empty-step-description with exactly one retry and names the empty step', async () => {
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('formulate_plan', emptyStepPlan()))
      .mockResolvedValueOnce(toolCallResponse('formulate_plan', validPlan));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completePlan(makePayload());
    expect(result.description).toBe('Restore energy');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry prompt names step 2 and is appended as a user correction.
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    const lastMessage = body.messages[body.messages.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toContain('step 2 has an empty description');
  });

  it('emits [plan-invalid] reason=empty-step-description + [plan-repair] attempt=1', async () => {
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('formulate_plan', emptyStepPlan()))
      .mockResolvedValueOnce(toolCallResponse('formulate_plan', validPlan));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await client.completePlan(makePayload());
    const invalid = lines().filter((l) => l.includes('[plan-invalid]'));
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain('reason=empty-step-description');
    expect(invalid[0]).toMatch(/chars=\d+ estTokens=\d+/);
    const repair = lines().filter((l) => l.includes('[plan-repair]'));
    expect(repair).toHaveLength(1);
    expect(repair[0]).toContain('attempt=1');
    expect(repair[0]).toContain('reason=empty-step-description');
  });

  it('throws after exactly two requests when the repair is still shape-invalid', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(toolCallResponse('formulate_plan', emptyStepPlan())),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await expect(client.completePlan(makePayload())).rejects.toThrow(LLMResponseError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Both the pre-repair and post-repair detections are named.
    const invalid = lines().filter((l) => l.includes('[plan-invalid]'));
    expect(invalid).toHaveLength(2);
  });

  it('never makes more than two requests per completePlan call', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(toolCallResponse('formulate_plan', emptyStepPlan())),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await client.completePlan(makePayload()).catch(() => undefined);
    await client.completePlan(makePayload()).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('a throwing [plan-invalid] writer never propagates (repair still succeeds)', async () => {
    errSpy.mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('[plan-invalid]')) throw new Error('diag boom');
    });
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('formulate_plan', emptyStepPlan()))
      .mockResolvedValueOnce(toolCallResponse('formulate_plan', validPlan));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await expect(client.completePlan(makePayload())).resolves.toMatchObject({
      description: 'Restore energy',
    });
  });

  it('a throwing [plan-prompt] writer never propagates', async () => {
    errSpy.mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('[plan-prompt]')) throw new Error('diag boom');
    });
    fetchMock.mockResolvedValue(toolCallResponse('formulate_plan', validPlan));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await expect(client.completePlan(makePayload())).resolves.toMatchObject({
      description: 'Restore energy',
    });
  });

  it('a valid plan makes exactly one request (no repair, no extra LLM calls)', async () => {
    fetchMock.mockResolvedValue(toolCallResponse('formulate_plan', validPlan));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await client.completePlan(makePayload());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-3: service backstop [plan-invalid] ───────────────────────────────────

class FakeDataProvider implements PlanDataProvider {
  agentState: AgentInternalState;
  storePlanCalls: FormulatePlanResult[] = [];

  constructor() {
    this.agentState = {
      agentId: AGENT_ID,
      drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
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
      id: 'plan-1',
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

class ShapeInvalidClient implements LLMClient {
  async completeStructured() {
    return { reasoning: 'r', action: 'idle' };
  }
  async completeReflection() {
    return { agentId: AGENT_ID, newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(): Promise<FormulatePlanResult> {
    return { description: '', steps: [{ description: 'x' }] } as FormulatePlanResult;
  }
  async completeReflect() {
    return { memoryEntry: { content: 'x', importance: 5, type: 'action' } };
  }
}

describe('PlanServiceImpl shape backstop diagnostic (spec 060, R2 / AC-3)', () => {
  it('emits [plan-invalid] with the classifier reason on the service shape branch', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: new ShapeInvalidClient(),
      dataProvider: new FakeDataProvider(),
    });
    const result = await service.plan(AGENT_ID, makePerception());
    expect(result.success).toBe(false);
    const invalid = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('[plan-invalid]'));
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain('reason=missing-description');
    expect(invalid[0]).toMatch(/chars=\d+ estTokens=\d+/);
    errSpy.mockRestore();
  });
});
