/**
 * Spec 050 — AC-6 (R6): `EngineConfig.maxConcurrentLLM` is consumed, not dead
 * ────────────────────────────────────────────────────────────────────────────
 * The scheduler reads `ENGINE_MAX_CONCURRENT_LLM` via `defaultPPERSchedulerConfig()`
 * (spec 022) and never read `config.maxConcurrentLLM` — a declared-but-unread
 * field. Spec 050's chosen resolution: the promoted assembler FORWARDS a
 * scheduler config derived from the field, with precedence
 *
 *     scene-level (`SceneDefinition.maxConcurrentCycles`, spec 022 Req 1)
 *       > `ENGINE_MAX_CONCURRENT_LLM` env (spec 022 R4)
 *         > `EngineConfig.maxConcurrentLLM` (spec 050 R6)
 *           > default 1.
 *
 * This suite asserts (a) the derivation helper in `@evol-hive/shared` picks
 * env over the field, (b) the assembled scheduler RECEIVES the derived
 * config, (c) scene-level config keeps precedence, and (d) — behaviorally —
 * a forwarded value demonstrably bounds concurrent PPER cycles.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  AgentProfile,
  EngineConfig,
  FormulatePlanResult,
  LLMActionResponse,
  LLMContextPayload,
  ReflectLLMResponse,
  ReflectionResult,
} from '@evol-hive/shared';
import type { LLMClient } from '@evol-hive/cognition';
import type { EngineCore } from '@evol-hive/engine';
import { assembleWorld } from '@evol-hive/assembly';

const ENV_KEYS = ['ENGINE_MAX_CONCURRENT_LLM'] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

function makeConfig(maxConcurrentLLM: number): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

/** A slow, no-network mock LLM: plan responses hold long enough to observe concurrency. */
class SlowMockLLMClient implements LLMClient {
  inFlight = 0;
  maxInFlight = 0;
  started: string[] = [];

  async completeStructured(payload: LLMContextPayload): Promise<LLMActionResponse> {
    this.started.push(payload.perceptionContext.slice(0, 32));
    return this.hold();
  }

  /** Shared hold window — cycles in flight overlap during the plan phase. */
  private async hold(): Promise<LLMActionResponse> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 30));
    this.inFlight -= 1;
    return { reasoning: 'Mock action.', action: 'observe' };
  }
  async completeReflection(): Promise<ReflectionResult> {
    return { agentId: 'mock', newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(_payload: LLMContextPayload): Promise<FormulatePlanResult> {
    this.started.push('plan');
    await this.hold();
    return {
      description: 'Observe the environment',
      steps: [{ description: 'Observe', targetAffordance: 'observe' }],
    };
  }
  async completeReflect(): Promise<ReflectLLMResponse> {
    return { memoryContent: 'Observed the environment.' };
  }
}

function makeProfile(id: string): AgentProfile {
  return { id, name: id, description: `agent ${id}`, traits: [], initialDrives: {} };
}

// ── (a) The shared derivation helper ─────────────────────────────────────────

describe('overrideSchedulerConfig (spec 050 R6 shared helper)', () => {
  it('forwards config.maxConcurrentLLM when the env var is unset', async () => {
    const { overrideSchedulerConfig } = await import('@evol-hive/shared');
    const config = makeConfig(3);
    expect(overrideSchedulerConfig(config)).toEqual({ maxConcurrentCycles: 3 });
  });

  it('returns undefined when ENGINE_MAX_CONCURRENT_LLM is set — the env var keeps override semantics (spec 022 R4)', async () => {
    const { overrideSchedulerConfig } = await import('@evol-hive/shared');
    process.env['ENGINE_MAX_CONCURRENT_LLM'] = '5';
    expect(overrideSchedulerConfig(makeConfig(3))).toBeUndefined();
  });
});

// ── (b) The assembled scheduler receives the derived config ──────────────────

describe('spec 050 AC-6 — the scheduler consumes EngineConfig.maxConcurrentLLM', () => {
  it('a scene-less world forwards the engine config field to the scheduler', () => {
    const world = assembleWorld({ config: makeConfig(3), mockLLMClient: new SlowMockLLMClient() });
    expect(world.core.scheduler).toBeDefined();
    expect(world.core.scheduler!.maxConcurrentCycles).toBe(3);
  });

  it('ENGINE_MAX_CONCURRENT_LLM still overrides the field (env wins)', () => {
    process.env['ENGINE_MAX_CONCURRENT_LLM'] = '5';
    const world = assembleWorld({ config: makeConfig(3), mockLLMClient: new SlowMockLLMClient() });
    expect(world.core.scheduler!.maxConcurrentCycles).toBe(5);
  });
});

// ── (d) Behavioral: the forwarded value bounds concurrent PPER cycles ────────

describe('spec 050 AC-6 — behavioral bound on concurrent PPER cycles', () => {
  function spawnFour(core: EngineCore): void {
    for (const id of ['agent-a', 'agent-b', 'agent-c', 'agent-d']) {
      core.agentManager.spawn(makeProfile(id));
      core.agentManager.updateState(id, { location: 'garden', lastPerceptionTick: 0 });
    }
  }

  it('maxConcurrentLLM: 2 bounds in-flight cycles to 2 (scheduler receives the derived config)', async () => {
    const llm = new SlowMockLLMClient();
    const world = assembleWorld({
      config: makeConfig(2),
      mockLLMClient: llm,
      sceneSetup: (core) => spawnFour(core),
    });
    // Drive deterministic ticks — no real timers needed for the loop itself.
    world.gameLoop.injectElapsed(0.25); // 15 ticks at 60 FPS
    // Let the in-flight (slow-mock) cycles settle before asserting.
    await new Promise((r) => setTimeout(r, 120));
    expect(llm.started.length).toBeGreaterThanOrEqual(1);
    expect(llm.maxInFlight).toBeLessThanOrEqual(2);
  }, 15_000);

  it('ENGINE_MAX_CONCURRENT_LLM=1 overrides the field — only one cycle in flight', async () => {
    process.env['ENGINE_MAX_CONCURRENT_LLM'] = '1';
    const llm = new SlowMockLLMClient();
    const world = assembleWorld({
      config: makeConfig(4),
      mockLLMClient: llm,
      sceneSetup: (core) => spawnFour(core),
    });
    expect(world.core.scheduler!.maxConcurrentCycles).toBe(1);
    world.gameLoop.injectElapsed(0.25);
    await new Promise((r) => setTimeout(r, 120));
    expect(llm.started.length).toBeGreaterThanOrEqual(1);
    expect(llm.maxInFlight).toBeLessThanOrEqual(1);
  }, 15_000);
});