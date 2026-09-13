/**
 * Spec 055 — Engine-stamped plan outcome via the Reflect phase
 * (Req 4 — issue #198)
 * ────────────────────────────────────────────────────────────────────────────
 * The engine's PPER data layer stamps `AgentInternalState.lastPlanOutcome`
 * when a plan completes or fails. The stamping seam: `ReflectDataProvider`
 * gains an OPTIONAL `stampLastPlanOutcome(agentId, outcome)` method
 * (spec-039/052 additive pattern), and `ReflectServiceImpl` calls it at the
 * moment the data exists — after the reflect phase's memory write, before the
 * plan-clear — for plans that just COMPLETED (all steps done) or FAILED
 * (execution failure reaching reflect). Per-cycle step progress on a
 * still-active plan is not a plan outcome and never stamps.
 *
 * The engine provider implementations (write/read through `AgentManager`) are
 * exercised through the REAL stack in
 * `examples/tests/spec-055-water-economy.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import type {
  AgentInternalState,
  ExecuteResult,
  LastPlanOutcome,
  ReflectDataProvider,
} from '@evol-hive/shared';
import { ReflectServiceImpl } from '../src/pper/reflect-service.js';
import { ReflectBuilderImpl } from '../src/pper/reflect-builder.js';
import type { LLMClient } from '../src/index.js';

function makeState(planSteps = 1): AgentInternalState {
  return {
    agentId: 'a1',
    drives: { energy: 45, hunger: 50, social: 50, comfort: 50, curiosity: 60 },
    currentGoal: 'water the plants',
    currentPlan:
      planSteps > 0
        ? {
            id: 'plan_a1_1',
            description: 'Water the greenhouse plants',
            steps: Array.from({ length: planSteps }, (_, i) => ({
              description: `step ${i + 1}`,
              completed: false,
              targetAffordance: i === planSteps - 1 ? 'water_plants' : 'go_to_greenhouse',
            })),
            currentStepIndex: planSteps, // already advanced by Execute
            createdAt: 0,
          }
        : null,
    isThinking: false,
    location: 'greenhouse',
    lastPerceptionTick: 0,
  };
}

function successExecute(driveChanges?: Record<string, number>): ExecuteResult {
  return {
    success: true,
    planComplete: true,
    ...(driveChanges !== undefined ? { result: { success: true, driveChanges } } : {}),
  };
}

/** A reflect provider recording stamp calls; all other methods inert. */
function makeReflectProvider(
  state: AgentInternalState,
  stamps: LastPlanOutcome[],
): ReflectDataProvider {
  return {
    getAgentState: () => state,
    applyDriveChanges: () => {},
    updateGoal: () => {},
    storeMemory: async () => {},
    clearPlanIfComplete: () => {
      if (
        state.currentPlan !== null &&
        state.currentPlan.currentStepIndex >= state.currentPlan.steps.length
      ) {
        state.currentPlan = null;
        return true;
      }
      return false;
    },
    setThinking: () => {},
    getAgentProfile: () => null,
    stampLastPlanOutcome: (agentId, outcome) => {
      stamps.push(outcome);
      state.lastPlanOutcome = outcome;
    },
  };
}

function makeLLM(): LLMClient {
  return {
    completeReflect: async () => ({
      memoryContent: 'Watered the plants; the reservoir dropped.',
      memoryImportance: 5,
      memoryType: 'action',
    }),
  } as unknown as LLMClient;
}

function makeService(provider: ReflectDataProvider): ReflectServiceImpl {
  return new ReflectServiceImpl({
    reflectBuilder: new ReflectBuilderImpl(),
    llmClient: makeLLM(),
    dataProvider: provider,
  });
}

describe('spec 055 Req 4: ReflectServiceImpl stamps the plan outcome', () => {
  it('a completing plan stamps success with steps, drive deltas, and reflected=true', async () => {
    const state = makeState(1); // plan completed (index 1 of 1 step)
    const stamps: LastPlanOutcome[] = [];
    const provider = makeReflectProvider(state, stamps);
    const service = makeService(provider);

    const result = await service.reflect('a1', successExecute({ curiosity: 10, comfort: 5 }));
    expect(result.success).toBe(true);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toEqual({
      planDescription: 'Water the greenhouse plants',
      steps: ['water_plants'],
      success: true,
      driveChanges: { curiosity: 10, comfort: 5 },
      reflected: true,
    });
    expect(state.lastPlanOutcome).toEqual(stamps[0]);
  });

  it('a failing execution reaching reflect stamps success=false (reflected per memory)', async () => {
    const state = makeState(1);
    const stamps: LastPlanOutcome[] = [];
    const provider = makeReflectProvider(state, stamps);
    const service = makeService(provider);

    const result = await service.reflect('a1', {
      success: false,
      error: 'The watering can is empty.',
      planComplete: false,
    });
    expect(result.success).toBe(true); // the reflect itself succeeds
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.success).toBe(false);
    expect(stamps[0]!.driveChanges).toBeUndefined();
    expect(stamps[0]!.reflected).toBe(true); // the reflect stored a memory
  });

  it('per-cycle step progress on a still-active plan never stamps', async () => {
    const state = makeState(2); // 2-step plan, index 2 = just completed second step…
    // Make the plan still-active: index 1 of 2 (step 1 executed this cycle).
    state.currentPlan!.currentStepIndex = 1;
    const stamps: LastPlanOutcome[] = [];
    const provider = makeReflectProvider(state, stamps);
    const service = makeService(provider);

    await service.reflect('a1', successExecute({ curiosity: 10 }));
    expect(stamps).toHaveLength(0);
    expect(state.currentPlan).not.toBeNull(); // not cleared either
  });

  it('an agent without an active plan never stamps', async () => {
    const state = makeState(0); // currentPlan: null
    const stamps: LastPlanOutcome[] = [];
    const provider = makeReflectProvider(state, stamps);
    const service = makeService(provider);

    await service.reflect('a1', successExecute());
    expect(stamps).toHaveLength(0);
  });

  it('a reflect-phase failure still stamps a failed plan (the outcome data exists)', async () => {
    const state = makeState(1);
    const stamps: LastPlanOutcome[] = [];
    const provider: ReflectDataProvider = {
      ...makeReflectProvider(state, stamps),
      storeMemory: async () => {
        throw new Error('memory store down');
      },
    };
    const service = makeService(provider);

    const result = await service.reflect('a1', successExecute({ curiosity: 10 }));
    expect(result.success).toBe(false); // memory store failed → reflect failed
    // The plan completed and its execution outcome was real — the stamp fires
    // with reflected=false (no memory node was written for it).
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.success).toBe(true);
    expect(stamps[0]!.reflected).toBe(false);
  });

  it('legacy providers without stampLastPlanOutcome never break the reflect phase', async () => {
    const state = makeState(1);
    const provider: ReflectDataProvider = {
      getAgentState: () => state,
      applyDriveChanges: () => {},
      updateGoal: () => {},
      storeMemory: async () => {},
      clearPlanIfComplete: () => {
        state.currentPlan = null;
        return true;
      },
      setThinking: () => {},
      getAgentProfile: () => null,
    };
    const service = makeService(provider);
    const result = await service.reflect('a1', successExecute({ curiosity: 10 }));
    expect(result.success).toBe(true);
    expect(state.lastPlanOutcome).toBeUndefined();
  });
});
