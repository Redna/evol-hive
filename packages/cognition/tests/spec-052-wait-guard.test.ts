/**
 * Spec 052 — Req 3: critical-drive wait guard (issue #183).
 *
 * An all-`wait` plan is never rejected while drives starve: the plan-builder
 * system prompt endorses wait ("Use wait when no affordance is relevant") and
 * nothing structural stops passivity at low drives — the #183 suspect 3.
 *
 * AC-2 coverage (pure guard + PlanServiceImpl integration):
 * - with a hintable drive at 8 and its direct restorer in the enum, an
 *   all-`wait` plan is rejected with a reason naming the drive and the
 *   restorer;
 * - with the drive at 25, the same plan passes;
 * - with no restorer in the enum, the same plan passes (no phantom forcing);
 * - with `waitSuppression: false` the guard is inert;
 * - `wait` stays legal mid-chain — only TOTAL passivity under a critical,
 *   directly-restorable drive is rejected;
 * - `social` is never a guard trigger (spec 018/024/047 own it).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Affordance,
  AgentInternalState,
  FormulatePlanResult,
  GuardrailConfig,
  PerceptionResult,
  PlanDataProvider,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload, GuardrailEngine } from '../src/index.js';
import { GuardrailEngineImpl } from '../src/guardrails/index.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { PlanServiceImpl } from '../src/pper/plan-service.js';
import { checkWaitSuppression, DRIVE_CRITICAL_THRESHOLD } from '../src/guardrails/wait-guard.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'a1';
const ROOM_ID = 'greenhouse';

const rest_among_seedlings: Affordance = {
  id: 'rest_among_seedlings',
  label: 'Rest among the seedlings',
  engineEffect: 'rest_among_seedlings',
  preconditions: [],
  effects: { comfort: 15, energy: 4 },
};

const observe: Affordance = {
  id: 'observe',
  label: 'Observe',
  engineEffect: 'observe',
  preconditions: [],
  effects: {},
};

const allWaitPlan: FormulatePlanResult = {
  description: 'Wait for something to happen',
  steps: [
    { description: 'Wait a while', targetAffordance: 'wait' },
    { description: 'Wait some more', targetAffordance: 'wait' },
  ],
};

const restoringPlan: FormulatePlanResult = {
  description: 'Restore energy',
  steps: [{ description: 'Rest among the seedlings', targetAffordance: 'rest_among_seedlings' }],
};

/** An area-bound plan navigates — not total passivity, never rejected. */
const areaBoundPlan: FormulatePlanResult = {
  description: 'Walk to the garden',
  steps: [{ description: 'Head to the garden', targetAffordance: 'wait', targetArea: 'garden' }],
};

// ─── AC-2: the pure guard ────────────────────────────────────────────────────

describe('spec 052 Req 3 — checkWaitSuppression (AC-2)', () => {
  it('rejects an all-wait plan when a hintable drive is critical and its restorer is in the enum', () => {
    const verdict = checkWaitSuppression(
      { energy: 8, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      [rest_among_seedlings, observe],
      allWaitPlan,
    );
    expect(verdict.rejected).toBe(true);
    // The reason is actionable: it names the drive AND the restorer.
    expect(verdict.reason).toContain('energy');
    expect(verdict.reason).toContain('rest_among_seedlings');
    expect(verdict.reason).toContain('critical drive');
    expect(verdict.reason).toContain('plan a restoring step');
  });

  it('passes the same all-wait plan when the drive is urgent but not critical (25 ≥ 10)', () => {
    const verdict = checkWaitSuppression(
      { energy: 25, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      [rest_among_seedlings, observe],
      allWaitPlan,
    );
    expect(verdict.rejected).toBe(false);
  });

  it('passes the same all-wait plan when no direct restorer is in the enum (no phantom forcing)', () => {
    const verdict = checkWaitSuppression(
      { energy: 8, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      [observe],
      allWaitPlan,
    );
    expect(verdict.rejected).toBe(false);
  });

  it('is inert when waitSuppression is false', () => {
    const verdict = checkWaitSuppression(
      { energy: 8, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      [rest_among_seedlings, observe],
      allWaitPlan,
      false,
    );
    expect(verdict.rejected).toBe(false);
  });

  it('is enabled by default — an omitted flag does not disable the guard', () => {
    const verdict = checkWaitSuppression(
      { energy: 8, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      [rest_among_seedlings, observe],
      allWaitPlan,
      undefined,
    );
    expect(verdict.rejected).toBe(true);
  });

  it('passes a plan with at least one non-wait step (only TOTAL passivity is rejected)', () => {
    const verdict = checkWaitSuppression(
      { energy: 8, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      [rest_among_seedlings, observe],
      restoringPlan,
    );
    expect(verdict.rejected).toBe(false);
  });

  it('passes an area-bound all-wait plan (movement is planned, not passive)', () => {
    const verdict = checkWaitSuppression(
      { energy: 8, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      [rest_among_seedlings, observe],
      areaBoundPlan,
    );
    expect(verdict.rejected).toBe(false);
  });

  it('never triggers on the social drive (spec 018/024/047 own social restoration)', () => {
    const talk: Affordance = {
      ...observe,
      id: 'talk_to',
      effects: { social: 10 },
    };
    const verdict = checkWaitSuppression(
      { energy: 50, hunger: 50, social: 2, comfort: 50, curiosity: 50 },
      [talk, observe],
      allWaitPlan,
    );
    expect(verdict.rejected).toBe(false);
  });

  it('a critical drive WITHOUT a visible restorer does not reject (other drives unaffected)', () => {
    const verdict = checkWaitSuppression(
      { energy: 50, hunger: 3, social: 50, comfort: 50, curiosity: 50 },
      [rest_among_seedlings, observe],
      allWaitPlan,
    );
    // hunger is critical but nothing in the enum restores it → no forcing.
    expect(verdict.rejected).toBe(false);
  });

  it('the critical threshold defaults to 10 (env-overridable)', () => {
    expect(DRIVE_CRITICAL_THRESHOLD).toBe(10);
    // Boundary: at exactly the threshold the drive is NOT critical (below only).
    const at = checkWaitSuppression(
      { energy: 10, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      [rest_among_seedlings, observe],
      allWaitPlan,
    );
    expect(at.rejected).toBe(false);
    const below = checkWaitSuppression(
      { energy: 9, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      [rest_among_seedlings, observe],
      allWaitPlan,
    );
    expect(below.rejected).toBe(true);
  });
});

// ─── AC-2: PlanServiceImpl integration ───────────────────────────────────────

class FakePlanProvider implements PlanDataProvider {
  agentState: AgentInternalState;
  storePlanCalls: FormulatePlanResult[] = [];

  constructor(drives: Record<string, number>) {
    this.agentState = {
      agentId: AGENT_ID,
      drives,
      currentGoal: '',
      currentPlan: null,
      isThinking: false,
      location: ROOM_ID,
      lastPerceptionTick: 0,
    };
  }

  getAgentState(): AgentInternalState {
    return this.agentState;
  }

  storePlan(_agentId: string, result: FormulatePlanResult): AgentInternalState['currentPlan'] {
    this.storePlanCalls.push(result);
    return {
      id: 'plan-1',
      description: result.description,
      steps: result.steps.map((s) => ({ description: s.description, completed: false })),
      currentStepIndex: 0,
      createdAt: 0,
    };
  }

  setThinking(_agentId: string, isThinking: boolean): void {
    if (this.agentState) this.agentState = { ...this.agentState, isThinking };
  }
}

class SinglePlanClient implements LLMClient {
  constructor(private readonly plan: FormulatePlanResult) {}
  async completeStructured() {
    return { reasoning: 'r', action: 'idle' };
  }
  async completeReflection() {
    return { agentId: AGENT_ID, newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(): Promise<FormulatePlanResult> {
    return this.plan;
  }
  async completeReflect() {
    return { memoryEntry: { content: 'x', importance: 5, type: 'action' } };
  }
}

function makePerception(drives: Record<string, number>): PerceptionResult {
  return {
    passive: {
      roomId: ROOM_ID,
      objectsPresent: [],
      drives,
    },
    prunedAffordances: [rest_among_seedlings, observe],
    primaryDriveLabel: 'low energy, need to restore energy',
  } as unknown as PerceptionResult;
}

describe('spec 052 Req 3 — PlanServiceImpl integration (AC-2)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('rejects the all-wait plan before storePlan; the reason rides the plan-failure path', async () => {
    const provider = new FakePlanProvider({
      energy: 8,
      hunger: 50,
      social: 50,
      comfort: 50,
      curiosity: 50,
    });
    const guardrail = new GuardrailEngineImpl({
      affordanceMasking: true,
      contextualForcing: true,
      planValidation: true,
    });
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: new SinglePlanClient(allWaitPlan),
      dataProvider: provider,
      guardrail,
    });
    const result = await service.plan(AGENT_ID, makePerception({ energy: 8 }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('critical drive energy');
    expect(result.error).toContain('rest_among_seedlings');
    expect(provider.storePlanCalls).toHaveLength(0);
    // isThinking is always reset (§9.1).
    expect(provider.agentState.isThinking).toBe(false);
    errSpy.mockRestore();
  });

  it('stores the same plan when the drive is above the critical threshold', async () => {
    const provider = new FakePlanProvider({
      energy: 25,
      hunger: 50,
      social: 50,
      comfort: 50,
      curiosity: 50,
    });
    const guardrail = new GuardrailEngineImpl({
      affordanceMasking: true,
      contextualForcing: true,
      planValidation: true,
    });
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: new SinglePlanClient(allWaitPlan),
      dataProvider: provider,
      guardrail,
    });
    const result = await service.plan(AGENT_ID, makePerception({ energy: 25 }));
    expect(result.success).toBe(true);
    expect(provider.storePlanCalls).toHaveLength(1);
    errSpy.mockRestore();
  });

  it('is inert when the guardrail config sets waitSuppression: false', async () => {
    const provider = new FakePlanProvider({
      energy: 8,
      hunger: 50,
      social: 50,
      comfort: 50,
      curiosity: 50,
    });
    const guardrail = new GuardrailEngineImpl({
      affordanceMasking: true,
      contextualForcing: true,
      planValidation: true,
      waitSuppression: false,
    });
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: new SinglePlanClient(allWaitPlan),
      dataProvider: provider,
      guardrail,
    });
    const result = await service.plan(AGENT_ID, makePerception({ energy: 8 }));
    expect(result.success).toBe(true);
    expect(provider.storePlanCalls).toHaveLength(1);
    errSpy.mockRestore();
  });

  it('is inert without a guardrail engine (no config to gate on)', async () => {
    const provider = new FakePlanProvider({
      energy: 8,
      hunger: 50,
      social: 50,
      comfort: 50,
      curiosity: 50,
    });
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: new SinglePlanClient(allWaitPlan),
      dataProvider: provider,
    });
    const result = await service.plan(AGENT_ID, makePerception({ energy: 8 }));
    expect(result.success).toBe(true);
    expect(provider.storePlanCalls).toHaveLength(1);
    errSpy.mockRestore();
  });

  it('a restoring plan stores normally under a critical drive (the guard pushes, not blocks)', async () => {
    const provider = new FakePlanProvider({
      energy: 8,
      hunger: 50,
      social: 50,
      comfort: 50,
      curiosity: 50,
    });
    const guardrail: GuardrailEngine = new GuardrailEngineImpl({
      affordanceMasking: true,
      contextualForcing: true,
      planValidation: true,
    });
    const service = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: new SinglePlanClient(restoringPlan),
      dataProvider: provider,
      guardrail,
    });
    const result = await service.plan(AGENT_ID, makePerception({ energy: 8 }));
    expect(result.success).toBe(true);
    expect(provider.storePlanCalls).toHaveLength(1);
    errSpy.mockRestore();
  });
});
