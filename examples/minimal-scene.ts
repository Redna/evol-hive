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
  MemoryNode,
  PPEROrchestratorPort,
  PPERPhase,
  EngineConfig,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '@evol-hive/cognition';
import { createPPEROrchestrator, OpenAICompatibleLLMClient } from '@evol-hive/cognition';
import type { AffordanceClassifier } from '@evol-hive/cognition';
import { OnnxEmbeddingProvider, AffordanceClassifierImpl, defaultClassifierConfig } from '@evol-hive/cognition';
import type {
  EmbeddingProvider as MemEmbeddingProvider,
  VectorStore,
  MemoryStore,
} from '@evol-hive/memory';
import { MemoryStoreImpl } from '@evol-hive/memory';
import { createEngineCore, assembleGameLoop, loadScene } from '@evol-hive/engine';
import type { AssembledEngine } from '@evol-hive/engine';

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

// ── Mock LLM client (AC-21) ──────────────────────────────────────────────────

export class MockLLMClient implements LLMClient {
  async completeStructured(_payload: LLMContextPayload): Promise<LLMActionResponse> {
    return { reasoning: 'I need energy. I will brew coffee.', action: 'brew_coffee' };
  }

  async completeReflection(
    _systemPrompt: string,
    _memoryNodes: { id: string; content: string; importance: number; timestamp: number }[],
  ): Promise<ReflectionResult> {
    return { agentId: 'agent-1', newMemories: [], consolidatedNodeIds: [] };
  }

  async completePlan(_payload: LLMContextPayload): Promise<FormulatePlanResult> {
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

// ── Mock affordance classifier (returns all affordances — no pruning) ─────────

function makeMockClassifier(): AffordanceClassifier {
  return {
    async prune(_driveLabel: string, affordances: Affordance[]) {
      return affordances;
    },
  };
}

// ── In-memory vector store ────────────────────────────────────────────────────

class InMemoryVectorStore implements VectorStore {
  private readonly nodes = new Map<string, MemoryNode>();

  async store(node: MemoryNode): Promise<void> {
    this.nodes.set(node.id, node);
  }

  async get(id: string): Promise<MemoryNode | null> {
    return this.nodes.get(id) ?? null;
  }

  async queryByEmbedding(_embedding: number[], _topK: number): Promise<MemoryNode[]> {
    return [...this.nodes.values()];
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.nodes.delete(id);
  }

  async countRecent(_agentId: string, _sinceTimestamp: number): Promise<number> {
    return 0;
  }
}

// ── Logging orchestrator wrapper (AC-20) ─────────────────────────────────────

class LoggingOrchestrator implements PPEROrchestratorPort {
  private readonly inner: PPEROrchestratorPort;
  private logged = false;

  constructor(inner: PPEROrchestratorPort) {
    this.inner = inner;
  }

  async runCycle(agentId: string): Promise<void> {
    await this.inner.runCycle(agentId);
    if (!this.logged) {
      this.logged = true;
      // eslint-disable-next-line no-console
      console.log(`Agent ${agentId} completed PPER cycle: success=true`);
    }
  }

  getPhase(agentId: string): PPERPhase {
    return this.inner.getPhase(agentId);
  }
}

// ── Engine assembly (AC-19) ──────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
  };
}

export function buildMinimalEngine(): AssembledEngine {
  const config = makeConfig();

  // Memory subsystem — use real ONNX embeddings when USE_REAL_EMBEDDINGS=true.
  const useRealEmbeddings = process.env['USE_REAL_EMBEDDINGS'] === 'true';
  const vectorStore = new InMemoryVectorStore();
  const embeddingProvider: MemEmbeddingProvider = useRealEmbeddings
    ? new OnnxEmbeddingProvider({
        modelPath: process.env['EMBEDDING_MODEL_PATH']!,
        tokenizerPath: process.env['EMBEDDING_TOKENIZER_PATH'] ?? undefined,
      })
    : new MockEmbeddingProvider();
  const memoryStore: MemoryStore = new MemoryStoreImpl({ vectorStore, embeddingProvider });

  // Engine core + scene.
  const core = createEngineCore(config, memoryStore);
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

  // PPER orchestrator (cognition) wired from the engine bridges + LLM.
  const useRealLLM = process.env['USE_REAL_LLM'] === 'true';
  const llmResponseFormat =
    (process.env['LLM_RESPONSE_FORMAT'] as 'json_schema' | 'json_object' | 'auto' | undefined) ??
    'auto';
  const llmClient: LLMClient = useRealLLM
    ? new OpenAICompatibleLLMClient({
        baseUrl: process.env['LLM_BASE_URL'] ?? 'http://localhost:11434/v1',
        model: process.env['LLM_MODEL'] ?? 'llama3.1',
        ...(process.env['LLM_API_KEY'] !== undefined ? { apiKey: process.env['LLM_API_KEY'] } : {}),
        responseFormat: llmResponseFormat,
        enableJsonRecovery: true,
      })
    : new MockLLMClient();

  // Classifier — use real AffordanceClassifierImpl when USE_REAL_EMBEDDINGS=true.
  const classifier: AffordanceClassifier = useRealEmbeddings
    ? new AffordanceClassifierImpl(embeddingProvider, defaultClassifierConfig())
    : makeMockClassifier();

  const orchestrator = createPPEROrchestrator({
    perceptionProvider: core.bridges.perception,
    planProvider: core.bridges.plan,
    executeProvider: core.bridges.execute,
    reflectProvider: core.bridges.reflect,
    classifier,
    llmClient,
  });

  const loggingOrchestrator = new LoggingOrchestrator(orchestrator);

  const gameLoop = assembleGameLoop(core, loggingOrchestrator);

  return {
    gameLoop,
    agentManager: core.agentManager,
    sceneManager: core.sceneManager,
    smartObjectRegistry: core.smartObjectRegistry,
    affordanceRegistry: core.affordanceRegistry,
    bridges: core.bridges,
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
