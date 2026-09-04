/**
 * examples/assembly.ts — Shared cognition/memory assembly (spec 027, Req 1)
 * ────────────────────────────────────────────────────────────────────────────
 * Extracts the real-LLM subsystem wiring that was inlined in
 * `buildCoffeeShopEngine()` (spec 019) so that BOTH entry points — the
 * headless coffee-shop validation scene and the visualizer demo (spec 023/027)
 * — share one wiring source of truth instead of two code paths that drift.
 *
 * All `USE_REAL_LLM` / `USE_REAL_EMBEDDINGS` / `LLM_*` / `EMBEDDING_*` /
 * `MEMORY_*` env vars are read here, in one place:
 *   - `USE_REAL_LLM=true`   → OpenAICompatibleLLMClient + CognitiveToolExecutorImpl
 *   - `USE_REAL_EMBEDDINGS=true` → OnnxEmbeddingProvider + AffordanceClassifierImpl
 *   - defaults              → in-memory mock embeddings + drive-aware/mock LLM
 *
 * `buildCoffeeShopEngine()` (spec 019) and `startVisualizerDemo()` (spec 023/027)
 * both call `assembleCognitionStack()`, so env-var behavior is identical across
 * entry points (spec 027, AC-9).
 *
 * Order matters: the memory subsystem must be constructed BEFORE
 * `createEngineCore(config, memoryStore, vectorStore)` — the engine core's
 * reflect bridge captures the memory store at construction time. Use
 * `buildMemorySubsystem()` first, pass it to `createEngineCore`, then hand the
 * assembled core to `assembleCognitionStack()`.
 */

import type {
  MemoryDecayConfig,
  Affordance,
  LLMActionResponse,
  FormulatePlanResult,
  ReflectLLMResponse,
  GuardrailConfig,
  TopologyGuard,
  AffordanceGuard,
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
  type PPEROrchestratorImpl,
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
import type { EngineCore } from '@evol-hive/engine';
import { SocialManager } from '@evol-hive/engine';

// ── Mock embedding provider (no network, deterministic) ─────────────────────

/**
 * Mock embedding provider used when `USE_REAL_EMBEDDINGS` is not `'true'`.
 * Deterministic length-keyed vectors — no ONNX model, no network.
 */
export class MockEmbeddingProvider implements MemEmbeddingProvider {
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

/**
 * Default mock LLM used by `assembleCognitionStack()` when `USE_REAL_LLM` is
 * not `'true'` and the caller does not supply its own scene-aware mock.
 */
class DefaultMockLLMClient implements LLMClient {
  async completeStructured(_payload: LLMContextPayload): Promise<LLMActionResponse> {
    return { reasoning: 'Mock action.', action: 'observe' };
  }
  async completeReflection(): Promise<import('@evol-hive/shared').ReflectionResult> {
    return { agentId: 'mock', newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(_payload: LLMContextPayload): Promise<FormulatePlanResult> {
    return {
      description: 'Observe the environment',
      steps: [{ description: 'Observe', targetAffordance: 'observe' }],
    };
  }
  async completeReflect(_payload: LLMContextPayload): Promise<ReflectLLMResponse> {
    return { memoryContent: 'Observed the environment.' };
  }
}

// ── Memory subsystem (built before the engine core) ──────────────────────────

/** The memory subsystem pieces required by `createEngineCore()`. */
export interface MemorySubsystem {
  readonly embeddingProvider: MemEmbeddingProvider;
  readonly vectorStore: InMemoryVectorStore;
  readonly memoryStore: MemoryStore;
}

/**
 * Build the memory subsystem: embedding provider (`USE_REAL_EMBEDDINGS` →
 * OnnxEmbeddingProvider, otherwise mock), vector store, and memory store.
 * Must be called BEFORE `createEngineCore(config, memoryStore, vectorStore)`.
 */
export function buildMemorySubsystem(): MemorySubsystem {
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

  return { embeddingProvider, vectorStore, memoryStore };
}

// ── Cognition stack assembly ─────────────────────────────────────────────────

/** Options for {@link assembleCognitionStack}. */
export interface AssembleCognitionStackOptions {
  /**
   * The memory subsystem previously passed to `createEngineCore()`. When
   * omitted, a fresh one is built (fine for embedder-only consumers, but the
   * core's reflect bridge will not share it).
   */
  memory?: MemorySubsystem;
  /**
   * LLM client used when `USE_REAL_LLM` is not `'true'`. Defaults to a generic
   * no-network mock. Scene entry points pass their drive-aware mock (e.g.
   * `CoffeeShopMockLLMClient`).
   */
  mockLLMClient?: LLMClient;
  /**
   * Construct the memory decay service + reflection loop and expose them on
   * the engine core (spec 014). Default: `true`.
   */
  wireMemoryMaintenance?: boolean;
}

/**
 * The assembled cognition stack: the subsystem fields `CoffeeShopAssembledEngine`
 * adds beyond `AssembledEngine` (spec 027, Req 1), plus the decay config used.
 */
export interface CognitionStack {
  readonly socialManager: SocialManager;
  readonly llmClient: LLMClient;
  /** Token usage aggregation (spec 022, Req 10) — populated for real LLM runs. */
  readonly tokenUsageReporter: TokenUsageReporter;
  readonly guardrail: GuardrailEngineImpl;
  readonly embeddingProvider: MemEmbeddingProvider;
  readonly classifier: AffordanceClassifier;
  readonly vectorStore: InMemoryVectorStore;
  readonly cognitiveToolExecutor?: CognitiveToolExecutorImpl;
  readonly memoryDecayService?: MemoryDecayService;
  readonly reflectionLoop?: ReflectionLoop;
  /** The decay config applied to the memory decay service and maintenance system. */
  readonly decayConfig: MemoryDecayConfig;
  readonly orchestrator: PPEROrchestratorImpl;
}

/**
 * Read and validate the MEMORY_DECAY_RATE / MEMORY_PRUNE_THRESHOLD env vars
 * (spec 019, Req 13) into a MemoryDecayConfig.
 */
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

/**
 * Assemble the cognition subsystems on top of an engine core: SocialManager,
 * LLM client selection (`USE_REAL_LLM`), CognitiveToolExecutor, affordance
 * classifier (`USE_REAL_EMBEDDINGS`), guardrail engine, PPER orchestrator, and
 * (per options) the memory decay service + reflection loop. All env vars are
 * read here — one place, every entry point (spec 027, Req 1 / AC-9).
 *
 * @param core - An assembled engine core (created with the memory subsystem
 *   from {@link buildMemorySubsystem} so the reflect bridge shares it).
 * @param socialManager - Optional pre-built SocialManager. When omitted, a new
 *   one is constructed and wired into the perception bridge (spec 019, Req 8).
 * @param options - Optional memory subsystem / mock LLM / maintenance wiring.
 */
export function assembleCognitionStack(
  core: EngineCore,
  socialManager?: SocialManager,
  options: AssembleCognitionStackOptions = {},
): CognitionStack {
  const memory = options.memory ?? buildMemorySubsystem();
  const wireMemoryMaintenance = options.wireMemoryMaintenance ?? true;

  // ── SocialManager (spec 019, Req 8) ────────────────────────────────────────
  const social = socialManager ?? new SocialManager(core.agentManager);
  // Wire social perception into the perception bridge.
  core.bridges.perception.setSocialManager(social);

  // ── LLM client (spec 019, Req 5, Req 9) ───────────────────────────────────
  const useRealLLM = process.env['USE_REAL_LLM'] === 'true';
  const reasoningEffort = process.env['LLM_REASONING_EFFORT'] as
    'low' | 'medium' | 'high' | 'none' | undefined;

  // Spec 022 (Req 10): token usage aggregation — created always so the
  // end-of-run summary can report real token numbers when USE_REAL_LLM=true.
  const tokenUsageReporter = new TokenUsageReporter();

  const maxToolCallIterationsEnv = process.env['LLM_MAX_TOOL_CALL_ITERATIONS'];
  const maxToolCallIterations =
    maxToolCallIterationsEnv !== undefined ? Number(maxToolCallIterationsEnv) : undefined;

  // ── Guardrails (spec 019, Req 10; spec 030, Req 14) ──────────────────────
  const guardrailConfig: GuardrailConfig = {
    affordanceMasking: true,
    contextualForcing: true,
    planValidation: true,
    ...(process.env['LLM_MAX_SCENE_MUTATIONS_PER_CYCLE'] !== undefined
      ? { maxSceneMutationsPerCycle: Number(process.env['LLM_MAX_SCENE_MUTATIONS_PER_CYCLE']) }
      : {}),
  };
  // Topology-aware plan validation (spec 030, Req 10): the adapter reads the
  // core's CURRENT scene manager, staying correct across loadScene swaps.
  const topologyGuard: TopologyGuard = {
    isMovementBlocked: (agentId: string, action: string, fromRoom: string): boolean =>
      core.sceneManager.isMovementBlocked(agentId, action, fromRoom),
  };
  // Affordance co-location plan validation (spec 031, Req 5): the adapter
  // reads the core's live smart-object registry — objects move at runtime
  // (spec 030 move_object), so the guard must never trust a cached view.
  const affordanceGuard: AffordanceGuard = {
    isAffordanceAvailableInRoom: (affordanceId: string, roomId: string): boolean =>
      core.smartObjectRegistry.isAffordanceAvailableInRoom(affordanceId, roomId),
  };
  const guardrail = new GuardrailEngineImpl({ config: guardrailConfig, topologyGuard });

  // CognitiveToolExecutor (spec 019, Req 9) — only needed for real LLM (tool call loop).
  // The mutation port wires the modify_scene tool to the engine's mutation
  // funnel (spec 030, Req 13); the per-cycle budget comes from the guardrail
  // config (Req 14a).
  const cognitiveToolExecutor = useRealLLM
    ? new CognitiveToolExecutorImpl({
        stateDataProvider: core.bridges.reflect,
        socialBridge: social,
        mutationPort: core.mutationService,
        maxSceneMutationsPerCycle: guardrailConfig.maxSceneMutationsPerCycle ?? 1,
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
        embeddingProvider: memory.embeddingProvider,
        // Spec 022 (Req 10): opt-in token usage tracking — wired when token
        // reporting is enabled so `getTotalUsage()` can print totals at end.
        ...(useRealLLM ? { tokenUsageReporter } : {}),
      })
    : (options.mockLLMClient ?? new DefaultMockLLMClient());

  // ── Classifier (spec 019, Req 7) ──────────────────────────────────────────
  const useRealEmbeddings = process.env['USE_REAL_EMBEDDINGS'] === 'true';
  const classifier: AffordanceClassifier = useRealEmbeddings
    ? new AffordanceClassifierImpl(memory.embeddingProvider, defaultClassifierConfig())
    : makeMockClassifier();

  // ── PPER orchestrator ─────────────────────────────────────────────────────
  const orchestrator = createPPEROrchestrator({
    perceptionProvider: core.bridges.perception,
    planProvider: core.bridges.plan,
    executeProvider: core.bridges.execute,
    reflectProvider: core.bridges.reflect,
    classifier,
    llmClient,
    guardrail,
    affordanceGuard,
  });

  // ── Memory decay + reflection (spec 019, Req 13) ──────────────────────────
  let memoryDecayService: MemoryDecayService | undefined;
  let reflectionLoop: ReflectionLoop | undefined;
  const decayConfig = buildMemoryDecayConfig();
  if (wireMemoryMaintenance) {
    memoryDecayService = new MemoryDecayServiceImpl({
      vectorStore: memory.vectorStore,
      config: decayConfig,
    });
    const consolidationProvider = new ConsolidationProviderImpl({ llmClient });
    reflectionLoop = new ReflectionLoopImpl({
      vectorStore: memory.vectorStore,
      embeddingProvider: memory.embeddingProvider,
      consolidationProvider,
      config: defaultReflectionConfig,
      clock: () => core.gameLoop.currentTick().simulationTime,
    });
    // Expose on core for introspection (spec 019, Req 13).
    core.memoryDecayService = memoryDecayService;
    core.reflectionLoop = reflectionLoop;
    core.memoryMaintenanceConfig = decayConfig;
  }

  return {
    socialManager: social,
    llmClient,
    tokenUsageReporter,
    guardrail,
    embeddingProvider: memory.embeddingProvider,
    classifier,
    vectorStore: memory.vectorStore,
    ...(cognitiveToolExecutor !== undefined ? { cognitiveToolExecutor } : {}),
    ...(memoryDecayService !== undefined ? { memoryDecayService } : {}),
    ...(reflectionLoop !== undefined ? { reflectionLoop } : {}),
    decayConfig,
    orchestrator,
  };
}
