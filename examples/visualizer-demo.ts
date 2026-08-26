/**
 * examples/visualizer-demo.ts — Browser-based visualizer demo (spec 023, Req 18 / AC-13)
 * ────────────────────────────────────────────────────────────────────────────
 * Builds an engine core + PPER orchestrator (mock LLM by default), wraps it in
 * a `VisualizerDataAdapter`, starts a `VisualizerServer`, and serves the canvas
 * renderer at `http://localhost:<port>/`.
 *
 * Run with: `npx tsx examples/visualizer-demo.ts`
 * Then open the logged URL in a browser to see the live visualization.
 */

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
  VisualizerDataAdapter,
} from '@evol-hive/engine';
import type { EngineCore } from '@evol-hive/engine';
import { VisualizerServer } from '@evol-hive/visualizer';
import { COFFEE_SHOP_SCENE } from './coffee-shop.js';

// ── Built-in scenes ──────────────────────────────────────────────────────────
// The minimal and morning-routine scenes are defined inline so this demo does
// not depend on the (typecheck-excluded) example entry points. The coffee-shop
// scene is imported from its fully typechecked example file.

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

function buildSceneMap(): Map<string, SceneDefinition> {
  const scenes = new Map<string, SceneDefinition>();
  scenes.set('minimal', MINIMAL_SCENE);
  scenes.set('morning-routine', MORNING_ROUTINE_SCENE);
  scenes.set('coffee-shop', COFFEE_SHOP_SCENE);
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
// For the visualizer demo we do not need real LLM-driven cognition — the
// renderer only displays state. A lightweight mock orchestrator reports the
// 'perceive' phase for every agent.

class MockOrchestrator implements PPEROrchestratorPort {
  async runCycle(_agentId: string): Promise<void> {
    // No-op — the visualizer does not require PPER cycles to run.
  }
  getPhase(_agentId: string): PPERPhase {
    return 'perceive';
  }
}

// ── Affordance handler registration (minimal) ────────────────────────────────

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
}

/**
 * Build and start the visualizer demo. Returns a handle with the server,
 * adapter, engine core, port, and a `stop()` function.
 */
export async function startVisualizerDemo(
  opts: { port?: number } = {},
): Promise<VisualizerDemoHandle> {
  const config = makeConfig();
  const core = createEngineCore(config);
  loadScene(core, MINIMAL_SCENE);
  registerHandlers(core);

  const orchestrator = new MockOrchestrator();
  assembleGameLoop(core, orchestrator);

  const scenes = buildSceneMap();

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
  console.log(`\n  🖥️  evol-hive visualizer running at http://localhost:${port}/\n`);

  // Start the simulation so the visualizer shows live (decaying) state.
  core.gameLoop.start();

  const stop = async (): Promise<void> => {
    core.gameLoop.stop();
    await server.stop();
  };

  return { server, adapter, core, port, stop };
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
