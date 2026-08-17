/**
 * Tests for LLM Schema-in-Prompt & Field Name Aliasing
 * (spec 010, issue #37).
 *
 * Covers acceptance criteria AC-1, AC-6 through AC-36.
 *
 * Tests mock the global `fetch` API and do NOT require a running LLM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Affordance,
  CognitiveTool,
  ExecuteResult,
  AgentInternalState,
  PerceptionResult,
  MemorySnippet,
} from '@evol-hive/shared';
import {
  llmActionResponseSchema,
  formulatePlanSchema,
  reflectSchema,
  PLAN_SCHEMA_HINT,
  ACTION_RESPONSE_SCHEMA_HINT,
  REFLECT_SCHEMA_HINT,
  MEMORY_CONSOLIDATION_SCHEMA_HINT,
} from '@evol-hive/shared';
import type { LLMContextPayload } from '../src/index.js';
import { OpenAICompatibleLLMClient, LLMResponseError } from '../src/llm/openai-client.js';
import { resolveField } from '../src/llm/json-recovery.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { ReflectBuilderImpl } from '../src/pper/reflect-builder.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:8080/v1';
const MODEL = 'llama3.1';
const CHAT_URL = `${BASE_URL}/chat/completions`;

type FetchArgs = [string, RequestInit];

function callAt(mock: ReturnType<typeof vi.fn>, index: number): { url: string; init: RequestInit } {
  const args = mock.mock.calls[index] as unknown as FetchArgs;
  return { url: args[0], init: args[1] };
}

function makePayload(overrides: Partial<LLMContextPayload> = {}): LLMContextPayload {
  return {
    systemPrompt: 'You are a helpful agent.',
    perceptionContext: 'You are in a kitchen. There is a coffee machine.',
    availableAffordances: [{ id: 'brew_coffee', label: 'Brew coffee' }] as Affordance[],
    cognitiveTools: [
      { name: 'formulate_plan', description: 'Formulate a plan', argsSchema: {} },
    ] as CognitiveTool[],
    responseSchema: llmActionResponseSchema,
    ...overrides,
  };
}

function chatResponse(content: string, status = 200): Response {
  const body = JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function userMessageFromCall(mock: ReturnType<typeof vi.fn>, index = 0): string {
  const body = JSON.parse(callAt(mock, index).init.body as string);
  return body.messages[1].content as string;
}

const FULL_DRIVES = { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 };

function makePerceptionResult(): PerceptionResult {
  return {
    passive: {
      roomId: 'kitchen',
      objectsPresent: [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
      drives: FULL_DRIVES,
    },
    prunedAffordances: [{ id: 'brew_coffee', label: 'Brew coffee' }],
    primaryDriveLabel: 'energy',
  };
}

function makeAgentState(): AgentInternalState {
  return {
    agentId: 'agent-1',
    drives: FULL_DRIVES,
    currentGoal: 'Restore energy',
    currentPlan: null,
    isThinking: false,
    room: 'kitchen',
  };
}

function makeExecuteResult(): ExecuteResult {
  return {
    agentId: 'agent-1',
    success: true,
    stepExecuted: { description: 'Brew coffee', targetAffordance: 'brew_coffee' },
    result: undefined,
    planComplete: false,
    stepSkipped: false,
  };
}

// ─── Test setup ──────────────────────────────────────────────────────────────

describe('Schema-in-prompt & field aliasing (spec 010)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ─── AC-1: LLMContextPayload.schemaHint optional ──────────────────────────

  describe('LLMContextPayload.schemaHint (AC-1)', () => {
    it('payload without schemaHint produces a user message with no schema hint paragraph (AC-1, AC-10)', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload(); // no schemaHint
      await client.completeStructured(payload);
      const userMsg = userMessageFromCall(fetchMock, 0);
      // The user message should NOT contain any schema hint string.
      expect(userMsg).not.toContain('Respond with JSON in this exact format');
    });

    it('schemaHint is optional and can be omitted from the payload type (AC-1)', () => {
      const payload: LLMContextPayload = {
        systemPrompt: 'sys',
        perceptionContext: 'ctx',
        availableAffordances: [],
        cognitiveTools: [],
        responseSchema: {},
      };
      expect(payload.schemaHint).toBeUndefined();
    });
  });

  // ─── AC-6, AC-7, AC-8: Builders populate schemaHint ────────────────────────

  describe('Builder schemaHint population (AC-6, AC-7, AC-8)', () => {
    it('PlanBuilderImpl.build() returns payload with schemaHint = PLAN_SCHEMA_HINT (AC-6)', () => {
      const builder = new PlanBuilderImpl();
      const payload = builder.build(makePerceptionResult());
      expect(payload.schemaHint).toBe(PLAN_SCHEMA_HINT);
    });

    it('PerceptionBuilderImpl.build() returns payload with schemaHint = ACTION_RESPONSE_SCHEMA_HINT (AC-7)', () => {
      const builder = new PerceptionBuilderImpl();
      const payload = builder.build(makePerceptionResult());
      expect(payload.schemaHint).toBe(ACTION_RESPONSE_SCHEMA_HINT);
    });

    it('ReflectBuilderImpl.build() returns payload with schemaHint = REFLECT_SCHEMA_HINT (AC-8)', () => {
      const builder = new ReflectBuilderImpl();
      const payload = builder.build('agent-1', makeAgentState(), makeExecuteResult());
      expect(payload.schemaHint).toBe(REFLECT_SCHEMA_HINT);
    });
  });

  // ─── AC-9, AC-10: buildUserMessage appends schemaHint ──────────────────────

  describe('buildUserMessage schemaHint appending (AC-9, AC-10)', () => {
    it('appends schemaHint as a separate paragraph when non-empty (AC-9)', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const hint = 'Respond with JSON in this exact format: {"foo": "bar"}';
      const payload = makePayload({ schemaHint: hint });
      await client.completeStructured(payload);
      const userMsg = userMessageFromCall(fetchMock, 0);
      // The schema hint should appear as a separate paragraph (preceded by \n\n).
      expect(userMsg).toContain('\n\n' + hint);
      // It should appear after the existing content (perception context, affordances, tools).
      const hintIdx = userMsg.indexOf(hint);
      expect(hintIdx).toBeGreaterThan(userMsg.indexOf(payload.perceptionContext));
      expect(hintIdx).toBeGreaterThan(userMsg.indexOf('Cognitive tools:'));
    });

    it('does not append a schema hint paragraph when schemaHint is undefined (AC-10)', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload();
      await client.completeStructured(payload);
      const userMsg = userMessageFromCall(fetchMock, 0);
      expect(userMsg).not.toContain('Respond with JSON in this exact format');
    });

    it('does not append a schema hint paragraph when schemaHint is an empty string (AC-10)', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ schemaHint: '' });
      await client.completeStructured(payload);
      const userMsg = userMessageFromCall(fetchMock, 0);
      // No trailing double newline paragraph added.
      expect(userMsg).not.toMatch(/\n\n$/);
    });
  });

  // ─── AC-11: buildReflectionUserMessage appends MEMORY_CONSOLIDATION_SCHEMA_HINT ─

  describe('buildReflectionUserMessage schemaHint (AC-11, AC-34)', () => {
    const memoryNodes: MemorySnippet[] = [
      { id: 'mem-1', content: 'Ate food.', importance: 3, timestamp: 1000 },
    ];

    it('appends MEMORY_CONSOLIDATION_SCHEMA_HINT as a separate paragraph (AC-11, AC-34)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(JSON.stringify({ consolidatedMemories: [], consolidatedNodeIds: [] })),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await client.completeReflection('Consolidate memories.', memoryNodes);
      const userMsg = userMessageFromCall(fetchMock, 0);
      expect(userMsg).toContain(MEMORY_CONSOLIDATION_SCHEMA_HINT);
      // The hint should appear after the memory node list.
      const hintIdx = userMsg.indexOf(MEMORY_CONSOLIDATION_SCHEMA_HINT);
      expect(hintIdx).toBeGreaterThan(userMsg.indexOf('Memory nodes to consolidate'));
      expect(userMsg).toContain('\n\n' + MEMORY_CONSOLIDATION_SCHEMA_HINT);
    });
  });

  // ─── AC-31..AC-33: End-to-end schema hint in user message via builders ────

  describe('End-to-end schema hint in user message (AC-31, AC-32, AC-33)', () => {
    it('completePlan() with PlanBuilderImpl payload sends PLAN_SCHEMA_HINT in user message (AC-31)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(JSON.stringify({ description: 'd', steps: [{ description: 's' }] })),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const builder = new PlanBuilderImpl();
      const payload = builder.build(makePerceptionResult());
      await client.completePlan(payload);
      const userMsg = userMessageFromCall(fetchMock, 0);
      expect(userMsg).toContain(PLAN_SCHEMA_HINT);
    });

    it('completeStructured() with PerceptionBuilderImpl payload sends ACTION_RESPONSE_SCHEMA_HINT in user message (AC-32)', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const builder = new PerceptionBuilderImpl();
      const payload = builder.build(makePerceptionResult());
      await client.completeStructured(payload);
      const userMsg = userMessageFromCall(fetchMock, 0);
      expect(userMsg).toContain(ACTION_RESPONSE_SCHEMA_HINT);
    });

    it('completeReflect() with ReflectBuilderImpl payload sends REFLECT_SCHEMA_HINT in user message (AC-33)', async () => {
      fetchMock.mockResolvedValue(chatResponse('{}'));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const builder = new ReflectBuilderImpl();
      const payload = builder.build('agent-1', makeAgentState(), makeExecuteResult());
      await client.completeReflect(payload);
      const userMsg = userMessageFromCall(fetchMock, 0);
      expect(userMsg).toContain(REFLECT_SCHEMA_HINT);
    });
  });

  // ─── AC-12, AC-13, AC-14, AC-30, AC-35, AC-36: completePlan alias mapping ─

  describe('completePlan alias mapping (AC-12..AC-14, AC-30, AC-35, AC-36)', () => {
    it('maps goal→description and affordance→targetAffordance (AC-12)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            goal: 'Restore energy',
            steps: [{ description: 'Brew coffee', affordance: 'brew_coffee' }],
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      const result = await client.completePlan(payload);
      expect(result.description).toBe('Restore energy');
      expect(result.steps[0]!.description).toBe('Brew coffee');
      expect(result.steps[0]!.targetAffordance).toBe('brew_coffee');
    });

    it('maps affordance: null to targetAffordance: undefined (AC-13)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            description: 'Rest',
            steps: [{ description: 'Wait', affordance: null }],
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      const result = await client.completePlan(payload);
      expect(result.steps[0]!.targetAffordance).toBeUndefined();
    });

    it('throws LLMResponseError when both description and goal are missing (AC-14)', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ steps: [{ description: 's' }] })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      await expect(client.completePlan(payload)).rejects.toThrow(LLMResponseError);
    });

    it('throws LLMResponseError when steps is missing (AC-14)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(JSON.stringify({ description: 'A plan', goal: 'A plan' })),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      await expect(client.completePlan(payload)).rejects.toThrow(LLMResponseError);
    });

    it('throws LLMResponseError when steps is empty (AC-14)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(JSON.stringify({ description: 'A plan', steps: [] })),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      await expect(client.completePlan(payload)).rejects.toThrow(LLMResponseError);
    });

    it('works with canonical field names without triggering alias mapping (AC-30)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            description: 'Brew coffee',
            steps: [{ description: 'Brew a cup', targetAffordance: 'brew_coffee' }],
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      const result = await client.completePlan(payload);
      expect(result.description).toBe('Brew coffee');
      expect(result.steps[0]!.targetAffordance).toBe('brew_coffee');
      // No alias warning should be emitted.
      const aliasWarnings = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('[field-alias]'));
      expect(aliasWarnings).toHaveLength(0);
    });

    it('silently ignores extra fields (AC-35)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            tool: 'formulate_plan',
            order: 1,
            goal: 'restore energy',
            description: 'restore energy',
            steps: [{ description: 's', targetAffordance: 'brew_coffee' }],
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      const result = await client.completePlan(payload);
      expect(result.description).toBe('restore energy');
      expect(result.steps).toHaveLength(1);
    });

    it('end-to-end reproduction from issue #37 (AC-36)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            tool: 'formulate_plan',
            goal: 'restore energy',
            steps: [
              { order: 1, description: 'Observe the coffee machine...', affordance: 'observe' },
              { order: 2, description: 'Brew coffee...', affordance: 'brew_coffee' },
            ],
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      const result = await client.completePlan(payload);
      expect(result.description).toBe('restore energy');
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0]!.targetAffordance).toBe('observe');
      expect(result.steps[1]!.targetAffordance).toBe('brew_coffee');
    });

    it('canonical description takes priority over goal alias (AC-12, Req 8)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            description: 'canonical desc',
            goal: 'alias desc',
            steps: [{ description: 's', targetAffordance: 'brew_coffee' }],
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      const result = await client.completePlan(payload);
      expect(result.description).toBe('canonical desc');
    });

    it('logs a field-alias warning when goal is used instead of description (AC-24)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            goal: 'Restore energy',
            steps: [{ description: 's', targetAffordance: 'brew_coffee' }],
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      await client.completePlan(payload);
      const aliasWarnings = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('[field-alias]') && s.includes('completePlan'));
      expect(aliasWarnings.length).toBeGreaterThanOrEqual(1);
      // Should mention canonical and usedAlias.
      expect(aliasWarnings[0]).toContain('description');
      expect(aliasWarnings[0]).toContain('goal');
    });

    it('logs a field-alias warning when affordance is used instead of targetAffordance (AC-24)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            description: 'd',
            steps: [{ description: 's', affordance: 'brew_coffee' }],
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: formulatePlanSchema });
      await client.completePlan(payload);
      const aliasWarnings = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter(
          (s) =>
            s.includes('[field-alias]') &&
            s.includes('targetAffordance') &&
            s.includes('affordance'),
        );
      expect(aliasWarnings.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── AC-15, AC-16, AC-17: completeStructured alias mapping ─────────────────

  describe('completeStructured alias mapping (AC-15..AC-17)', () => {
    it('maps reason→reasoning and tool→action (AC-15)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(JSON.stringify({ reason: 'I need coffee', tool: 'brew_coffee' })),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const result = await client.completeStructured(makePayload());
      expect(result.reasoning).toBe('I need coffee');
      expect(result.action).toBe('brew_coffee');
    });

    it('maps args→actionArgs, observe_target→observeTarget, updated_goal→updatedGoal (AC-16)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            reasoning: 'r',
            action: 'a',
            args: { x: 1 },
            observe_target: 'obj-1',
            updated_goal: 'new goal',
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const result = await client.completeStructured(makePayload());
      expect(result.actionArgs).toEqual({ x: 1 });
      expect(result.observeTarget).toBe('obj-1');
      expect(result.updatedGoal).toBe('new goal');
    });

    it('maps arguments→actionArgs and goal→updatedGoal (AC-16)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            reasoning: 'r',
            action: 'a',
            arguments: { y: 2 },
            goal: 'updated via goal',
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const result = await client.completeStructured(makePayload());
      expect(result.actionArgs).toEqual({ y: 2 });
      expect(result.updatedGoal).toBe('updated via goal');
    });

    it('throws LLMResponseError when both reasoning and reason are missing (AC-17)', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ action: 'a' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await expect(client.completeStructured(makePayload())).rejects.toThrow(LLMResponseError);
    });

    it('throws LLMResponseError when both action and tool are missing (AC-17)', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await expect(client.completeStructured(makePayload())).rejects.toThrow(LLMResponseError);
    });

    it('canonical reasoning/action take priority over aliases (AC-15)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            reasoning: 'canonical',
            reason: 'alias',
            action: 'canonical-action',
            tool: 'alias-tool',
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const result = await client.completeStructured(makePayload());
      expect(result.reasoning).toBe('canonical');
      expect(result.action).toBe('canonical-action');
    });

    it('logs field-alias warnings when reason/tool aliases are used (AC-24)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(JSON.stringify({ reason: 'I need coffee', tool: 'brew_coffee' })),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await client.completeStructured(makePayload());
      const aliasWarnings = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('[field-alias]') && s.includes('completeStructured'));
      expect(aliasWarnings.length).toBeGreaterThanOrEqual(1);
    });

    it('does not log alias warnings when canonical names are used (AC-25)', async () => {
      fetchMock.mockResolvedValue(chatResponse(JSON.stringify({ reasoning: 'r', action: 'a' })));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await client.completeStructured(makePayload());
      const aliasWarnings = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('[field-alias]'));
      expect(aliasWarnings).toHaveLength(0);
    });

    it('truncates alias warning value to ≤200 chars (AC-24)', async () => {
      const longReason = 'x'.repeat(300);
      fetchMock.mockResolvedValue(
        chatResponse(JSON.stringify({ reason: longReason, tool: 'brew_coffee' })),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      await client.completeStructured(makePayload());
      const aliasWarnings = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('[field-alias]'));
      expect(aliasWarnings.length).toBeGreaterThanOrEqual(1);
      // The full 300-char string should not appear in the warning.
      for (const w of aliasWarnings) {
        expect(w).not.toContain('x'.repeat(300));
      }
    });
  });

  // ─── AC-18, AC-19: completeReflect alias mapping ──────────────────────────

  describe('completeReflect alias mapping (AC-18, AC-19)', () => {
    it('maps goal→newGoal, drives→driveOverrides, memory→memoryEntry (AC-18)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            goal: 'Survive',
            drives: { energy: 50 },
            memory: { content: 'Brewed coffee', importance: 5, type: 'action' },
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: reflectSchema });
      const result = await client.completeReflect(payload);
      expect(result.newGoal).toBe('Survive');
      expect(result.driveOverrides).toEqual({ energy: 50 });
      expect(result.memoryEntry?.content).toBe('Brewed coffee');
      expect(result.memoryEntry?.importance).toBe(5);
      expect(result.memoryEntry?.type).toBe('action');
    });

    it('maps new_goal→newGoal, drive_overrides→driveOverrides, memory_entry→memoryEntry (AC-18)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            new_goal: 'Survive',
            drive_overrides: { energy: 40 },
            memory_entry: { content: 'Did something', importance: 3, type: 'observation' },
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: reflectSchema });
      const result = await client.completeReflect(payload);
      expect(result.newGoal).toBe('Survive');
      expect(result.driveOverrides).toEqual({ energy: 40 });
      expect(result.memoryEntry?.content).toBe('Did something');
    });

    it('returns empty {} when all fields are missing (AC-19)', async () => {
      fetchMock.mockResolvedValue(chatResponse('{}'));
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: reflectSchema });
      const result = await client.completeReflect(payload);
      expect(result).toEqual({});
    });

    it('canonical newGoal takes priority over goal alias (AC-18)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            newGoal: 'canonical goal',
            goal: 'alias goal',
            driveOverrides: { energy: 10 },
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: reflectSchema });
      const result = await client.completeReflect(payload);
      expect(result.newGoal).toBe('canonical goal');
    });

    it('logs field-alias warnings when goal/drives/memory aliases are used (AC-24)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            goal: 'Survive',
            drives: { energy: 50 },
            memory: { content: 'Brewed coffee', importance: 5, type: 'action' },
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: reflectSchema });
      await client.completeReflect(payload);
      const aliasWarnings = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('[field-alias]') && s.includes('completeReflect'));
      expect(aliasWarnings.length).toBeGreaterThanOrEqual(1);
    });

    it('does not log alias warnings when canonical names are used (AC-25)', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          JSON.stringify({
            newGoal: 'g',
            driveOverrides: { energy: 50 },
          }),
        ),
      );
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      const payload = makePayload({ responseSchema: reflectSchema });
      await client.completeReflect(payload);
      const aliasWarnings = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('[field-alias]'));
      expect(aliasWarnings).toHaveLength(0);
    });
  });

  // ─── AC-20..AC-23: resolveField utility ───────────────────────────────────

  describe('resolveField utility (AC-20..AC-23)', () => {
    it('returns the canonical value when canonical field is present (AC-20, AC-21)', () => {
      const parsed = { description: 'hello' };
      const result = resolveField(parsed, 'description', ['goal']);
      expect(result.value).toBe('hello');
      expect(result.usedAlias).toBeNull();
    });

    it('canonical takes priority even when aliases are present (AC-21)', () => {
      const parsed = { description: 'canonical', goal: 'alias' };
      const result = resolveField(parsed, 'description', ['goal']);
      expect(result.value).toBe('canonical');
      expect(result.usedAlias).toBeNull();
    });

    it('returns the first matching alias when canonical is missing (AC-22)', () => {
      const parsed = { goal: 'alias-value' };
      const result = resolveField(parsed, 'description', ['goal', 'plan']);
      expect(result.value).toBe('alias-value');
      expect(result.usedAlias).toBe('goal');
    });

    it('first matching alias wins when multiple aliases present (AC-22)', () => {
      const parsed = { updated_goal: 'second', goal: 'first' };
      const result = resolveField(parsed, 'updatedGoal', ['goal', 'updated_goal']);
      // 'goal' is checked first.
      expect(result.value).toBe('first');
      expect(result.usedAlias).toBe('goal');
    });

    it('returns undefined with null usedAlias when neither canonical nor any alias is present (AC-23)', () => {
      const parsed = { unrelated: 'x' };
      const result = resolveField(parsed, 'description', ['goal', 'plan']);
      expect(result.value).toBeUndefined();
      expect(result.usedAlias).toBeNull();
    });

    it('returns undefined with null usedAlias when parsed is empty (AC-23)', () => {
      const result = resolveField({}, 'description', ['goal']);
      expect(result.value).toBeUndefined();
      expect(result.usedAlias).toBeNull();
    });

    it('treats a present-but-undefined canonical as missing and falls through to aliases', () => {
      const parsed: Record<string, unknown> = { description: undefined, goal: 'fallback' };
      const result = resolveField(parsed, 'description', ['goal']);
      expect(result.value).toBe('fallback');
      expect(result.usedAlias).toBe('goal');
    });

    it('is exported from json-recovery.ts (AC-20)', () => {
      expect(typeof resolveField).toBe('function');
    });
  });

  // ─── AC-26: LLMClient interface unchanged ──────────────────────────────────

  describe('LLMClient interface unchanged (AC-26)', () => {
    it('OpenAICompatibleLLMClient still implements all four methods (AC-26)', () => {
      const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
      expect(typeof client.completeStructured).toBe('function');
      expect(typeof client.completeReflection).toBe('function');
      expect(typeof client.completePlan).toBe('function');
      expect(typeof client.completeReflect).toBe('function');
    });
  });

  // ─── AC-28: No engine import, no new deps ──────────────────────────────────

  describe('Package boundaries (AC-28, AC-27)', () => {
    it('OpenAICompatibleLLMClient does not import from @evol-hive/engine (AC-28)', async () => {
      const fs = await import('fs');
      const src = fs.readFileSync('src/llm/openai-client.ts', 'utf-8');
      expect(src).not.toContain('@evol-hive/engine');
    });

    it('json-recovery.ts does not import any external dependency (AC-28)', async () => {
      const fs = await import('fs');
      const src = fs.readFileSync('src/llm/json-recovery.ts', 'utf-8');
      expect(src).not.toContain('import');
      expect(src).not.toContain('@evol-hive/engine');
    });
  });
});
