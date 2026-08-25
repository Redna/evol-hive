/**
 * Spec 019 — Wire SocialManager in Assembly & Example Scenes (issue #73)
 * ====================================================================
 * Tests that `createEngineCore()` constructs a `SocialManager`, wires it to
 * the `PerceptionDataProviderImpl`, and exposes it on `EngineCore` and
 * `AssembledEngine`. Also verifies that the example scenes expose
 * `socialManager` and that the morning-routine mock LLM is socially aware.
 *
 * Acceptance criteria covered: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6,
 * AC-10, AC-11, AC-14, AC-15, AC-16, AC-17, AC-18, AC-20, AC-21.
 *
 * AC-7, AC-8, AC-9, AC-12, AC-13 are wiring checks on the example scene
 * source (verified via source inspection tests below). AC-22..AC-24 require
 * a running LLM server and are documented as manual/integration verification.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type {
  EngineConfig,
  AgentProfile,
  PPEROrchestratorPort,
  PPERPhase,
} from '@evol-hive/shared';
import { createEngine, createEngineCore, loadScene } from '../src/assembly.js';
import { SocialManager } from '../src/social/social-manager.js';
import {
  MORNING_ROUTINE_SCENE,
  buildMorningRoutineEngine,
  MorningRoutineMockLLMClient,
} from '../../../examples/morning-routine.ts';
import { OFFICE_DAY_SCENE, buildOfficeDayEngine } from '../../../examples/office-day.ts';
import type { LLMContextPayload } from '@evol-hive/cognition';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
  };
}

function makeAgent(id: string): AgentProfile {
  return {
    id,
    name: id,
    description: 'test agent',
    traits: [],
    initialDrives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

class FakeOrchestrator implements PPEROrchestratorPort {
  async runCycle(_agentId: string): Promise<void> {}
  getPhase(_agentId: string): PPERPhase {
    return 'perceive';
  }
}

function makePayload(roomId: string, primaryDriveLabel: string): LLMContextPayload {
  return {
    perceptionContext: `Room: ${roomId}\nPrimary drive: low ${primaryDriveLabel}, value 15`,
  } as LLMContextPayload;
}

const examplesDir = join(process.cwd(), '..', '..', 'examples');

function readExample(name: string): string {
  return readFileSync(join(examplesDir, name), 'utf8');
}

// ── AC-1, AC-3, AC-15: createEngineCore returns SocialManager ───────────────

describe('Spec 019 — AC-1/AC-3/AC-15: createEngineCore creates SocialManager', () => {
  it('createEngineCore(config).socialManager is an instance of SocialManager (not undefined)', () => {
    const core = createEngineCore(makeConfig());
    expect(core.socialManager).toBeDefined();
    expect(core.socialManager).toBeInstanceOf(SocialManager);
  });
});

// ── AC-2, AC-16: PerceptionDataProviderImpl has SocialManager wired ─────────

describe('Spec 019 — AC-2/AC-16: perception provider wired to SocialManager', () => {
  it('getAgentsInRoom returns the other agent when two agents share a room', () => {
    const core = createEngineCore(makeConfig());
    core.agentManager.spawn(makeAgent('agent-a'));
    core.agentManager.spawn(makeAgent('agent-b'));
    core.agentManager.updateState('agent-a', { location: 'kitchen', lastPerceptionTick: 0 });
    core.agentManager.updateState('agent-b', { location: 'kitchen', lastPerceptionTick: 0 });

    const summaries = core.bridges.perception.getAgentsInRoom('kitchen', 'agent-a');
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.agentId).toBe('agent-b');
  });

  it('getAgentsInRoom returns empty when no other agents are present', () => {
    const core = createEngineCore(makeConfig());
    core.agentManager.spawn(makeAgent('agent-a'));
    core.agentManager.updateState('agent-a', { location: 'kitchen', lastPerceptionTick: 0 });

    const summaries = core.bridges.perception.getAgentsInRoom('kitchen', 'agent-a');
    expect(summaries).toEqual([]);
  });
});

// ── AC-4: EngineCore interface includes socialManager (type-level) ──────────

describe('Spec 019 — AC-4: EngineCore.socialManager is non-optional', () => {
  it('EngineCore type includes socialManager: SocialManager (compile-time + runtime check)', () => {
    const core = createEngineCore(makeConfig());
    // The field is present and non-undefined (non-optional).
    expect(core.socialManager).not.toBeUndefined();
  });
});

// ── AC-5, AC-17: createEngine returns socialManager ─────────────────────────

describe('Spec 019 — AC-5/AC-17: createEngine returns socialManager', () => {
  it('createEngine(config, orchestrator).socialManager is not undefined', () => {
    const engine = createEngine(makeConfig(), new FakeOrchestrator());
    expect(engine.socialManager).toBeDefined();
    expect(engine.socialManager).toBeInstanceOf(SocialManager);
  });
});

// ── AC-6: assembly.ts imports SocialManager ─────────────────────────────────

describe('Spec 019 — AC-6: assembly.ts imports SocialManager', () => {
  it('assembly.ts imports SocialManager from ./social/social-manager.js', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'assembly.ts'), 'utf8');
    expect(src).toContain('./social/social-manager.js');
    expect(src).toMatch(
      /import\s+\{[^}]*SocialManager[^}]*\}\s+from\s+['"]\.\/social\/social-manager\.js['"]/,
    );
  });
});

// ── AC-18: Integration — agents perceive each other after loadScene ─────────

describe('Spec 019 — AC-18: multi-agent scene perception after wiring', () => {
  it('after loadScene + moving two agents to the same room, getAgentsInRoom returns the other agent', () => {
    const core = createEngineCore(makeConfig());
    loadScene(core, MORNING_ROUTINE_SCENE);

    // Alice starts in bedroom, Bob in living_room. Move Alice to living_room.
    core.agentManager.updateState('agent-alice', {
      location: 'living_room',
      lastPerceptionTick: 0,
    });

    const summaries = core.bridges.perception.getAgentsInRoom('living_room', 'agent-alice');
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries.some((s) => s.agentId === 'agent-bob')).toBe(true);
  });
});

// ── AC-10: buildMorningRoutineEngine exposes socialManager ──────────────────

describe('Spec 019 — AC-10: morning-routine engine exposes socialManager', () => {
  it('buildMorningRoutineEngine().socialManager is not undefined', () => {
    const engine = buildMorningRoutineEngine();
    expect(engine.socialManager).toBeDefined();
  });
});

// ── AC-11: MorningRoutineMockLLMClient social awareness ─────────────────────

describe('Spec 019 — AC-11: MorningRoutineMockLLMClient social awareness', () => {
  it("returns 'observe' (not 'watch_tv') when drive=social and room=living_room", async () => {
    const llm = new MorningRoutineMockLLMClient();
    const plan = await llm.completePlan(
      makePayload('living_room', 'social, need to restore social'),
    );
    expect(plan.steps[0]!.targetAffordance).toBe('observe');
  });
});

// ── AC-14: buildOfficeDayEngine exposes socialManager ───────────────────────

describe('Spec 019 — AC-14: office-day engine exposes socialManager', () => {
  it('buildOfficeDayEngine().socialManager is not undefined', () => {
    const engine = buildOfficeDayEngine();
    expect(engine.socialManager).toBeDefined();
  });
});

// ── AC-7: minimal-scene.ts wires socialBridge when USE_REAL_LLM ─────────────

describe('Spec 019 — AC-7: minimal-scene wires socialBridge', () => {
  it('minimal-scene.ts passes socialBridge: core.socialManager to CognitiveToolExecutorImpl', () => {
    const src = readExample('minimal-scene.ts');
    expect(src).toContain('socialBridge');
    expect(src).toContain('core.socialManager');
  });
});

// ── AC-8, AC-9: morning-routine real-LLM mode ───────────────────────────────

describe('Spec 019 — AC-8/AC-9: morning-routine real-LLM mode', () => {
  it('morning-routine.ts imports OpenAICompatibleLLMClient and CognitiveToolExecutorImpl', () => {
    const src = readExample('morning-routine.ts');
    expect(src).toMatch(/OpenAICompatibleLLMClient/);
    expect(src).toMatch(/CognitiveToolExecutorImpl/);
  });

  it('morning-routine.ts checks USE_REAL_LLM and wires socialBridge: core.socialManager', () => {
    const src = readExample('morning-routine.ts');
    expect(src).toContain('USE_REAL_LLM');
    expect(src).toContain('socialBridge');
    expect(src).toContain('core.socialManager');
  });

  it('morning-routine.ts still uses MorningRoutineMockLLMClient as fallback', () => {
    const src = readExample('morning-routine.ts');
    expect(src).toContain('MorningRoutineMockLLMClient');
  });
});

// ── AC-12, AC-13: office-day real-LLM mode ──────────────────────────────────

describe('Spec 019 — AC-12/AC-13: office-day real-LLM mode', () => {
  it('office-day.ts imports OpenAICompatibleLLMClient and CognitiveToolExecutorImpl', () => {
    const src = readExample('office-day.ts');
    expect(src).toMatch(/OpenAICompatibleLLMClient/);
    expect(src).toMatch(/CognitiveToolExecutorImpl/);
  });

  it('office-day.ts checks USE_REAL_LLM and wires socialBridge: core.socialManager', () => {
    const src = readExample('office-day.ts');
    expect(src).toContain('USE_REAL_LLM');
    expect(src).toContain('socialBridge');
    expect(src).toContain('core.socialManager');
  });

  it('office-day.ts still uses OfficeDayMockLLMClient as fallback', () => {
    const src = readExample('office-day.ts');
    expect(src).toContain('OfficeDayMockLLMClient');
  });
});

// ── AC-20, AC-21: Backward compatibility ────────────────────────────────────

describe('Spec 019 — AC-20/AC-21: backward compatibility', () => {
  it('existing createEngineCore callers (not referencing socialManager) still work', () => {
    const core = createEngineCore(makeConfig());
    // Destructure without socialManager — must compile and work.
    const { agentManager, bridges, gameLoop } = core;
    expect(agentManager).toBeDefined();
    expect(bridges.perception).toBeDefined();
    expect(gameLoop).toBeDefined();
  });

  it('existing createEngine callers (not referencing socialManager) still work', () => {
    const engine = createEngine(makeConfig(), new FakeOrchestrator());
    const { agentManager, sceneManager, gameLoop } = engine;
    expect(agentManager).toBeDefined();
    expect(sceneManager).toBeDefined();
    expect(gameLoop).toBeDefined();
  });
});
