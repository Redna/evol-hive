/**
 * Tests for spec 015 — defaultCognitiveTools, builder & service updates
 * (AC-9, AC-29, AC-30, AC-31, AC-32, AC-33).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  formulatePlanTool,
  chooseActionTool,
  reflectTool,
  queryMemoryTool,
  updateInternalStateTool,
  type PerceptionResult,
  type AgentInternalState,
  type ExecuteResult,
  type LLMContextPayload,
} from '@evol-hive/shared';
import {
  defaultCognitiveTools,
  PlanBuilderImpl,
  PerceptionBuilderImpl,
  ReflectBuilderImpl,
  PlanServiceImpl,
  ReflectServiceImpl,
  type LLMClient,
} from '../src/index.js';

function makePerceptionResult(overrides: Partial<PerceptionResult> = {}): PerceptionResult {
  return {
    passive: {
      roomId: 'kitchen',
      objectsPresent: [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
      drives: { energy: 10, hunger: 50 },
    },
    prunedAffordances: [{ id: 'brew_coffee', label: 'Brew coffee' }],
    primaryDriveLabel: 'low energy',
    ...overrides,
  };
}

function makeAgentState(): AgentInternalState {
  return {
    agentId: 'agent-1',
    currentGoal: 'find coffee',
    drives: { energy: 10, hunger: 50 },
    isThinking: false,
    currentRoom: 'kitchen',
  };
}

function makeExecuteResult(): ExecuteResult {
  return {
    success: true,
    planComplete: false,
    result: { success: true, newState: {}, driveChanges: { energy: 20 } },
  };
}

// ─── AC-9: defaultCognitiveTools query_memory argsSchema with topK ───────────

describe('defaultCognitiveTools query_memory argsSchema (AC-9)', () => {
  it('query_memory entry has topK in argsSchema.properties', () => {
    const qm = defaultCognitiveTools.find((t) => t.name === 'query_memory');
    expect(qm).toBeDefined();
    const props = qm!.argsSchema['properties'] as Record<string, unknown>;
    expect(props['topK']).toBeDefined();
    const topK = props['topK'] as Record<string, unknown>;
    expect(topK['type']).toBe('integer');
    expect(topK['minimum']).toBe(1);
    expect(topK['maximum']).toBe(20);
  });

  it('query_memory argsSchema.required still only has query', () => {
    const qm = defaultCognitiveTools.find((t) => t.name === 'query_memory');
    expect(qm!.argsSchema['required']).toEqual(['query']);
  });
});

// ─── AC-29: PlanBuilderImpl tools ────────────────────────────────────────────

describe('PlanBuilderImpl tools (AC-29)', () => {
  it('build() returns tools: [formulatePlanTool, queryMemoryTool, updateInternalStateTool]', () => {
    const builder = new PlanBuilderImpl();
    const payload: LLMContextPayload = builder.build(makePerceptionResult());
    expect(payload.tools).toEqual([formulatePlanTool, queryMemoryTool, updateInternalStateTool]);
  });

  it('cognitiveTools field still references defaultCognitiveTools', () => {
    const builder = new PlanBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    expect(payload.cognitiveTools).toEqual(defaultCognitiveTools);
  });
});

// ─── AC-30: PerceptionBuilderImpl tools ──────────────────────────────────────

describe('PerceptionBuilderImpl tools (AC-30)', () => {
  it('build() returns tools: [chooseActionTool, queryMemoryTool, updateInternalStateTool]', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    expect(payload.tools).toEqual([chooseActionTool, queryMemoryTool, updateInternalStateTool]);
  });

  it('cognitiveTools field still references defaultCognitiveTools (all three)', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    expect(payload.cognitiveTools).toEqual(defaultCognitiveTools);
  });
});

// ─── AC-31: ReflectBuilderImpl tools ─────────────────────────────────────────

describe('ReflectBuilderImpl tools (AC-31)', () => {
  it('build() returns tools: [reflectTool, queryMemoryTool, updateInternalStateTool]', () => {
    const builder = new ReflectBuilderImpl();
    const payload = builder.build('agent-1', makeAgentState(), makeExecuteResult());
    expect(payload.tools).toEqual([reflectTool, queryMemoryTool, updateInternalStateTool]);
  });

  it('cognitiveTools field is filtered to update_internal_state only', () => {
    const builder = new ReflectBuilderImpl();
    const payload = builder.build('agent-1', makeAgentState(), makeExecuteResult());
    expect(payload.cognitiveTools.map((t) => t.name)).toEqual(['update_internal_state']);
  });
});

// ─── AC-32: PlanServiceImpl sets agentId on payload ──────────────────────────

describe('PlanServiceImpl agentId (AC-32)', () => {
  it('sets payload.agentId = agentId before calling completePlan', async () => {
    let capturedPayload: LLMContextPayload | undefined;
    const llm: LLMClient = {
      completeStructured: vi.fn(),
      completeReflection: vi.fn(),
      completePlan: vi.fn().mockImplementation(async (payload: LLMContextPayload) => {
        capturedPayload = payload;
        return { description: 'd', steps: [{ description: 's' }] };
      }),
      completeReflect: vi.fn(),
    };
    const dataProvider = {
      getAgentState: vi.fn().mockReturnValue(null),
      storePlan: vi.fn().mockReturnValue({ steps: [], currentStepIndex: 0, description: 'd' }),
      setThinking: vi.fn(),
    };
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: dataProvider as never,
    });
    await service.plan('agent-99', makePerceptionResult());
    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.agentId).toBe('agent-99');
  });
});

// ─── AC-33: ReflectServiceImpl sets agentId on payload ───────────────────────

describe('ReflectServiceImpl agentId (AC-33)', () => {
  it('sets payload.agentId = agentId before calling completeReflect', async () => {
    let capturedPayload: LLMContextPayload | undefined;
    const llm: LLMClient = {
      completeStructured: vi.fn(),
      completeReflection: vi.fn(),
      completePlan: vi.fn(),
      completeReflect: vi.fn().mockImplementation(async (payload: LLMContextPayload) => {
        capturedPayload = payload;
        return {};
      }),
    };
    const dataProvider = {
      getAgentState: vi.fn().mockReturnValue(makeAgentState()),
      getAgentProfile: vi.fn().mockReturnValue(null),
      applyDriveChanges: vi.fn(),
      updateGoal: vi.fn(),
      storeMemory: vi.fn(),
      clearPlanIfComplete: vi.fn().mockReturnValue(false),
      setThinking: vi.fn(),
    };
    const service = new ReflectServiceImpl({
      reflectBuilder: new ReflectBuilderImpl(),
      llmClient: llm,
      dataProvider: dataProvider as never,
    });
    await service.reflect('agent-77', makeExecuteResult());
    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.agentId).toBe('agent-77');
  });
});
