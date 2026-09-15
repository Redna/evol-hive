/**
 * Spec 060 — R4: bounded, self-resetting fallback floor (issue #214).
 *
 * Covers AC-5:
 * - N-1 consecutive formation failures do not floor; the Nth stores a
 *   shape-valid, binding-valid single-step plan, returns success, emits
 *   `[plan-floor]`, and resets the counter.
 * - The binding follows `observe` → critical-drive restorer → `wait`, and a
 *   floor under a critical drive with a restorer binds the restorer (never an
 *   all-`wait` plan the spec-052 guard would reject).
 * - `0` disables the floor.
 * - The LLM attempt count stays bounded across many cycles.
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
import { WAIT_AFFORDANCE } from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '../src/index.js';
import { PlanServiceImpl, checkPlanBinding } from '../src/pper/plan-service.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';

const AGENT_ID = 'a1';
const ROOM_ID = 'greenhouse';

const observe: Affordance = {
  id: 'observe',
  label: 'Observe',
  engineEffect: 'observe',
  preconditions: [],
  effects: {},
};

const restorer: Affordance = {
  id: 'rest_among_seedlings',
  label: 'Rest among the seedlings',
  engineEffect: 'rest_among_seedlings',
  preconditions: [],
  effects: { energy: 15 },
};

const inert: Affordance = {
  id: 'polish_glass',
  label: 'Polish the glass',
  engineEffect: 'polish_glass',
  preconditions: [],
  effects: {},
};

const invalidPlan: FormulatePlanResult = {
  description: '',
  steps: [{ description: 'x' }],
} as FormulatePlanResult;

function makePerception(
  affordances: Affordance[],
  drives: Record<string, number>,
): PerceptionResult {
  return {
    passive: { roomId: ROOM_ID, objectsPresent: [], drives },
    prunedAffordances: affordances,
    primaryDriveLabel: 'testing',
  } as unknown as PerceptionResult;
}

const calmDrives = { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 };
const starvingDrives = { energy: 8, hunger: 50, social: 50, comfort: 50, curiosity: 50 };

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

class QueueLLMClient implements LLMClient {
  plans: (FormulatePlanResult | Error)[] = [];
  calls: LLMContextPayload[] = [];

  async completeStructured() {
    return { reasoning: 'r', action: 'idle' };
  }
  async completeReflection() {
    return { agentId: AGENT_ID, newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(payload: LLMContextPayload): Promise<FormulatePlanResult> {
    this.calls.push(payload);
    const next = this.plans.shift();
    if (next === undefined) throw new Error('QueueLLMClient exhausted');
    if (next instanceof Error) throw next;
    return next;
  }
  async completeReflect() {
    return { memoryEntry: { content: 'x', importance: 5, type: 'action' } };
  }
}

function alwaysInvalidClient(count: number): QueueLLMClient {
  const client = new QueueLLMClient();
  client.plans = Array.from({ length: count }, () => invalidPlan);
  return client;
}

describe('PlanServiceImpl fallback floor (spec 060, R4 / AC-5)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('PLAN_FLOOR_AFTER_FAILURES', '3');
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    errSpy.mockRestore();
  });

  it('does not floor before N consecutive failures; the Nth floors, stores, and resets', async () => {
    const provider = new FakeDataProvider();
    const llm = alwaysInvalidClient(10);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });

    const first = await service.plan(AGENT_ID, makePerception([observe], calmDrives));
    const second = await service.plan(AGENT_ID, makePerception([observe], calmDrives));
    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    expect(provider.storePlanCalls).toHaveLength(0);

    const third = await service.plan(AGENT_ID, makePerception([observe], calmDrives));
    expect(third.success).toBe(true);
    expect(provider.storePlanCalls).toHaveLength(1);
    const floorLog = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('[plan-floor]'));
    expect(floorLog).toHaveLength(1);
    expect(floorLog[0]).toContain('agent=a1');
    expect(floorLog[0]).toContain('failures=3');
    expect(floorLog[0]).toContain('target=observe');

    // Counter reset: the next failure starts a fresh run (no immediate floor).
    const fourth = await service.plan(AGENT_ID, makePerception([observe], calmDrives));
    expect(fourth.success).toBe(false);
    expect(provider.storePlanCalls).toHaveLength(1);
  });

  it('floors with a shape-valid, binding-valid single-step plan', async () => {
    const provider = new FakeDataProvider();
    const llm = alwaysInvalidClient(10);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    await service.plan(AGENT_ID, makePerception([observe], calmDrives));
    await service.plan(AGENT_ID, makePerception([observe], calmDrives));
    const result = await service.plan(AGENT_ID, makePerception([observe], calmDrives));
    expect(result.success).toBe(true);
    const stored = provider.storePlanCalls[0]!;
    expect(stored.steps).toHaveLength(1);
    expect(stored.description.length).toBeGreaterThan(0);
    const verdict = checkPlanBinding(stored, ['observe']);
    expect(verdict.valid).toBe(true);
    expect(verdict.shapeValid).toBe(true);
  });

  it('prefers observe when it is in the enum (even under a critical drive)', async () => {
    const provider = new FakeDataProvider();
    const llm = alwaysInvalidClient(10);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    await service.plan(AGENT_ID, makePerception([restorer, observe], starvingDrives));
    await service.plan(AGENT_ID, makePerception([restorer, observe], starvingDrives));
    await service.plan(AGENT_ID, makePerception([restorer, observe], starvingDrives));
    expect(provider.storePlanCalls[0]!.steps[0]!.targetAffordance).toBe('observe');
  });

  it('binds a direct restorer for a critical drive when observe is absent (never all-wait)', async () => {
    const provider = new FakeDataProvider();
    const llm = alwaysInvalidClient(10);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    await service.plan(AGENT_ID, makePerception([restorer, inert], starvingDrives));
    await service.plan(AGENT_ID, makePerception([restorer, inert], starvingDrives));
    await service.plan(AGENT_ID, makePerception([restorer, inert], starvingDrives));
    const stored = provider.storePlanCalls[0]!;
    expect(stored.steps[0]!.targetAffordance).toBe('rest_among_seedlings');
    expect(stored.steps.every((s) => s.targetAffordance === WAIT_AFFORDANCE)).toBe(false);
  });

  it('falls back to wait when nothing else is legal and no critical restorer exists', async () => {
    const provider = new FakeDataProvider();
    const llm = alwaysInvalidClient(10);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    await service.plan(AGENT_ID, makePerception([inert], calmDrives));
    await service.plan(AGENT_ID, makePerception([inert], calmDrives));
    await service.plan(AGENT_ID, makePerception([inert], calmDrives));
    expect(provider.storePlanCalls[0]!.steps[0]!.targetAffordance).toBe(WAIT_AFFORDANCE);
  });

  it('0 disables the floor — failures never store a plan', async () => {
    vi.stubEnv('PLAN_FLOOR_AFTER_FAILURES', '0');
    const provider = new FakeDataProvider();
    const llm = alwaysInvalidClient(10);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    for (let i = 0; i < 5; i++) {
      const r = await service.plan(AGENT_ID, makePerception([observe], calmDrives));
      expect(r.success).toBe(false);
    }
    expect(provider.storePlanCalls).toHaveLength(0);
  });

  it('keeps LLM attempts bounded across many cycles (floor then reset, never unbounded)', async () => {
    const provider = new FakeDataProvider();
    const llm = alwaysInvalidClient(20);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    for (let i = 0; i < 6; i++) {
      await service.plan(AGENT_ID, makePerception([observe], calmDrives));
    }
    // Two floors (cycles 3 and 6); one LLM attempt per cycle in this fake.
    expect(provider.storePlanCalls).toHaveLength(2);
    expect(llm.calls.length).toBeLessThanOrEqual(6);
  });
});
