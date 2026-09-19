/**
 * Spec 215, item 3 (issue #215) — orchestrator-level Reflect non-double-stamp.
 *
 * Spec 059 AC-5 pins the single-stamp property for `lastPlanOutcome` at the
 * engine seam (`PlanManagerImpl.invalidatePlan` stamps `superseded` once and
 * the `[plan-superseded]` line fires once), but there was no end-to-end test
 * that drives the PPER cycle Orchestrator → Execute(invalidate) → Reflect.
 * The single-stamp property was previously argued from ordering reasoning and
 * from the live 1:1 `[plan-stale]`:`[plan-superseded]` ratio in the 40-minute
 * validation run.
 *
 * The ordering claim this pins: Execute's `invalidatePlan` clears
 * `currentPlan` before the orchestrator routes the deviation to Reflect, so
 * `ReflectServiceImpl` reads `planAtEntry === null` and its `finally`-block
 * `stampPlanOutcome` early-returns — no second `lastPlanOutcome` write and no
 * second `[plan-superseded]` diagnostic. If Reflect could still see the plan
 * (e.g. a future refactor captured it earlier, or invalidation stopped
 * clearing), the stamp would be written twice with the second one replacing
 * the honest `superseded` outcome with a `success: false` Reflect stamp.
 *
 * The provider below is a RECORDING double that mirrors the engine's
 * `PlanManagerImpl.invalidatePlan` semantics (spec 056 stamp + one
 * `[plan-superseded]` line + clear) because cognition cannot import `engine`
 * (ADR-0001 — `shared ← cognition`, never `engine ← cognition`). The engine
 * stamp itself is covered by the engine spec-059 suite; this test covers the
 * orchestration seam.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Affordance,
  AffordanceResult,
  AgentInternalState,
  AgentPlan,
  AgentProfile,
  ExecuteDataProvider,
  FormulatePlanResult,
  LastPlanOutcome,
  LLMActionResponse,
  LLMContextPayload,
  MemoryEntryInput,
  MemorySnippet,
  PerceptionDataProvider,
  PlanDataProvider,
  PlanStep,
  ReflectDataProvider,
  ReflectLLMResponse,
  ReflectionResult,
  SmartObjectSummary,
} from '@evol-hive/shared';
import { PPEROrchestratorImpl } from '../src/pper/orchestrator.js';
import { GuardrailEngineImpl } from '../src/guardrails/index.js';
import type { AffordanceClassifier } from '../src/classifier/index.js';
import type { LLMClient } from '../src/index.js';

const AGENT_ID = 'iris-1';
const ROOM = 'garden';

const GUARDRAIL_CONFIG = {
  affordanceMasking: true,
  contextualForcing: true,
  planValidation: true,
};

/** An in-flight 2-step plan whose current step targets a stale affordance. */
function stalePlan(): AgentPlan {
  return {
    id: 'plan_iris-1_150.6_40',
    description: 'Water the greenhouse',
    steps: [
      { description: 'Walk', completed: true, targetAffordance: 'go_to_greenhouse' },
      { description: 'Water', completed: false, targetAffordance: 'water_plants' },
    ],
    currentStepIndex: 1,
    createdAt: 150.6,
  };
}

/**
 * One recording double serving all four PPER provider roles, sharing a single
 * mutable `state` (as the assembled engine does). Every `lastPlanOutcome`
 * write — from invalidation OR from Reflect's `stampLastPlanOutcome` — is
 * appended to {@link lastPlanOutcomeWrites}, so "exactly one write" is
 * observable regardless of which seam produced it.
 */
class RecordingProvider
  implements PerceptionDataProvider, PlanDataProvider, ExecuteDataProvider, ReflectDataProvider
{
  readonly state: AgentInternalState = {
    agentId: AGENT_ID,
    drives: { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    currentGoal: 'water the plants',
    currentPlan: stalePlan(),
    isThinking: false,
    location: ROOM,
    lastPerceptionTick: 0,
  };

  readonly invalidateCalls: string[] = [];
  readonly lastPlanOutcomeWrites: LastPlanOutcome[] = [];
  readonly stampLastPlanOutcomeCalls: { agentId: string; outcome: LastPlanOutcome }[] = [];
  readonly systemFeedback: string[] = [];

  // ── shared state ─────────────────────────────────────────────────────────
  getAgentState(): AgentInternalState {
    return this.state;
  }
  setThinking(_agentId: string, isThinking: boolean): void {
    this.state.isThinking = isThinking;
  }
  getAgentProfile(): AgentProfile | null {
    return null;
  }
  applyDriveChanges(_agentId: string, changes: Partial<Record<string, number>>): void {
    for (const [drive, delta] of Object.entries(changes)) {
      this.state.drives[drive as keyof typeof this.state.drives] += delta ?? 0;
    }
  }

  // ── PerceptionDataProvider ───────────────────────────────────────────────
  getAgentLocation(): string {
    return this.state.location;
  }
  getObjectsInRoom(): SmartObjectSummary[] {
    return [];
  }
  getAffordancesInRoom(): Affordance[] {
    return [];
  }
  getAgentDrives(): Record<string, number> {
    return { ...this.state.drives };
  }
  getPrimaryDriveLabel(): string {
    return 'low energy, need to restore energy';
  }
  getSystemFeedback(): string | undefined {
    return this.systemFeedback[this.systemFeedback.length - 1];
  }

  // ── PlanDataProvider ─────────────────────────────────────────────────────
  storePlan(_agentId: string, result: FormulatePlanResult): AgentPlan {
    const plan: AgentPlan = {
      id: 'plan_stored',
      description: result.description,
      steps: result.steps.map((step) => {
        const planStep: PlanStep = { description: step.description, completed: false };
        if (step.targetAffordance !== undefined) planStep.targetAffordance = step.targetAffordance;
        return planStep;
      }),
      currentStepIndex: 0,
      createdAt: 1,
    };
    this.state.currentPlan = plan;
    return plan;
  }

  // ── ExecuteDataProvider ──────────────────────────────────────────────────
  getCurrentStep(): PlanStep | null {
    const plan = this.state.currentPlan;
    if (plan === null) return null;
    return plan.steps[plan.currentStepIndex] ?? null;
  }
  isPlanComplete(): boolean {
    const plan = this.state.currentPlan;
    return plan === null || plan.currentStepIndex >= plan.steps.length;
  }
  resolveAffordance(
    _roomId: string,
    affordanceId: string,
  ): { objectId: string; affordance: Affordance } | null {
    return {
      objectId: 'obj-1',
      affordance: {
        id: affordanceId,
        label: affordanceId,
        engineEffect: affordanceId,
        preconditions: [],
        effects: {},
      },
    };
  }
  checkPreconditions(): { satisfied: boolean; failed: string[] } {
    return { satisfied: true, failed: [] };
  }
  async executeAffordance(): Promise<AffordanceResult> {
    return { success: true };
  }
  advanceStep(): void {
    const plan = this.state.currentPlan;
    if (plan === null) return;
    this.state.currentPlan = { ...plan, currentStepIndex: plan.currentStepIndex + 1 };
  }
  setSystemFeedback(_agentId: string, feedback: string): void {
    this.systemFeedback.push(feedback);
  }

  /**
   * Mirrors `PlanManagerImpl.invalidatePlan` (spec 059 R3): stamp the spec-056
   * `superseded` outcome for the in-flight plan, emit exactly one
   * `[plan-superseded]` line, then clear `currentPlan`.
   */
  invalidatePlan(agentId: string): void {
    this.invalidateCalls.push(agentId);
    const plan = this.state.currentPlan;
    if (plan === null || plan.currentStepIndex >= plan.steps.length) return;
    const outcome: LastPlanOutcome = {
      planDescription: plan.description,
      steps: plan.steps.map((step) => step.targetAffordance ?? step.description),
      success: false,
      superseded: true,
      stepsCompleted: plan.currentStepIndex,
      stepsTotal: plan.steps.length,
      reflected: false,
    };
    this.lastPlanOutcomeWrites.push(outcome);
    this.state.lastPlanOutcome = outcome;
    console.error(
      `[plan-superseded] agent=${agentId}: superseded after ` +
        `${plan.currentStepIndex} of ${plan.steps.length} steps`,
    );
    this.state.currentPlan = null;
  }

  // ── ReflectDataProvider ──────────────────────────────────────────────────
  updateGoal(_agentId: string, goal: string): void {
    this.state.currentGoal = goal;
  }
  async storeMemory(_agentId: string, _entry: MemoryEntryInput): Promise<void> {}
  clearPlanIfComplete(): boolean {
    const plan = this.state.currentPlan;
    if (plan !== null && plan.currentStepIndex >= plan.steps.length) {
      this.state.currentPlan = null;
      return true;
    }
    return false;
  }
  stampLastPlanOutcome(agentId: string, outcome: LastPlanOutcome): void {
    this.stampLastPlanOutcomeCalls.push({ agentId, outcome });
    this.lastPlanOutcomeWrites.push(outcome);
    this.state.lastPlanOutcome = outcome;
  }
}

function makeClassifier(): AffordanceClassifier {
  return {
    async prune(_drive, affordances) {
      return affordances;
    },
  };
}

describe('spec 215 item 3: invalidating execute → Reflect does not double-stamp lastPlanOutcome', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('one lastPlanOutcome write, one [plan-superseded] line, Reflect never overwrites it', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.map(String).join(' '));
    });

    const provider = new RecordingProvider();
    let reflectCalls = 0;
    const llmClient: LLMClient = {
      async completeStructured(_payload: LLMContextPayload): Promise<LLMActionResponse> {
        return { reasoning: '', action: 'wait' };
      },
      async completeReflection(
        _system: string,
        _nodes: MemorySnippet[],
      ): Promise<ReflectionResult> {
        return { agentId: AGENT_ID, newMemories: [], consolidatedNodeIds: [] };
      },
      async completePlan(_payload: LLMContextPayload): Promise<FormulatePlanResult> {
        // Never expected: the pre-set in-flight plan short-circuits the Plan
        // phase (spec 002 stickiness) so the stale plan reaches Execute.
        return {
          description: 'unreachable',
          steps: [{ description: 'wait', targetAffordance: 'wait' }],
        };
      },
      async completeReflect(_payload: LLMContextPayload): Promise<ReflectLLMResponse> {
        reflectCalls += 1;
        return {};
      },
    };

    const orchestrator = new PPEROrchestratorImpl({
      perceptionProvider: provider,
      planProvider: provider,
      executeProvider: provider,
      reflectProvider: provider,
      classifier: makeClassifier(),
      llmClient,
      guardrail: new GuardrailEngineImpl(GUARDRAIL_CONFIG),
      // Moment-scoped eligibility says the target is gone; the room-registry
      // fallback would still say it is available — the agent-scoped method wins
      // (spec 059 R1) and produces the `stale-target` rejection that invalidates.
      affordanceGuard: {
        isAffordanceAvailableInRoom: () => true,
        isAffordanceEligibleForAgent: () => false,
      },
    });

    const outcome = await orchestrator.runCycle(AGENT_ID);

    // The cycle actually went Orchestrator → Execute(invalidate) → Reflect.
    expect(outcome.appliedDriveChanges).toBe(false);
    expect(provider.invalidateCalls).toEqual([AGENT_ID]);
    expect(reflectCalls).toBe(1);

    // Exactly one `lastPlanOutcome` write across the whole cycle — the
    // invalidation stamp. Reflect's `finally`-block stamp ran against a null
    // `planAtEntry` and wrote nothing.
    expect(provider.stampLastPlanOutcomeCalls).toEqual([]);
    expect(provider.lastPlanOutcomeWrites).toHaveLength(1);
    expect(provider.lastPlanOutcomeWrites[0]).toMatchObject({
      planDescription: 'Water the greenhouse',
      steps: ['go_to_greenhouse', 'water_plants'],
      success: false,
      superseded: true,
      stepsCompleted: 1,
      stepsTotal: 2,
      reflected: false,
    });

    // The stamped outcome is not replaced, and the plan is cleared.
    expect(provider.state.lastPlanOutcome).toBe(provider.lastPlanOutcomeWrites[0]);
    expect(provider.state.currentPlan).toBeNull();

    // Exactly one `[plan-superseded]` line — no second stamp, no replacement.
    expect(errors.filter((line) => line.includes('[plan-superseded]'))).toHaveLength(1);
  });
});
