/**
 * Spec 059 — plan-invalidation integration through the REAL assembly bridge
 * (issue #215, item 5 — re-adds the test the QA workflow lost in run 35017052250).
 * ═══════════════════════════════════════════════════════════════════════════
 * The existing spec-059 coverage pinned the seam with *fake* providers
 * (`packages/cognition/tests/spec-059-execute-plan-invalidation.test.ts`) and
 * with a recording double
 * (`packages/cognition/tests/spec-215-orchestrator-reflect-non-double-stamp.test.ts`).
 * This file drives the real engine↔cognition boundary:
 *
 *   real `assembleWorld` → real `SmartObjectRegistry` + perception projection
 *   → real `ExecuteServiceImpl` → real `ExecuteDataProviderImpl.invalidatePlan`
 *   → real `PlanManagerImpl` (stamp + clear) → real `PlanDataProviderImpl` +
 *   real `PlanServiceImpl` re-formulates next cycle (not sticky).
 *
 * The stale premise is created exactly the way the world creates it: the plan
 * is in flight, then its target object moves (spec 030 `move_object`), so the
 * live `getVisibleAffordancesInRoom` projection no longer contains the target
 * (spec 058 R1 / spec 059 R1).
 *
 * Deterministic throughout — the mock LLM is scripted and no network is used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Affordance,
  AgentPlan,
  EngineConfig,
  FormulatePlanResult,
  LLMActionResponse,
  ReflectLLMResponse,
  ReflectionResult,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '@evol-hive/cognition';
import { assembleWorld } from '@evol-hive/assembly';
import type { AssembledWorld } from '@evol-hive/assembly';
import type { EngineCore } from '@evol-hive/engine';

const ROOM = 'garden';
const AGENT = 'agent-a';
const STALE_TARGET = 'water_plants';

const ENV_KEYS = ['USE_REAL_LLM', 'USE_REAL_EMBEDDINGS', 'ENGINE_MAX_CONCURRENT_LLM'] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

function makeConfig(): EngineConfig {
  return {
    fps: 30,
    spatialDebounceSeconds: 2,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

function makeAffordance(id: string, effects: Record<string, number> = {}): Affordance {
  return { id, label: id, engineEffect: id, preconditions: [], effects };
}

/** The greenhouse lives in the room; a deterministic handler makes execution succeed. */
function setupScene(core: EngineCore): void {
  core.smartObjectRegistry.register({
    id: 'greenhouse-1',
    name: 'Greenhouse',
    type: 'fixture',
    state: {},
    affordances: [makeAffordance(STALE_TARGET, { curiosity: 10 })],
    roomId: ROOM,
  });
  core.affordanceRegistry.registerHandler(STALE_TARGET, async () => ({
    success: true,
    driveChanges: { curiosity: 10 },
  }));
  core.agentManager.spawn({
    id: AGENT,
    name: AGENT,
    description: 'agent a',
    traits: [],
    initialDrives: {},
  });
  core.agentManager.updateState(AGENT, { location: ROOM, lastPerceptionTick: 0 });
}

/** A scripted client: one valid re-formulation target, never invoked in cycle 1. */
class ScriptedPlanLLM implements LLMClient {
  planCalls = 0;
  async completeStructured(): Promise<LLMActionResponse> {
    return { reasoning: 'scripted', action: 'wait' };
  }
  async completeReflection(): Promise<ReflectionResult> {
    return { agentId: AGENT, newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(_payload: LLMContextPayload): Promise<FormulatePlanResult> {
    this.planCalls += 1;
    return {
      description: 'Water the greenhouse',
      steps: [{ description: 'Water', targetAffordance: STALE_TARGET }],
    };
  }
  async completeReflect(): Promise<ReflectLLMResponse> {
    return { memoryContent: 'Watered the plants.', memoryImportance: 3, memoryType: 'action' };
  }
}

/** An in-flight plan whose premise was valid when it was formulated. */
function inFlightPlan(id: string): AgentPlan {
  return {
    id,
    description: 'Water the greenhouse',
    steps: [{ description: 'Water', targetAffordance: STALE_TARGET }],
    currentStepIndex: 0,
    createdAt: 100,
  };
}

function buildWorld(mock: LLMClient): AssembledWorld {
  return assembleWorld({ config: makeConfig(), sceneSetup: setupScene, mockLLMClient: mock });
}

function diagnostics(): string[] {
  return vi.mocked(console.error).mock.calls.map((args) => args.map(String).join(' '));
}

function lines(match: string): string[] {
  return diagnostics().filter((l) => l.includes(match));
}

describe('spec 059 integration — stale-target invalidation through the REAL assembly bridge', () => {
  it('the real bridge invalidates once ([plan-stale] + [plan-superseded], no [step-skip]) and the next cycle re-formulates (not sticky)', async () => {
    const mock = new ScriptedPlanLLM();
    const world = buildWorld(mock);
    const { core, orchestrator } = world;

    // Plan in flight, formed while the greenhouse was in the room.
    core.agentManager.updateState(AGENT, { currentPlan: inFlightPlan('plan_stale_1') });
    // ... then the premise moves (spec 030 move_object) BEFORE Execute.
    core.smartObjectRegistry.setRoom('greenhouse-1', 'workshop');

    const first = await orchestrator.runCycle(AGENT);

    // The real engine manager stamped + cleared (not a recording double).
    expect(typeof core.bridges.execute.invalidatePlan).toBe('function');
    const state = core.agentManager.getState(AGENT);
    expect(state?.currentPlan).toBeNull();
    expect(state?.lastPlanOutcome).toMatchObject({
      planDescription: 'Water the greenhouse',
      steps: [STALE_TARGET],
      success: false,
      superseded: true,
      stepsCompleted: 0,
      stepsTotal: 1,
      reflected: false,
    });
    expect(first.appliedDriveChanges).toBe(false);

    // One `[plan-stale]` from cognition's execute seam...
    const stale = lines('[plan-stale]');
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain(`agent=${AGENT}`);
    expect(stale[0]).toContain('plan=plan_stale_1');
    expect(stale[0]).toContain("target='water_plants'");
    // ... and exactly one `[plan-superseded]` from the real PlanManagerImpl.
    expect(lines('[plan-superseded]')).toHaveLength(1);
    // The invalidation path never uses the R4 step-skip net.
    expect(lines('[step-skip]')).toHaveLength(0);
    // Plan phase was sticky in cycle 1 — no formulation spend.
    expect(mock.planCalls).toBe(0);

    // Restore the premise and run the next cycle: the cleared plan must not be
    // returned (stickiness bypassed) — real PlanServiceImpl re-formulates and
    // stores a fresh plan from the live enum.
    const created: string[] = [];
    const storePlan = core.bridges.plan.storePlan.bind(core.bridges.plan);
    vi.spyOn(core.bridges.plan, 'storePlan').mockImplementation((agentId, result) => {
      const plan = storePlan(agentId, result);
      created.push(`${plan.id}:${plan.steps[0]?.targetAffordance ?? ''}`);
      return plan;
    });
    core.smartObjectRegistry.setRoom('greenhouse-1', ROOM);
    await orchestrator.runCycle(AGENT);

    expect(mock.planCalls).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]).not.toContain('plan_stale_1');
    expect(created[0]).toContain(STALE_TARGET);
    // The fresh plan executed and Reflect cleared it on completion — no R4 skip.
    expect(core.agentManager.getState(AGENT)?.currentPlan).toBeNull();
    expect(lines('[step-skip]')).toHaveLength(0);
    // Exactly one invalidation across both cycles — no re-invalidation.
    expect(lines('[plan-stale]')).toHaveLength(1);
  });

  it('the wired real bridge invalidatePlan clears the plan and stamps superseded (production wiring, not a no-op)', async () => {
    const mock = new ScriptedPlanLLM();
    const world = buildWorld(mock);
    const { core } = world;

    core.agentManager.updateState(AGENT, { currentPlan: inFlightPlan('plan_direct_1') });
    core.bridges.execute.invalidatePlan(AGENT);

    const state = core.agentManager.getState(AGENT);
    expect(state?.currentPlan).toBeNull();
    expect(state?.lastPlanOutcome?.superseded).toBe(true);
    expect(state?.lastPlanOutcome?.stepsTotal).toBe(1);
    expect(lines('[plan-superseded]')).toHaveLength(1);
  });
});
