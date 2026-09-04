/**
 * Tests for the engine assembly factory (createEngine / createEngineCore / assembleGameLoop).
 * Covers AC-11.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  EngineConfig,
  PPEROrchestratorPort,
  PPERPhase,
  AgentProfile,
} from '@evol-hive/shared';
import { createEngine, createEngineCore, assembleGameLoop } from '../src/assembly.js';
import type { EngineSystem } from '../src/index.js';

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
  };
}

function makeProfile(): AgentProfile {
  return {
    id: 'a1',
    name: 'a1',
    description: 'test',
    traits: [],
    initialDrives: { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

/** A fake orchestrator that records calls. */
class FakeOrchestrator implements PPEROrchestratorPort {
  calls: string[] = [];
  async runCycle(agentId: string): Promise<void> {
    this.calls.push(agentId);
  }
  getPhase(_agentId: string): PPERPhase {
    return 'perceive';
  }
}

describe('Engine assembly factory (AC-11)', () => {
  it('createEngine wires all subsystems and registers systems in order: SpatialSystem → DriveDecaySystem → ObjectStateSystem → PPERScheduler', () => {
    const config = makeConfig();
    const orch = new FakeOrchestrator();
    const engine = createEngine(config, orch);

    // Inspect the registered systems order via the game loop.
    const names = engine.gameLoop.systemNames();
    expect(names).toEqual([
      'scene-mutations',
      'spatial',
      'drive-decay',
      'object-state',
      'pper-scheduler',
    ]);
  });

  it('createEngine exposes agentManager, sceneManager, and bridges', () => {
    const orch = new FakeOrchestrator();
    const engine = createEngine(makeConfig(), orch);
    expect(engine.agentManager).toBeDefined();
    expect(engine.sceneManager).toBeDefined();
    expect(engine.bridges.perception).toBeDefined();
    expect(engine.bridges.plan).toBeDefined();
    expect(engine.bridges.execute).toBeDefined();
    expect(engine.bridges.reflect).toBeDefined();
  });

  it('GameLoopImpl.start() on the assembled engine runs all systems', () => {
    vi.useFakeTimers();
    const orch = new FakeOrchestrator();
    const engine = createEngine(makeConfig(), orch);
    engine.agentManager.spawn(makeProfile());
    engine.agentManager.updateState('a1', { location: 'kitchen' });

    engine.gameLoop.start();
    vi.advanceTimersByTime(50);
    engine.gameLoop.stop();

    // The PPERScheduler should have invoked the orchestrator at least once.
    expect(orch.calls.length).toBeGreaterThan(0);
  });

  it('createEngineCore builds subsystems + bridges; assembleGameLoop registers systems in order', () => {
    const core = createEngineCore(makeConfig());
    expect(core.agentManager).toBeDefined();
    expect(core.sceneManager).toBeDefined();
    expect(core.spatial).toBeDefined();
    expect(core.bridges.perception).toBeDefined();

    const orch = new FakeOrchestrator();
    const loop = assembleGameLoop(core, orch);
    expect(loop.systemNames()).toEqual([
      'scene-mutations',
      'spatial',
      'drive-decay',
      'object-state',
      'pper-scheduler',
    ]);
  });
});
