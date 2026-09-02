/**
 * Spec 025 — Memory Entry Flatten & Auto-Fallback
 * Tests for the cognition layer:
 *   - completeReflect parsing of flattened fields (R3, AC-7, AC-8, AC-9)
 *   - ReflectServiceImpl validation and application (R4, AC-10, AC-11, AC-12)
 *   - Auto-fallback memory generation (R5, AC-13, AC-14, AC-15, AC-16)
 *   - Reflect system prompt (R6, AC-17)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  AgentInternalState,
  ExecuteResult,
  MemoryEntryInput,
  ReflectDataProvider,
  ReflectLLMResponse,
} from '@evol-hive/shared';
import { reflectSchema, reflectTool } from '@evol-hive/shared';
import type { LLMContextPayload, LLMClient } from '../src/index.js';
import { OpenAICompatibleLLMClient } from '../src/llm/openai-client.js';
import { ReflectBuilderImpl } from '../src/pper/reflect-builder.js';
import { ReflectServiceImpl } from '../src/pper/reflect-service.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:8080/v1';
const MODEL = 'llama3.1';
const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

function makeAgentState(overrides: Partial<AgentInternalState> = {}): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { energy: 50, hunger: 30, social: 80, comfort: 60, curiosity: 40 },
    currentGoal: 'Stay alive',
    currentPlan: null,
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
    ...overrides,
  };
}

function makeExecuteResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    success: true,
    planComplete: false,
    ...overrides,
  };
}

function makePayload(overrides: Partial<LLMContextPayload> = {}): LLMContextPayload {
  return {
    systemPrompt: 'You are a helpful agent.',
    perceptionContext: 'You are in a kitchen.',
    availableAffordances: [],
    cognitiveTools: [],
    tools: [reflectTool],
    ...overrides,
  };
}

/** Mock response with tool_calls in the body. */
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

// ─── R3: completeReflect parsing (AC-7, AC-8, AC-9) ──────────────────────────

describe('completeReflect — flattened fields parsing (R3, AC-7, AC-8, AC-9)', () => {
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

  // AC-7: flattened fields are parsed correctly
  it('parses memoryContent, memoryImportance, memoryType, memoryLocation from tool call args (AC-7)', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('reflect', {
        memoryContent: 'Brewed coffee successfully',
        memoryImportance: 7,
        memoryType: 'action',
        memoryLocation: 'kitchen',
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completeReflect(makePayload({ tools: [reflectTool] }));
    expect(result.memoryContent).toBe('Brewed coffee successfully');
    expect(result.memoryImportance).toBe(7);
    expect(result.memoryType).toBe('action');
    expect(result.memoryLocation).toBe('kitchen');
  });

  // AC-8: legacy memoryEntry is still accepted and translated to flattened fields
  it('accepts legacy memoryEntry and populates flattened fields (AC-8)', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('reflect', {
        memoryEntry: {
          content: 'Legacy memory',
          importance: 5,
          type: 'observation',
          location: 'bedroom',
        },
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completeReflect(makePayload({ tools: [reflectTool] }));
    expect(result.memoryContent).toBe('Legacy memory');
    expect(result.memoryImportance).toBe(5);
    expect(result.memoryType).toBe('observation');
    expect(result.memoryLocation).toBe('bedroom');
  });

  // AC-8: flattened fields take precedence over legacy memoryEntry when both present
  it('flattened fields take precedence over legacy memoryEntry when both present (AC-8)', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('reflect', {
        memoryContent: 'Flattened',
        memoryImportance: 9,
        memoryType: 'reflection',
        memoryLocation: 'hall',
        memoryEntry: {
          content: 'Legacy',
          importance: 3,
          type: 'action',
          location: 'old-room',
        },
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completeReflect(makePayload({ tools: [reflectTool] }));
    expect(result.memoryContent).toBe('Flattened');
    expect(result.memoryImportance).toBe(9);
    expect(result.memoryType).toBe('reflection');
    expect(result.memoryLocation).toBe('hall');
  });

  // AC-9: default importance to 5 when missing
  it('defaults memoryImportance to 5 when missing (AC-9)', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('reflect', {
        memoryContent: 'Some memory',
        memoryType: 'action',
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completeReflect(makePayload({ tools: [reflectTool] }));
    expect(result.memoryImportance).toBe(5);
  });

  // AC-9: default importance to 5 when invalid (not 1-10)
  it('defaults memoryImportance to 5 when invalid (non-integer or out of range) (AC-9)', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('reflect', {
        memoryContent: 'Some memory',
        memoryImportance: 15,
        memoryType: 'action',
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completeReflect(makePayload({ tools: [reflectTool] }));
    expect(result.memoryImportance).toBe(5);
  });

  // AC-9: default type to "observation" when missing
  it('defaults memoryType to "observation" when missing (AC-9)', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('reflect', {
        memoryContent: 'Some memory',
        memoryImportance: 5,
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completeReflect(makePayload({ tools: [reflectTool] }));
    expect(result.memoryType).toBe('observation');
  });

  // AC-9: default type to "observation" when invalid (not in enum)
  it('defaults memoryType to "observation" when invalid (not in enum) (AC-9)', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('reflect', {
        memoryContent: 'Some memory',
        memoryImportance: 5,
        memoryType: 'invalid_type',
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completeReflect(makePayload({ tools: [reflectTool] }));
    expect(result.memoryType).toBe('observation');
  });

  // AC-9: memoryLocation is undefined when missing
  it('leaves memoryLocation undefined when missing (AC-9)', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('reflect', {
        memoryContent: 'Some memory',
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completeReflect(makePayload({ tools: [reflectTool] }));
    expect(result.memoryLocation).toBeUndefined();
  });

  it('returns empty response when no memory fields present', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('reflect', {
        newGoal: 'New goal',
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completeReflect(makePayload({ tools: [reflectTool] }));
    expect(result.memoryContent).toBeUndefined();
    expect(result.newGoal).toBe('New goal');
  });
});

// ─── Fake ReflectDataProvider for ReflectServiceImpl tests ────────────────────

class FakeReflectDataProvider implements ReflectDataProvider {
  getAgentStateCalls: string[] = [];
  applyDriveChangesCalls: { agentId: string; changes: Partial<Record<string, number>> }[] = [];
  updateGoalCalls: { agentId: string; goal: string }[] = [];
  storeMemoryCalls: { agentId: string; entry: MemoryEntryInput }[] = [];
  clearPlanIfCompleteCalls: string[] = [];
  setThinkingCalls: { agentId: string; isThinking: boolean }[] = [];

  agentState: AgentInternalState | null = makeAgentState();
  clearPlanReturn: boolean = false;
  storeMemoryShouldThrow: Error | null = null;

  getAgentState(agentId: string): AgentInternalState | null {
    this.getAgentStateCalls.push(agentId);
    return this.agentState;
  }
  applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void {
    this.applyDriveChangesCalls.push({ agentId, changes });
  }
  updateGoal(agentId: string, goal: string): void {
    this.updateGoalCalls.push({ agentId, goal });
  }
  async storeMemory(agentId: string, entry: MemoryEntryInput): Promise<void> {
    this.storeMemoryCalls.push({ agentId, entry });
    if (this.storeMemoryShouldThrow) {
      throw this.storeMemoryShouldThrow;
    }
  }
  clearPlanIfComplete(agentId: string): boolean {
    this.clearPlanIfCompleteCalls.push(agentId);
    return this.clearPlanReturn;
  }
  setThinking(agentId: string, isThinking: boolean): void {
    this.setThinkingCalls.push({ agentId, isThinking });
    if (this.agentState) {
      this.agentState = { ...this.agentState, isThinking };
    }
  }
}

/** Fake LLMClient for reflect testing. */
class FakeLLMClient implements LLMClient {
  completeStructured = vi.fn();
  completeReflection = vi.fn();
  completePlan = vi.fn();
  completeReflect = vi.fn();
}

function makeService(
  provider: FakeReflectDataProvider,
  reflectResponse: ReflectLLMResponse | Error = {},
): { service: ReflectServiceImpl; llm: FakeLLMClient } {
  const llm = new FakeLLMClient();
  if (reflectResponse instanceof Error) {
    llm.completeReflect = vi.fn().mockRejectedValue(reflectResponse);
  } else {
    llm.completeReflect = vi.fn().mockResolvedValue(reflectResponse);
  }
  const service = new ReflectServiceImpl({
    reflectBuilder: new ReflectBuilderImpl(),
    llmClient: llm,
    dataProvider: provider,
  });
  return { service, llm };
}

// ─── R4: ReflectServiceImpl with flattened fields (AC-10, AC-11, AC-12) ──────

describe('ReflectServiceImpl — flattened memoryContent (R4, AC-10, AC-11, AC-12)', () => {
  let provider: FakeReflectDataProvider;

  beforeEach(() => {
    provider = new FakeReflectDataProvider();
  });

  // AC-10: stores memory when memoryContent is non-empty
  it('stores a memory when memoryContent is non-empty (AC-10)', async () => {
    const response: ReflectLLMResponse = {
      memoryContent: 'I learned something important',
      memoryImportance: 7,
      memoryType: 'reflection',
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result.success).toBe(true);
    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
    expect(provider.storeMemoryCalls[0]!.entry.content).toBe('I learned something important');
    expect(provider.storeMemoryCalls[0]!.entry.importance).toBe(7);
    expect(provider.storeMemoryCalls[0]!.entry.type).toBe('reflection');
  });

  // AC-10: stores memory with defaults when optional fields missing
  it('uses default importance=5 and type=observation when not provided (AC-10)', async () => {
    const response: ReflectLLMResponse = {
      memoryContent: 'Just content',
    };
    const { service } = makeService(provider, response);
    await service.reflect(AGENT_ID, makeExecuteResult());

    expect(provider.storeMemoryCalls[0]!.entry.importance).toBe(5);
    expect(provider.storeMemoryCalls[0]!.entry.type).toBe('observation');
  });

  // AC-10: stores memoryLocation when provided
  it('stores memoryLocation when provided (AC-10)', async () => {
    const response: ReflectLLMResponse = {
      memoryContent: 'Event in hall',
      memoryLocation: 'hall',
    };
    const { service } = makeService(provider, response);
    await service.reflect(AGENT_ID, makeExecuteResult());

    expect(provider.storeMemoryCalls[0]!.entry.location).toBe('hall');
  });

  // AC-10: memoryLocation is undefined when not provided
  it('does not set location when memoryLocation is not provided (AC-10)', async () => {
    const response: ReflectLLMResponse = {
      memoryContent: 'Event somewhere',
    };
    const { service } = makeService(provider, response);
    await service.reflect(AGENT_ID, makeExecuteResult());

    expect(provider.storeMemoryCalls[0]!.entry.location).toBeUndefined();
  });

  // AC-11: stores memory from legacy memoryEntry when flattened fields absent
  it('stores a memory from legacy memoryEntry when flattened fields are absent (AC-11)', async () => {
    const response: ReflectLLMResponse = {
      memoryEntry: {
        content: 'Legacy memory',
        importance: 6,
        type: 'action',
        location: 'bedroom',
      },
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result.success).toBe(true);
    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
    expect(provider.storeMemoryCalls[0]!.entry.content).toBe('Legacy memory');
    expect(provider.storeMemoryCalls[0]!.entry.importance).toBe(6);
    expect(provider.storeMemoryCalls[0]!.entry.type).toBe('action');
    expect(provider.storeMemoryCalls[0]!.entry.location).toBe('bedroom');
  });

  // AC-12: empty memoryContent triggers auto-fallback (spec 025, R5.1)
  it('auto-generates a memory when memoryContent is empty string (AC-12, spec 025)', async () => {
    const response: ReflectLLMResponse = {
      memoryContent: '',
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result.success).toBe(true);
    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
    // Auto-fallback content (not the empty memoryContent)
    expect(provider.storeMemoryCalls[0]!.entry.content).not.toBe('');
    expect(provider.storeMemoryCalls[0]!.entry.importance).toBe(3);
  });

  // whitespace-only memoryContent triggers auto-fallback (spec 025, R5.1)
  it('auto-generates a memory when memoryContent is whitespace-only (spec 025)', async () => {
    const response: ReflectLLMResponse = {
      memoryContent: '   ',
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result.success).toBe(true);
    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
    expect(provider.storeMemoryCalls[0]!.entry.content).not.toBe('   ');
    expect(provider.storeMemoryCalls[0]!.entry.importance).toBe(3);
  });

  // R4.4 / AC-12: invalid legacy memoryEntry content still causes failure
  it('returns failure with no partial updates when legacy memoryEntry has empty content (AC-12)', async () => {
    const response: ReflectLLMResponse = {
      newGoal: 'New goal',
      driveOverrides: { hunger: 20 },
      memoryEntry: { content: '', importance: 5, type: 'action' },
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult());

    expect(result.success).toBe(false);
    expect(result.cycleComplete).toBe(false);
    expect(result.error).toContain('Invalid memory entry from LLM');
    expect(result.memoryStored).toBe(false);
    expect(result.goalUpdated).toBe(false);
    expect(result.drivesUpdated).toBe(false);
    expect(provider.applyDriveChangesCalls).toHaveLength(0);
    expect(provider.updateGoalCalls).toHaveLength(0);
  });

  // Flattened fields take precedence over legacy memoryEntry in service
  it('uses flattened memoryContent when both flattened and legacy are present', async () => {
    const response: ReflectLLMResponse = {
      memoryContent: 'Flattened content',
      memoryImportance: 8,
      memoryType: 'reflection',
      memoryEntry: { content: 'Legacy content', importance: 2, type: 'action' },
    };
    const { service } = makeService(provider, response);
    await service.reflect(AGENT_ID, makeExecuteResult());

    expect(provider.storeMemoryCalls).toHaveLength(1);
    expect(provider.storeMemoryCalls[0]!.entry.content).toBe('Flattened content');
    expect(provider.storeMemoryCalls[0]!.entry.importance).toBe(8);
    expect(provider.storeMemoryCalls[0]!.entry.type).toBe('reflection');
  });
});

// ─── R5: Auto-fallback memory generation (AC-13, AC-14, AC-15, AC-16) ─────────

describe('ReflectServiceImpl — auto-fallback memory generation (R5, AC-13, AC-14, AC-15, AC-16)', () => {
  let provider: FakeReflectDataProvider;

  beforeEach(() => {
    provider = new FakeReflectDataProvider();
  });

  // AC-13: auto-generates memory when LLM omits all memory fields
  it('auto-generates a memory when LLM omits all memory fields (AC-13)', async () => {
    const { service } = makeService(provider, {});
    const result = await service.reflect(AGENT_ID, makeExecuteResult({ success: true }));

    expect(result.success).toBe(true);
    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
  });

  // AC-14: auto-generated content is non-empty and contains the goal
  it('auto-generated content is non-empty and contains the agent current goal on success (AC-14)', async () => {
    const agentState = makeAgentState({ currentGoal: 'Find coffee beans' });
    provider.agentState = agentState;
    const { service } = makeService(provider, {});
    await service.reflect(AGENT_ID, makeExecuteResult({ success: true }));

    const entry = provider.storeMemoryCalls[0]!.entry;
    expect(entry.content.length).toBeGreaterThan(0);
    expect(entry.content).toContain('Find coffee beans');
  });

  // AC-14: auto-generated content contains the error on failure
  it('auto-generated content contains the execution error on failure (AC-14)', async () => {
    provider.agentState = makeAgentState({ currentGoal: 'Brew coffee' });
    const { service } = makeService(provider, {});
    await service.reflect(
      AGENT_ID,
      makeExecuteResult({ success: false, error: 'No water in machine' }),
    );

    const entry = provider.storeMemoryCalls[0]!.entry;
    expect(entry.content).toContain('No water in machine');
    expect(entry.content).toContain('Brew coffee');
  });

  // AC-14: auto-generated content for stepSkipped
  it('auto-generated content mentions idle tick when stepSkipped is true (AC-14)', async () => {
    provider.agentState = makeAgentState({ currentGoal: 'Explore' });
    const { service } = makeService(provider, {});
    await service.reflect(AGENT_ID, makeExecuteResult({ stepSkipped: true }));

    const entry = provider.storeMemoryCalls[0]!.entry;
    expect(entry.content.toLowerCase()).toContain('idle');
    expect(entry.content).toContain('Explore');
  });

  // AC-15: importance=3, type="action" on success
  it('auto-generated memory has importance=3 and type="action" on success (AC-15)', async () => {
    const { service } = makeService(provider, {});
    await service.reflect(AGENT_ID, makeExecuteResult({ success: true }));

    const entry = provider.storeMemoryCalls[0]!.entry;
    expect(entry.importance).toBe(3);
    expect(entry.type).toBe('action');
  });

  // AC-15: importance=3, type="observation" on failure
  it('auto-generated memory has importance=3 and type="observation" on failure (AC-15)', async () => {
    const { service } = makeService(provider, {});
    await service.reflect(AGENT_ID, makeExecuteResult({ success: false, error: 'failed' }));

    const entry = provider.storeMemoryCalls[0]!.entry;
    expect(entry.importance).toBe(3);
    expect(entry.type).toBe('observation');
  });

  // AC-15: location from agentState
  it('auto-generated memory location is the agent location from agentState (AC-15)', async () => {
    provider.agentState = makeAgentState({ location: 'bedroom' });
    const { service } = makeService(provider, {});
    await service.reflect(AGENT_ID, makeExecuteResult({ success: true }));

    expect(provider.storeMemoryCalls[0]!.entry.location).toBe('bedroom');
  });

  // AC-16: auto-fallback does NOT trigger when LLM provides memoryContent
  it('does NOT auto-generate when LLM provides memoryContent (AC-16)', async () => {
    const response: ReflectLLMResponse = {
      memoryContent: 'LLM-provided memory',
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult({ success: true }));

    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
    expect(provider.storeMemoryCalls[0]!.entry.content).toBe('LLM-provided memory');
  });

  // AC-16: auto-fallback does NOT trigger when LLM provides legacy memoryEntry
  it('does NOT auto-generate when LLM provides legacy memoryEntry (AC-16)', async () => {
    const response: ReflectLLMResponse = {
      memoryEntry: { content: 'Legacy', importance: 5, type: 'action' },
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult({ success: true }));

    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls).toHaveLength(1);
    expect(provider.storeMemoryCalls[0]!.entry.content).toBe('Legacy');
  });

  // AC-16: auto-fallback does NOT trigger when memoryContent is empty but legacy memoryEntry is present
  it('does NOT auto-generate when memoryContent is empty but legacy memoryEntry is present (AC-16)', async () => {
    const response: ReflectLLMResponse = {
      memoryContent: '',
      memoryEntry: { content: 'Legacy', importance: 5, type: 'action' },
    };
    const { service } = makeService(provider, response);
    const result = await service.reflect(AGENT_ID, makeExecuteResult({ success: true }));

    expect(result.memoryStored).toBe(true);
    expect(provider.storeMemoryCalls[0]!.entry.content).toBe('Legacy');
  });

  // Auto-fallback appends drive changes on success
  it('appends drive changes to auto-generated content on success', async () => {
    provider.agentState = makeAgentState({ currentGoal: 'Eat' });
    const { service } = makeService(provider, {});
    const execResult = makeExecuteResult({
      success: true,
      result: {
        driveChanges: { energy: 20, hunger: -5 },
      },
    });
    await service.reflect(AGENT_ID, execResult);

    const content = provider.storeMemoryCalls[0]!.entry.content;
    expect(content).toContain('energy');
    expect(content).toContain('+20');
    expect(content).toContain('hunger');
    expect(content).toContain('-5');
  });

  // Auto-fallback on stepSkipped uses "observation" type (not "action")
  it('auto-generated memory type is "observation" when stepSkipped', async () => {
    const { service } = makeService(provider, {});
    await service.reflect(AGENT_ID, makeExecuteResult({ stepSkipped: true }));

    const entry = provider.storeMemoryCalls[0]!.entry;
    expect(entry.type).toBe('observation');
    expect(entry.importance).toBe(3);
  });
});

// ─── R6: Reflect system prompt (AC-17) ───────────────────────────────────────

describe('ReflectBuilderImpl — system prompt (R6, AC-17)', () => {
  it('system prompt references memoryContent, memoryImportance, memoryType by name', () => {
    const builder = new ReflectBuilderImpl();
    const payload = builder.build(AGENT_ID, makeAgentState(), makeExecuteResult());
    expect(payload.systemPrompt).toContain('memoryContent');
    expect(payload.systemPrompt).toContain('memoryImportance');
    expect(payload.systemPrompt).toContain('memoryType');
  });

  it('system prompt references memoryLocation', () => {
    const builder = new ReflectBuilderImpl();
    const payload = builder.build(AGENT_ID, makeAgentState(), makeExecuteResult());
    expect(payload.systemPrompt).toContain('memoryLocation');
  });

  it('system prompt does NOT reference legacy memoryEntry', () => {
    const builder = new ReflectBuilderImpl();
    const payload = builder.build(AGENT_ID, makeAgentState(), makeExecuteResult());
    expect(payload.systemPrompt).not.toContain('memoryEntry');
  });

  it('system prompt with persona also references flattened field names', () => {
    const builder = new ReflectBuilderImpl();
    const profile = {
      name: 'Alice',
      personaPrompt: 'A curious explorer',
      personaWeight: 1,
      primaryDrive: 'curiosity' as const,
      longTermGoals: ['Find treasure'],
      relationships: {},
    };
    const payload = builder.build(AGENT_ID, makeAgentState(), makeExecuteResult(), profile);
    expect(payload.systemPrompt).toContain('memoryContent');
    expect(payload.systemPrompt).toContain('memoryImportance');
    expect(payload.systemPrompt).toContain('memoryType');
  });
});
