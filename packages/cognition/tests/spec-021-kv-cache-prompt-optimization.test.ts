/**
 * Tests for spec 021 — KV Cache Prompt Optimization (Issue #86).
 *
 * Verifies that prompt construction produces a stable prefix (system prompt +
 * stable user-message content) so the Ollama KV cache can hit across ticks.
 *
 * Acceptance criteria covered:
 *   - AC-1:  PlanBuilderImpl system prompt excludes primaryDriveLabel; identical
 *            across calls with different labels.
 *   - AC-2:  ReflectBuilderImpl system prompt is stable (no dynamic content).
 *   - AC-3:  PlanBuilderImpl perceptionContext has `---` separator; stable
 *            content above, `Primary drive:` + `Drives:` below.
 *   - AC-4:  ReflectBuilderImpl perceptionContext has `---` separator; stable
 *            content above, `Drives:` below.
 *   - AC-5:  PerceptionBuilderImpl perceptionContext has `---` separator;
 *            stable content above, dynamic content below.
 *   - AC-6:  PlanBuilderImpl formatDrives rounds to integers.
 *   - AC-7:  ReflectBuilderImpl formatDrives rounds to integers.
 *   - AC-8:  PerceptionBuilderImpl formatDrives rounds to integers.
 *   - AC-9:  OpenAICompatibleLLMClient.buildUserMessage() omits "Cognitive tools:".
 *   - AC-10: OpenAICompatibleLLMClient.buildUserMessage() omits affordance text list.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Affordance,
  AgentInternalState,
  CognitiveTool,
  ExecuteResult,
  PerceptionResult,
} from '@evol-hive/shared';
import { chooseActionTool } from '@evol-hive/shared';
import type { LLMContextPayload } from '../src/index.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { ReflectBuilderImpl } from '../src/pper/reflect-builder.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { OpenAICompatibleLLMClient } from '../src/llm/openai-client.js';
import { defaultCognitiveTools } from '../src/tools/index.js';

// ─── Shared test data ─────────────────────────────────────────────────────────

const ROOM_ID = 'kitchen';

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
];

function makePerceptionResult(overrides: Partial<PerceptionResult> = {}): PerceptionResult {
  return {
    passive: {
      roomId: ROOM_ID,
      objectsPresent: objects,
      drives: {
        energy: 19.998333333333335,
        hunger: 50.4,
        social: 80.6,
        comfort: 60,
        curiosity: 40,
      },
    },
    prunedAffordances: affordances,
    primaryDriveLabel: 'low energy',
    ...overrides,
  };
}

function makeAgentState(overrides: Partial<AgentInternalState> = {}): AgentInternalState {
  return {
    agentId: 'a1',
    drives: { energy: 19.998333333333335, hunger: 50.4, social: 80.6, comfort: 60, curiosity: 40 },
    currentGoal: 'Stay alive',
    currentPlan: null,
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
    ...overrides,
  };
}

function makeExecuteResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return { success: true, planComplete: false, ...overrides };
}

// ─── Helper: split perceptionContext at the `---` separator ───────────────────

function splitAtSeparator(context: string): { above: string[]; below: string[] } {
  const lines = context.split('\n');
  const sepIndex = lines.indexOf('---');
  expect(sepIndex, 'perceptionContext must contain a --- separator line').toBeGreaterThan(-1);
  return {
    above: lines.slice(0, sepIndex),
    below: lines.slice(sepIndex + 1),
  };
}

// ─── AC-1: PlanBuilderImpl system prompt excludes primaryDriveLabel ──────────

describe('Spec 021 — AC-1: PlanBuilderImpl system prompt is stable', () => {
  const builder = new PlanBuilderImpl();

  it('system prompt does NOT contain the primaryDriveLabel string', () => {
    const label = 'low energy, need to restore energy';
    const payload = builder.build(makePerceptionResult({ primaryDriveLabel: label }));
    expect(payload.systemPrompt).not.toContain(label);
    // The dynamic "Your primary drive is:" sentence must be gone.
    expect(payload.systemPrompt).not.toContain('Your primary drive is:');
  });

  it('two calls with different primaryDriveLabel produce identical system prompts', () => {
    const p1 = builder.build(makePerceptionResult({ primaryDriveLabel: 'low energy' }));
    const p2 = builder.build(makePerceptionResult({ primaryDriveLabel: 'high hunger' }));
    expect(p1.systemPrompt).toBe(p2.systemPrompt);
  });

  it('system prompt still instructs to formulate a plan for the most urgent drive', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.systemPrompt).toContain('most urgent drive');
  });
});

// ─── AC-2: ReflectBuilderImpl system prompt is stable ────────────────────────

describe('Spec 021 — AC-2: ReflectBuilderImpl system prompt is stable', () => {
  const builder = new ReflectBuilderImpl();

  it('system prompt is identical across calls with different drive values', () => {
    const s1 = builder.build('a1', makeAgentState({ drives: { energy: 10 } }), makeExecuteResult());
    const s2 = builder.build('a1', makeAgentState({ drives: { energy: 90 } }), makeExecuteResult());
    expect(s1.systemPrompt).toBe(s2.systemPrompt);
  });

  it('system prompt does not contain drive values', () => {
    const payload = builder.build(
      'a1',
      makeAgentState({ drives: { energy: 19.998333333333335 } }),
      makeExecuteResult(),
    );
    expect(payload.systemPrompt).not.toContain('19.998');
  });
});

// ─── AC-3: PlanBuilderImpl perceptionContext separator ───────────────────────

describe('Spec 021 — AC-3: PlanBuilderImpl perceptionContext separator', () => {
  const builder = new PlanBuilderImpl();

  it('perceptionContext contains a --- separator line on its own line', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).toContain('\n---\n');
  });

  it('stable content (Room, Objects) is above ---', () => {
    const payload = builder.build(makePerceptionResult());
    const { above } = splitAtSeparator(payload.perceptionContext);
    const aboveText = above.join('\n');
    expect(aboveText).toContain(`Room: ${ROOM_ID}`);
    expect(aboveText).toContain('Coffee Machine');
  });

  it('dynamic content (Primary drive, Drives) is below ---', () => {
    const payload = builder.build(makePerceptionResult());
    const { below } = splitAtSeparator(payload.perceptionContext);
    const belowText = below.join('\n');
    expect(belowText).toContain('Primary drive:');
    expect(belowText).toContain('Drives:');
  });
});

// ─── AC-4: ReflectBuilderImpl perceptionContext separator ────────────────────

describe('Spec 021 — AC-4: ReflectBuilderImpl perceptionContext separator', () => {
  const builder = new ReflectBuilderImpl();

  it('perceptionContext contains a --- separator line on its own line', () => {
    const payload = builder.build('a1', makeAgentState(), makeExecuteResult());
    expect(payload.perceptionContext).toContain('\n---\n');
  });

  it('stable content (Current goal, Plan status) is above ---', () => {
    const payload = builder.build('a1', makeAgentState(), makeExecuteResult());
    const { above } = splitAtSeparator(payload.perceptionContext);
    const aboveText = above.join('\n');
    expect(aboveText).toContain('Current goal:');
    expect(aboveText).toContain('Plan status:');
  });

  it('dynamic content (Drives) is below ---', () => {
    const payload = builder.build('a1', makeAgentState(), makeExecuteResult());
    const { below } = splitAtSeparator(payload.perceptionContext);
    const belowText = below.join('\n');
    expect(belowText).toContain('Drives:');
  });
});

// ─── AC-5: PerceptionBuilderImpl perceptionContext separator ─────────────────

describe('Spec 021 — AC-5: PerceptionBuilderImpl perceptionContext separator', () => {
  const builder = new PerceptionBuilderImpl();

  it('perceptionContext contains a --- separator line on its own line', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).toContain('\n---\n');
  });

  it('stable content (Room, Objects) is above ---', () => {
    const payload = builder.build(makePerceptionResult());
    const { above } = splitAtSeparator(payload.perceptionContext);
    const aboveText = above.join('\n');
    expect(aboveText).toContain(`Room: ${ROOM_ID}`);
    expect(aboveText).toContain('Coffee Machine');
  });

  it('dynamic content (Primary drive, Drives) is below ---', () => {
    const payload = builder.build(makePerceptionResult());
    const { below } = splitAtSeparator(payload.perceptionContext);
    const belowText = below.join('\n');
    expect(belowText).toContain('Primary drive:');
    expect(belowText).toContain('Drives:');
  });

  it('Name and Tendencies (persona) are above --- when persona present', () => {
    const payload = builder.build(
      makePerceptionResult({
        persona: {
          name: 'Alice',
          backstory: 'A researcher.',
          behavioralTendencies: ['curious', 'social'],
        },
      }),
    );
    const { above } = splitAtSeparator(payload.perceptionContext);
    const aboveText = above.join('\n');
    expect(aboveText).toContain('Name: Alice');
    expect(aboveText).toContain('Tendencies: curious, social');
  });
});

// ─── AC-6: PlanBuilderImpl formatDrives rounds to integers ───────────────────

describe('Spec 021 — AC-6: PlanBuilderImpl formatDrives rounds values', () => {
  const builder = new PlanBuilderImpl();

  it('energy=19.998... renders as energy=20', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).toContain('energy=20');
    expect(payload.perceptionContext).not.toContain('19.998');
  });

  it('hunger=50.4 renders as hunger=50', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).toContain('hunger=50');
  });

  it('social=80.6 renders as social=81', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).toContain('social=81');
  });
});

// ─── AC-7: ReflectBuilderImpl formatDrives rounds to integers ────────────────

describe('Spec 021 — AC-7: ReflectBuilderImpl formatDrives rounds values', () => {
  const builder = new ReflectBuilderImpl();

  it('energy=19.998... renders as energy=20', () => {
    const payload = builder.build('a1', makeAgentState(), makeExecuteResult());
    expect(payload.perceptionContext).toContain('energy=20');
    expect(payload.perceptionContext).not.toContain('19.998');
  });
});

// ─── AC-8: PerceptionBuilderImpl formatDrives rounds to integers ─────────────

describe('Spec 021 — AC-8: PerceptionBuilderImpl formatDrives rounds values', () => {
  const builder = new PerceptionBuilderImpl();

  it('energy=19.998... renders as energy=20', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).toContain('energy=20');
    expect(payload.perceptionContext).not.toContain('19.998');
  });
});

// ─── AC-9 & AC-10: OpenAICompatibleLLMClient.buildUserMessage ─────────────────

describe('Spec 021 — AC-9/AC-10: buildUserMessage omits tool text', () => {
  const BASE_URL = 'http://localhost:8080/v1';
  const MODEL = 'llama3.1';

  function makePayload(overrides: Partial<LLMContextPayload> = {}): LLMContextPayload {
    return {
      systemPrompt: 'You are a helpful agent.',
      perceptionContext: 'You are in a kitchen.',
      availableAffordances: affordances,
      cognitiveTools: defaultCognitiveTools as unknown as CognitiveTool[],
      tools: [chooseActionTool],
      ...overrides,
    };
  }

  function toolCallResponse(toolName: string, args: unknown): Response {
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
                function: { name: toolName, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function getUserMessage(payload: LLMContextPayload): Promise<string> {
    fetchMock.mockResolvedValue(toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await client.completeStructured(payload);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    return body.messages[1].content as string;
  }

  it('AC-9: user message does NOT contain "Cognitive tools:"', async () => {
    const userMsg = await getUserMessage(makePayload());
    expect(userMsg).not.toContain('Cognitive tools:');
  });

  it('AC-9: user message does NOT contain cognitive tool name/description text', async () => {
    const userMsg = await getUserMessage(makePayload());
    expect(userMsg).not.toContain('name: formulate_plan');
    expect(userMsg).not.toContain('description:');
  });

  it('AC-10: user message does NOT contain affordance labels as a text list', async () => {
    const userMsg = await getUserMessage(makePayload());
    expect(userMsg).not.toContain('Brew coffee');
    expect(userMsg).not.toContain('Available actions:');
  });

  it('user message still contains the perceptionContext', async () => {
    const payload = makePayload();
    const userMsg = await getUserMessage(payload);
    expect(userMsg).toContain(payload.perceptionContext);
  });
});
