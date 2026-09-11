/**
 * @evol-hive/assembly — the composition root (spec 050, issue #166)
 * ────────────────────────────────────────────────────────────────────────────
 * ONE assembler for the whole world. `assembleWorld()` internally calls
 * `createEngineCore` (all engine wiring: agent/drive/plan managers, physics +
 * spatial + scene manager, SocialManager ↔ ConversationManager ↔ self-model ↔
 * consolidation sink, mutation funnel + dormancy + YAAM log, the four data
 * provider bridges — perception wired with social/conversation/self-model/
 * tick-source, persistence, scheduler config) AND builds the cognition stack
 * (LLM client incl. `USE_REAL_LLM` selection, guardrail engine + topology and
 * affordance guards, System-0 classifier incl. `USE_REAL_EMBEDDINGS`, PPER
 * orchestrator, token usage reporter), memory maintenance (decay service,
 * reflection loop, configs), System 1 (gate, importance head, feature service,
 * outcome recorder, salience-weighted identity hook, session sample log), and
 * calls `assembleGameLoop` with all of it — no optional wires left to the
 * caller (R2).
 *
 * This package is the ONLY place allowed to depend on both `@evol-hive/engine`
 * and `@evol-hive/cognition` (ADR-0001: the two never import each other; a
 * package ABOVE both preserves the acyclic dependency graph — Decision 1 of
 * the spec-050 workspace notes). `examples/assembly.ts` — the second wiring
 * path that had already diverged twice (#155 stale renderer, #165 dormant
 * conversation bridge) — is deleted by this spec; every consumer (all sims,
 * `packages/cli` `run-scene`) passes config + env only (R3).
 *
 * All `USE_REAL_LLM` / `USE_REAL_EMBEDDINGS` / `LLM_*` / `EMBEDDING_*` /
 * `MEMORY_*` env vars are read here, in one place (spec 027, Req 1 / AC-9,
 * now structurally enforced):
 *   - `USE_REAL_LLM=true`   → OpenAICompatibleLLMClient + CognitiveToolExecutorImpl
 *   - `USE_REAL_EMBEDDINGS=true` → OnnxEmbeddingProvider + AffordanceClassifierImpl
 *   - defaults              → in-memory mock embeddings + drive-aware/mock LLM
 *
 * Order matters (R5): the memory subsystem is constructed BEFORE
 * `createEngineCore(config, memoryStore, vectorStore)` — the engine core's
 * reflect bridge captures the memory store at construction time.
 * `assembleWorld()` does this internally; `buildMemorySubsystem()` is exported
 * for callers that need to pre-build a subsystem.
 *
 * Scene data stays CALLER-side by design (spec 050 constraint): `loadScene`
 * and affordance-handler registration are scene data, not wiring — the
 * `sceneSetup` hook runs between `createEngineCore` and the loop assembly.
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
  System1GatePort,
  System1IdentityTriggerPort,
  System1OutcomeProbePort,
  System1OutcomeRecorderPort,
  System1FeatureRefresherPort,
  GateWeightArtifact,
  AutoSaveConfig,
  EngineConfig,
  PPERCycleOutcome,
  PPEROrchestratorPort,
  PPERPhase,
} from '@evol-hive/shared';
import {
  defaultEngineConfig,
  defaultMemoryDecayConfig,
  defaultReflectionConfig,
  defaultSystem1GateConfig,
  overrideSchedulerConfig,
} from '@evol-hive/shared';
import type {
  LLMClient,
  LLMContextPayload,
  AffordanceClassifier,
  IdentityProposalProvider,
} from '@evol-hive/cognition';
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
  IdentityConsolidationServiceImpl,
  InMemorySampleLogWriter,
  JsonlSessionSampleLog,
  LinearImportanceHead,
  makeFileSampleLogWriter,
  ReactGateHead,
  SalienceAccumulator,
  SalienceWeightedIdentityService,
  System1FeatureServiceImpl,
  System1GateServiceImpl,
  makeFileArtifactLoader,
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
import {
  GameLoopImpl,
  SocialManager,
  System1AgentTracker,
  System1OutcomeRecorderImpl,
} from '@evol-hive/engine';
import { createEngineCore, assembleGameLoop } from '@evol-hive/engine';

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

// ── No-op orchestrator (mock parity for entry points that run no cycles) ─────

/**
 * Minimal no-op orchestrator: mock mode runs no cycles — nothing was ever
 * applied (spec 041 causal outcome). The former per-entry-point classes
 * (`MockOrchestrator` in visualizer-demo, `NoopOrchestrator` in
 * dynamic-world-sim) are now this one class, so a consumer can hand the
 * assembler's mock-mode orchestrator to a visualizer adapter unchanged.
 */
export class MockOrchestrator implements PPEROrchestratorPort {
  async runCycle(_agentId: string): Promise<PPERCycleOutcome> {
    return { appliedDriveChanges: false };
  }
  getPhase(_agentId: string): PPERPhase {
    return 'perceive';
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
 * Must run BEFORE the engine core is created — the core's reflect bridge
 * captures the memory store at construction time. `assembleWorld()` does this
 * internally; consumers never construct memory stores directly (R5).
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
  const memoryStore: MemoryStore = new MemoryStoreImpl({
    vectorStore,
    embeddingProvider,
  });

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
 * The assembled cognition stack: the subsystem fields consumers observe beyond
 * the engine core (spec 027, Req 1), plus the decay config used.
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
 * Assemble the cognition subsystems on top of an engine core: the social
 * surface, LLM client selection (`USE_REAL_LLM`), CognitiveToolExecutor,
 * affordance classifier (`USE_REAL_EMBEDDINGS`), guardrail engine, PPER
 * orchestrator, and (per options) the memory decay service + reflection loop.
 * All env vars are read here — one place, every entry point (spec 027, Req 1
 * / AC-9).
 *
 * @param core - An assembled engine core (created with the memory subsystem
 *   from {@link buildMemorySubsystem} so the reflect bridge shares it).
 * @param socialManager - Optional pre-built SocialManager. When omitted, the
 *   core's own SocialManager is used — the exact instance `createEngineCore`
 *   built and wired into the perception bridge (spec 019, Req 8 / spec 045
 *   R2: exactly one SocialManager holds both roles; this promoted assembler
 *   constructs none — that would be a second manager, the #165 drift shape).
 * @param options - Optional memory subsystem / mock LLM / maintenance wiring.
 */
export function assembleCognitionStack(
  core: EngineCore,
  socialManager?: SocialManager,
  options: AssembleCognitionStackOptions = {},
): CognitionStack {
  const memory = options.memory ?? buildMemorySubsystem();
  const wireMemoryMaintenance = options.wireMemoryMaintenance ?? true;

  // ── Social surface (spec 019, Req 8; spec 045 R2) ──────────────────────────
  // The core's SocialManager is THE manager: it is already wired into the
  // perception bridge (createEngineCore) and already carries the conversation
  // delegate (spec 043 pending-address data, spec 044 reciprocity). When a
  // caller injects one explicitly (component tests), the same two wires are
  // applied to it — never creating a second manager.
  const social = socialManager ?? core.socialManager;
  core.bridges.perception.setSocialManager(social);
  social.setConversationManager(core.conversationManager);

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
        // Spec 045 (R1): talk_to joins/opens real conversation threads via
        // spec 033 R1/R3 openOrContribute — the delta becomes a
        // deterministic function of the conversation's aggregate sentiment
        // (spec 033 R6) instead of the legacy blind +5/+2 fallback (kept
        // for unwired contexts, spec 033 AC-14).
        conversationBridge: core.conversationManager,
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

// ─────────────────────────────────────────────────────────────────────────────
// System 1 trainable heads (spec 035, issue #132) — application wiring
// ─────────────────────────────────────────────────────────────────────────────

/** Options for {@link assembleSystem1}. */
export interface System1AssemblyOptions {
  /**
   * Path to the versioned gate artifact. When omitted, the gate fails OPEN
   * (every tick cycles — today's behavior) after a single warning (Req 6).
   * Point this at `training/artifacts/*.json` (see `training/README.md`).
   */
  gateArtifactPath?: string;
  /**
   * Directory for per-agent JSONL session sample logs (Req 9). When omitted,
   * samples land in an in-memory sink (introspection only).
   */
  sessionLogDir?: string;
  /**
   * LLM proposal provider for the salience-weighted identity hook (Req 16/17).
   * When omitted, a zero-proposal provider is used (identity never drifts —
   * the machinery is wired, the LLM path stays off).
   */
  identityProposalProvider?: IdentityProposalProvider;
}

/** The assembled System 1 pieces — pass the ports to {@link assembleGameLoop}. */
export interface System1Assembled {
  gate: System1GatePort;
  outcomeRecorder: System1OutcomeRecorderPort;
  featureRefresher: System1FeatureServiceImpl;
  identityTrigger?: System1IdentityTriggerPort;
  /** Hot-swap a dream-updated artifact into the live gate (Req 12). */
  hotSwapGateArtifact: (artifact: GateWeightArtifact) => void;
  gateHead: ReactGateHead;
  importanceHead: LinearImportanceHead;
  salience: SalienceWeightedIdentityService;
  sampleLog: JsonlSessionSampleLog;
}

/** Zero-proposal identity provider (used when no LLM provider is wired). */
const nullIdentityProposalProvider: IdentityProposalProvider = {
  async proposeIdentityDeltas() {
    return { deltas: [] };
  },
};

/**
 * Builds the System 1 services (cognition side) + the engine-side outcome
 * probe and wires them into the port shape {@link assembleGameLoop} consumes.
 * Gating is fail-open by construction: no artifact → every tick cycles
 * (spec 035, Req 6), so enabling this wiring is behavior-safe.
 */
export function assembleSystem1(
  core: EngineCore,
  memory: { embeddingProvider: MemEmbeddingProvider; vectorStore: InMemoryVectorStore },
  options: System1AssemblyOptions = {},
): System1Assembled {
  // ── Gate + importance heads (lazy artifact load, fail-open) ──────────────
  // Exploration factor (spec 036): default-off per spec; SYSTEM1_EPSILON_BASE
  // opts a run in (typical 0.1–0.3). Exploration draws produce IGNORE-labeled
  // outcome samples — the counterfactual data a greedy gate never generates
  // (without it, dream retraining can only reconfirm "always react": 6,050
  // react vs 7 ignore in grand10+grand12 session logs).
  const epsilonBaseEnv = process.env['SYSTEM1_EPSILON_BASE'];
  const gateHead = new ReactGateHead({
    loader: options.gateArtifactPath
      ? makeFileArtifactLoader(options.gateArtifactPath)
      : async () => null,
    threshold: defaultSystem1GateConfig().threshold,
    ...(epsilonBaseEnv !== undefined
      ? {
          epsilonBase: Number(epsilonBaseEnv),
          curiositySource: (agentId: string): number => {
            const s = core.agentManager.getState(agentId);
            const c = s?.drives['curiosity'];
            return typeof c === 'number' ? c : 0;
          },
        }
      : {}),
  });
  void gateHead.ensureLoaded(); // best-effort; fail-open until the artifact lands

  const importanceHead = new LinearImportanceHead({
    loader: options.gateArtifactPath
      ? makeFileArtifactLoader(options.gateArtifactPath)
      : async () => null,
  });
  void importanceHead.ensureLoaded();

  // ── Feature service (cached features; scalar sync + embedding async) ─────
  const featureService = new System1FeatureServiceImpl({
    embeddingProvider: memory.embeddingProvider,
    recentMemories: {
      async getRecentMemoryEmbeddings(agentId, k) {
        const nodes = await memory.vectorStore.queryByAgent(agentId);
        return nodes
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, k)
          .map((n) => n.embedding);
      },
    },
  });

  const gate = new System1GateServiceImpl({ head: gateHead, featureSource: featureService });

  // ── Session sample log (Req 9): per-agent JSONL or in-memory ─────────────
  const sampleLog = options.sessionLogDir
    ? new JsonlSessionSampleLog(makeFileSampleLogWriter(options.sessionLogDir))
    : new JsonlSessionSampleLog(new InMemorySampleLogWriter());

  // ── Outcome probe (engine state → OutcomeSnapshot) ────────────────────────
  const tracker = new System1AgentTracker();
  const probe: System1OutcomeProbePort = {
    async snapshot(agentId) {
      const state = core.agentManager.getState(agentId);
      const plan = state?.currentPlan ?? null;
      let memoryCount: number;
      try {
        memoryCount = (await memory.vectorStore.countByAgent(agentId)) ?? 0;
      } catch {
        memoryCount = 0;
      }
      let conversationTurns = 0;
      for (const conversation of core.conversationManager.listConversationsInRoom(
        state?.location ?? '',
      )) {
        const me = conversation.participants.find((p) => p.agentId === agentId);
        if (me && conversation.status !== 'closed') {
          conversationTurns = Math.max(conversationTurns, me.turnCount);
        }
      }
      const mutations = core.mutationService.getMutations();
      const lastSeq = mutations.length > 0 ? (mutations[mutations.length - 1]?.seq ?? 0) : 0;
      return {
        planId: plan?.id ?? null,
        planStepIndex: plan?.currentStepIndex ?? 0,
        drives: state?.drives ?? {},
        memoryCount,
        conversationTurns,
        planStepIds: plan?.steps.map((s) => s.targetAffordance ?? '') ?? [],
        mutationSeq: lastSeq,
      };
    },
  };

  const outcomeRecorder = new System1OutcomeRecorderImpl({
    probe,
    sink: sampleLog,
    tracker,
    featureSource: featureService,
  });
  core.system1Tracker = tracker;

  // ── Salience-weighted identity hook (Req 16/17) ──────────────────────────
  const salience = new SalienceWeightedIdentityService({
    inner: new IdentityConsolidationServiceImpl({
      selfModelBridge: core.selfModelManager,
      provider: options.identityProposalProvider ?? nullIdentityProposalProvider,
    }),
    accumulator: new SalienceAccumulator(),
  });
  const identityTrigger: System1IdentityTriggerPort = {
    tick(agentId: string): void {
      if (!salience.shouldConsolidateMidSession(agentId)) return;
      void salience.consolidateMidSession(agentId, []).catch(() => {
        // A failed mid-session pass must never break the loop.
      });
    },
  };

  return {
    gate,
    outcomeRecorder,
    featureRefresher: featureService,
    identityTrigger,
    hotSwapGateArtifact: (artifact) => gateHead.hotSwap(artifact),
    gateHead,
    importanceHead,
    salience,
    sampleLog,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The promoted assembler (spec 050, R1–R6)
// ─────────────────────────────────────────────────────────────────────────────

/** Options for {@link assembleWorld}. Config + env + scene data only (R3). */
export interface AssembleWorldOptions {
  /**
   * Engine configuration. When omitted, `defaultEngineConfig()` is used
   * (env-driven where defined). The `maxConcurrentLLM` field is consumed by
   * the scheduler via {@link overrideSchedulerConfig} (spec 050, R6).
   */
  config?: EngineConfig;
  /**
   * Scene-data hook (spec 050 constraint — scene data stays caller-side):
   * runs between `createEngineCore` and the cognition/loop wiring. Put
   * `loadScene`, `autoRegisterHandlers`, and per-scene affordance handlers
   * here. NEVER wiring: components and ports are assembled by this function
   * regardless of what the hook does.
   */
  sceneSetup?: (core: EngineCore) => void;
  /**
   * Pre-built memory subsystem (R5). When omitted, the assembler builds one
   * from env (`USE_REAL_EMBEDDINGS`) BEFORE the engine core, so the reflect
   * bridge and persistence capture the same store.
   */
  memory?: MemorySubsystem;
  /**
   * Scene-aware mock LLM used when `USE_REAL_LLM` is not `'true'`
   * (e.g. a drive-aware scene mock). Providing one makes the assembler build
   * a real orchestrator driven by the mock in mock mode; without it (and
   * without `USE_REAL_LLM`), the assembler wires a no-op orchestrator —
   * no cycles run, nothing applied (the former per-entry-point
   * `NoopOrchestrator`/`MockOrchestrator` mock parity).
   */
  mockLLMClient?: LLMClient;
  /**
   * Construct the memory decay service + reflection loop (spec 014).
   * Default: `true` on the cognition paths.
   */
  wireMemoryMaintenance?: boolean;
  /**
   * System 1 trainable heads wiring (spec 035): gate artifact path, session
   * sample log dir, salience identity provider. When omitted, no System 1
   * ports are wired (the scheduler behaves exactly as before spec 035).
   */
  system1?: System1AssemblyOptions;
  /**
   * Auto-save configuration (spec 017). When provided, `core.autoSaveConfig`
   * is set and the AutoSaveSystem is registered (requires a vector store —
   * present on every cognition path).
   */
  autoSave?: AutoSaveConfig;
}

/** The fully assembled world: engine core + wired loop + cognition stack. */
export interface AssembledWorld {
  /** The engine core (subsystems + bridges; scene data applied via `sceneSetup`). */
  readonly core: EngineCore;
  /** The registered game loop (also `core.gameLoop`). */
  readonly gameLoop: GameLoopImpl;
  /** The PPER orchestrator driving cycles (no-op instance in mock mode). */
  readonly orchestrator: import('@evol-hive/shared').PPEROrchestratorPort;
  /** The cognition stack — `undefined` in no-op mock mode (no cycles run). */
  readonly stack?: CognitionStack;
  /** System 1 pieces — present when `options.system1` was provided. */
  readonly system1?: System1Assembled;
  /** The memory subsystem the world was built around (undefined in no-op mock mode). */
  readonly memory?: MemorySubsystem;
}

/** Map the assembled System 1 pieces onto {@link assembleGameLoop}'s port shape. */
function toSystem1Ports(system1: System1Assembled): {
  gate: System1GatePort;
  outcomeRecorder?: System1OutcomeRecorderPort;
  identityTrigger?: System1IdentityTriggerPort;
  featureRefresher?: System1FeatureRefresherPort;
} {
  return {
    gate: system1.gate,
    outcomeRecorder: system1.outcomeRecorder,
    featureRefresher: system1.featureRefresher,
    ...(system1.identityTrigger !== undefined ? { identityTrigger: system1.identityTrigger } : {}),
  };
}

/**
 * Assemble the whole world — the single wiring source of truth (spec 050).
 *
 * @param options - config + env + scene data; see {@link AssembleWorldOptions}.
 */
export function assembleWorld(options: AssembleWorldOptions = {}): AssembledWorld {
  const config = options.config ?? defaultEngineConfig();
  const useRealLLM = process.env['USE_REAL_LLM'] === 'true';
  const wantsCognition = useRealLLM || options.mockLLMClient !== undefined;

  // ── Memory subsystem FIRST (R5): the engine core's reflect bridge captures
  // the memory store at construction time, and persistence captures the vector
  // store. No-cognition mock mode keeps the former shape: no subsystem at all
  // (the engine core uses its internal NullMemoryStore).
  const memory: MemorySubsystem | undefined =
    options.memory ??
    (wantsCognition || options.system1 !== undefined ? buildMemorySubsystem() : undefined);

  const core = createEngineCore(config, memory?.memoryStore, memory?.vectorStore);

  // ── Scene data (caller-side by design): loadScene + handler registration
  // run between the core and the cognition/loop wiring (spec 050 constraint).
  options.sceneSetup?.(core);

  // ── R6: forward `EngineConfig.maxConcurrentLLM` to the scheduler — unless a
  // scene-level config exists (spec 022 Req 1 keeps precedence) or the
  // `ENGINE_MAX_CONCURRENT_LLM` env var is set (spec 022 R4; forwarded via
  // `defaultPPERSchedulerConfig()` when the override is omitted).
  const schedulerConfig =
    core.sceneSchedulerConfig !== undefined ? undefined : overrideSchedulerConfig(config);

  const autoSaveArg = options.autoSave !== undefined ? { config: options.autoSave } : undefined;
  if (options.autoSave !== undefined) core.autoSaveConfig = options.autoSave;

  if (!wantsCognition) {
    // No-cognition mock parity (spec 027-era behavior): a no-op orchestrator
    // drives nothing — "nothing was ever applied" (spec 041 causal outcome).
    // System 1 wiring is honored when explicitly requested (it needs the
    // memory subsystem, which the assembler built above in that case).
    const system1 =
      options.system1 !== undefined && memory !== undefined
        ? assembleSystem1(core, memory, options.system1)
        : undefined;
    assembleGameLoop(
      core,
      new MockOrchestrator(),
      undefined,
      autoSaveArg,
      schedulerConfig,
      ...(system1 !== undefined ? [toSystem1Ports(system1)] : []),
    );
    return {
      core,
      gameLoop: core.gameLoop,
      orchestrator: new MockOrchestrator(),
      ...(system1 !== undefined ? { system1 } : {}),
    };
  }

  // ── The cognition stack + memory maintenance (R2). `memory` is always
  // defined on this path (built above or caller-supplied).
  const stack = assembleCognitionStack(core, undefined, {
    ...(memory !== undefined ? { memory } : {}),
    ...(options.mockLLMClient !== undefined ? { mockLLMClient: options.mockLLMClient } : {}),
    ...(options.wireMemoryMaintenance !== undefined
      ? { wireMemoryMaintenance: options.wireMemoryMaintenance }
      : {}),
  });

  const system1 =
    options.system1 !== undefined && memory !== undefined
      ? assembleSystem1(core, memory, options.system1)
      : undefined;

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
    autoSaveArg,
    schedulerConfig,
    ...(system1 !== undefined ? [toSystem1Ports(system1)] : []),
  );

  return {
    core,
    gameLoop: core.gameLoop,
    orchestrator: stack.orchestrator,
    stack,
    ...(system1 !== undefined ? { system1 } : {}),
    ...(memory !== undefined ? { memory } : {}),
  };
}
