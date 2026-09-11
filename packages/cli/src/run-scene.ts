/**
 * run-scene command — loads a scene, builds the engine, and runs the simulation (spec 022, Req 16)
 * ────────────────────────────────────────────────────────────────────────────
 * Loads a scene file and hands it to the promoted assembler (spec 050):
 * `assembleWorld()` wires the engine core + cognition stack in one call —
 * a real or mock LLM based on the `USE_REAL_LLM` env var, mock memory by
 * default — with the scene load + affordance-handler registration staying
 * caller-side (scene data). Starts the game loop, runs the simulation for a
 * configurable duration, and prints periodic agent state snapshots.
 */

import type {
  LLMActionResponse,
  FormulatePlanResult,
  ReflectLLMResponse,
  ReflectionResult,
  EngineConfig,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '@evol-hive/cognition';
import {
  loadScene,
  loadSceneFile,
  createBuiltinPlugins,
  registerHandlerPlugin,
  clearHandlerPlugins,
  autoRegisterHandlers,
} from '@evol-hive/engine';
import { assembleWorld } from '@evol-hive/assembly';

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

    // One call, fully wired (spec 050): the promoted assembler owns all wiring.
    // The scene-aware mock LLM is handed in; scene data (scene load + builtin
    // plugin handler registration) stays caller-side via `sceneSetup`.
    const world = assembleWorld({
      config,
      mockLLMClient: new MockLLMClient(),
      sceneSetup: (core) => {
        loadScene(core, scene);

        // Register built-in plugins + auto-register handlers
        clearHandlerPlugins();
        for (const plugin of createBuiltinPlugins()) {
          registerHandlerPlugin(plugin);
        }
        autoRegisterHandlers(core, scene);
      },
    });
    const core = world.core;
    const gameLoop = world.gameLoop;

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
