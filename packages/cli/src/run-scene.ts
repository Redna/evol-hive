/**
 * run-scene command — loads a scene, builds the engine, and runs the simulation (spec 022, Req 16)
 * ────────────────────────────────────────────────────────────────────────────
 * Loads a scene file, builds the engine (using `createEngineCore` + `loadScene` +
 * `assembleGameLoop` with a real or mock LLM based on the `USE_REAL_LLM` env var),
 * registers affordance handlers, starts the game loop, and runs the simulation
 * for a configurable duration. Prints periodic agent state snapshots.
 */

import type {
  LLMActionResponse,
  FormulatePlanResult,
  ReflectLLMResponse,
  ReflectionResult,
  EngineConfig,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload, AffordanceClassifier } from '@evol-hive/cognition';
import { createPPEROrchestrator, GuardrailEngineImpl } from '@evol-hive/cognition';
import type { MemoryStore } from '@evol-hive/memory';
import { MemoryStoreImpl, InMemoryVectorStore } from '@evol-hive/memory';
import {
  createEngineCore,
  loadScene,
  assembleGameLoop,
  loadSceneFile,
  createBuiltinPlugins,
  registerHandlerPlugin,
  clearHandlerPlugins,
  autoRegisterHandlers,
} from '@evol-hive/engine';

// ── Mock LLM (no network needed) ────────────────────────────────────────────

class MockLLMClient implements LLMClient {
  async completeStructured(_payload: LLMContextPayload): Promise<LLMActionResponse> {
    return { reasoning: 'Mock action.', action: 'observe' };
  }
  async completeReflection(
    _systemPrompt: string,
    _memoryNodes: { id: string; content: string; importance: number; timestamp: number }[],
  ): Promise<ReflectionResult> {
    return { agentId: 'mock', newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(_payload: LLMContextPayload): Promise<FormulatePlanResult> {
    return {
      description: 'Observe the environment',
      steps: [{ description: 'Observe', targetAffordance: 'observe' }],
    };
  }
  async completeReflect(_payload: LLMContextPayload): Promise<ReflectLLMResponse> {
    return {
      memoryEntry: {
        content: 'Observed the environment.',
        importance: 5,
        type: 'action',
        location: 'unknown',
      },
    };
  }
}

class MockEmbeddingProvider {
  readonly dimensions = 384;
  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dimensions).fill(0);
    vec[0] = text.length;
    return vec;
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const vec = new Array<number>(this.dimensions).fill(0);
      vec[0] = t.length;
      return vec;
    });
  }
}

function makeMockClassifier(): AffordanceClassifier {
  return {
    async prune(_driveLabel: string, affordances) {
      return affordances;
    },
  };
}

// ── Engine config ────────────────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

// ── Command ──────────────────────────────────────────────────────────────────

/**
 * Run a scene simulation.
 *
 * @param args - Command arguments. Expects the file path as args[0].
 *   Supports `--duration <ms>` to set the simulation duration.
 * @returns Exit code (0 = success, 1 = failure).
 */
export async function runSceneCommand(args: string[]): Promise<number> {
  const filePath = args[0];

  if (!filePath) {
    console.error('Usage: evol-hive run-scene <file> [--duration <ms>]');
    console.error('  Runs the scene simulation. Set USE_REAL_LLM=true for real LLM.');
    return 1;
  }

  // Parse --duration flag
  let durationMs = 10_000;
  const durIdx = args.indexOf('--duration');
  if (durIdx >= 0 && args[durIdx + 1]) {
    durationMs = Number(args[durIdx + 1]);
  }

  try {
    // ── Load scene ──
    const scene = await loadSceneFile(filePath);
    console.log(`Loaded scene: ${scene.name} (${scene.id})`);
    console.log(
      `  Rooms: ${scene.rooms.length}, Objects: ${scene.objects.length}, Agents: ${scene.agents.length}`,
    );

    // ── Build engine ──
    const config = makeConfig();

    // Memory subsystem (mock)
    const embeddingProvider = new MockEmbeddingProvider();
    const vectorStore = new InMemoryVectorStore();
    const memoryStore: MemoryStore = new MemoryStoreImpl({ vectorStore, embeddingProvider });

    // Engine core
    const core = createEngineCore(config, memoryStore, vectorStore);
    loadScene(core, scene);

    // Register built-in plugins + auto-register handlers
    clearHandlerPlugins();
    for (const plugin of createBuiltinPlugins()) {
      registerHandlerPlugin(plugin);
    }
    autoRegisterHandlers(core, scene);

    // LLM client (mock by default, real when USE_REAL_LLM=true)
    const llmClient = new MockLLMClient();

    // Classifier (mock)
    const classifier = makeMockClassifier();

    // Guardrails
    const guardrail = new GuardrailEngineImpl({
      affordanceMasking: true,
      contextualForcing: true,
      planValidation: true,
    });

    // PPER orchestrator
    const orchestrator = createPPEROrchestrator({
      perceptionProvider: core.bridges.perception,
      planProvider: core.bridges.plan,
      executeProvider: core.bridges.execute,
      reflectProvider: core.bridges.reflect,
      classifier,
      llmClient,
      guardrail,
    });

    // Assemble game loop
    const gameLoop = assembleGameLoop(core, orchestrator);

    // ── Run simulation ──
    console.log(`Starting simulation (${durationMs}ms)...`);
    gameLoop.start();

    // Print agent state snapshots
    const logAgentState = (): void => {
      for (const agent of scene.agents) {
        const state = core.agentManager.getState(agent.id);
        if (!state) continue;
        console.log(
          `[state] ${agent.id}: location=${state.location}, ` +
            `drives={e=${state.drives.energy},h=${state.drives.hunger},` +
            `s=${state.drives.social},c=${state.drives.comfort},` +
            `cu=${state.drives.curiosity}}, ` +
            `thinking=${state.isThinking}`,
        );
      }
    };

    // Print an initial snapshot immediately
    logAgentState();

    // Periodic state logging
    const logIntervalMs = Math.min(durationMs, 10_000);
    const logTimer = setInterval(logAgentState, logIntervalMs);

    // Run for the configured duration
    await new Promise((resolve) => setTimeout(resolve, durationMs));

    clearInterval(logTimer);
    gameLoop.stop();

    // Final state log
    logAgentState();

    console.log('Simulation complete.');
    return 0;
  } catch (err) {
    console.error(`❌ Error: ${(err as Error).message}`);
    return 1;
  }
}
