/**
 * Spec 052 — Greenhouse restoration loop: REAL-SCENE Integration/E2E — the
 * deterministic proxy for the live-run acceptance instruments (AC-5/AC-6/AC-7
 * of `docs/specs/052-greenhouse-drive-restoration-diagnostics.md`, issue #183).
 *
 * The unit suites pin each mechanism in isolation (cognition spec-052 tests:
 * pruning exemption, wait guard, `[drive-hint]` diagnostic; examples
 * spec-052-greenhouse-scene: the reconciled scene) — none exercises them
 * THROUGH the production stack over the REAL scene. This suite closes that
 * gap (the spec-048-chain-hints-e2e pattern, extended from perceive→render to
 * the full perceive→plan→execute→reflect loop):
 *
 * - REAL `DYNAMIC_WORLD_SCENE` (spec 052 Req 4: 3 agents, Tomas & Iris
 *   greenhouse-resident) loaded into a REAL engine core, wired exactly like
 *   `dynamic-world-sim.ts` (builtin plugins + scene handlers);
 * - REAL System-0 classifier (`AffordanceClassifierImpl` over the production
 *   deterministic `MockEmbeddingProvider` — the `USE_REAL_EMBEDDINGS=off`
 *   branch of the assembler) so the Req-2 restoration exemption runs for real;
 * - REAL `GuardrailEngineImpl` (spec 052 Req 3: `waitSuppression` defaults on)
 *   so the wait guard runs inside the REAL `PlanServiceImpl`;
 * - REAL execute path over the REAL seed-shelf/potting-table handlers (the
 *   spec-052 live-run finding: the greenhouse restorers were handlerless);
 * - REAL fog gate reproducing the #183 live-run condition: iris-1 reached the
 *   greenhouse through the `go_to_*` teleport path, so her spatial memory
 *   NEVER recorded the visit — the spec-052 occupied-room override (engine)
 *   must surface the room anyway (`inRoom>0`), or every later assertion fails.
 *
 * A scripted LLM client replays the two-cycle #183 failure→recovery arc:
 * cycle 1 the LLM submits an all-`wait` plan while hunger is critical (8) and
 * `eat_herbs` sits in the post-prune enum → the guard rejects it before
 * `storePlan`; cycle 2 the LLM plans the restorer → stored, executed, hunger
 * +20. No greenhouse drive ends at 0 (the AC-5 headline, deterministically),
 * and the `[drive-hint]` lines distinguish "guard fired" (chosen=[none])
 * from "hint rendered, LLM chose the restorer" (AC-6's assertable trichotomy).
 *
 * No LLM anywhere (the scripted client is local); the live 30-min cc=3 run
 * remains the AC-5/6/7 acceptance instrument — this suite is its mechanical
 * rehearsal, green in CI on every commit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createEngineCore,
  loadScene,
  autoRegisterHandlers,
  clearHandlerPlugins,
  registerHandlerPlugin,
  createBuiltinPlugins,
} from '@evol-hive/engine';
import type { EngineCore } from '@evol-hive/engine';
import {
  PPEROrchestratorImpl,
  AffordanceClassifierImpl,
  GuardrailEngineImpl,
  defaultClassifierConfig,
} from '@evol-hive/cognition';
import type { LLMClient } from '@evol-hive/cognition';
import { MockEmbeddingProvider, buildMemorySubsystem } from '@evol-hive/assembly';
import { defaultGuardrailConfig } from '@evol-hive/shared';
import type {
  FormulatePlanResult,
  LLMActionResponse,
  ReflectLLMResponse,
  ReflectionResult,
} from '@evol-hive/shared';
import { DYNAMIC_WORLD_SCENE, createDynamicWorldHandlers } from '../dynamic-world.ts';

// ── Helpers (the spec-032/048 production wiring) ─────────────────────────────

const IRIS = 'iris-1';

/** The sim's engine config (deterministic — no env coupling in tests). */
function makeConfig(): import('@evol-hive/shared').EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

/** Wire a core exactly like dynamic-world-sim.ts does, with the memory subsystem. */
function wireStackedCore(): EngineCore {
  const memory = buildMemorySubsystem();
  const core = createEngineCore(makeConfig(), memory.memoryStore, memory.vectorStore);
  loadScene(core, DYNAMIC_WORLD_SCENE);
  clearHandlerPlugins();
  for (const plugin of createBuiltinPlugins()) {
    registerHandlerPlugin(plugin);
  }
  autoRegisterHandlers(core, DYNAMIC_WORLD_SCENE);
  for (const [effect, handler] of Object.entries(createDynamicWorldHandlers())) {
    core.affordanceRegistry.registerHandler(effect, handler);
  }
  return core;
}

/**
 * Put iris-1 in the #183 live-run condition: hunger CRITICAL (8 < 10 — the
 * wait guard's threshold), energy urgent (35 < 40), and an EMPTY spatial
 * memory — she reached the greenhouse via the `go_to_*` teleport path, which
 * moves the agent without recording the fog visit. The spec-052 occupied-room
 * override must keep the room perceivable (`inRoom=7`) anyway.
 */
function makeCriticalIris(core: EngineCore): void {
  const state = core.agentManager.getState(IRIS)!;
  core.agentManager.updateState(IRIS, {
    drives: { ...state.drives, energy: 35, hunger: 8, social: 55, comfort: 50, curiosity: 55 },
    spatialMemory: { visitedRooms: [], knownDoors: [], discoveredAt: {} },
  });
}

/**
 * The REAL System-0 classifier over the production deterministic embedder —
 * the `USE_REAL_EMBEDDINGS=off` assembly branch, minus the pass-through
 * classifier stub (spec 052 Req 2 needs the REAL pruning funnel).
 */
function makeRealClassifier(): AffordanceClassifierImpl {
  return new AffordanceClassifierImpl(new MockEmbeddingProvider(), defaultClassifierConfig());
}

/** Scripted LLM: plans are served in order; reflect/structured responses canned. */
class ScriptedPlanLLM implements LLMClient {
  private readonly queue: FormulatePlanResult[];
  constructor(...plans: FormulatePlanResult[]) {
    this.queue = [...plans];
  }
  async completeStructured(): Promise<LLMActionResponse> {
    return { reasoning: 'scripted', action: 'idle' };
  }
  async completeReflection(): Promise<ReflectionResult> {
    return { agentId: IRIS, newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(): Promise<FormulatePlanResult> {
    const next = this.queue.shift();
    if (next === undefined) throw new Error('ScriptedPlanLLM script exhausted');
    return next;
  }
  async completeReflect(): Promise<ReflectLLMResponse> {
    return { memoryEntry: { content: 'scripted reflection', importance: 5, type: 'action' } };
  }
}

const ALL_WAIT_PLAN: FormulatePlanResult = {
  description: 'Wait for something to happen',
  steps: [
    { description: 'Wait a while', targetAffordance: 'wait' },
    { description: 'Wait some more', targetAffordance: 'wait' },
  ],
};

const EAT_HERBS_PLAN: FormulatePlanResult = {
  description: 'Eat a fresh herb to restore hunger',
  steps: [{ description: 'Eat a fresh herb from the seed shelf', targetAffordance: 'eat_herbs' }],
};

const REST_SEEDLINGS_PLAN: FormulatePlanResult = {
  description: 'Rest among the seedlings to restore energy',
  steps: [{ description: 'Rest among the seedlings', targetAffordance: 'rest_among_seedlings' }],
};

function makeOrchestrator(
  core: EngineCore,
  llm: LLMClient,
  guardrail = new GuardrailEngineImpl(defaultGuardrailConfig()),
): PPEROrchestratorImpl {
  return new PPEROrchestratorImpl({
    perceptionProvider: core.bridges.perception,
    planProvider: core.bridges.plan,
    executeProvider: core.bridges.execute,
    reflectProvider: core.bridges.reflect,
    // The REAL classifier — the assembly's mock-embedding branch (deterministic:
    // every label embeds parallel, so pruning reduces to the topK/exemption
    // budget over the REAL scene declarations).
    classifier: makeRealClassifier(),
    llmClient: llm,
    guardrail,
  });
}

function consoleLines(spy: ReturnType<typeof vi.spyOn>, marker: string): string[] {
  return spy.mock.calls.map((args) => args.map(String).join(' ')).filter((l) => l.includes(marker));
}

beforeEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  delete process.env['SCENE_DURATION_MS'];
  delete process.env['ENGINE_GUARDRAILS_WAIT_SUPPRESSION'];
  delete process.env['DRIVE_CRITICAL_THRESHOLD'];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env['USE_REAL_LLM'];
  delete process.env['USE_REAL_EMBEDDINGS'];
  delete process.env['SCENE_DURATION_MS'];
  delete process.env['ENGINE_GUARDRAILS_WAIT_SUPPRESSION'];
  delete process.env['DRIVE_CRITICAL_THRESHOLD'];
  vi.restoreAllMocks();
});

// ── The two-cycle failure→recovery arc (AC-5/6/7 deterministic proxy) ────────

describe('spec 052 E2E — greenhouse failure→recovery arc over the production stack', () => {
  it('cycle 1: the guard rejects an all-wait plan before storePlan; cycle 2: the restorer is planned, executed, and hunger is restored', async () => {
    const core = wireStackedCore();
    makeCriticalIris(core);

    const orch = makeOrchestrator(core, new ScriptedPlanLLM(ALL_WAIT_PLAN, EAT_HERBS_PLAN));

    // ── Cycle 1: all-wait plan under a critical, directly-restorable drive ──
    await orch.runCycle(IRIS);

    // The wait guard fired through the REAL PlanServiceImpl with the REAL
    // enum: the reason names the drive AND the restorer (AC-2's actionable
    // reason, end-to-end).
    const guardLines = consoleLines(vi.mocked(console.error), '[wait-guard]');
    expect(guardLines).toHaveLength(1);
    expect(guardLines[0]).toContain('agent=iris-1');
    expect(guardLines[0]).toContain('critical drive hunger');
    expect(guardLines[0]).toContain('eat_herbs');
    expect(guardLines[0]).toContain('plan a restoring step');
    // The plan never reached the provider (guard fires before storePlan).
    expect(core.agentManager.getState(IRIS)!.currentPlan).toBeNull();

    // AC-6 machinery over the REAL scene: exactly one [drive-hint] line, and
    // the failed plan renders chosen=[none] — "hint rendered, LLM chose wait
    // (guard fired)" is assertable from the line alone.
    const hints = consoleLines(vi.mocked(console.log), '[drive-hint]');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('agent=iris-1 room=greenhouse');
    // The fog-override dependency: iris-1's fog is EMPTY, yet the occupied
    // room surfaces 7 affordances (the #183 empty-perception symptom is gone).
    expect(hints[0]).toContain('inRoom=7');
    // The Req-2 exemption through the REAL classifier: 3 topK slots + the 2
    // urgent restorers (go_to_garden is fogged — no known doors) survive.
    expect(hints[0]).toContain('afterPrune=5');
    // Planless + masking on → the mask stage empties the perception enum, but
    // the plan-side hint still rendered (the plan builder sees the pruned set).
    expect(hints[0]).toContain('afterMask=0');
    expect(hints[0]).toMatch(/energy=35\|hint=true\|prunedAway=\[\]/);
    expect(hints[0]).toMatch(/hunger=8\|hint=true\|prunedAway=\[\]/);
    expect(hints[0]).toContain('chosen=[none]');

    // ── Cycle 2: the LLM plans the restorer → stored, executed, restored ────
    await orch.runCycle(IRIS);

    // Exactly one [drive-hint] line per cycle; the second cycle's line carries
    // the choice side: "hint rendered, LLM chose eat_herbs" (AC-6).
    const hints2 = consoleLines(vi.mocked(console.log), '[drive-hint]');
    expect(hints2).toHaveLength(2);
    expect(hints2[1]).toContain('chosen=[eat_herbs]');
    // The plan executed through the REAL handler: hunger 8 + 20 = 28.
    const drives = core.agentManager.getState(IRIS)!.drives;
    expect(drives.hunger).toBe(28);

    // AC-5 proxy (deterministic): no greenhouse drive bottomed out — the
    // restoration loop closed instead of sliding to zero.
    for (const value of Object.values(drives)) {
      expect(value).toBeGreaterThan(0);
    }
    // The executed plan completed and cleared (reflect phase, spec 003/004).
    expect(core.agentManager.getState(IRIS)!.currentPlan).toBeNull();
  });

  it('an all-wait plan IS stored when waitSuppression is false (the guard is inert end-to-end)', async () => {
    const core = wireStackedCore();
    makeCriticalIris(core);

    const guardrail = new GuardrailEngineImpl({
      ...defaultGuardrailConfig(),
      waitSuppression: false,
    });
    const orch = makeOrchestrator(
      core,
      new ScriptedPlanLLM(ALL_WAIT_PLAN, ALL_WAIT_PLAN),
      guardrail,
    );

    await orch.runCycle(IRIS);

    expect(consoleLines(vi.mocked(console.error), '[wait-guard]')).toHaveLength(0);
    // The plan stored and executed (both wait steps) — the explicit false
    // disables the guard through the REAL config plumbing (AC-2 inert path).
    expect(core.agentManager.getState(IRIS)!.drives.hunger).toBe(8); // wait restores nothing
  });

  it('the greenhouse ENERGY restorer closes the energy loop through the full stack (QA handler-gap pin)', async () => {
    const core = wireStackedCore();
    makeCriticalIris(core);

    // rest_among_seedlings (comfort +15, energy +4) — the potting-table's
    // declared restorer, handlerless until the spec-052 live-run finding.
    const orch = makeOrchestrator(core, new ScriptedPlanLLM(REST_SEEDLINGS_PLAN));

    await orch.runCycle(IRIS);

    const drives = core.agentManager.getState(IRIS)!.drives;
    expect(drives.energy).toBe(39); // 35 + 4
    expect(drives.comfort).toBe(65); // 50 + 15
  });
});
