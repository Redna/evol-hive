/**
 * Spec 060 — R4: the floor's honest-failure branch (issue #214 / AC-5).
 *
 * When no binding survives the `observe` → critical-drive restorer → `wait`
 * order, the cycle stays a formation failure: nothing is stored and the
 * consecutive-failure counter is NOT reset, so the very next cycle retries the
 * floor rather than starting over.
 *
 * The wait guard is mocked here so a `wait` binding can be forced into the
 * "rejected" state even when the floor's own restorer search found nothing —
 * the one combination the real guard's predicate cannot produce on its own.
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
import type { LLMClient } from '../src/index.js';
import { PlanServiceImpl } from '../src/pper/plan-service.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';

const state = vi.hoisted(() => ({ rejectWait: true }));

vi.mock('../src/guardrails/wait-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/guardrails/wait-guard.js')>();
  return {
    ...actual,
    checkWaitSuppression: vi.fn(() =>
      state.rejectWait
        ? { rejected: true, reason: 'forced-rejection-for-test' }
        : { rejected: false },
    ),
  };
});

const AGENT_ID = 'a1';

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

const calmDrives = { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 };

function makePerception(): PerceptionResult {
  return {
    passive: { roomId: 'greenhouse', objectsPresent: [], drives: calmDrives },
    prunedAffordances: [inert],
    primaryDriveLabel: 'testing',
  } as unknown as PerceptionResult;
}

class FakeDataProvider implements PlanDataProvider {
  agentState = {
    agentId: AGENT_ID,
    drives: calmDrives,
    currentGoal: '',
    currentPlan: null,
    isThinking: false,
    location: 'greenhouse',
    lastPerceptionTick: 0,
  } as unknown as AgentInternalState;
  storePlanCalls: FormulatePlanResult[] = [];

  getAgentState(): AgentInternalState {
    return this.agentState;
  }
  storePlan(_agentId: string, result: FormulatePlanResult): AgentPlan {
    this.storePlanCalls.push(result);
    return {
      id: 'plan',
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

class AlwaysInvalidClient implements LLMClient {
  async completeStructured() {
    return { reasoning: 'r', action: 'idle' };
  }
  async completeReflection() {
    return { agentId: AGENT_ID, newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(): Promise<FormulatePlanResult> {
    return invalidPlan;
  }
  async completeReflect() {
    return { memoryEntry: { content: 'x', importance: 5, type: 'action' } };
  }
}

describe('fallback floor honest failure (spec 060, R4 / AC-5)', () => {
  beforeEach(() => {
    state.rejectWait = true;
    vi.stubEnv('PLAN_FLOOR_AFTER_FAILURES', '2');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('stays an honest failure with the counter unreset when no binding survives', async () => {
    const provider = new FakeDataProvider();
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: new AlwaysInvalidClient(),
      dataProvider: provider,
    });

    // Two failures reach the threshold; the mocked guard rejects the wait binding.
    const r1 = await service.plan(AGENT_ID, makePerception());
    const r2 = await service.plan(AGENT_ID, makePerception());
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
    expect(provider.storePlanCalls).toHaveLength(0);

    // Counter was NOT reset: once the wait binding becomes legal the very next
    // cycle floors immediately (count 3 ≥ threshold 2) instead of starting over.
    state.rejectWait = false;
    const r3 = await service.plan(AGENT_ID, makePerception());
    expect(r3.success).toBe(true);
    expect(provider.storePlanCalls).toHaveLength(1);
    expect(provider.storePlanCalls[0]!.steps[0]!.targetAffordance).toBe('wait');
  });
});
