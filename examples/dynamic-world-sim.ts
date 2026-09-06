/**
 * dynamic-world-sim.ts — Long-horizon validation with dynamic scene mutations
 * (spec 030, issue #117 follow-up; drive economy per spec 032, issue #125)
 * ──────────────────────────────────────────────────────────────────────────────
 * Runs the Dynamic World demo (garden ↔ workshop) with real LLM cognition for
 * an extended period while exercising every mutation type from spec 030:
 *
 *   t+60s   spawn_agent     — Gardener's Apprentice joins mid-run
 *   t+120s  move_object     — Toolbox carried garden → workshop
 *   t+180s  add_object      — Watering can appears in the garden
 *   t+240s  close gate      — connection closed; pathing blocked
 *   t+300s  open gate       — connection restored
 *   t+360s  despawn_agent   — Apprentice goes dormant (state → YAAM)
 *   t+420s  respawn agent   — Apprentice returns from dormancy (state restored)
 *
 * Drive economy (spec 032 — closed loops, no one-way slide):
 *   All five drives decay at 0.1/s (≈1.5 points per ~15s PPER cycle, spec 019).
 *   Restoration affordances balance the decay when used at a reasonable duty
 *   cycle. Decay AND restoration path for every drive (spec 034, Req 7):
 *   - energy:   garden-bench-1 `sit_outside` (+3) / `relax` (+5) in the garden;
 *               stool-1 `relax` (+5) in the workshop — every room restores
 *               energy, offsetting the workbench's energy-negative `work` (−4)
 *   - comfort:  bench `sit_outside` (+15) / `relax` (+20), stool `relax`
 *               (+20), water_plants (+5), harvest (+5), build_planter (+8)
 *   - curiosity: plant_seeds (+12), water_plants (+10), take_tool (+8),
 *               work (+6), build_planter (+20), harvest (+10),
 *               bench `sit_outside` (+5)
 *   - social:   restored ONLY through agent-to-agent cognitive tools —
 *               `talk_to` (own social +10) and `help` (target's primary drive
 *               + own social), both require a co-present agent. Solo-window
 *               bound: at most 6 points of social decay (0.1/s × 60s, from
 *               the default 100) before the Apprentice spawns at t+60s, so
 *               social never approaches 0 while the Gardener is alone.
 *   - hunger:   planter-1 `eat` (+25) — the plant → water → harvest → eat
 *               chain (spec 034, Req 6) closes the loop; hunger previously
 *               had NO restoration path and pinned at 0 in runs ≳ 16 min
 *
 * The visualizer serves the live canvas at http://localhost:3100/ so every
 * structural change is observable in the browser as it happens.
 *
 * Run (12 min, real LLM via local Ollama — gemma4 recommended):
 *   USE_REAL_LLM=true SCENE_DURATION_MS=720000 npx tsx examples/dynamic-world-sim.ts
 * Quick smoke (mock orchestrator, 10s):
 *   npx tsx examples/dynamic-world-sim.ts
 */

import type {
  AgentProfile,
  EngineConfig,
  PPEROrchestratorPort,
  PPERPhase,
  SmartObject,
} from '@evol-hive/shared';
import {
  createEngineCore,
  loadScene,
  assembleGameLoop,
  autoRegisterHandlers,
  clearHandlerPlugins,
  registerHandlerPlugin,
  createBuiltinPlugins,
  VisualizerDataAdapter,
} from '@evol-hive/engine';
import type { EngineCore } from '@evol-hive/engine';
import type { AffordanceHandler } from '@evol-hive/engine';
import { VisualizerServer } from '@evol-hive/visualizer';
import { assembleCognitionStack, assembleSystem1, buildMemorySubsystem } from './assembly.ts';
import {
  DYNAMIC_WORLD_SCENE,
  createCarryEffect,
  createGateHandlers,
  createDynamicWorldHandlers,
} from './dynamic-world.ts';

// ── Config ───────────────────────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: Number(process.env['ENGINE_MAX_CONCURRENT_LLM'] ?? '1'),
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

/** Minimal no-op orchestrator for mock mode (parity with visualizer-demo). */
class NoopOrchestrator implements PPEROrchestratorPort {
  async runCycle(): Promise<void> {}
  getPhase(): PPERPhase {
    return 'perceive';
  }
}

/** The apprentice profile, spawned mid-run (spec 030, Req 6). */
function apprenticeProfile(): AgentProfile {
  return {
    id: 'apprentice-1',
    name: 'Tomas Lind',
    description:
      'Apprentice gardener — a former furniture-maker who left the workshop bench to learn how things grow.',
    traits: ['curious', 'energetic'],
    backstory:
      'Tomas spent three years sanding chair legs before realizing he wanted to grow ' +
      'what he built with. He asked Maren for work until she said yes. He trusts his ' +
      'hands more than his words and learns by doing, not by asking twice.',
    longTermGoals: [
      'Grow something from seed to table entirely on his own',
      "Earn Maren's full trust",
    ],
    // Mid-level drives (spec 034/032 validation design — see dynamic-world.ts)
    initialDrives: { energy: 45, hunger: 40, social: 60, comfort: 50, curiosity: 60 },
    startRoomId: 'workshop',
  };
}

/** Schedule engine-driven mutations that exercise every spec-030 operation. */
function scheduleMutations(core: EngineCore, log: (msg: string) => void): NodeJS.Timeout[] {
  const service = core.mutationService;
  const timers: NodeJS.Timeout[] = [];
  const propose = (label: string, proposal: Parameters<typeof service.propose>[0]): void => {
    const r = service.propose(proposal);
    log(r.accepted ? `[mutation] ${label} accepted` : `[mutation] ${label} REJECTED: ${r.error}`);
  };

  at(60_000, 'spawn_agent(apprentice-1)', () =>
    propose('spawn_agent(apprentice-1)', {
      type: 'spawn_agent',
      payload: { profile: apprenticeProfile() },
      source: 'system',
    }),
  );
  at(120_000, 'move_object(toolbox-1 → workshop)', () =>
    propose('move_object(toolbox-1 → workshop)', {
      type: 'move_object',
      payload: { objectId: 'toolbox-1', toRoomId: 'workshop' },
      source: 'system',
    }),
  );
  at(180_000, 'add_object(watering-can-1 @ garden)', () => {
    const can: SmartObject = {
      id: 'watering-can-1',
      name: 'Watering Can',
      type: 'tool',
      state: { water_level: 10 },
      affordances: [
        {
          id: 'water_plants',
          label: 'Water the plants',
          engineEffect: 'water_plants',
          preconditions: [],
          effects: {},
        },
        {
          id: 'observe',
          label: 'Observe',
          engineEffect: 'observe',
          preconditions: [],
          effects: {},
        },
      ],
      roomId: 'garden',
    };
    propose('add_object(watering-can-1 @ garden)', {
      type: 'add_object',
      payload: { object: can },
      source: 'system',
    });
  });
  at(240_000, 'close gate (garden ↔ workshop)', () =>
    propose('set_connection_state(close)', {
      type: 'set_connection_state',
      payload: { roomA: 'garden', roomB: 'workshop', action: 'close' },
      source: 'system',
    }),
  );
  at(300_000, 'open gate (garden ↔ workshop)', () =>
    propose('set_connection_state(open)', {
      type: 'set_connection_state',
      payload: { roomA: 'garden', roomB: 'workshop', action: 'open' },
      source: 'system',
    }),
  );
  at(360_000, 'despawn_agent(apprentice-1)', () =>
    propose('despawn_agent(apprentice-1)', {
      type: 'despawn_agent',
      payload: { agentId: 'apprentice-1' },
      source: 'system',
    }),
  );
  at(420_000, 'respawn apprentice from dormancy', () =>
    propose('spawn_agent(dormant:apprentice-1)', {
      type: 'spawn_agent',
      payload: { dormantAgentId: 'apprentice-1' },
      source: 'system',
    }),
  );

  function at(ms: number, label: string, fn: () => void): void {
    timers.push(
      setTimeout(() => {
        try {
          fn();
        } catch (err) {
          log(`[mutation] ${label} THREW: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, ms),
    );
  }

  return timers;
}

// ── State logging ────────────────────────────────────────────────────────────

/**
 * Log one state sample per active agent (spec 030; amended by spec 034,
 * Req 8: all FIVE drives per sample — `h=` hunger and `co=` comfort alongside
 * energy, social, and curiosity — so equilibrium validation can observe
 * restoration bounces on every drive, not just three).
 */
export function logState(core: EngineCore, log: (msg: string) => void): void {
  for (const agent of core.agentManager.getActiveAgents()) {
    const state = core.agentManager.getState(agent.agentId);
    if (!state) continue;
    log(
      `[state] ${agent.agentId}: room=${state.location} ` +
        `e=${Math.round(state.drives.energy)} h=${Math.round(state.drives.hunger)} ` +
        `s=${Math.round(state.drives.social)} co=${Math.round(state.drives.comfort)} ` +
        `cu=${Math.round(state.drives.curiosity)} thinking=${state.isThinking}`,
    );
  }
  const mutations = core.mutationService.getMutations();
  if (mutations.length > 0) {
    const last = mutations[mutations.length - 1]!;
    log(`[mutations] total=${mutations.length} last=#${last.seq} ${last.type}@t${last.tick}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const useRealLLM = process.env['USE_REAL_LLM'] === 'true';
  const durationMs = Number(process.env['SCENE_DURATION_MS'] ?? (useRealLLM ? 720_000 : 10_000));
  const port = Number(process.env['VISUALIZER_PORT'] ?? '3100');
  const log = (msg: string): void => console.log(msg);

  const config = makeConfig();
  const memory = useRealLLM ? buildMemorySubsystem() : undefined;
  const core = createEngineCore(config, memory?.memoryStore, memory?.vectorStore);
  loadScene(core, DYNAMIC_WORLD_SCENE);

  // Handler registration: builtin plugins + carry/gate handlers (spec 030).
  clearHandlerPlugins();
  for (const plugin of createBuiltinPlugins()) {
    registerHandlerPlugin(plugin);
  }
  autoRegisterHandlers(core, DYNAMIC_WORLD_SCENE);
  for (const [effect, handler] of Object.entries(createDynamicWorldHandlers())) {
    core.affordanceRegistry.registerHandler(effect, handler);
  }
  // Diagnostic wrapper: every affordance execution is visible in the log —
  // this is how we verify the drive→affordance → execute → driveChanges loop
  // end-to-end in live runs.
  const logged =
    (effectId: string, handler: AffordanceHandler): AffordanceHandler =>
    async (objectId, agentId, state) => {
      const r = await handler(objectId, agentId, state);
      log(
        `[affordance] ${agentId} ${effectId} @ ${objectId} → ` +
          (r.success
            ? `ok${r.driveChanges ? ' drives=' + JSON.stringify(r.driveChanges) : ''}`
            : `FAILED: ${r.failureReason ?? '?'}`),
      );
      return r;
    };
  for (const [effect, handler] of Object.entries(createDynamicWorldHandlers())) {
    core.affordanceRegistry.registerHandler(effect, logged(effect, handler));
  }
  core.affordanceRegistry.registerHandler(
    'carry',
    logged('carry', createCarryEffect(core.mutationService)),
  );
  for (const [effect, handler] of Object.entries(createGateHandlers(core.mutationService))) {
    core.affordanceRegistry.registerHandler(effect, logged(effect, handler));
  }

  // Cognition stack (real LLM) or no-op orchestrator (mock), + game loop.
  let orchestrator: PPEROrchestratorPort;
  let tokenReporter:
    | { getTotalUsage(): { promptTokens: number; completionTokens: number; totalTokens: number } }
    | undefined;
  if (useRealLLM && memory !== undefined) {
    const stack = assembleCognitionStack(core, undefined, { memory });
    orchestrator = stack.orchestrator;

    // System 1 trainable heads (spec 035) — fail-open until an artifact
    // lands; session logs accumulate outcome samples for the first dream
    // update. Env-overridable like coffee-shop (grand-validation wiring,
    // issue #139 follow-up arc).
    const system1 = assembleSystem1(core, memory, {
      ...(process.env['SYSTEM1_GATE_ARTIFACT'] !== undefined
        ? { gateArtifactPath: process.env['SYSTEM1_GATE_ARTIFACT'] }
        : {}),
      ...(process.env['SYSTEM1_SESSION_LOG_DIR'] !== undefined
        ? { sessionLogDir: process.env['SYSTEM1_SESSION_LOG_DIR'] }
        : { sessionLogDir: 'session-logs' }),
    });

    assembleGameLoop(
      core,
      stack.orchestrator,
      stack.memoryDecayService !== undefined
        ? {
            memoryDecayService: stack.memoryDecayService,
            ...(stack.reflectionLoop !== undefined ? { reflectionLoop: stack.reflectionLoop } : {}),
            decayConfig: stack.decayConfig,
          }
        : undefined,
      undefined,
      undefined,
      {
        gate: system1.gate,
        outcomeRecorder: system1.outcomeRecorder,
        featureRefresher: system1.featureRefresher,
        ...(system1.identityTrigger !== undefined
          ? { identityTrigger: system1.identityTrigger }
          : {}),
      },
    );
    // Reporter is cumulative — read totals at END of run.
    tokenReporter = stack.tokenUsageReporter;
  } else {
    orchestrator = new NoopOrchestrator();
    assembleGameLoop(core, orchestrator);
  }

  // Visualizer: adapter + server (live structural rendering, spec 030 Req 15).
  const scenes = new Map([['dynamic-world', DYNAMIC_WORLD_SCENE]]);
  const agentProfiles = new Map<string, AgentProfile>();
  for (const agent of core.agentManager.getActiveAgents()) {
    const profile = core.agentManager.getProfile(agent.agentId);
    if (profile) agentProfiles.set(agent.agentId, profile);
  }
  const adapter = new VisualizerDataAdapter({
    gameLoop: core.gameLoop,
    agentManager: core.agentManager,
    smartObjectRegistry: core.smartObjectRegistry,
    sceneManager: core.sceneManager,
    orchestrator,
    agentProfiles,
    scenes,
    mutationService: core.mutationService,
  });
  const server = new VisualizerServer({ adapter, port, scenes });
  await server.start();
  log(`\n  🖥️  Dynamic World visualizer at http://localhost:${server.getPort()}/`);

  log(
    `Starting Dynamic World simulation (${Math.round(durationMs / 1000)}s, LLM=${useRealLLM ? 'real' : 'mock'})...`,
  );
  core.gameLoop.start();

  const mutationTimers = scheduleMutations(core, log);
  const stateTimer = setInterval(() => logState(core, log), 15_000);

  await new Promise((resolve) => setTimeout(resolve, durationMs));

  clearInterval(stateTimer);
  for (const t of mutationTimers) clearTimeout(t);
  core.gameLoop.stop();

  // ── Final report ──────────────────────────────────────────────────────────
  log('\n===== Final Report =====');
  logState(core, log);
  const mutations = core.mutationService.getMutations();
  log(`[mutations] ${mutations.length} applied: ${mutations.map((m) => m.type).join(', ')}`);
  log(`[dormant] ${core.dormantStore.size()} dormant agent(s)`);
  if (memory) {
    const all = await memory.vectorStore.exportAll();
    log(`[memory] ${all.length} memory node(s)`);
  }
  if (tokenReporter) {
    const total = tokenReporter.getTotalUsage();
    log(
      `[tokens] prompt=${total.promptTokens} completion=${total.completionTokens} total=${total.totalTokens}`,
    );
  }

  await server.stop();
  log('Done.');
}

const isMain = process.argv[1]?.endsWith('dynamic-world-sim.ts');
if (isMain) {
  main().catch((err) => {
    console.error('Dynamic World simulation failed:', err);
    process.exit(1);
  });
}
