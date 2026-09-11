/**
 * examples/minimal-scene.ts — Minimal playable scene (spec 005, Req 14-17)
 * ────────────────────────────────────────────────────────────────────────────
 * A headless simulation prototype: one room ("kitchen") with a CoffeeMachine
 * smart object (brew_coffee + observe affordances) and one agent (energy: 20).
 *
 * Uses mock LLM and mock embedding implementations so it runs without external
 * services. Run with: `npx tsx examples/minimal-scene.ts`
 */

import type {
  SceneDefinition,
  Affordance,
  SmartObject,
  AgentProfile,
  Room,
  FormulatePlanResult,
  ReflectLLMResponse,
  LLMActionResponse,
  ReflectionResult,
  EngineConfig,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '@evol-hive/cognition';
import type { EmbeddingProvider as MemEmbeddingProvider } from '@evol-hive/memory';
import { loadScene } from '@evol-hive/engine';
import type { AssembledEngine } from '@evol-hive/engine';
import { assembleWorld } from '@evol-hive/assembly';

// ── Scene definition (AC-18) ─────────────────────────────────────────────────

const brewCoffee: Affordance = {
  id: 'brew_coffee',
  label: 'Brew coffee',
  engineEffect: 'brew_coffee',
  preconditions: [],
  effects: { energy: 20 },
};

const observe: Affordance = {
  id: 'observe',
  label: 'Observe',
  engineEffect: 'observe',
  preconditions: [],
  effects: {},
};

const coffeeMachine: SmartObject = {
  id: 'coffee-1',
  name: 'Coffee Machine',
  type: 'appliance',
  state: { water_level: 5, bean_count: 12 },
  affordances: [brewCoffee, observe],
  roomId: 'kitchen',
};

const kitchen: Room = {
  id: 'kitchen',
  name: 'Kitchen',
  description: 'A small kitchen with a coffee machine.',
  connections: [],
  objectIds: ['coffee-1'],
};

const agent: AgentProfile = {
  id: 'agent-1',
  name: 'Alice',
  description: 'A sleepy agent who needs coffee.',
  traits: ['diligent', 'caffeine-dependent'],
  initialDrives: { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
};

export const MINIMAL_SCENE: SceneDefinition = {
  id: 'minimal',
  name: 'Minimal Scene',
  rooms: [kitchen],
  objects: [coffeeMachine],
  agents: [agent],
};

// ── Mock LLM client (AC-21, spec 019 Req 17) ─────────────────────────────────

export class MockLLMClient implements LLMClient {
  async completeStructured(payload: LLMContextPayload): Promise<LLMActionResponse> {
    // Identify affordance tools (spec 019): tools whose names are not cognitive
    // tool names and not choose_action.
    const cognitiveNames = new Set<string>([
      'query_memory',
      'update_internal_state',
      'talk_to',
      'observe_agent',
      'help',
      'ignore',
      'formulate_plan',
    ]);
    const affordanceTool = (payload.tools ?? []).find(
      (t) => t.function.name !== 'choose_action' && !cognitiveNames.has(t.function.name),
    );
    if (affordanceTool) {
      return { reasoning: '', action: affordanceTool.function.name };
    }
    return { reasoning: 'I need energy. I will brew coffee.', action: 'brew_coffee' };
  }

  async completeReflection(
    _systemPrompt: string,
    _memoryNodes: { id: string; content: string; importance: number; timestamp: number }[],
  ): Promise<ReflectionResult> {
    return { agentId: 'agent-1', newMemories: [], consolidatedNodeIds: [] };
  }

  async completePlan(payload: LLMContextPayload): Promise<FormulatePlanResult> {
    // Identify affordance tools and use their names as targetAffordance values (spec 019).
    const cognitiveNames = new Set<string>([
      'query_memory',
      'update_internal_state',
      'talk_to',
      'observe_agent',
      'help',
      'ignore',
      'formulate_plan',
    ]);
    const affordanceTools = (payload.tools ?? []).filter(
      (t) => t.function.name !== 'choose_action' && !cognitiveNames.has(t.function.name),
    );
    if (affordanceTools.length > 0) {
      return {
        description: 'Brew coffee to restore energy',
        steps: affordanceTools.map((t) => ({
          description: t.function.name,
          targetAffordance: t.function.name,
        })),
      };
    }
    return {
      description: 'Brew coffee to restore energy',
      steps: [{ description: 'Brew a cup of coffee', targetAffordance: 'brew_coffee' }],
    };
  }

  async completeReflect(_payload: LLMContextPayload): Promise<ReflectLLMResponse> {
    return {
      memoryEntry: {
        content: 'Brewed a cup of coffee to restore energy.',
        importance: 5,
        type: 'action',
        location: 'kitchen',
      },
    };
  }
}

// ── Mock embedding provider (AC-22) ──────────────────────────────────────────

export class MockEmbeddingProvider implements MemEmbeddingProvider {
  readonly dimensions = 384;

  async embed(text: string): Promise<number[]> {
    // Deterministic zero-ish vector with the first element encoding text length.
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

// ── Engine assembly (AC-19) ──────────────────────────────────────────────────

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

export function buildMinimalEngine(): AssembledEngine & {
  vectorStore: import('@evol-hive/memory').InMemoryVectorStore;
} {
  const config = makeConfig();

  // One call, fully wired (spec 050 R2/R3): the promoted assembler owns every
  // wire — engine core, cognition stack (the scene's mock LLM is handed in via
  // `mockLLMClient`; `USE_REAL_LLM=true` selects the real client), memory
  // subsystem, guardrails, orchestrator, and the game loop. Scene data (the
  // scene load + the two demo handlers) stays caller-side via `sceneSetup`.
  const world = assembleWorld({
    config,
    mockLLMClient: new MockLLMClient(),
    sceneSetup: (core) => {
      loadScene(core, MINIMAL_SCENE);

      // Register the brew_coffee affordance handler.
      core.affordanceRegistry.registerHandler('brew_coffee', async (_objectId, _agentId, state) => {
        const newState = { ...state, water_level: ((state['water_level'] as number) ?? 0) - 1 };
        return {
          success: true,
          newState,
          driveChanges: { energy: 20 },
        };
      });
      core.affordanceRegistry.registerHandler('observe', async (_objectId, _agentId, state) => {
        return { success: true, newState: state };
      });
    },
  });

  const core = world.core;

  return {
    gameLoop: world.gameLoop,
    agentManager: core.agentManager,
    sceneManager: core.sceneManager,
    smartObjectRegistry: core.smartObjectRegistry,
    affordanceRegistry: core.affordanceRegistry,
    bridges: core.bridges,
    // The social surface the assembler wired (spec 019): the core's own
    // SocialManager — the single instance holding both bridge roles.
    socialManager: core.socialManager,
    // Exposed so tests can observe a completed PPER cycle end-to-end (the
    // Reflect phase stores a memory node in the assembler's store).
    vectorStore: world.memory!.vectorStore,
  };
}

// ── Entry point (AC-19, AC-20) ───────────────────────────────────────────────

async function main(): Promise<void> {
  const engine = buildMinimalEngine();

  // eslint-disable-next-line no-console
  console.log('Starting minimal scene simulation…');
  engine.gameLoop.start();

  // Let the simulation run for a short wall-clock window so the fired-and-forgotten
  // PPER cycle can complete. A real LLM may take 1–5 seconds per request, so the
  // wait is configurable via SCENE_DURATION_MS (default 5000) when USE_REAL_LLM.
  const useRealLLM = process.env['USE_REAL_LLM'] === 'true';
  const waitMs = useRealLLM ? Number(process.env['SCENE_DURATION_MS'] ?? '5000') : 200;
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  engine.gameLoop.stop();
  const state = engine.agentManager.getState('agent-1');
  // eslint-disable-next-line no-console
  console.log(
    `Final agent-1 state: energy=${state?.drives.energy}, isThinking=${state?.isThinking}`,
  );
}

// Run only when executed directly (not when imported by tests).
const isMain = typeof process !== 'undefined' && process.argv[1]?.endsWith('minimal-scene.ts');
if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Minimal scene failed:', err);
    process.exit(1);
  });
}
