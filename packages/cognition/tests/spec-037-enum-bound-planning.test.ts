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
 * - AC-1: dynamic enum in the plan tool schema (pruned IDs + 'wait'),
 *   preserved across every spec-024 tool-ordering branch
 * - AC-2: unbound/unknown steps fail validation; exactly one feedback retry
 *   whose payload carries the explicit CORRECTION feedback
 * - AC-3: `[plan-bind]` telemetry per plan cycle
 * - AC-5 (unit level): a bound plan stores and executes past the 'wait' escape
 *   — the execute-service 'wait' no-op branch is exercised directly here
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Affordance,
  AffordanceResult,
  FormulatePlanResult,
  PerceptionResult,
  AgentInternalState,
  AgentPlan,
  PlanDataProvider,
  PlanStep,
  ExecuteResult,
  GuardrailConfig,
} from '@evol-hive/shared';
import { formulatePlanSchemaFor, formulatePlanToolFor, WAIT_AFFORDANCE } from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload, GuardrailEngine } from '../src/index.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { PlanServiceImpl, checkPlanBinding } from '../src/pper/plan-service.js';
import { ExecuteServiceImpl } from '../src/pper/execute-service.js';

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
  /** Payloads received by each completePlan call, in order. */
  calls: LLMContextPayload[] = [];

  constructor(plans: (FormulatePlanResult | Error)[]) {
    this.plans = plans;
  }

  async completePlan(payload: LLMContextPayload): Promise<FormulatePlanResult> {
    this.calls.push(payload);
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

  it('AC-1 × spec 024: social-primary ordering keeps the enum-bound plan tool LAST', () => {
    const socialPerception = {
      ...makePerceptionResult(),
      passive: {
        ...makePerceptionResult().passive,
        agentsPresent: [
          { agentId: 'a2', name: 'Barista', currentActivity: 'wiping counter', isThinking: false },
        ],
      },
      primaryDriveLabel: 'low social, need conversation',
    } as unknown as PerceptionResult;
    const payload = new PlanBuilderImpl().build(socialPerception);
    const tools = payload.tools;
    // Spec 024, Req 2: formulate_plan demoted to the very end of the array.
    expect(tools[tools.length - 1]!.function.name).toBe('formulate_plan');
    expect(tools.filter((t) => t.function.name === 'formulate_plan')).toHaveLength(1);
    // The demoted tool is the DYNAMIC (enum-bound) one, not the deprecated static.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = tools[tools.length - 1]!.function.parameters as Record<string, any>;
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

  it('AC-2: the retry prompt carries the explicit CORRECTION feedback naming the violation', async () => {
    const hallucinated: FormulatePlanResult = {
      description: 'Hallucinated',
      steps: [{ description: 'Fly to the moon', targetAffordance: 'fly_to_moon' }],
    };
    const llm = new FakeLLMClient([hallucinated, boundPlan]);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    const result = await service.plan(AGENT_ID, makePerceptionResult());
    expect(result.success).toBe(true);
    // Exactly one retry — two completePlan calls total.
    expect(llm.calls).toHaveLength(2);
    // The retry payload appends the correction to the (unchanged) perception
    // context — KV-cache-safe append (spec 021), per Req 2 "specific error".
    const retryPayload = llm.calls[1]!;
    expect(retryPayload.perceptionContext).toContain('CORRECTION:');
    expect(retryPayload.perceptionContext).toContain("'fly_to_moon'");
    expect(retryPayload.perceptionContext).toContain('Resubmit the full corrected plan');
    // The original (first-call) context is not mutated.
    expect(llm.calls[0]!.perceptionContext).not.toContain('CORRECTION');
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

  it('AC-3: the retry cycle logs a second [plan-bind] line marked as retry', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const llm = new FakeLLMClient([narrativePlan, boundPlan]);
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: provider,
    });
    await service.plan(AGENT_ID, makePerceptionResult());
    const bindLogs = errSpy.mock.calls.filter((c) => String(c[0]).includes('[plan-bind]'));
    // One log per LLM call: initial + retry.
    expect(bindLogs.length).toBe(2);
    expect(String(bindLogs[0]![0])).toContain('violations=');
    expect(String(bindLogs[1]![0])).toContain('retry');
    errSpy.mockRestore();
  });
});

// ─── Wait escape execution (spec 037, Req 1 / AC-5 unit level) ────────────────────

/** Minimal ExecuteDataProvider fake for the wait-escape tests. */
class FakeExecuteDataProvider implements ExecuteDataProvider {
  agentState: AgentInternalState;
  currentStep: PlanStep | null;
  planCompleteAfterAdvance = false;
  /** Optional override for isPlanComplete (multi-step scenarios). */
  isPlanCompleteFn: (() => boolean) | null = null;
  resolved: { objectId: string; affordance: Affordance } | null = null;

  resolveAffordanceCalls: { roomId: string; affordanceId: string }[] = [];
  executeAffordanceCalls: { objectId: string; affordanceId: string; agentId: string }[] = [];
  checkPreconditionsCalls: { affordanceId: string; objectId: string }[] = [];
  applyDriveChangesCalls: { agentId: string; changes: Partial<Record<string, number>> }[] = [];
  setSystemFeedbackCalls: { agentId: string; feedback: string }[] = [];
  advanceStepCalls: string[] = [];
  setThinkingCalls: { agentId: string; isThinking: boolean }[] = [];

  constructor(step: PlanStep | null) {
    this.currentStep = step;
    this.agentState = makeAgentState();
    this.agentState.currentPlan = {
      id: 'plan_037',
      description: 'Wait or brew',
      steps: step ? [step] : [],
      currentStepIndex: 0,
      createdAt: 100,
    };
  }

  getAgentState(): AgentInternalState | null {
    return this.agentState;
  }
  getCurrentStep(): PlanStep | null {
    return this.currentStep;
  }
  isPlanComplete(): boolean {
    if (this.isPlanCompleteFn) return this.isPlanCompleteFn();
    return this.planCompleteAfterAdvance && this.advanceStepCalls.length > 0;
  }
  resolveAffordance(
    roomId: string,
    affordanceId: string,
  ): { objectId: string; affordance: Affordance } | null {
    this.resolveAffordanceCalls.push({ roomId, affordanceId });
    return this.resolved;
  }
  checkPreconditions(
    affordanceId: string,
    objectId: string,
  ): { satisfied: boolean; failed: string[] } {
    this.checkPreconditionsCalls.push({ affordanceId, objectId });
    return { satisfied: true, failed: [] };
  }
  async executeAffordance(
    objectId: string,
    affordanceId: string,
    agentId: string,
  ): Promise<AffordanceResult> {
    this.executeAffordanceCalls.push({ objectId, affordanceId, agentId });
    return { success: true, driveChanges: { energy: 20 } };
  }
  advanceStep(agentId: string): void {
    this.advanceStepCalls.push(agentId);
  }
  applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void {
    this.applyDriveChangesCalls.push({ agentId, changes });
  }
  setSystemFeedback(agentId: string, feedback: string): void {
    this.setSystemFeedbackCalls.push({ agentId, feedback });
  }
  setThinking(agentId: string, isThinking: boolean): void {
    this.setThinkingCalls.push({ agentId, isThinking });
  }
}

/** Guardrail stub that rejects EVERY physical action and records the calls. */
class RejectingGuardrail implements GuardrailEngine {
  validateActionCalls: string[] = [];
  config = {
    affordanceMasking: false,
    contextualForcing: false,
    planValidation: true,
  } as GuardrailConfig;
  maskAffordances(affordances: Affordance[]): Affordance[] {
    return affordances;
  }
  validateAction(action: string): { valid: boolean; reason?: string } {
    this.validateActionCalls.push(action);
    return { valid: false, reason: 'rejected by test guardrail' };
  }
}

describe('wait escape — ExecuteServiceImpl no-op (spec 037, Req 1 / AC-5 unit level)', () => {
  const waitStep: PlanStep = {
    description: 'Idle a while',
    targetAffordance: WAIT_AFFORDANCE,
    completed: false,
  };

  it('advances past a wait step without touching the world and without stepSkipped', async () => {
    const provider = new FakeExecuteDataProvider(waitStep);
    provider.planCompleteAfterAdvance = true;
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result: ExecuteResult = await service.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(result.planComplete).toBe(true);
    // Intentional no-op — distinct from the legacy narrative skip flag.
    expect(result.stepSkipped).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(provider.advanceStepCalls).toEqual([AGENT_ID]);
    // World untouched: no resolution, execution, precondition check, drive
    // changes, or system feedback.
    expect(provider.resolveAffordanceCalls).toHaveLength(0);
    expect(provider.checkPreconditionsCalls).toHaveLength(0);
    expect(provider.executeAffordanceCalls).toHaveLength(0);
    expect(provider.applyDriveChangesCalls).toHaveLength(0);
    expect(provider.setSystemFeedbackCalls).toHaveLength(0);
    expect(provider.setThinkingCalls).toHaveLength(0);
  });

  it('wait is never resolved as a room affordance even if the room is empty', async () => {
    const provider = new FakeExecuteDataProvider(waitStep);
    provider.resolved = null; // nothing in the room — must not matter
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);
    expect(result.success).toBe(true);
    expect(provider.resolveAffordanceCalls).toHaveLength(0);
  });

  it('wait bypasses plan validation — the guardrail is never consulted', async () => {
    const provider = new FakeExecuteDataProvider(waitStep);
    const guardrail = new RejectingGuardrail();
    const service = new ExecuteServiceImpl({ dataProvider: provider, guardrail });
    const result = await service.execute(AGENT_ID);
    // 'wait' is always a legal binding — validation must not run (and must not
    // reject it as a plan deviation, which would trap the agent mid-plan).
    expect(guardrail.validateActionCalls).toHaveLength(0);
    expect(result.success).toBe(true);
    expect(result.deviationRejected).toBeUndefined();
  });

  it('a bound step executes, then a wait step completes the plan (store→execute arc)', async () => {
    const boundStep: PlanStep = {
      description: 'Brew coffee',
      targetAffordance: 'brew_coffee',
      completed: false,
    };
    const provider = new FakeExecuteDataProvider(boundStep);
    provider.resolved = { objectId: 'coffee-1', affordance: prunedAffordances[0]! };
    provider.isPlanCompleteFn = () => provider.advanceStepCalls.length >= 2;
    const service = new ExecuteServiceImpl({ dataProvider: provider });

    // Step 1: bound affordance executes with drive changes.
    const r1 = await service.execute(AGENT_ID);
    expect(r1.success).toBe(true);
    expect(r1.planComplete).toBe(false);
    expect(provider.executeAffordanceCalls).toHaveLength(1);
    expect(provider.applyDriveChangesCalls).toHaveLength(1);
    expect(provider.applyDriveChangesCalls[0]!.changes).toEqual({ energy: 20 });

    // Step 2: the wait escape — advances and completes without touching the world.
    provider.currentStep = waitStep;
    const r2 = await service.execute(AGENT_ID);
    expect(r2.success).toBe(true);
    expect(r2.planComplete).toBe(true);
    expect(r2.stepSkipped).toBeUndefined();
    expect(provider.advanceStepCalls).toHaveLength(2);
    expect(provider.executeAffordanceCalls).toHaveLength(1); // unchanged
  });

  it('narrative steps still take the legacy skip path — wait is the distinct, intentional no-op', async () => {
    const narrativeStep: PlanStep = { description: 'Think about coffee', completed: false };
    const provider = new FakeExecuteDataProvider(narrativeStep);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new ExecuteServiceImpl({ dataProvider: provider });
    const result = await service.execute(AGENT_ID);
    errSpy.mockRestore();
    // Legacy path: skip flag + diagnostic.
    expect(result.success).toBe(true);
    expect(result.stepSkipped).toBe(true);
    expect(provider.advanceStepCalls).toHaveLength(1);
  });
});
