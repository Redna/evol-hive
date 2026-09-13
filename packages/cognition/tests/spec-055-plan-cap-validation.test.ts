/**
 * Spec 055 — Plan step cap: plan-service shape validation + one-retry path
 * (Req 6 — issue #198, AC-6 service half)
 * ────────────────────────────────────────────────────────────────────────────
 * `checkPlanBinding` rejects over-cap plans (`steps.length > PLAN_MAX_STEPS`)
 * with actionable feedback and the existing ONE-retry-with-feedback path
 * (the spec-037 pattern): the first over-cap response triggers a resubmission;
 * a within-cap resubmission succeeds, a second over-cap response fails the
 * cycle. The schema half lives in
 * `packages/shared/tests/spec-055-plan-max-steps.test.ts`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type {
  PerceptionResult,
  FormulatePlanResult,
  PlanDataProvider,
  AgentInternalState,
  AgentPlan,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '../src/index.js';
import { PlanServiceImpl, checkPlanBinding } from '../src/pper/plan-service.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';

function makePlan(steps: number, description = 'A chained plan'): FormulatePlanResult {
  return {
    description,
    steps: Array.from({ length: steps }, (_, i) => ({
      description: `step ${i + 1}`,
      targetAffordance: 'water_plants',
    })),
  };
}

function makeState(): AgentInternalState {
  return {
    agentId: 'a1',
    drives: { energy: 30, hunger: 50, social: 50, comfort: 50, curiosity: 60 },
    currentGoal: '',
    currentPlan: null,
    isThinking: false,
    location: 'garden',
    lastPerceptionTick: 0,
  };
}

function makePerception(): PerceptionResult {
  return {
    passive: {
      roomId: 'garden',
      objectsPresent: [{ objectId: 'planter-1', name: 'Planter', type: 'furniture' }],
      drives: { energy: 30, hunger: 50, social: 50, comfort: 50, curiosity: 60 },
    },
    prunedAffordances: [
      {
        id: 'water_plants',
        label: 'Water the plants',
        engineEffect: 'water_plants',
        preconditions: [],
        effects: { curiosity: 10, comfort: 5 },
      },
    ],
    primaryDriveLabel: 'low curiosity, need to restore curiosity',
  };
}

function makePlanProvider(state: AgentInternalState): PlanDataProvider {
  return {
    getAgentState: () => state,
    storePlan: (_id, result) => {
      const plan: AgentPlan = {
        id: `plan_${Date.now()}`,
        description: result.description,
        steps: result.steps.map((s) => ({ description: s.description, completed: false })),
        currentStepIndex: 0,
        createdAt: 0,
      };
      state.currentPlan = plan;
      return plan;
    },
    setThinking: () => {},
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('spec 055 Req 6: checkPlanBinding enforces the step cap', () => {
  it('a plan within the default cap is valid', () => {
    const verdict = checkPlanBinding(makePlan(6), ['water_plants']);
    expect(verdict.valid).toBe(true);
    expect(verdict.shapeValid).toBe(true);
  });

  it('a plan over the default cap fails with actionable, shape-valid feedback', () => {
    const verdict = checkPlanBinding(makePlan(7), ['water_plants']);
    expect(verdict.valid).toBe(false);
    // Over-cap is a RETRYABLE violation (spec-037 one-retry path), not a
    // hard §7 shape failure — the plan itself is well-formed, just too long.
    expect(verdict.shapeValid).toBe(true);
    expect(verdict.violations.join(' ')).toContain('7');
    expect(verdict.violations.join(' ')).toContain('6');
    expect(verdict.feedback).toContain('cap is 6');
    expect(verdict.feedback).toContain('7 steps');
    expect(verdict.feedback).toContain('Resubmit');
  });

  it('the cap reads the PLAN_MAX_STEPS env override at validation time', () => {
    vi.stubEnv('PLAN_MAX_STEPS', '2');
    expect(checkPlanBinding(makePlan(3), ['water_plants']).valid).toBe(false);
    expect(checkPlanBinding(makePlan(2), ['water_plants']).valid).toBe(true);
  });

  it('an explicit maxSteps argument overrides the env default', () => {
    vi.stubEnv('PLAN_MAX_STEPS', '6');
    expect(checkPlanBinding(makePlan(3), ['water_plants'], undefined, 2).valid).toBe(false);
    expect(checkPlanBinding(makePlan(2), ['water_plants'], undefined, 2).valid).toBe(true);
  });

  it('the cap never rejects the wait-only masked enum plan (binding skip unchanged)', () => {
    // Masked / affordance-less context (spec 016): binding is skipped — the
    // cap still applies to a well-formed plan but the zero-affordance path
    // remains valid for plans within the cap.
    const verdict = checkPlanBinding(makePlan(2), []);
    expect(verdict.valid).toBe(true);
  });
});

describe('spec 055 Req 6: PlanServiceImpl retries once on over-cap plans', () => {
  it('an over-cap response triggers exactly one retry; the within-cap resubmission succeeds', async () => {
    const state = makeState();
    const planProvider = makePlanProvider(state);
    const calls: FormulatePlanResult[] = [
      makePlan(7, 'Seven steps — over the cap'),
      makePlan(6, 'Six steps — within the cap'),
    ];
    let completePlanCalls = 0;
    const llm: LLMClient = {
      completePlan: async () => {
        completePlanCalls += 1;
        const next = calls.shift();
        if (next === undefined) throw new Error('script exhausted');
        return next;
      },
    } as unknown as LLMClient;

    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: planProvider,
    });
    const result = await service.plan('a1', makePerception());
    expect(result.success).toBe(true);
    expect(result.plan?.steps).toHaveLength(6);
    expect(completePlanCalls).toBe(2); // original + exactly one retry
    expect(state.currentPlan?.steps).toHaveLength(6);
  });

  it('a second over-cap response fails the cycle after the one retry', async () => {
    const state = makeState();
    const llm: LLMClient = {
      completePlan: async () => makePlan(9, 'Always over the cap'),
    } as unknown as LLMClient;
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: makePlanProvider(state),
    });
    const result = await service.plan('a1', makePerception());
    expect(result.success).toBe(false);
    expect(result.error).toContain('cap is 6');
    expect(state.currentPlan).toBeNull();
  });

  it('the retry feedback reaches the LLM as a CORRECTION appended to the context', async () => {
    const state = makeState();
    const contexts: string[] = [];
    const llm: LLMClient = {
      completePlan: async (payload: LLMContextPayload) => {
        contexts.push(payload.perceptionContext);
        return contexts.length === 1 ? makePlan(7) : makePlan(4);
      },
    } as unknown as LLMClient;
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: llm,
      dataProvider: makePlanProvider(state),
    });
    const result = await service.plan('a1', makePerception());
    expect(result.success).toBe(true);
    expect(contexts[1]).toContain('CORRECTION:');
    expect(contexts[1]).toContain('cap is 6');
    // The correction is appended to the DYNAMIC (post-`---`) section — the
    // stable prefix the retry payload reuses stays byte-identical (spec 021).
    const stable1 = contexts[0]!.split('\n---\n')[0];
    const stable2 = contexts[1]!.split('\n---\n')[0];
    expect(stable2).toBe(stable1);
  });
});
