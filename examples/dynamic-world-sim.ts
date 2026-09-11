/**
 * dynamic-world-sim.ts — Long-horizon validation with dynamic scene mutations
 * (spec 030, issue #117 follow-up; drive economy per spec 032, issue #125)
 * ──────────────────────────────────────────────────────────────────────────────
 * Runs the Dynamic World demo (garden ↔ workshop) with real LLM cognition for
 * an extended period while exercising every mutation type from spec 030:
 *
 *   t+60s   spawn_agent     — skipped: the Apprentice ships in the scene
 *                             since spec 052 (Req 4, issue #183) — he is
 *                             present from t=0 for the cc=3 decay divisor
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
 *               bound (historical): at most 6 points of social decay
 *               (0.1/s × 60s, from the default 100) before the Apprentice
 *               spawned at t+60s — since spec 052 (issue #183) apprentice-1
 *               ships in the scene (greenhouse) from t=0, the t+60s spawn is
 *               skipped and the cc=3 divisor counts 3 live agents from the
 *               first tick.
 *   - hunger:   planter-1 `eat` (+25) — the plant → water → harvest → eat
 *               chain (spec 034, Req 6) closes the loop; hunger previously
 *               had NO restoration path and pinned at 0 in runs ≳ 16 min
 *
 * cc=3 rebalance (spec 048 — issue #168): at ENGINE_MAX_CONCURRENT_LLM=3 the
 *   scheduler spreads cycles across agents, stretching each agent's effective
 *   cycle interval to 60–90s of sim time while ambient decay accrued per wall
 *   sim-second — per-interval decay 6–9 points vs a best +5 restoration made
 *   the economy structurally net-negative (every run ended all-zeros). Two
 *   fixes, both audit-backed (no hand-tuning):
 *   1. Per-agent decay scaling (Req 1): DriveDecaySystem applies an effective
 *      rate of decayRate / N per wall sim-second (N = live agents; no-op at
 *      N=1; ENGINE_DECAY_SCALING=none escapes). At cc=3 per-interval decay
 *      drops to ≈ decayRate/3 × interval = 0.1/3 × 90s ≈ 3 points (worst-case
 *      documented interval, issue evidence).
 *   2. Restoration audit (Req 2, examples/tests/spec-048-economy-audit.test.ts):
 *      for every drive, the largest declared restoring delta must exceed that
 *      per-interval decay — energy 5 > 3, hunger 25 > 3, comfort 20 > 3,
 *      curiosity 12 > 3, social 10 (talk_to, spec 018) > 3. Magnitudes move
 *      only where the audit fails (none do), protecting the #139 oscillation
 *      (Req 4 — restoration stays just above decay, never an order above).
 *   Hunger-chain surfacing (Req 3): planter-1 `plant_seeds`/`harvest` declare
 *   `progresses: { drive: 'hunger' }` so the spec-034 matcher surfaces the
 *   next chain step while hunger is urgent — the 2/3-seeds stall fix.
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
  SmartObject,
} from '@evol-hive/shared';
import { defaultDecayScaling } from '@evol-hive/shared';
import {
  loadScene,
  autoRegisterHandlers,
  clearHandlerPlugins,
  registerHandlerPlugin,
  createBuiltinPlugins,
  VisualizerDataAdapter,
} from '@evol-hive/engine';
import type { EngineCore } from '@evol-hive/engine';
import type { AffordanceHandler } from '@evol-hive/engine';
import { VisualizerServer } from '@evol-hive/visualizer';
import { assembleWorld } from '@evol-hive/assembly';
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
    // Spec 048, Req 1: per-agent decay scaling, surfaced from
    // ENGINE_DECAY_SCALING ('per-agent' default | 'none') exactly like
    // ENGINE_MAX_CONCURRENT_LLM above.
    decayScaling: defaultDecayScaling(),
  };
}

/** The apprentice profile — now sourced from the shipped scene (spec 052, Req 4).
 *
 * Tomas ships IN `DYNAMIC_WORLD_SCENE` (greenhouse-resident, the #183 run
 * population) instead of joining mid-run. This function returns the scene's
 * entry — the single source of truth for the persona the spec 049 seed-audit
 * test pins (issue #167): 'energetic' infers the 0.8 talkativeness seed.
 */
export function apprenticeProfile(): AgentProfile {
  const agent = DYNAMIC_WORLD_SCENE.agents.find((a) => a.id === 'apprentice-1');
  if (agent === undefined) {
    throw new Error('apprentice-1 must ship in DYNAMIC_WORLD_SCENE (spec 052, Req 4)');
  }
  return agent;
}

/** Schedule engine-driven mutations that exercise every spec-030 operation. */
function scheduleMutations(core: EngineCore, log: (msg: string) => void): NodeJS.Timeout[] {
  const service = core.mutationService;
  const timers: NodeJS.Timeout[] = [];
  const propose = (label: string, proposal: Parameters<typeof service.propose>[0]): void => {
    const r = service.propose(proposal);
    log(r.accepted ? `[mutation] ${label} accepted` : `[mutation] ${label} REJECTED: ${r.error}`);
  };

  // Spec 052 (Req 4 — issue #183): apprentice-1 ships in the scene from t=0
  // (the #183 run population — 3 live agents for the cc=3 decay divisor), so
  // the mid-run spawn proposal is skipped: the engine would reject it as a
  // duplicate agent id. The t+60s slot is kept as an explicit no-op so the
  // spec-030 mutation timeline stays recognizable in the logs; the
  // despawn/respawn cycle below still exercises dormancy.
  at(60_000, 'spawn_agent(apprentice-1)', () => {
    if (DYNAMIC_WORLD_SCENE.agents.some((a) => a.id === 'apprentice-1')) {
      log(
        '[mutation] spawn_agent(apprentice-1) skipped: ships in the scene (spec 052 Req 4)',
      );
      return;
    }
    propose('spawn_agent(apprentice-1)', {
      type: 'spawn_agent',
      payload: { profile: apprenticeProfile() },
      source: 'system',
    });
  });
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

  // One call, fully wired (spec 050): the promoted assembler owns ALL wiring —
  // engine core, cognition stack (real LLM when USE_REAL_LLM=true), memory
  // subsystem (R5), System 1 heads, and the game loop. Mock mode (no env, no
  // mock client) gets the no-op orchestrator parity: no cycles, no memory.
  // Scene data (scene load + handlers) stays caller-side via sceneSetup.
  const world = assembleWorld({
    config,
    ...(useRealLLM
      ? {
          system1: {
            // System 1 trainable heads (spec 035) — fail-open until an artifact
            // lands; session logs accumulate outcome samples for the first dream
            // update. Env-overridable like coffee-shop (grand-validation wiring,
            // issue #139 follow-up arc).
            ...(process.env['SYSTEM1_GATE_ARTIFACT'] !== undefined
              ? { gateArtifactPath: process.env['SYSTEM1_GATE_ARTIFACT'] }
              : {}),
            ...(process.env['SYSTEM1_SESSION_LOG_DIR'] !== undefined
              ? { sessionLogDir: process.env['SYSTEM1_SESSION_LOG_DIR'] }
              : { sessionLogDir: 'session-logs' }),
          },
        }
      : {}),
    sceneSetup: (core: EngineCore) => {
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
    },
  });

  const core = world.core;
  let orchestrator: PPEROrchestratorPort = world.orchestrator;
  // Reporter is cumulative — read totals at END of run (real-LLM runs only).
  const tokenReporter = world.stack?.tokenUsageReporter;
  const memory = world.memory;

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
    ...(core.navigation !== undefined ? { navigation: core.navigation } : {}),
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
