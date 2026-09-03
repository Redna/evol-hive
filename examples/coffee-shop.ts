/**
 * examples/coffee-shop.ts — "Coffee Shop" Phase 4 validation scene (spec 019, issue #74)
 * ────────────────────────────────────────────────────────────────────────────
 * A comprehensive integration scene that wires EVERY subsystem simultaneously:
 *   - 4 connected rooms (kitchen ↔ living_room, living_room ↔ bathroom/garden, kitchen ↔ garden)
 *   - 3 agents with distinct drive profiles (Alice: energy, Bob: social, Carol: curiosity)
 *   - 7 non-doorway smart objects including compound actions, state rules, conditional
 *     affordances, object dependencies, and cross-object state changes
 *   - SocialManager wired as SocialActionBridge → CognitiveToolExecutorImpl
 *   - CognitiveToolExecutorImpl with stateDataProvider + socialBridge
 *   - GuardrailEngineImpl with all three guardrails
 *   - EnginePersistenceImpl + AutoSaveSystem (30s default interval)
 *   - MemoryDecayService + ReflectionLoop + MemoryMaintenanceSystem
 *   - Real LLM (OpenAICompatibleLLMClient) when USE_REAL_LLM=true
 *   - Real ONNX embeddings + AffordanceClassifierImpl when USE_REAL_EMBEDDINGS=true
 *   - Configurable drive decay, memory decay, run duration, and logging interval
 *
 * Run with: `npx tsx examples/coffee-shop.ts`
 */

import type {
  SceneDefinition,
  Room,
  SmartObject,
  Affordance,
  AgentProfile,
  ObjectStateRule,
  CompoundAction,
  ObjectDependency,
  AffordanceCondition,
  FormulatePlanResult,
  ReflectLLMResponse,
  LLMActionResponse,
  ReflectionResult,
  EngineConfig,
  MemoryDecayConfig,
  AutoSaveConfig,
} from '@evol-hive/shared';
import { defaultMemoryDecayConfig, defaultReflectionConfig } from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload, AffordanceClassifier } from '@evol-hive/cognition';
import {
  createPPEROrchestrator,
  OpenAICompatibleLLMClient,
  CognitiveToolExecutorImpl,
  GuardrailEngineImpl,
  OnnxEmbeddingProvider,
  AffordanceClassifierImpl,
  defaultClassifierConfig,
  ConsolidationProviderImpl,
  TokenUsageReporter,
} from '@evol-hive/cognition';
import type {
  EmbeddingProvider as MemEmbeddingProvider,
  MemoryStore,
  MemoryDecayService,
  ReflectionLoop,
} from '@evol-hive/memory';
import {
  MemoryStoreImpl,
  InMemoryVectorStore,
  MemoryDecayServiceImpl,
  ReflectionLoopImpl,
} from '@evol-hive/memory';
import { createEngineCore, assembleGameLoop, loadScene } from '@evol-hive/engine';
import type { AssembledEngine, EngineCore, EnginePersistence } from '@evol-hive/engine';
import { SocialManager } from '@evol-hive/engine';
import { registerAffordanceHandlers, registerCoffeeShopHandlers } from './scene-helpers.ts';

// Re-export for convenience and testability (spec 019, Req 16–18).
export { registerCoffeeShopHandlers } from './scene-helpers.ts';

// ── Affordance factory helpers ───────────────────────────────────────────────

function aff(
  id: string,
  label: string,
  preconditions: string[] = [],
  effects: Record<string, number> = {},
): Affordance {
  return { id, label, engineEffect: id, preconditions, effects };
}

const observeAffordance: Affordance = aff('observe', 'Observe');

/** Build a Doorway smart object with go_to_<conn> affordances + observe. */
function makeDoorway(roomId: string, connections: string[]): SmartObject {
  const affordances: Affordance[] = connections.map((conn) =>
    aff(`go_to_${conn}`, `Go to ${conn}`),
  );
  affordances.push(observeAffordance);
  return {
    id: `doorway-${roomId}`,
    name: 'Doorway',
    type: 'doorway',
    state: {},
    affordances,
    roomId,
  };
}

// ── Room definitions (Req 1) ─────────────────────────────────────────────────

const kitchen: Room = {
  id: 'kitchen',
  name: 'Kitchen',
  description: 'A kitchen with a coffee machine and sink.',
  connections: ['living_room', 'garden'],
  objectIds: ['coffee-1', 'sink-1', 'doorway-kitchen'],
};

const livingRoom: Room = {
  id: 'living_room',
  name: 'Living Room',
  description: 'A living room with a bookshelf and sofa.',
  connections: ['kitchen', 'bathroom', 'garden'],
  objectIds: ['bookshelf-1', 'sofa-1', 'doorway-living_room'],
};

const bathroom: Room = {
  id: 'bathroom',
  name: 'Bathroom',
  description: 'A small bathroom with a toilet.',
  connections: ['living_room'],
  objectIds: ['toilet-1', 'doorway-bathroom'],
};

const garden: Room = {
  id: 'garden',
  name: 'Garden',
  description: 'A garden with a bench and flower bed.',
  connections: ['living_room', 'kitchen'],
  objectIds: ['bench-1', 'flowerbed-1', 'doorway-garden'],
};

// ── Object definitions (Req 3) ───────────────────────────────────────────────

// Coffee Machine — compound action, state rules, conditional affordances, dependencies.
const brewConditions: AffordanceCondition[] = [
  { field: 'water_level', operator: '>', value: 0 },
  { field: 'bean_count', operator: '>', value: 0 },
];

const addWaterConditions: AffordanceCondition[] = [
  { field: 'water_level', operator: '<', value: 5 },
];

const coffeeCompoundAction: CompoundAction = {
  id: 'brew_coffee_sequence',
  label: 'Brew a cup of coffee',
  steps: [
    { affordanceId: 'add_water', description: 'Add water to the machine' },
    { affordanceId: 'brew_coffee', description: 'Brew the coffee' },
    { affordanceId: 'pour_cup', description: 'Pour into a cup' },
  ],
};

const coffeeStateRules: ObjectStateRule[] = [
  // Evaporation: water_level slowly decays.
  { field: 'water_level', operation: 'decay', rate: 0.1, interval: 1 },
  // Auto-refill: water_level replenishes toward 5.
  { field: 'water_level', operation: 'approach', rate: 0.5, target: 5, interval: 1 },
];

const coffeeDependencies: ObjectDependency[] = [
  {
    affordanceId: 'add_water',
    requiresObjectId: 'sink-1',
    requiresAffordance: 'refill_pitcher',
    description: 'Must refill the pitcher at the Sink before adding water to the Coffee Machine.',
  },
];

const coffeeMachine: SmartObject = {
  id: 'coffee-1',
  name: 'Coffee Machine',
  type: 'appliance',
  state: { water_level: 5, bean_count: 10, cup_count: 3 },
  affordances: [
    {
      ...aff('add_water', 'Add water', [], {}),
      stepGroup: 'brew_coffee_sequence',
      stepOrder: 1,
      conditions: addWaterConditions,
    },
    {
      ...aff('brew_coffee', 'Brew coffee', ['has_water', 'has_beans'], { energy: 20 }),
      stepGroup: 'brew_coffee_sequence',
      stepOrder: 2,
      conditions: brewConditions,
    },
    {
      ...aff('pour_cup', 'Pour a cup', ['has_cups'], { comfort: 5 }),
      stepGroup: 'brew_coffee_sequence',
      stepOrder: 3,
    },
    observeAffordance,
  ],
  roomId: 'kitchen',
  stateRules: coffeeStateRules,
  compoundActions: [coffeeCompoundAction],
  dependencies: coffeeDependencies,
};

// Sink — cross-object state change via refill_pitcher.
const sinkStateRules: ObjectStateRule[] = [
  { field: 'water_supply', operation: 'decay', rate: 0.05, interval: 1 },
];

const sink: SmartObject = {
  id: 'sink-1',
  name: 'Sink',
  type: 'fixture',
  state: { water_supply: 20 },
  affordances: [
    aff('refill_pitcher', 'Refill pitcher', ['has_water_supply'], {}),
    aff('wash_hands', 'Wash hands', [], { comfort: 5 }),
    observeAffordance,
  ],
  roomId: 'kitchen',
  stateRules: sinkStateRules,
};

// Bookshelf — conditional affordance (book_count > 0).
const bookshelf: SmartObject = {
  id: 'bookshelf-1',
  name: 'Bookshelf',
  type: 'furniture',
  state: { book_count: 8 },
  affordances: [
    {
      ...aff('read_book', 'Read a book', ['has_books'], { curiosity: 20, energy: -10 }),
      conditions: [{ field: 'book_count', operator: '>', value: 0 }],
    },
    observeAffordance,
  ],
  roomId: 'living_room',
};

// Sofa — relax affordance (comfort + energy; social bonus via shared space context).
const sofa: SmartObject = {
  id: 'sofa-1',
  name: 'Sofa',
  type: 'furniture',
  state: {},
  affordances: [
    aff('relax', 'Relax on the sofa', [], { comfort: 20, energy: 5 }),
    observeAffordance,
  ],
  roomId: 'living_room',
};

// Toilet — use_bathroom (comfort +10).
const toilet: SmartObject = {
  id: 'toilet-1',
  name: 'Toilet',
  type: 'fixture',
  state: {},
  affordances: [aff('use_bathroom', 'Use the bathroom', [], { comfort: 10 }), observeAffordance],
  roomId: 'bathroom',
};

// Garden Bench — sit_outside (comfort +15, curiosity +5, energy +3).
const gardenBench: SmartObject = {
  id: 'bench-1',
  name: 'Garden Bench',
  type: 'furniture',
  state: {},
  affordances: [
    aff('sit_outside', 'Sit outside', [], { comfort: 15, curiosity: 5, energy: 3 }),
    observeAffordance,
  ],
  roomId: 'garden',
};

// Flower Bed — conditional affordance (bloom_count > 0), state rules.
const flowerbedStateRules: ObjectStateRule[] = [
  { field: 'bloom_count', operation: 'decay', rate: 0.02, interval: 1 },
  { field: 'bloom_count', operation: 'approach', rate: 0.1, target: 5, interval: 1 },
];

const flowerBed: SmartObject = {
  id: 'flowerbed-1',
  name: 'Flower Bed',
  type: 'nature',
  state: { bloom_count: 5 },
  affordances: [
    {
      ...aff('observe_flowers', 'Observe flowers', ['has_blooms'], {
        curiosity: 10,
        comfort: 5,
      }),
      conditions: [{ field: 'bloom_count', operator: '>', value: 0 }],
    },
    observeAffordance,
  ],
  roomId: 'garden',
  stateRules: flowerbedStateRules,
};

// ── Agent definitions (Req 2) ────────────────────────────────────────────────

const alice: AgentProfile = {
  id: 'agent-alice',
  name: 'Alice',
  description: 'A caffeine-dependent person who needs coffee to function.',
  traits: ['diligent', 'caffeine-dependent'],
  initialDrives: { energy: 15, hunger: 60, social: 40, comfort: 50, curiosity: 30 },
  startRoomId: 'kitchen',
};

const bob: AgentProfile = {
  id: 'agent-bob',
  name: 'Bob',
  description: 'A social person who seeks company and conversation.',
  traits: ['social', 'easygoing'],
  initialDrives: { energy: 50, hunger: 40, social: 15, comfort: 60, curiosity: 50 },
  startRoomId: 'living_room',
};

const carol: AgentProfile = {
  id: 'agent-carol',
  name: 'Carol',
  description: 'A curious analyst who wants to explore and learn.',
  traits: ['curious', 'analytical'],
  initialDrives: { energy: 60, hunger: 30, social: 50, comfort: 40, curiosity: 15 },
  startRoomId: 'garden',
};

// ── Scene definition (Req 24) ────────────────────────────────────────────────

export const COFFEE_SHOP_SCENE: SceneDefinition = {
  id: 'coffee-shop',
  name: 'Coffee Shop',
  rooms: [kitchen, livingRoom, bathroom, garden],
  objects: [
    coffeeMachine,
    sink,
    bookshelf,
    sofa,
    toilet,
    gardenBench,
    flowerBed,
    makeDoorway('kitchen', kitchen.connections),
    makeDoorway('living_room', livingRoom.connections),
    makeDoorway('bathroom', bathroom.connections),
    makeDoorway('garden', garden.connections),
  ],
  agents: [alice, bob, carol],
};

// ── Mock embedding provider ───────────────────────────────────────────────────

class MockEmbeddingProvider implements MemEmbeddingProvider {
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
    async prune(_driveLabel: string, affordances: Affordance[]) {
      return affordances;
    },
  };
}

// ── Drive-aware mock LLM (Req 23) ────────────────────────────────────────────

/**
 * Mock LLM that selects a coffee-shop-appropriate affordance based on the
 * agent's primary drive and current room. Deterministic heuristic — not real AI.
 * Handles social awareness by detecting "Agents present:" in the perception
 * context and selecting `relax` when other agents are nearby.
 */
export class CoffeeShopMockLLMClient implements LLMClient {
  async completeStructured(_payload: LLMContextPayload): Promise<LLMActionResponse> {
    return { reasoning: 'Drive-aware mock action.', action: 'observe' };
  }

  async completeReflection(
    _systemPrompt: string,
    _memoryNodes: { id: string; content: string; importance: number; timestamp: number }[],
  ): Promise<ReflectionResult> {
    return { agentId: 'agent-alice', newMemories: [], consolidatedNodeIds: [] };
  }

  async completePlan(payload: LLMContextPayload): Promise<FormulatePlanResult> {
    return this.planFromContext(payload.perceptionContext);
  }

  /**
   * Synchronous plan helper exposed for testability (AC-22). Parses the
   * perception context string and returns a drive-appropriate plan.
   */
  completePlanSync(perceptionContext: string): FormulatePlanResult {
    return this.planFromContext(perceptionContext);
  }

  private planFromContext(perceptionContext: string): FormulatePlanResult {
    const { room, drive, agentsPresent } = parseContext(perceptionContext);
    const target = this.selectAffordance(room, drive, agentsPresent);
    return {
      description: `Address ${drive} drive in ${room}`,
      steps: [{ description: `Use ${target}`, targetAffordance: target }],
    };
  }

  async completeReflect(_payload: LLMContextPayload): Promise<ReflectLLMResponse> {
    return {
      memoryEntry: {
        content: 'Completed an action in the coffee shop.',
        importance: 5,
        type: 'action',
        location: 'kitchen',
      },
    };
  }

  /**
   * Select an affordance that addresses the primary drive based on the agent's
   * current room. Falls back to `observe` when no drive-specific affordance is
   * available.
   */
  private selectAffordance(room: string, drive: string, agentsPresent: boolean): string {
    // Energy restoration — coffee.
    if (drive === 'energy') {
      if (room === 'kitchen') return 'brew_coffee';
      if (room === 'living_room') return 'go_to_kitchen';
      if (room === 'bathroom') return 'go_to_living_room';
      if (room === 'garden') return 'go_to_kitchen';
      return 'go_to_kitchen';
    }
    // Social restoration — navigate to living room (shared space).
    if (drive === 'social') {
      if (room === 'living_room') {
        // If other agents are present, relax (social-aware).
        if (agentsPresent) return 'relax';
        return 'relax'; // fallback — relax in shared space
      }
      return 'go_to_living_room';
    }
    // Curiosity restoration.
    if (drive === 'curiosity') {
      if (room === 'garden') return 'observe_flowers';
      if (room === 'living_room') return 'read_book';
      if (room === 'kitchen') return 'go_to_living_room';
      if (room === 'bathroom') return 'go_to_living_room';
      return 'go_to_living_room';
    }
    // Comfort restoration.
    if (drive === 'comfort') {
      if (room === 'living_room') return 'relax';
      if (room === 'garden') return 'sit_outside';
      if (room === 'bathroom') return 'use_bathroom';
      if (room === 'kitchen') return 'go_to_living_room';
      return 'go_to_living_room';
    }
    // Hunger — no food affordances; observe as fallback.
    return 'observe';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse room, primary drive, and agents-present flag from perceptionContext. */
function parseContext(perceptionContext: string): {
  room: string;
  drive: string;
  agentsPresent: boolean;
} {
  const roomMatch = perceptionContext.match(/^Room: (.+)$/m);
  const driveMatch = perceptionContext.match(/Primary drive: low (\w+),/);
  const agentsMatch = perceptionContext.match(/^Agents present:/m);
  return {
    room: roomMatch ? roomMatch[1]! : '',
    drive: driveMatch ? driveMatch[1]! : '',
    agentsPresent: agentsMatch !== null,
  };
}

// ── Engine config helpers ─────────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

/** Read and validate the DRIVE_DECAY_RATE env var (Req 14 / AC-16). */
function readDriveDecayRate(): number | undefined {
  const raw = process.env['DRIVE_DECAY_RATE'];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Build a MemoryDecayConfig from defaults + env overrides (Req 13). */
function buildMemoryDecayConfig(): MemoryDecayConfig {
  const base = { ...defaultMemoryDecayConfig };
  const decayRate = process.env['MEMORY_DECAY_RATE'];
  if (decayRate !== undefined) {
    const parsed = Number(decayRate);
    if (!Number.isNaN(parsed)) base.decayRate = parsed;
  }
  const pruneThreshold = process.env['MEMORY_PRUNE_THRESHOLD'];
  if (pruneThreshold !== undefined) {
    const parsed = Number(pruneThreshold);
    if (!Number.isNaN(parsed)) base.pruneThreshold = parsed;
  }
  return base;
}

/** Build the AutoSaveConfig from env (Req 11). 30s = 1800 ticks at 60 FPS. */
function buildAutoSaveConfig(): AutoSaveConfig {
  const useAutosave = process.env['USE_AUTOSAVE'] !== 'false';
  return {
    enabled: useAutosave,
    intervalTicks: 30 * 60,
    filePath: process.env['SAVE_FILE_PATH'] ?? './coffee-shop-save.json',
  };
}

// ── Assembled engine type (extends AssembledEngine with coffee-shop extras) ───

/**
 * The full coffee-shop engine assembly, exposing all wired subsystems for
 * observability and testing. Extends `AssembledEngine` with the SocialManager,
 * CognitiveToolExecutor, LLM client, guardrail, embedding provider, classifier,
 * vector store, memory decay service, and reflection loop.
 */
export interface CoffeeShopAssembledEngine extends AssembledEngine {
  readonly socialManager: SocialManager;
  readonly cognitiveToolExecutor?: CognitiveToolExecutorImpl;
  readonly llmClient: LLMClient;
  /** Token usage aggregation (spec 022, Req 10) — populated for real LLM runs. */
  readonly tokenUsageReporter: TokenUsageReporter;
  readonly guardrail: GuardrailEngineImpl;
  readonly embeddingProvider: MemEmbeddingProvider;
  readonly classifier: AffordanceClassifier;
  readonly vectorStore: InMemoryVectorStore;
  readonly memoryDecayService?: MemoryDecayService;
  readonly reflectionLoop?: ReflectionLoop;
}

// ── Engine assembly (Req 5–15) ────────────────────────────────────────────────

/**
 * Build the full Coffee Shop engine with all subsystems wired. When
 * `USE_REAL_LLM=true`, uses `OpenAICompatibleLLMClient`; otherwise uses
 * `CoffeeShopMockLLMClient`. When `USE_REAL_EMBEDDINGS=true`, uses
 * `OnnxEmbeddingProvider` and `AffordanceClassifierImpl`; otherwise uses mocks.
 */
export function buildCoffeeShopEngine(): CoffeeShopAssembledEngine {
  const config = makeConfig();

  // Read DRIVE_DECAY_RATE (Req 14 / AC-16). The current engine does not yet
  // expose a configurable decay rate on DriveSystemImpl/EngineConfig; the env
  // var is read here so it is ready when the underlying spec is implemented.
  void readDriveDecayRate();

  // ── Memory subsystem (Req 6, Req 15) ──────────────────────────────────────
  const useRealEmbeddings = process.env['USE_REAL_EMBEDDINGS'] === 'true';
  const embeddingProvider: MemEmbeddingProvider = useRealEmbeddings
    ? new OnnxEmbeddingProvider({
        modelPath: process.env['EMBEDDING_MODEL_PATH']!,
        ...(process.env['EMBEDDING_TOKENIZER_PATH'] !== undefined
          ? { tokenizerPath: process.env['EMBEDDING_TOKENIZER_PATH'] }
          : {}),
      })
    : new MockEmbeddingProvider();

  const vectorStore = new InMemoryVectorStore();
  const memoryStore: MemoryStore = new MemoryStoreImpl({ vectorStore, embeddingProvider });

  // ── Engine core (Req 11) ──────────────────────────────────────────────────
  const core: EngineCore = createEngineCore(config, memoryStore, vectorStore);
  loadScene(core, COFFEE_SHOP_SCENE);
  registerAffordanceHandlers(core);
  registerCoffeeShopHandlers(core);

  // ── SocialManager (Req 8) ─────────────────────────────────────────────────
  const socialManager = new SocialManager(core.agentManager);
  // Wire social perception into the perception bridge.
  core.bridges.perception.setSocialManager(socialManager);

  // ── LLM client (Req 5, Req 9) ─────────────────────────────────────────────
  const useRealLLM = process.env['USE_REAL_LLM'] === 'true';
  const reasoningEffort = process.env['LLM_REASONING_EFFORT'] as
    'low' | 'medium' | 'high' | 'none' | undefined;

  // Spec 022 (Req 10): token usage aggregation — created always so the end-of-run
  // summary can report real token numbers when USE_REAL_LLM=true.
  const tokenUsageReporter = new TokenUsageReporter();

  const maxToolCallIterationsEnv = process.env['LLM_MAX_TOOL_CALL_ITERATIONS'];
  const maxToolCallIterations =
    maxToolCallIterationsEnv !== undefined ? Number(maxToolCallIterationsEnv) : undefined;

  // CognitiveToolExecutor (Req 9) — only needed for real LLM (tool call loop).
  const cognitiveToolExecutor = useRealLLM
    ? new CognitiveToolExecutorImpl({
        stateDataProvider: core.bridges.reflect,
        socialBridge: socialManager,
      })
    : undefined;

  const llmClient: LLMClient = useRealLLM
    ? new OpenAICompatibleLLMClient({
        baseUrl: process.env['LLM_BASE_URL'] ?? 'http://localhost:11434/v1',
        model: process.env['LLM_MODEL'] ?? 'llama3.1',
        ...(process.env['LLM_API_KEY'] !== undefined ? { apiKey: process.env['LLM_API_KEY'] } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(cognitiveToolExecutor !== undefined ? { cognitiveToolExecutor } : {}),
        ...(maxToolCallIterations !== undefined ? { maxToolCallIterations } : {}),
        embeddingProvider: embeddingProvider as MemEmbeddingProvider,
        // Spec 022 (Req 10): opt-in token usage tracking — wired when token
        // reporting is enabled so `getTotalUsage()` can print totals at end.
        ...(useRealLLM ? { tokenUsageReporter } : {}),
      })
    : new CoffeeShopMockLLMClient();

  // ── Classifier (Req 7) ────────────────────────────────────────────────────
  const classifier: AffordanceClassifier = useRealEmbeddings
    ? new AffordanceClassifierImpl(embeddingProvider, defaultClassifierConfig())
    : makeMockClassifier();

  // ── Guardrails (Req 10) ───────────────────────────────────────────────────
  const guardrail = new GuardrailEngineImpl({
    affordanceMasking: true,
    contextualForcing: true,
    planValidation: true,
  });

  // ── PPER orchestrator ─────────────────────────────────────────────────────
  const orchestrator = createPPEROrchestrator({
    perceptionProvider: core.bridges.perception,
    planProvider: core.bridges.plan,
    executeProvider: core.bridges.execute,
    reflectProvider: core.bridges.reflect,
    classifier,
    llmClient,
    guardrail,
  });

  // ── Memory decay + reflection (Req 13) ────────────────────────────────────
  const decayConfig = buildMemoryDecayConfig();
  const memoryDecayService = new MemoryDecayServiceImpl({ vectorStore, config: decayConfig });
  const consolidationProvider = new ConsolidationProviderImpl({ llmClient });
  const reflectionLoop = new ReflectionLoopImpl({
    vectorStore,
    embeddingProvider,
    consolidationProvider,
    config: defaultReflectionConfig,
    clock: () => core.gameLoop.currentTick().simulationTime,
  });
  // Expose on core for introspection (spec 019, Req 13).
  core.memoryDecayService = memoryDecayService;
  core.reflectionLoop = reflectionLoop;
  core.memoryMaintenanceConfig = decayConfig;

  // ── Auto-save (Req 11) ────────────────────────────────────────────────────
  const autoSaveConfig = buildAutoSaveConfig();
  core.autoSaveConfig = autoSaveConfig;

  // ── Assemble game loop with memory maintenance + auto-save ────────────────
  const gameLoop = assembleGameLoop(
    core,
    orchestrator,
    { memoryDecayService, reflectionLoop, decayConfig },
    { config: autoSaveConfig },
  );

  const persistence: EnginePersistence | undefined = core.persistence;

  return {
    gameLoop,
    agentManager: core.agentManager,
    sceneManager: core.sceneManager,
    smartObjectRegistry: core.smartObjectRegistry,
    affordanceRegistry: core.affordanceRegistry,
    bridges: core.bridges,
    ...(persistence !== undefined ? { persistence } : {}),
    socialManager,
    ...(cognitiveToolExecutor !== undefined ? { cognitiveToolExecutor } : {}),
    llmClient,
    tokenUsageReporter,
    guardrail,
    embeddingProvider,
    classifier,
    vectorStore,
    memoryDecayService,
    reflectionLoop,
  };
}

// ── Entry point (Req 20–22) ──────────────────────────────────────────────────

/** Default run durations (Req 20). */
function defaultDurationMs(): number {
  const useRealLLM = process.env['USE_REAL_LLM'] === 'true';
  return useRealLLM ? 300_000 : 10_000;
}

/** Log agent state snapshot (Req 21). */
function logAgentState(engine: CoffeeShopAssembledEngine): void {
  for (const id of ['agent-alice', 'agent-bob', 'agent-carol']) {
    const state = engine.agentManager.getState(id);
    if (!state) continue;
    const rels = engine.socialManager.getRelationships(id);
    const relSummary =
      Object.keys(rels).length > 0
        ? Object.entries(rels)
            .map(([other, rel]) => `${other}:t=${rel.trust},f=${rel.familiarity}`)
            .join('; ')
        : 'none';
    // eslint-disable-next-line no-console
    console.log(
      `[state] ${id}: location=${state.location}, ` +
        `drives={e=${state.drives.energy},h=${state.drives.hunger},` +
        `s=${state.drives.social},c=${state.drives.comfort},` +
        `cu=${state.drives.curiosity}}, ` +
        `thinking=${state.isThinking}, relationships=${relSummary}`,
    );
  }
}

async function main(): Promise<void> {
  const engine = buildCoffeeShopEngine();

  const durationMs = Number(process.env['SCENE_DURATION_MS'] ?? defaultDurationMs());
  const logIntervalMs = Number(process.env['LOG_INTERVAL_MS'] ?? '10000');

  // eslint-disable-next-line no-console
  console.log(`Starting Coffee Shop scene simulation (${durationMs}ms)...`);
  engine.gameLoop.start();

  // Periodic state logging (Req 21).
  const logTimer = setInterval(() => logAgentState(engine), logIntervalMs);

  // Run for the configured duration.
  await new Promise((resolve) => setTimeout(resolve, durationMs));

  clearInterval(logTimer);
  engine.gameLoop.stop();

  // Final state log.
  logAgentState(engine);

  // Token usage summary (spec 022, Req 10) — real LLM runs only.
  if (process.env['USE_REAL_LLM'] === 'true') {
    const total = engine.tokenUsageReporter.getTotalUsage();
    // eslint-disable-next-line no-console
    console.log(
      `[tokens] prompt=${total.promptTokens} completion=${total.completionTokens} ` +
        `total=${total.totalTokens}`,
    );
  }

  // ── Save/load demonstration (Req 22) ──────────────────────────────────────
  if (engine.persistence) {
    const saveState = await engine.persistence.save();
    // eslint-disable-next-line no-console
    console.log(
      `[save] agents=${saveState.agents.length}, ` +
        `objects=${saveState.world.objects.length}, ` +
        `memories=${saveState.memories.length}`,
    );

    // Write to file when a path is configured.
    const savePath = process.env['SAVE_FILE_PATH'] ?? './coffee-shop-save.json';
    await engine.persistence.saveToFile(savePath);
    // eslint-disable-next-line no-console
    console.log(`[save] Written to ${savePath}`);

    // Optional load demo (Req 22).
    if (process.env['DEMO_LOAD'] === 'true') {
      const fresh = buildCoffeeShopEngine();
      await fresh.persistence!.loadFromFile(savePath);
      const loaded = fresh.agentManager.getState('agent-alice');
      // eslint-disable-next-line no-console
      console.log(
        `[load] Alice: location=${loaded?.location}, ` + `energy=${loaded?.drives.energy}`,
      );
    }
  }
}

// Run only when executed directly (not when imported by tests).
const isMain = typeof process !== 'undefined' && process.argv[1]?.endsWith('coffee-shop.ts');
if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Coffee Shop scene failed:', err);
    process.exit(1);
  });
}
