/**
 * Spec 014 — MemoryMaintenanceSystem (engine layer) + assembly integration
 * ──────────────────────────────────────────────────────────────────────
 * Covers AC-40 through AC-46, AC-51.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  GameTick,
  MemoryDecayConfig,
  DecayResult,
  ReflectionResult,
  ReflectionConfig,
  AgentProfile,
  EngineConfig,
  PPEROrchestratorPort,
  PPERPhase,
} from '@evol-hive/shared';
import { defaultMemoryDecayConfig, defaultReflectionConfig } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { MemoryMaintenanceSystem } from '../src/systems/memory-maintenance.js';
import type { MemoryDecayService, ReflectionLoop } from '@evol-hive/memory';
import { createEngineCore, assembleGameLoop } from '../src/assembly.js';
import type { EngineSystem } from '../src/index.js';

// ─── Fakes (use mock.calls to inspect args; recording impls are overridden by mockResolvedValue) ──

class FakeDecayService implements MemoryDecayService {
  applyDecay = vi.fn(async (agentId: string, currentSimTime: number): Promise<DecayResult> => {
    return { agentId, pruneCandidateIds: [], scores: [] };
  });
  pruneMemories = vi.fn(async (): Promise<number> => 0);
}

class FakeReflectionLoop implements ReflectionLoop {
  config: ReflectionConfig = defaultReflectionConfig;
  shouldReflect = vi.fn(
    async (_agentId: string, _currentSimTime: number, _isIdle: boolean): Promise<boolean> => false,
  );
  runReflection = vi.fn(async (agentId: string): Promise<ReflectionResult> => ({
    agentId,
    newMemories: [],
    consolidatedNodeIds: [],
  }));
  start = vi.fn();
  stop = vi.fn();
}

function makeProfile(id = 'a1'): AgentProfile {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

const TICK = (n: number, simTime = n): GameTick => ({
  tickNumber: n,
  simulationTime: simTime,
  deltaSeconds: 0.0167,
});

/** Flush pending microtasks so fire-and-forget `.then` callbacks run. */
async function flushMicrotasks(): Promise<void> {
  // Two rounds ensure nested `.then` chains (shouldReflect → runReflection) settle.
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

// ─── AC-40: exported & EngineSystem ──────────────────────────────────────────

describe('AC-40: MemoryMaintenanceSystem exported', () => {
  it('is importable and is an EngineSystem', () => {
    const sys: EngineSystem = new MemoryMaintenanceSystem({
      agentManager: new AgentManagerImpl(),
      memoryDecayService: new FakeDecayService(),
      reflectionLoop: new FakeReflectionLoop(),
      decayConfig: defaultMemoryDecayConfig,
    });
    expect(sys).toBeDefined();
    expect(typeof sys.update).toBe('function');
  });
});

// ─── AC-41: name ─────────────────────────────────────────────────────────────

describe('AC-41: name is "memory-maintenance"', () => {
  it('exposes the correct name', () => {
    const sys = new MemoryMaintenanceSystem({
      agentManager: new AgentManagerImpl(),
      memoryDecayService: new FakeDecayService(),
      reflectionLoop: new FakeReflectionLoop(),
      decayConfig: defaultMemoryDecayConfig,
    });
    expect(sys.name).toBe('memory-maintenance');
  });
});

// ─── AC-42: decay runs every decayIntervalTicks ──────────────────────────────

describe('AC-42: decay runs every decayIntervalTicks', () => {
  it('fires applyDecay only on interval ticks (fire-and-forget)', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('a1'));
    const decay = new FakeDecayService();
    const reflection = new FakeReflectionLoop();
    const config: MemoryDecayConfig = {
      decayRate: 0.001,
      pruneThreshold: 0.5,
      decayIntervalTicks: 10,
    };
    const sys = new MemoryMaintenanceSystem({
      agentManager: agents,
      memoryDecayService: decay,
      reflectionLoop: reflection,
      decayConfig: config,
    });

    // Drive 20 update calls. Decay fires when the internal tick counter
    // (count of update calls) is a multiple of 10 → calls 10 and 20.
    for (let i = 1; i <= 20; i++) sys.update(TICK(i, i));
    expect(decay.applyDecay).toHaveBeenCalledTimes(2);

    // First decay at the 10th call with simTime=10.
    const firstCall = decay.applyDecay.mock.calls[0]!;
    expect(firstCall[0]).toBe('a1');
    expect(firstCall[1]).toBe(10);

    // Ticks 1..9 produced no decay.
    // (Verified indirectly: exactly 2 calls across 20 ticks.)
  });
});

// ─── AC-43: reflection triggered via shouldReflect ───────────────────────────

describe('AC-43: update triggers reflection when shouldReflect is true', () => {
  it('calls runReflection (fire-and-forget) when shouldReflect returns true', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('a1'));
    const decay = new FakeDecayService();
    const reflection = new FakeReflectionLoop();
    reflection.shouldReflect.mockResolvedValue(true);
    const sys = new MemoryMaintenanceSystem({
      agentManager: agents,
      memoryDecayService: decay,
      reflectionLoop: reflection,
      decayConfig: defaultMemoryDecayConfig,
    });

    sys.update(TICK(1, 1));
    // shouldReflect is invoked synchronously; runReflection is scheduled in a
    // .then microtask (fire-and-forget) — flush the microtask queue.
    await flushMicrotasks();
    expect(reflection.shouldReflect).toHaveBeenCalledTimes(1);
    // isIdle = !isThinking = !false = true for a non-thinking agent.
    expect(reflection.shouldReflect.mock.calls[0]?.[0]).toBe('a1');
    expect(reflection.shouldReflect.mock.calls[0]?.[1]).toBe(1);
    expect(reflection.shouldReflect.mock.calls[0]?.[2]).toBe(true);
    expect(reflection.runReflection).toHaveBeenCalledWith('a1');
  });

  it('does NOT call runReflection when shouldReflect returns false', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('a1'));
    const decay = new FakeDecayService();
    const reflection = new FakeReflectionLoop();
    reflection.shouldReflect.mockResolvedValue(false);
    const sys = new MemoryMaintenanceSystem({
      agentManager: agents,
      memoryDecayService: decay,
      reflectionLoop: reflection,
      decayConfig: defaultMemoryDecayConfig,
    });

    sys.update(TICK(1, 1));
    await flushMicrotasks();
    expect(reflection.runReflection).not.toHaveBeenCalled();
  });

  it('passes isIdle = !agent.isThinking', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('a1'));
    agents.updateState('a1', { isThinking: true });
    const decay = new FakeDecayService();
    const reflection = new FakeReflectionLoop();
    reflection.shouldReflect.mockResolvedValue(false);
    const sys = new MemoryMaintenanceSystem({
      agentManager: agents,
      memoryDecayService: decay,
      reflectionLoop: reflection,
      decayConfig: defaultMemoryDecayConfig,
    });

    sys.update(TICK(1, 1));
    await flushMicrotasks();
    // isThinking=true → isIdle=false.
    expect(reflection.shouldReflect.mock.calls[0]?.[2]).toBe(false);
  });
});

// ─── AC-44: update never awaits ──────────────────────────────────────────────

describe('AC-44: update is synchronous and fire-and-forget', () => {
  it('returns synchronously even when async ops never resolve', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('a1'));
    const decay = new FakeDecayService();
    // applyDecay that never resolves.
    decay.applyDecay.mockReturnValue(new Promise<DecayResult>(() => {}));
    const reflection = new FakeReflectionLoop();
    reflection.shouldReflect.mockResolvedValue(true);
    reflection.runReflection.mockReturnValue(new Promise<ReflectionResult>(() => {}));
    const config: MemoryDecayConfig = {
      decayRate: 0.001,
      pruneThreshold: 0.5,
      decayIntervalTicks: 1, // fire every tick
    };
    const sys = new MemoryMaintenanceSystem({
      agentManager: agents,
      memoryDecayService: decay,
      reflectionLoop: reflection,
      decayConfig: config,
    });

    let returned = false;
    sys.update(TICK(1, 1));
    returned = true;
    expect(returned).toBe(true);
  });

  it('swallows errors from applyDecay and runReflection (logs, no throw)', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('a1'));
    const decay = new FakeDecayService();
    decay.applyDecay.mockRejectedValue(new Error('decay boom'));
    const reflection = new FakeReflectionLoop();
    reflection.shouldReflect.mockResolvedValue(true);
    reflection.runReflection.mockRejectedValue(new Error('reflect boom'));
    const config: MemoryDecayConfig = {
      decayRate: 0.001,
      pruneThreshold: 0.5,
      decayIntervalTicks: 1,
    };
    const sys = new MemoryMaintenanceSystem({
      agentManager: agents,
      memoryDecayService: decay,
      reflectionLoop: reflection,
      decayConfig: config,
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => sys.update(TICK(1, 1))).not.toThrow();
    errSpy.mockRestore();
  });
});

// ─── AC-45, AC-46: assembly integration ──────────────────────────────────────

function makeConfig(): EngineConfig {
  return { fps: 60, spatialDebounceSeconds: 5, maxConcurrentLLM: 8, guardrailsEnabled: true };
}

class FakeOrchestrator implements PPEROrchestratorPort {
  async runCycle(): Promise<void> {}
  getPhase(): PPERPhase {
    return 'perceive';
  }
}

describe('AC-45: assembleGameLoop registers MemoryMaintenanceSystem when decay service provided', () => {
  it('registers memory-maintenance after the scene-mutation system (spec 030)', () => {
    const core = createEngineCore(makeConfig());
    const decay = new FakeDecayService();
    const reflection = new FakeReflectionLoop();
    assembleGameLoop(core, new FakeOrchestrator(), {
      memoryDecayService: decay,
      reflectionLoop: reflection,
      decayConfig: defaultMemoryDecayConfig,
    });
    const names = core.gameLoop.systemNames();
    expect(names).toEqual([
      'scene-mutations',
      'spatial',
      'drive-decay',
      'object-state',
      'pper-scheduler',
      'memory-maintenance',
    ]);
  });
});

describe('AC-46: assembleGameLoop does NOT register memory-maintenance when no decay service', () => {
  it('keeps the deterministic systems (now 5 with scene-mutations, spec 030)', () => {
    const core = createEngineCore(makeConfig());
    assembleGameLoop(core, new FakeOrchestrator());
    const names = core.gameLoop.systemNames();
    expect(names).toEqual([
      'scene-mutations',
      'spatial',
      'drive-decay',
      'object-state',
      'pper-scheduler',
    ]);
  });
});

// ─── AC-51: package boundaries ───────────────────────────────────────────────

describe('AC-51: MemoryMaintenanceSystem imports from shared + memory, not cognition', () => {
  it('source does not import @evol-hive/cognition', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('src/systems/memory-maintenance.ts', 'utf-8');
    expect(source).not.toContain('@evol-hive/cognition');
  });
});
