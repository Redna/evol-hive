/**
 * Tests for spec 019 — Affordance-as-Tools (cognition layer).
 * Covers AC-6 through AC-23, AC-26:
 *   - PerceptionBuilderImpl affordance tools (AC-6, AC-7)
 *   - PlanBuilderImpl affordance tools (AC-8)
 *   - buildUserMessage no "Available actions" (AC-9)
 *   - completeStructured affordance tool mapping (AC-10, AC-11)
 *   - COGNITIVE_TOOL_NAMES unchanged (AC-12)
 *   - requestChat return type (AC-13)
 *   - completePlan string array parsing (AC-14, AC-15, AC-16)
 *   - End-to-end Perception→completeStructured (AC-22)
 *   - End-to-end Plan→completePlan (AC-23)
 *   - Cognitive tool loop with affordance tools (AC-26)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Affordance,
  PassivePerception,
  PerceptionResult,
  LLMActionResponse,
  CognitiveTool,
  ToolDefinition,
  CognitiveToolExecutor,
} from '@evol-hive/shared';
import {
  chooseActionTool,
  formulatePlanTool,
  queryMemoryTool,
  updateInternalStateTool,
  affordancesToToolDefinitions,
  affordanceToToolDefinition,
} from '@evol-hive/shared';
import type { LLMContextPayload } from '../src/index.js';
import { OpenAICompatibleLLMClient, LLMResponseError } from '../src/llm/openai-client.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { defaultCognitiveTools } from '../src/tools/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:8080/v1';
const MODEL = 'llama3.1';

type FetchArgs = [string, RequestInit];
type FetchCall = { url: string; init: RequestInit };

function callAt(mock: ReturnType<typeof vi.fn>, index: number): FetchCall {
  const args = mock.mock.calls[index] as unknown as FetchArgs;
  return { url: args[0], init: args[1] };
}

const drives = { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 };
const objects = [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }];

function makeAffordance(overrides: Partial<Affordance> = {}): Affordance {
  return {
    id: 'brew_coffee',
    label: 'Brew coffee',
    engineEffect: 'brew_coffee',
    preconditions: [],
    effects: { energy: 20 },
    ...overrides,
  };
}

function makePerceptionResult(affordances?: Affordance[]): PerceptionResult {
  const passive: PassivePerception = {
    roomId: 'kitchen',
    objectsPresent: objects,
    drives,
  };
  return {
    passive,
    prunedAffordances: affordances ?? [makeAffordance()],
    primaryDriveLabel: 'low energy',
  };
}

function makePayload(overrides: Partial<LLMContextPayload> = {}): LLMContextPayload {
  return {
    systemPrompt: 'You are a helpful agent.',
    perceptionContext: 'You are in a kitchen. There is a coffee machine.',
    availableAffordances: [makeAffordance()],
    cognitiveTools: [
      { name: 'formulate_plan', description: 'Formulate a plan', argsSchema: {} },
    ] as CognitiveTool[],
    tools: [chooseActionTool],
    ...overrides,
  };
}

function toolCallResponse(
  toolName: string,
  argumentsObj: unknown,
  toolCallId = 'call-1',
  status = 200,
): Response {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: toolCallId,
              type: 'function',
              function: {
                name: toolName,
                arguments: JSON.stringify(argumentsObj),
              },
            },
          ],
        },
      },
    ],
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── AC-6: PerceptionBuilderImpl includes affordance tools ───────────────────

describe('PerceptionBuilderImpl affordance tools (AC-6)', () => {
  it('includes affordance tool definitions in tools array alongside cognitive tools', () => {
    const builder = new PerceptionBuilderImpl();
    const affs = [
      makeAffordance({ id: 'brew_coffee' }),
      makeAffordance({ id: 'observe', label: 'Observe', effects: {} }),
    ];
    const payload = builder.build(makePerceptionResult(affs));

    // Cognitive tools present
    expect(payload.tools.some((t) => t.function.name === 'query_memory')).toBe(true);
    expect(payload.tools.some((t) => t.function.name === 'update_internal_state')).toBe(true);
    // Affordance tools present
    expect(payload.tools.some((t) => t.function.name === 'brew_coffee')).toBe(true);
    expect(payload.tools.some((t) => t.function.name === 'observe')).toBe(true);
  });

  it('does NOT include chooseActionTool in the tools array', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    expect(payload.tools.some((t) => t.function.name === 'choose_action')).toBe(false);
  });

  it('availableAffordances remains populated for backward compatibility', () => {
    const builder = new PerceptionBuilderImpl();
    const affs = [makeAffordance()];
    const payload = builder.build(makePerceptionResult(affs));
    expect(payload.availableAffordances).toBe(affs);
  });
});

// ─── AC-7: Affordance masking in PerceptionBuilderImpl ───────────────────────

describe('PerceptionBuilderImpl affordance masking (AC-7)', () => {
  it('excludes affordance tools when masking is active (no plan + masking)', () => {
    const builder = new PerceptionBuilderImpl();
    const affs = [makeAffordance({ id: 'brew_coffee' })];
    const payload = builder.build(makePerceptionResult(affs), {
      hasPlan: false,
      maskingEnabled: true,
    });

    // No affordance tools
    expect(payload.tools.some((t) => t.function.name === 'brew_coffee')).toBe(false);
    // No chooseActionTool
    expect(payload.tools.some((t) => t.function.name === 'choose_action')).toBe(false);
    // Cognitive tools remain (including formulate_plan)
    expect(payload.tools.some((t) => t.function.name === 'formulate_plan')).toBe(true);
    expect(payload.tools.some((t) => t.function.name === 'query_memory')).toBe(true);
    // availableAffordances is []
    expect(payload.availableAffordances).toEqual([]);
  });
});

// ─── AC-8: PlanBuilderImpl includes affordance tools ─────────────────────────

describe('PlanBuilderImpl affordance tools (AC-8)', () => {
  it('includes affordance tool definitions alongside formulatePlanTool and cognitive tools', () => {
    const builder = new PlanBuilderImpl();
    const affs = [
      makeAffordance({ id: 'brew_coffee' }),
      makeAffordance({ id: 'observe', label: 'Observe', effects: {} }),
    ];
    const payload = builder.build(makePerceptionResult(affs));

    // formulatePlanTool present
    expect(payload.tools.some((t) => t.function.name === 'formulate_plan')).toBe(true);
    // Cognitive tools present
    expect(payload.tools.some((t) => t.function.name === 'query_memory')).toBe(true);
    expect(payload.tools.some((t) => t.function.name === 'update_internal_state')).toBe(true);
    // Affordance tools present
    expect(payload.tools.some((t) => t.function.name === 'brew_coffee')).toBe(true);
    expect(payload.tools.some((t) => t.function.name === 'observe')).toBe(true);
  });

  it('availableAffordances remains populated', () => {
    const builder = new PlanBuilderImpl();
    const affs = [makeAffordance()];
    const payload = builder.build(makePerceptionResult(affs));
    expect(payload.availableAffordances).toBe(affs);
  });
});

// ─── AC-9: buildUserMessage does not append "Available actions" ──────────────

describe('buildUserMessage no "Available actions" text (AC-9)', () => {
  it('does NOT include "Available actions:" in the user message', async () => {
    fetchMock.mockResolvedValue(toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload();
    await client.completeStructured(payload);
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    const userMsg: string = body.messages[1].content;
    expect(userMsg).not.toContain('Available actions:');
  });

  it('user message still contains perceptionContext', async () => {
    fetchMock.mockResolvedValue(toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload();
    await client.completeStructured(payload);
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    const userMsg: string = body.messages[1].content;
    expect(userMsg).toContain(payload.perceptionContext);
  });

  // Spec 021, Req 4: Cognitive tool descriptions are no longer rendered as
  // text in the user message (sent via the `tools` API parameter instead).
  it('user message does NOT contain cognitive tools text (spec 021, Req 4)', async () => {
    fetchMock.mockResolvedValue(toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload();
    await client.completeStructured(payload);
    const body = JSON.parse(callAt(fetchMock, 0).init.body as string);
    const userMsg: string = body.messages[1].content;
    expect(userMsg).not.toContain('Cognitive tools:');
  });
});

// ─── AC-10: completeStructured maps affordance tool calls ────────────────────

describe('completeStructured affordance tool mapping (AC-10)', () => {
  it('returns LLMActionResponse with action === tool name when LLM calls affordance tool', async () => {
    fetchMock.mockResolvedValue(toolCallResponse('brew_coffee', {}));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload({
      tools: [queryMemoryTool, ...affordancesToToolDefinitions([makeAffordance()])],
    });
    const result = await client.completeStructured(payload);
    expect(result.action).toBe('brew_coffee');
    expect(result.reasoning).toBe('');
    expect(result.actionArgs).toEqual({});
  });

  it('actionArgs is the parsed arguments object', async () => {
    fetchMock.mockResolvedValue(toolCallResponse('brew_coffee', { temp: 'hot' }));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload({
      tools: affordancesToToolDefinitions([makeAffordance()]),
    });
    const result = await client.completeStructured(payload);
    expect(result.action).toBe('brew_coffee');
    expect(result.actionArgs).toEqual({ temp: 'hot' });
  });
});

// ─── AC-11: completeStructured backward compat with choose_action ───────────

describe('completeStructured backward compat choose_action (AC-11)', () => {
  it('extracts reasoning and action from choose_action tool arguments', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('choose_action', { reasoning: 'I need energy.', action: 'brew_coffee' }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload({ tools: [chooseActionTool] });
    const result = await client.completeStructured(payload);
    expect(result.reasoning).toBe('I need energy.');
    expect(result.action).toBe('brew_coffee');
  });
});

// ─── AC-13: requestChat returns { toolName, args } ──────────────────────────

describe('requestChat return type (AC-13)', () => {
  it('tool name from fetch response is available to completeStructured', async () => {
    fetchMock.mockResolvedValue(toolCallResponse('brew_coffee', {}));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload({
      tools: affordancesToToolDefinitions([makeAffordance()]),
    });
    const result = await client.completeStructured(payload);
    // The tool name "brew_coffee" must be mapped as the action.
    expect(result.action).toBe('brew_coffee');
  });
});

// ─── AC-14, AC-15, AC-16: completePlan step parsing ─────────────────────────

describe('completePlan step parsing (AC-14, AC-15, AC-16)', () => {
  it('AC-14: parses object format steps', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('formulate_plan', {
        description: 'Get energy',
        steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload({ tools: [formulatePlanTool] });
    const result = await client.completePlan(payload);
    expect(result.description).toBe('Get energy');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.description).toBe('Brew coffee');
    expect(result.steps[0]!.targetAffordance).toBe('brew_coffee');
  });

  it('AC-15: parses string format steps', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('formulate_plan', {
        description: 'Get energy',
        steps: ['brew_coffee'],
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload({ tools: [formulatePlanTool] });
    const result = await client.completePlan(payload);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.description).toBe('brew_coffee');
    expect(result.steps[0]!.targetAffordance).toBe('brew_coffee');
  });

  it('AC-16: recognizes "tool" field as alias for targetAffordance', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('formulate_plan', {
        description: 'Get energy',
        steps: [{ description: 'Brew', tool: 'brew_coffee' }],
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload({ tools: [formulatePlanTool] });
    const result = await client.completePlan(payload);
    expect(result.steps[0]!.targetAffordance).toBe('brew_coffee');
  });
});

// ─── AC-22: End-to-end Perception→completeStructured ─────────────────────────

describe('End-to-end Perception→completeStructured (AC-22)', () => {
  it('builder produces affordance tools, client sends them, mock returns affordance call', async () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult([makeAffordance()]));

    // Verify the payload has affordance tools
    expect(payload.tools.some((t) => t.function.name === 'brew_coffee')).toBe(true);
    expect(payload.tools.some((t) => t.function.name === 'choose_action')).toBe(false);

    // Mock fetch returns an affordance tool call
    fetchMock.mockResolvedValue(toolCallResponse('brew_coffee', {}));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completeStructured(payload);

    expect(result.action).toBe('brew_coffee');
    expect(result.reasoning).toBe('');
    expect(result.actionArgs).toEqual({});
  });
});

// ─── AC-23: End-to-end Plan→completePlan ────────────────────────────────────

describe('End-to-end Plan→completePlan (AC-23)', () => {
  it('builder produces affordance tools alongside formulatePlanTool, completePlan parses string steps', async () => {
    const builder = new PlanBuilderImpl();
    const payload = builder.build(makePerceptionResult([makeAffordance()]));

    // Verify the payload has formulatePlanTool and affordance tools
    expect(payload.tools.some((t) => t.function.name === 'formulate_plan')).toBe(true);
    expect(payload.tools.some((t) => t.function.name === 'brew_coffee')).toBe(true);

    // Mock fetch returns formulate_plan with string steps
    fetchMock.mockResolvedValue(
      toolCallResponse('formulate_plan', {
        description: 'Brew coffee',
        steps: ['brew_coffee'],
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completePlan(payload);

    expect(result.steps[0]!.targetAffordance).toBe('brew_coffee');
  });
});

// ─── AC-26: Cognitive tool loop with affordance tools ───────────────────────

describe('Cognitive tool loop with affordance tools (AC-26)', () => {
  it('executes cognitive tool mid-loop then terminates on affordance tool', async () => {
    const affTool = affordanceToToolDefinition(makeAffordance());
    const executor: CognitiveToolExecutor = {
      async executeQueryMemory() {
        return { memories: [] };
      },
      async executeUpdateInternalState() {
        return {};
      },
      async executeTalkTo() {
        return { success: true };
      },
      async executeObserveAgent() {
        return { success: true };
      },
      async executeHelp() {
        return { success: true };
      },
      async executeIgnore() {
        return { success: true };
      },
    };

    // First call: query_memory (cognitive), second call: brew_coffee (affordance terminal)
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('query_memory', { query: 'energy' }, 'call-1'))
      .mockResolvedValueOnce(toolCallResponse('brew_coffee', {}, 'call-2'));

    const client = new OpenAICompatibleLLMClient({
      baseUrl: BASE_URL,
      model: MODEL,
      cognitiveToolExecutor: executor,
    });
    const payload = makePayload({
      tools: [queryMemoryTool, affTool],
      agentId: 'agent-1',
    });
    const result = await client.completeStructured(payload);

    expect(result.action).toBe('brew_coffee');
    expect(result.reasoning).toBe('');
    // Two fetch calls: first for query_memory, second for brew_coffee
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
