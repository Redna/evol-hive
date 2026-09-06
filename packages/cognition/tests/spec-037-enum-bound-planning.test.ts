/**
 * Spec 037 — enum-bound plan formulation (issue #140).
 *
 * The affordance binding moves from prompt instruction to the tool-signature
 * level: `formulate_plan`'s schema carries a dynamic enum of the room's
 * available affordances (+ 'wait'), the validator enforces presence +
 * membership, and a single retry-with-feedback is attempted before the cycle
 * fails.
 *
 * AC coverage:
 * - AC-1: dynamic enum in the plan tool schema (pruned IDs + 'wait')
 * - AC-2: unbound/unknown steps fail validation; exactly one feedback retry
 * - AC-3: `[plan-bind]` telemetry per plan cycle
 * - AC-5 (unit level): a bound plan stores and executes past the 'wait' escape
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Affordance,
  FormulatePlanResult,
  PerceptionResult,
  AgentInternalState,
  AgentPlan,
  PlanDataProvider,
} from '@evol-hive/shared';
import { formulatePlanSchemaFor, formulatePlanToolFor, WAIT_AFFORDANCE } from '@evol-hive/shared';
import type { LLMClient } from '../src/index.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { PlanServiceImpl, checkPlanBinding } from '../src/pper/plan-service.js';

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

const prunedAffordances: Affordance[] = [
  {
    id: 'brew_coffee',
    label: 'Brew coffee',
    engineEffect: 'brew_coffee',
    preconditions: [],
    effects: { energy: 20 },
  },
  {
    id: 'open_gate',
    label: 'Open the gate',
    engineEffect: 'open_gate',
    preconditions: [],
    effects: {},
  },
];

function makePerceptionResult(): PerceptionResult {
  return {
    passive: {
      roomId: ROOM_ID,
      objectsPresent: [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
      drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    },
    prunedAffordances,
    primaryDriveLabel: 'low energy',
  } as unknown as PerceptionResult;
}

// ─── Schema factory (AC-1) ────────────────────────────────────────────────────

describe('formulatePlanSchemaFor (spec 037, AC-1)', () => {
  it('enum-binds targetAffordance to the available IDs plus the wait escape', () => {
    const schema = formulatePlanSchemaFor(['brew_coffee', 'open_gate']);
    const step = (
      schema as Record<
        string,
        {
          properties: {
            steps: { items: { properties: { targetAffordance: { enum: string[] } } } };
          };
        }
      >
    ).properties.steps.items;
    expect(step.properties.targetAffordance.enum).toEqual([
      'brew_coffee',
      'open_gate',
      WAIT_AFFORDANCE,
    ]);
    // Backend safety (issue #130 arc): targetAffordance is NOT in required —
    // requiring it broke tool-calling entirely. Presence is enforced by the
    // plan-service validator + retry instead.
    expect(step.required).toEqual(['description']);
  });

  it('collapses to [wait] when no affordances are available (guardrail masking)', () => {
    const schema = formulatePlanSchemaFor([]);
    const step = (
      schema as Record<
        string,
        {
          properties: {
            steps: { items: { properties: { targetAffordance: { enum: string[] } } } };
          };
        }
      >
    ).properties.steps.items;
    expect(step.properties.targetAffordance.enum).toEqual([WAIT_AFFORDANCE]);
  });

  it('tool definition keeps the formulate_plan name and carries the enum schema', () => {
    const tool = formulatePlanToolFor(['brew_coffee']);
    expect(tool.function.name).toBe('formulate_plan');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = tool.function.parameters as Record<string, any>;
    expect(schema.properties.steps.items.properties.targetAffordance.enum).toContain('brew_coffee');
  });
});

// ─── checkPlanBinding (AC-2) ──────────────────────────────────────────────────

describe('checkPlanBinding (spec 037, AC-2)', () => {
  const ids = ['brew_coffee', 'open_gate'];

  it('accepts a fully bound plan', () => {
    const plan: FormulatePlanResult = {
      description: 'Restore energy',
      steps: [
        { description: 'Go to the machine', targetAffordance: 'brew_coffee' },
        { description: 'Brew', targetAffordance: 'brew_coffee' },
      ],
    };
    const v = checkPlanBinding(plan, ids);
    expect(v.valid).toBe(true);
    expect(v.bound).toBe(2);
    expect(v.violations).toEqual([]);
  });

  it('accepts the wait escape', () => {
    const plan: FormulatePlanResult = {
      description: 'Nothing to do',
      steps: [{ description: 'Idle a while', targetAffordance: WAIT_AFFORDANCE }],
    };
    expect(checkPlanBinding(plan, ids).valid).toBe(true);
  });

  it('rejects a narrative step (missing targetAffordance)', () => {
    const plan: FormulatePlanResult = {
      description: 'Narrative plan',
      steps: [{ description: 'Think about coffee' }],
    };
    const v = checkPlanBinding(plan, ids);
    expect(v.valid).toBe(false);
    expect(v.bound).toBe(0);
    expect(v.violations[0]).toContain('missing');
  });

  it('rejects an unknown affordance (hallucinated ID)', () => {
    const plan: FormulatePlanResult = {
      description: 'Hallucinated',
      steps: [{ description: 'Fly to the moon', targetAffordance: 'fly_to_moon' }],
    };
    const v = checkPlanBinding(plan, ids);
    expect(v.valid).toBe(false);
    expect(v.violations[0]).toContain("'fly_to_moon'");
  });

  it('shape-invalid plans fail with the shape feedback (no binding retry)', () => {
    const plan = { steps: [{ description: 'x' }] } as unknown as FormulatePlanResult;
    const v = checkPlanBinding(plan, ids);
    expect(v.valid).toBe(false);
    expect(v.violations).toEqual(['missing description or steps']);
    expect(v.feedback).toContain('not a valid plan');
  });

  it('skips binding enforcement when no affordances are visible (spec 016 masking)', () => {
    const plan: FormulatePlanResult = {
      description: 'Narrative only',
      steps: [{ description: 'Think' }],
    };
    const v = checkPlanBinding(plan, []);
    expect(v.valid).toBe(true);
    expect(v.bound).toBe(1);
  });
});

// ─── PlanServiceImpl integration (AC-2, AC-3) ─────────────────────────────────

function makeAgentState(): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    currentGoal: 'stay alive',
    currentPlan: null,
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
  } as AgentInternalState;
}

class FakeDataProvider implements PlanDataProvider {
  agentState: AgentInternalState | null = makeAgentState();
  storePlanCalls: { agentId: string; result: FormulatePlanResult }[] = [];
  storedPlan: AgentPlan = {
    id: 'plan_x',
    description: 'd',
    steps: [],
    currentStepIndex: 0,
    createdAt: 1,
  };

  getAgentState(): AgentInternalState | null {
    return this.agentState;
  }
  storePlan(agentId: string, result: FormulatePlanResult): AgentPlan {
    this.storePlanCalls.push({ agentId, result });
    return this.storedPlan;
  }
  setThinking(agentId: string, isThinking: boolean): void {
    if (this.agentState) this.agentState = { ...this.agentState, isThinking };
  }
}

class FakeLLMClient implements LLMClient {
  completeStructured = vi.fn();
  completeReflection = vi.fn();
  plans: (FormulatePlanResult | Error)[] = [];

  constructor(plans: (FormulatePlanResult | Error)[]) {
    this.plans = plans;
  }

  async completePlan(): Promise<FormulatePlanResult> {
    const next = this.plans.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('FakeLLMClient exhausted');
    return next;
  }
}

const boundPlan: FormulatePlanResult = {
  description: 'Restore energy',
  steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
};

const narrativePlan: FormulatePlanResult = {
  description: 'Narrative',
  steps: [{ description: 'Think about coffee' }],
};

describe('PlanServiceImpl spec-037 behavior', () => {
  let provider: FakeDataProvider;

  beforeEach(() => {
    provider = new FakeDataProvider();
  });

  it('AC-1: the built payload carries an enum-bound formulate_plan tool', () => {
    const payload = new PlanBuilderImpl().build(makePerceptionResult());
    const tool = payload.tools.find((t) => t.function.name === 'formulate_plan')!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = tool.function.parameters as Record<string, any>;
    expect(schema.properties.steps.items.properties.targetAffordance.enum).toEqual([
      'brew_coffee',
      'open_gate',
      WAIT_AFFORDANCE,
    ]);
  });

  it('AC-2: bound plan stores without retry (single LLM call)', async () => {
    const llm = new FakeLLMClient([boundPlan]);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());
    expect(result.success).toBe(true);
    expect(provider.storePlanCalls).toHaveLength(1);
  });

  it('AC-2: narrative plan retries ONCE with feedback, then succeeds on the corrected plan', async () => {
    const llm = new FakeLLMClient([narrativePlan, boundPlan]);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());
    expect(result.success).toBe(true);
    expect(provider.storePlanCalls).toHaveLength(1);
  });

  it('AC-2: narrative plan fails the cycle when the retry also violates the enum', async () => {
    const llm = new FakeLLMClient([narrativePlan, narrativePlan]);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());
    expect(result.success).toBe(false);
    expect(result.error).toContain('affordance enum after retry');
    expect(provider.storePlanCalls).toHaveLength(0);
    expect(provider.agentState?.isThinking).toBe(false);
  });

  it('AC-2: shape-invalid plans fail immediately WITHOUT a binding retry', async () => {
    const shapeInvalid = { steps: [{ description: 'x' }] } as unknown as FormulatePlanResult;
    const llm = new FakeLLMClient([shapeInvalid]);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());
    expect(result.success).toBe(false);
    expect(provider.storePlanCalls).toHaveLength(0);
    // Only the initial call — shape failures are not repaired (§7).
    expect(llm.plans).toHaveLength(0);
  });

  it('AC-3: emits [plan-bind] telemetry per plan cycle', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const llm = new FakeLLMClient([boundPlan]);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    await service.plan(AGENT_ID, makePerceptionResult());
    const bindLogs = errSpy.mock.calls.filter((c) => String(c[0]).includes('[plan-bind]'));
    expect(bindLogs.length).toBeGreaterThanOrEqual(1);
    expect(String(bindLogs[0]![0])).toContain('bound=1');
    errSpy.mockRestore();
  });
});
