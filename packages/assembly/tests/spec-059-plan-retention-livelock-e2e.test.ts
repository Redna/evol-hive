/**
 * Spec 059 — plan-retention livelock bound E2E (issue #215, item 5 — re-adds
 * the test the QA workflow lost in run 35017052250).
 * ═══════════════════════════════════════════════════════════════════════════
 * Deterministic proxy for spec-059 AC-11's bound: over N PPER cycles with an
 * always-ineligible current step, no plan+step is handed to Execute more than
 * twice after a guardrail rejection, and `[reflect]` stays bounded (one per
 * invalidated plan). The live 40-minute instrument measured exactly this
 * (max 2 hand-offs, 0 stalled keys, `[reflect]` 1.86 per plan).
 *
 * Both pathological shapes are driven through the REAL assembled bridge
 * (`assembleWorld` → real `ExecuteDataProviderImpl` → real `PlanManagerImpl`),
 * instrumented at the hand-off seam (`ExecuteDataProviderImpl.getCurrentStep`):
 *
 *   1. invalidation wired   — the stale step is invalidated (plan cleared), so
 *                             each plan+step is handed at most once;
 *   2. invalidation removed — the legacy R4 net retains the plan and hands the
 *                             same plan+step exactly twice, then `[step-skip]`
 *                             advances it — never a third time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Affordance,
  AgentPlan,
  EngineConfig,
  FormulatePlanResult,
  LLMActionResponse,
  PlanStep,
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
    return { memoryContent: 'Took stock.', memoryImportance: 3, memoryType: 'action' };
  }
}

/** A single-step in-flight plan whose target is the (now stale) affordance. */
function stalePlan(id: string): AgentPlan {
  return {
    id,
    description: 'Water the greenhouse',
    steps: [{ description: 'Water', targetAffordance: STALE_TARGET }],
    currentStepIndex: 0,
    createdAt: 100,
  };
}

/**
 * Instrument the Execute hand-off seam: every time the real bridge hands a
 * step to the cognition Execute phase, count `planId#stepIndex`. Returns the
 * counter map (keyed by plan+step) so the bound is judged exactly like the
 * live AC-11 measurement.
 */
function installHandoffRecorder(core: EngineCore): Map<string, number> {
  const handoffs = new Map<string, number>();
  const bridge = core.bridges.execute;
  const original = bridge.getCurrentStep.bind(bridge);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(bridge, 'getCurrentStep').mockImplementation((agentId: string): PlanStep | null => {
    const plan = core.agentManager.getState(agentId)?.currentPlan ?? null;
    if (plan !== null) {
      const key = `${plan.id}#${plan.currentStepIndex}`;
      handoffs.set(key, (handoffs.get(key) ?? 0) + 1);
    }
    return original(agentId);
  });
  return handoffs;
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

describe('spec 059 livelock bound — no plan+step handed to Execute more than twice', () => {
  it('N cycles with an always-ineligible current step: each plan+step handed once, [reflect] bounded', async () => {
    const mock = new ScriptedPlanLLM();
    const world = buildWorld(mock);
    const { core, orchestrator } = world;
    // The premise is gone for the whole run — an always-ineligible step.
    core.smartObjectRegistry.setRoom('greenhouse-1', 'workshop');
    const handoffs = installHandoffRecorder(core);

    const N = 6;
    for (let i = 0; i < N; i++) {
      core.agentManager.updateState(AGENT, { currentPlan: stalePlan(`plan_stale_${i}`) });
      await orchestrator.runCycle(AGENT);
      // Invalidation clears the plan every cycle — nothing is re-queued.
      expect(core.agentManager.getState(AGENT)?.currentPlan).toBeNull();
    }

    // The AC-11 bound: at most two hand-offs per plan+step, and here (the
    // invalidation path) exactly one — invalidation removes the loop entirely.
    const counts = [...handoffs.values()];
    expect(counts).toHaveLength(N);
    expect(Math.max(...counts)).toBeLessThanOrEqual(2);
    expect(counts.every((c) => c === 1)).toBe(true);

    // One stale event + one honest superseded stamp per cycle; R4 never engages.
    expect(lines('[plan-stale]')).toHaveLength(N);
    expect(lines('[plan-superseded]')).toHaveLength(N);
    expect(lines('[step-skip]')).toHaveLength(0);

    // Bounded reflection: one Reflect per invalidated plan, never more.
    expect(lines('[reflect]').length).toBeLessThanOrEqual(N);
    // Every cycle was sticky — the bound is invalidation's, not re-formulation's.
    expect(mock.planCalls).toBe(0);
  });

  it('legacy (invalidation removed): the same plan+step is handed exactly twice, then [step-skip] advances it', async () => {
    const mock = new ScriptedPlanLLM();
    const world = buildWorld(mock);
    const { core, orchestrator } = world;
    // Model a legacy provider at the REAL seam: shadow the prototype method
    // with an own `undefined` so `dataProvider.invalidatePlan?.bind` falls
    // through to R4 (spec 059 AC-6 / AC-10 byte-identical legacy behavior).
    Object.defineProperty(core.bridges.execute, 'invalidatePlan', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    core.smartObjectRegistry.setRoom('greenhouse-1', 'workshop');
    const handoffs = installHandoffRecorder(core);

    core.agentManager.updateState(AGENT, { currentPlan: stalePlan('plan_legacy_1') });

    // Cycle 1: first offence — plan retained, no skip, no invalidation.
    await orchestrator.runCycle(AGENT);
    expect(core.agentManager.getState(AGENT)?.currentPlan).not.toBeNull();
    expect(lines('[plan-stale]')).toHaveLength(0);
    expect(lines('[step-skip]')).toHaveLength(0);

    // Cycle 2: second offence — R4 advances the step with `[step-skip]`.
    await orchestrator.runCycle(AGENT);
    expect(lines('[step-skip]')).toHaveLength(1);
    expect(lines('[plan-stale]')).toHaveLength(0);
    expect(lines('[plan-superseded]')).toHaveLength(0);

    // The bound: the same plan+step was handed exactly twice, never a third time.
    expect(handoffs.get('plan_legacy_1#0')).toBe(2);
    expect(Math.max(...handoffs.values())).toBeLessThanOrEqual(2);
    // Bounded reflection: one Reflect per rejection.
    expect(lines('[reflect]').length).toBeLessThanOrEqual(2);
  });
});
