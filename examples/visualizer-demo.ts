/**
 * examples/visualizer-demo.ts — Browser-based visualizer demo (spec 023, Req 18 / AC-13)
 * ────────────────────────────────────────────────────────────────────────────
 * Builds an engine core + PPER orchestrator, wraps it in a
 * `VisualizerDataAdapter`, starts a `VisualizerServer`, and serves the canvas
 * renderer at `http://localhost:<port>/`.
 *
 * Spec 027 (issue #106): when `USE_REAL_LLM=true`, the demo builds a real
 * `PPEROrchestrator` via the shared `assembleCognitionStack()` helper (the
 * same wiring `buildCoffeeShopEngine()` uses — one source of truth for
 * LLM/guardrail/tool-executor assembly), loads the coffee-shop scene from
 * `coffee-shop.scene.yaml` (the same YAML the headless CLI runs), registers
 * affordance handlers via the spec-022 plugin path, and performs a startup LLM
 * health check. Agents then execute full perceive→plan→execute→reflect cycles
 * on canvas: navigating rooms, brewing coffee, and updating drives live.
 *
 * Default (no env vars) behavior is unchanged: no-op `MockOrchestrator`,
 * zero network calls, static-agent scene with decaying drive bars.
 *
 * Run with: `npx tsx examples/visualizer-demo.ts`
 * Real-LLM run (requires a local OpenAI-compatible backend, e.g. Ollama):
 *   `USE_REAL_LLM=true npx tsx examples/visualizer-demo.ts`
 * Then open the logged URL in a browser to see the live visualization.
 */

import { fileURLToPath } from 'node:url';
import * as net from 'node:net';
import type {
  SceneDefinition,
  EngineConfig,
  PPEROrchestratorPort,
  PPERPhase,
  AffordanceResult,
  Room,
  SmartObject,
  Affordance,
  AgentProfile,
} from '@evol-hive/shared';
import {
  createEngineCore,
  assembleGameLoop,
  loadScene,
  loadSceneFile,
  clearHandlerPlugins,
  createBuiltinPlugins,
  registerHandlerPlugin,
  autoRegisterHandlers,
  VisualizerDataAdapter,
} from '@evol-hive/engine';
import type { EngineCore } from '@evol-hive/engine';
import type { LLMClient } from '@evol-hive/cognition';
import type { GuardrailEngineImpl } from '@evol-hive/cognition';
import { assembleCognitionStack, buildMemorySubsystem } from './assembly.js';
import { VisualizerServer } from '@evol-hive/visualizer';

// ── Built-in scenes ──────────────────────────────────────────────────────────
// The minimal and morning-routine scenes are defined inline so this demo does
// not depend on the (typecheck-excluded) example entry points; they are
// demo-only scenes with no validation counterpart (spec 027, Req 6). The
// coffee-shop scene is loaded from `coffee-shop.scene.yaml` via `loadSceneFile`
// — the same declarative file the headless CLI (`run-scene`/`validate-scene`)
// consumes — so what the visualizer renders is byte-for-byte the scene that
// headless validation runs (spec 027, Req 5).

const brewCoffee: Affordance = {
  id: 'brew_coffee',
  label: 'Brew coffee',
  engineEffect: 'brew_coffee',
  preconditions: [],
  effects: { energy: 20 },
};

const coffeeMachine: SmartObject = {
  id: 'coffee-1',
  name: 'Coffee Machine',
  type: 'appliance',
  state: { water_level: 5, bean_count: 12 },
  affordances: [brewCoffee],
  roomId: 'kitchen',
};

const kitchen: Room = {
  id: 'kitchen',
  name: 'Kitchen',
  description: 'A small kitchen with a coffee machine.',
  connections: [],
  objectIds: ['coffee-1'],
};

const alice: AgentProfile = {
  id: 'agent-1',
  name: 'Alice',
  description: 'A sleepy agent who needs coffee.',
  traits: ['diligent', 'caffeine-dependent'],
  initialDrives: { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
};

const MINIMAL_SCENE: SceneDefinition = {
  id: 'minimal',
  name: 'Minimal Scene',
  rooms: [kitchen],
  objects: [coffeeMachine],
  agents: [alice],
};

const bedroom: Room = {
  id: 'bedroom',
  name: 'Bedroom',
  description: 'A cozy bedroom.',
  connections: ['kitchen'],
  objectIds: [],
};

const bed: SmartObject = {
  id: 'bed-1',
  name: 'Bed',
  type: 'furniture',
  state: { made: false },
  affordances: [
    {
      id: 'sleep',
      label: 'Sleep',
      engineEffect: 'sleep',
      preconditions: [],
      effects: { energy: 40 },
    },
  ],
  roomId: 'bedroom',
};

const bob: AgentProfile = {
  id: 'agent-2',
  name: 'Bob',
  description: 'An agent with a morning routine.',
  traits: ['methodical'],
  initialDrives: { energy: 30, hunger: 60, social: 70, comfort: 40, curiosity: 50 },
  startRoomId: 'bedroom',
};

const MORNING_ROUTINE_SCENE: SceneDefinition = {
  id: 'morning-routine',
  name: 'Morning Routine',
  rooms: [{ ...kitchen, connections: ['bedroom'] }, bedroom],
  objects: [coffeeMachine, bed],
  agents: [bob],
};

/** Path to the declarative coffee-shop scene (resolvable from any cwd). */
export const COFFEE_SHOP_YAML_FILE = fileURLToPath(
  new URL('./coffee-shop.scene.yaml', import.meta.url),
);

/**
 * Build the demo scene map: `minimal` and `morning-routine` (inline demo-only
 * scenes) plus `coffee-shop`, loaded from the YAML file shared with the CLI
 * (spec 027, Req 5/6).
 */
export async function buildSceneMap(): Promise<Map<string, SceneDefinition>> {
  const scenes = new Map<string, SceneDefinition>();
  scenes.set('minimal', MINIMAL_SCENE);
  scenes.set('morning-routine', MORNING_ROUTINE_SCENE);
  scenes.set('coffee-shop', await loadSceneFile(COFFEE_SHOP_YAML_FILE));
  return scenes;
}

// ── Config ───────────────────────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
    driveDecayRate: 0.1,
  };
}

// ── Mock PPER orchestrator ────────────────────────────────────────────────────
// For the visualizer demo in mock mode we do not need LLM-driven cognition —
// the renderer only displays state. A lightweight mock orchestrator reports
// the 'perceive' phase for every agent and never runs cycles (spec 027:
// the mock demo stays deterministic — no simulated cycles).

export class MockOrchestrator implements PPEROrchestratorPort {
  async runCycle(_agentId: string): Promise<void> {
    // No-op — the visualizer does not require PPER cycles to run.
  }
  getPhase(_agentId: string): PPERPhase {
    return 'perceive';
  }
}

// ── LLM backend health check (spec 027, Req 9) ───────────────────────────────

export interface LLMHealthCheckOptions {
  /** Base URL to probe. Defaults to `LLM_BASE_URL` or the Ollama default. */
  baseUrl?: string;
  /** Model name for error messages. Defaults to `LLM_MODEL` or `llama3.1`. */
  model?: string;
  /** TCP connect timeout in ms. Default: 3000. */
  timeoutMs?: number;
}

/** Default LLM backend — identical convention to coffee-shop.ts (spec 019). */
const DEFAULT_LLM_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_LLM_MODEL = 'llama3.1';

/**
 * Verify the LLM backend is reachable (TCP connect to the `LLM_BASE_URL`
 * host/port). Throws an error naming the backend URL and model when the
 * backend is unreachable, converting the issue's silent-failure mode ("agents
 * never act") into a loud one. No-op cost in mock mode — never called there.
 */
export async function checkLLMHealth(opts: LLMHealthCheckOptions = {}): Promise<void> {
  const baseUrl = opts.baseUrl ?? process.env['LLM_BASE_URL'] ?? DEFAULT_LLM_BASE_URL;
  const model = opts.model ?? process.env['LLM_MODEL'] ?? DEFAULT_LLM_MODEL;
  const timeoutMs = opts.timeoutMs ?? 3000;

  const parsed = new URL(baseUrl);
  const port = parsed.port !== '' ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;

  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: parsed.hostname, port });
    const fail = (err: Error): void => {
      socket.destroy();
      reject(
        new Error(
          `LLM backend unreachable at ${baseUrl} (model: ${model}): ${err.message}. ` +
            `Start the backend (e.g. Ollama) or unset USE_REAL_LLM.`,
        ),
      );
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      socket.removeAllListeners('timeout');
      // Ignore late socket errors after a successful probe.
      socket.on('error', () => {});
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      fail(new Error(`connection timed out after ${timeoutMs}ms`));
    });
    socket.once('error', fail);
  });
}

// ── Affordance handler registration (minimal, mock mode) ─────────────────────

function registerHandlers(core: EngineCore): void {
  core.affordanceRegistry.registerHandler('brew_coffee', async (_id, _agent, state) => {
    const newState = { ...state, water_level: ((state['water_level'] as number) ?? 0) - 1 };
    const result: AffordanceResult = { success: true, newState, driveChanges: { energy: 20 } };
    return result;
  });
  core.affordanceRegistry.registerHandler('sleep', async (_id, _agent, state) => {
    return { success: true, newState: { ...state, made: true }, driveChanges: { energy: 40 } };
  });
}

// ── Public API (used by the smoke test + entry point) ────────────────────────

export interface VisualizerDemoHandle {
  server: VisualizerServer;
  adapter: VisualizerDataAdapter;
  core: EngineCore;
  port: number;
  stop: () => Promise<void>;
  /** The orchestrator driving PPER cycles — real in `USE_REAL_LLM=true` mode. */
  orchestrator: PPEROrchestratorPort;
  /** LLM client backing the orchestrator (real mode only; undefined in mock mode). */
  llmClient?: LLMClient;
  /** Guardrail engine (real mode only; undefined in mock mode). */
  guardrail?: GuardrailEngineImpl;
  /** All scenes available in the demo (minimal, morning-routine, coffee-shop). */
  scenes: Map<string, SceneDefinition>;
}

/** Options for {@link startVisualizerDemo}. */
export interface StartVisualizerDemoOptions {
  port?: number;
  /** Scene id to load. Defaults to `coffee-shop` in real-LLM mode, `minimal` otherwise. */
  scene?: string;
  /** Startup LLM health-check timeout in ms (real mode only). Default: 3000. */
  healthCheckTimeoutMs?: number;
}

/**
 * Build and start the visualizer demo. Returns a handle with the server,
 * adapter, engine core, orchestrator, port, and a `stop()` function.
 *
 * With `USE_REAL_LLM=true` the demo builds a real `PPEROrchestrator` via
 * `assembleCognitionStack()` (spec 027, Req 3), loads the coffee-shop scene
 * from YAML (Req 5), and registers the same affordance handlers the validation
 * scene uses via the spec-022 plugin path (Req 4). Otherwise the default
 * no-op `MockOrchestrator` and minimal scene are used — unchanged from
 * spec 023 (no network, no LLM required).
 */
export async function startVisualizerDemo(
  opts: StartVisualizerDemoOptions = {},
): Promise<VisualizerDemoHandle> {
  const useRealLLM = process.env['USE_REAL_LLM'] === 'true';

  // ── Startup LLM health check (Req 9) — real mode only. ────────────────────
  // Exits loudly (caller handles non-zero exit) when the backend is down
  // instead of silently showing a static scene.
  if (useRealLLM) {
    await checkLLMHealth(
      opts.healthCheckTimeoutMs !== undefined ? { timeoutMs: opts.healthCheckTimeoutMs } : {},
    );
  }

  const config = makeConfig();
  const scenes = await buildSceneMap();

  const sceneId = opts.scene ?? (useRealLLM ? 'coffee-shop' : 'minimal');
  const scene = scenes.get(sceneId);
  if (!scene) {
    throw new Error(
      `Unknown scene "${sceneId}" — available scenes: ${[...scenes.keys()].join(', ')}`,
    );
  }

  // Memory subsystem — real mode only; mock mode keeps the no-op default store.
  const memory = useRealLLM ? buildMemorySubsystem() : undefined;
  const core = createEngineCore(config, memory?.memoryStore, memory?.vectorStore);
  loadScene(core, scene);

  if (useRealLLM) {
    // Demo handler parity (Req 4): register the same affordance handlers the
    // coffee-shop validation scene uses, via the spec-022 plugin path.
    clearHandlerPlugins();
    for (const plugin of createBuiltinPlugins()) {
      registerHandlerPlugin(plugin);
    }
    autoRegisterHandlers(core, scene);
  } else {
    registerHandlers(core);
  }

  // ── Orchestrator selection (Req 3): real PPER orchestrator in real mode. ──
  let orchestrator: PPEROrchestratorPort;
  let llmClient: LLMClient | undefined;
  let guardrail: GuardrailEngineImpl | undefined;
  if (useRealLLM && memory !== undefined) {
    const stack = assembleCognitionStack(core, undefined, { memory });
    orchestrator = stack.orchestrator;
    llmClient = stack.llmClient;
    guardrail = stack.guardrail;
    assembleGameLoop(
      core,
      orchestrator,
      stack.memoryDecayService !== undefined
        ? {
            memoryDecayService: stack.memoryDecayService,
            ...(stack.reflectionLoop !== undefined ? { reflectionLoop: stack.reflectionLoop } : {}),
            decayConfig: stack.decayConfig,
          }
        : undefined,
    );
  } else {
    orchestrator = new MockOrchestrator();
    assembleGameLoop(core, orchestrator);
  }

  // Build the agent profiles map from the loaded agents so the adapter can
  // resolve display names (falls back to agentManager.getProfile()).
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
    ...(core.persistence ? { persistence: core.persistence } : {}),
    agentProfiles,
    scenes,
  });

  const server = new VisualizerServer({
    adapter,
    port: opts.port ?? 3000,
    scenes,
  });

  await server.start();
  const port = server.getPort();
  // eslint-disable-next-line no-console
  console.log(
    `\n  🖥️  evol-hive visualizer running at http://localhost:${port}/` +
      (useRealLLM ? `  (real LLM: ${llmClient ? 'connected' : ''}, scene: ${sceneId})` : ''),
  );

  // Start the simulation so the visualizer shows live state. In real mode the
  // PPER scheduler fires cycles for every agent each tick (§9.2) — agents
  // perceive, plan, execute affordances, and reflect on canvas.
  core.gameLoop.start();

  const stop = async (): Promise<void> => {
    core.gameLoop.stop();
    await server.stop();
  };

  return {
    server,
    adapter,
    core,
    port,
    stop,
    orchestrator,
    ...(llmClient !== undefined ? { llmClient } : {}),
    ...(guardrail !== undefined ? { guardrail } : {}),
    scenes,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const handle = await startVisualizerDemo();
  // Keep the process alive until Ctrl+C.
  process.on('SIGINT', async () => {
    await handle.stop();
    process.exit(0);
  });
}

const isMain = typeof process !== 'undefined' && process.argv[1]?.endsWith('visualizer-demo.ts');
if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Visualizer demo failed:', err);
    process.exit(1);
  });
}
