/**
 * Spec 060 — Fallback-floor E2E through the assembled world (assembly, issue #214)
 * ═══════════════════════════════════════════════════════════════════════════════
 * AC-5 at the full-stack boundary (the Micro V-Model "macro" layer): a
 * persistently shape-invalid provider must not spin an agent planless. After
 * `PLAN_FLOOR_AFTER_FAILURES` consecutive PPER cycles, the real
 * `PlanServiceImpl` (wired by `assembleWorld`) stores a shape-valid,
 * binding-valid single-step floor plan — chosen with the same
 * `checkWaitSuppression` predicate the spec-052 guard uses, so it can never be
 * an all-`wait` plan the guard would reject.
 *
 * This also pins the documented spec-008 interaction end-to-end: the floor
 * returns `success: true`, so the orchestrator's cycle-failure cooldown does
 * not engage for floor-able formation failures.
 *
 * Deterministic throughout — the mock LLM is scripted and no network is used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Affordance,
  EngineConfig,
  FormulatePlanResult,
  LLMActionResponse,
  ReflectLLMResponse,
  ReflectionResult,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '@evol-hive/cognition';
import { assembleWorld } from '@evol-hive/assembly';
import type { EngineCore } from '@evol-hive/engine';

const ROOM = 'garden';
const AGENT = 'agent-a';

const ENV_KEYS = [
  'USE_REAL_LLM',
  'USE_REAL_EMBEDDINGS',
  'ENGINE_MAX_CONCURRENT_LLM',
  'PLAN_FLOOR_AFTER_FAILURES',
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    guardrails: { affordanceMasking: false, contextualForcing: false, planValidation: false },
  };
}

function makeAffordance(id: string, effects: Record<string, number> = {}): Affordance {
  return { id, label: id, engineEffect: id, preconditions: [], effects };
}

/** A scene with an `observe` affordance and an energy restorer (for a starving agent). */
function setupScene(core: EngineCore): void {
  core.smartObjectRegistry.register({
    id: 'bench-1',
    name: 'Bench',
    type: 'furniture',
    state: {},
    affordances: [makeAffordance('observe')],
    roomId: ROOM,
  });
  core.smartObjectRegistry.register({
    id: 'cot-1',
    name: 'Cot',
    type: 'furniture',
    state: {},
    affordances: [makeAffordance('rest_among_seedlings', { energy: 15 })],
    roomId: ROOM,
  });
  core.agentManager.spawn({
    id: AGENT,
    name: AGENT,
    description: 'agent a',
    traits: [],
    initialDrives: { energy: 5, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  });
  core.agentManager.updateState(AGENT, { location: ROOM, lastPerceptionTick: 0 });
}

/** A provider whose plan responses are always §7 shape-invalid. */
class ShapeInvalidMockLLM implements LLMClient {
  planCalls = 0;
  async completeStructured(): Promise<LLMActionResponse> {
    return { reasoning: 'scripted', action: 'wait' };
  }
  async completeReflection(): Promise<ReflectionResult> {
    return { agentId: AGENT, newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(_payload: LLMContextPayload): Promise<FormulatePlanResult> {
    this.planCalls += 1;
    return { description: '', steps: [{ description: 'x' }] } as FormulatePlanResult;
  }
  async completeReflect(): Promise<ReflectLLMResponse> {
    return { memoryContent: 'Took stock.', memoryImportance: 3, memoryType: 'action' };
  }
}

function buildWorld(mock: LLMClient): ReturnType<typeof assembleWorld> {
  return assembleWorld({ config: makeConfig(), sceneSetup: setupScene, mockLLMClient: mock });
}

function floorLines(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map((args) => args.map(String).join(' '))
    .filter((l) => l.includes('[plan-floor]'));
}

describe('spec 060 E2E — the floor stores a valid plan after N formation failures (AC-5)', () => {
  it('a persistently shape-invalid provider floors the agent after N cycles (observe/restorer, never wait)', async () => {
    process.env['PLAN_FLOOR_AFTER_FAILURES'] = '2';
    const mock = new ShapeInvalidMockLLM();
    const world = buildWorld(mock);

    // Cycle 1: below threshold — nothing stored, honest failure.
    await world.orchestrator.runCycle(AGENT);
    expect(world.core.agentManager.getState(AGENT)?.currentPlan ?? null).toBeNull();
    expect(mock.planCalls).toBe(1);

    // Cycle 2: the Nth failure floors with a locally-synthesized valid plan.
    await world.orchestrator.runCycle(AGENT);
    const plan = world.core.agentManager.getState(AGENT)?.currentPlan ?? null;
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(1);
    const target = plan!.steps[0]!.targetAffordance;
    // Deterministic preference: `observe` when offered, else the critical-drive
    // restorer. Never `wait` — a restorer is in the enum (spec-052 guard).
    expect(['observe', 'rest_among_seedlings']).toContain(target);
    expect(target).not.toBe('wait');

    const floors = floorLines();
    expect(floors).toHaveLength(1);
    expect(floors[0]).toContain(`agent=${AGENT}`);
    expect(floors[0]).toContain('failures=2');
    expect(floors[0]).toContain(`target=${target}`);

    // No extra plan LLM call was made to synthesize the floor.
    expect(mock.planCalls).toBe(2);
  });

  it('PLAN_FLOOR_AFTER_FAILURES=0 disables the floor end-to-end', async () => {
    process.env['PLAN_FLOOR_AFTER_FAILURES'] = '0';
    const mock = new ShapeInvalidMockLLM();
    const world = buildWorld(mock);

    for (let i = 0; i < 5; i++) {
      await world.orchestrator.runCycle(AGENT);
    }
    expect(world.core.agentManager.getState(AGENT)?.currentPlan ?? null).toBeNull();
    expect(floorLines()).toHaveLength(0);
  });
});
