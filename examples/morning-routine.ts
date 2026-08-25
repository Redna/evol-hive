/**
 * examples/morning-routine.ts — "Morning Routine" prototype scene (spec 013, Req 20-24)
 * ────────────────────────────────────────────────────────────────────────────
 * A multi-room, multi-object, multi-agent scene demonstrating:
 *   - 4 connected rooms (bedroom → bathroom → living_room → kitchen)
 *   - Per-agent starting rooms (Alice in bedroom, Bob in living_room)
 *   - Object state depletion (Coffee Machine water/beans)
 *   - Drive prioritization via a drive-aware mock LLM
 *   - Room-to-room navigation via Doorway smart objects
 *
 * Run with: `npx tsx examples/morning-routine.ts`
 */

import type {
  SceneDefinition,
  Room,
  SmartObject,
  Affordance,
  AgentProfile,
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
import {
  createPPEROrchestrator,
  GuardrailEngineImpl,
  OpenAICompatibleLLMClient,
  CognitiveToolExecutorImpl,
} from '@evol-hive/cognition';
import type { AffordanceClassifier } from '@evol-hive/cognition';
import type {
  EmbeddingProvider as MemEmbeddingProvider,
  VectorStore,
  MemoryStore,
} from '@evol-hive/memory';
import { MemoryStoreImpl } from '@evol-hive/memory';
import { createEngineCore, assembleGameLoop, loadScene } from '@evol-hive/engine';
import type { AssembledEngine, EngineCore } from '@evol-hive/engine';
import { registerAffordanceHandlers } from './scene-helpers.ts';

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

/** Build a Doorway smart object for a room with go_to_<conn> affordances. */
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

// ── Room definitions (Req 20) ────────────────────────────────────────────────

const bedroom: Room = {
  id: 'bedroom',
  name: 'Bedroom',
  description: 'A cozy bedroom with a bed.',
  connections: ['bathroom', 'living_room'],
  objectIds: ['bed-1', 'doorway-bedroom'],
};

const bathroom: Room = {
  id: 'bathroom',
  name: 'Bathroom',
  description: 'A small bathroom with a shower.',
  connections: ['bedroom', 'living_room'],
  objectIds: ['shower-1', 'doorway-bathroom'],
};

const livingRoom: Room = {
  id: 'living_room',
  name: 'Living Room',
  description: 'A living room with a TV, bookshelf, and front door.',
  connections: ['bedroom', 'bathroom', 'kitchen'],
  objectIds: ['tv-1', 'bookshelf-1', 'front-door-1', 'doorway-living_room'],
};

const kitchen: Room = {
  id: 'kitchen',
  name: 'Kitchen',
  description: 'A kitchen with a coffee machine.',
  connections: ['living_room'],
  objectIds: ['coffee-1', 'doorway-kitchen'],
};

// ── Object definitions (Req 21) ──────────────────────────────────────────────

const bed: SmartObject = {
  id: 'bed-1',
  name: 'Bed',
  type: 'furniture',
  state: {},
  affordances: [aff('sleep', 'Sleep', [], { energy: 30, comfort: -5 }), observeAffordance],
  roomId: 'bedroom',
};

const shower: SmartObject = {
  id: 'shower-1',
  name: 'Shower',
  type: 'fixture',
  state: { water_level: 10 },
  affordances: [
    aff('take_shower', 'Take a shower', ['has_water'], { comfort: 25, energy: -5 }),
    observeAffordance,
  ],
  roomId: 'bathroom',
};

const tv: SmartObject = {
  id: 'tv-1',
  name: 'TV',
  type: 'electronics',
  state: { powered_on: true },
  affordances: [
    aff('watch_tv', 'Watch TV', ['is_powered'], { comfort: 15, energy: -5, curiosity: 5 }),
    observeAffordance,
  ],
  roomId: 'living_room',
};

const bookshelf: SmartObject = {
  id: 'bookshelf-1',
  name: 'Bookshelf',
  type: 'furniture',
  state: { book_count: 8 },
  affordances: [
    aff('read_book', 'Read a book', ['has_books'], { curiosity: 20, energy: -10 }),
    observeAffordance,
  ],
  roomId: 'living_room',
};

const frontDoor: SmartObject = {
  id: 'front-door-1',
  name: 'Front Door',
  type: 'fixture',
  state: {},
  affordances: [aff('go_outside', 'Go outside', [], {}), observeAffordance],
  roomId: 'living_room',
};

const coffeeMachine: SmartObject = {
  id: 'coffee-1',
  name: 'Coffee Machine',
  type: 'appliance',
  state: { water_level: 5, bean_count: 12 },
  affordances: [
    aff('brew_coffee', 'Brew coffee', ['has_water', 'has_beans'], { energy: 20 }),
    observeAffordance,
  ],
  roomId: 'kitchen',
};

// ── Agent definitions (Req 22) ────────────────────────────────────────────────

const alice: AgentProfile = {
  id: 'agent-alice',
  name: 'Alice',
  description: 'A caffeine-dependent researcher who needs coffee to start the day.',
  traits: ['diligent', 'caffeine-dependent'],
  initialDrives: { energy: 15, hunger: 60, social: 40, comfort: 50, curiosity: 30 },
  startRoomId: 'bedroom',
};

const bob: AgentProfile = {
  id: 'agent-bob',
  name: 'Bob',
  description: 'A social morning person who wants to chat and relax.',
  traits: ['social', 'easygoing'],
  initialDrives: { energy: 50, hunger: 40, social: 15, comfort: 60, curiosity: 50 },
  startRoomId: 'living_room',
};

// ── Scene definition (Req 23) ─────────────────────────────────────────────────

export const MORNING_ROUTINE_SCENE: SceneDefinition = {
  id: 'morning-routine',
  name: 'Morning Routine',
  rooms: [bedroom, bathroom, livingRoom, kitchen],
  objects: [
    bed,
    shower,
    tv,
    bookshelf,
    frontDoor,
    coffeeMachine,
    makeDoorway('bedroom', bedroom.connections),
    makeDoorway('bathroom', bathroom.connections),
    makeDoorway('living_room', livingRoom.connections),
    makeDoorway('kitchen', kitchen.connections),
  ],
  agents: [alice, bob],
};

// ── Drive-aware mock LLM (Req 24) ────────────────────────────────────────────

/**
 * Mock LLM that selects an affordance based on the agent's primary drive label
 * (parsed from the `perceptionContext` string) and current room (also parsed
 * from `perceptionContext`). Not real intelligence — a deterministic heuristic.
 */
export class MorningRoutineMockLLMClient implements LLMClient {
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
    const { room, drive } = parseContext(payload.perceptionContext);
    const target = this.selectAffordance(room, drive);
    return {
      description: `Address ${drive} drive in ${room}`,
      steps: [{ description: `Use ${target}`, targetAffordance: target }],
    };
  }

  async completeReflect(_payload: LLMContextPayload): Promise<ReflectLLMResponse> {
    return {
      memoryEntry: {
        content: 'Completed an action in the morning routine.',
        importance: 5,
        type: 'action',
        location: 'bedroom',
      },
    };
  }

  /**
   * Select an affordance that addresses the primary drive, based on the agent's
   * current room. Falls back to `observe` when no drive-specific affordance is
   * available.
   */
  private selectAffordance(room: string, drive: string): string {
    // Energy restoration.
    if (drive === 'energy') {
      if (room === 'kitchen') return 'brew_coffee';
      if (room === 'bedroom') return 'sleep';
      // In another room → move toward kitchen (via living_room).
      if (room === 'living_room') return 'go_to_kitchen';
      if (room === 'bathroom') return 'go_to_living_room';
      return 'go_to_kitchen';
    }
    // Comfort restoration.
    if (drive === 'comfort') {
      if (room === 'living_room') return 'watch_tv';
      if (room === 'bathroom') return 'take_shower';
      if (room === 'bedroom') return 'go_to_living_room';
      return 'go_to_living_room';
    }
    // Curiosity restoration.
    if (drive === 'curiosity') {
      if (room === 'living_room') return 'read_book';
      return 'go_to_living_room';
    }
    // Social restoration — no social affordances in the Morning Routine scene,
    // so move toward the living room where other agents may be. When already in
    // the living room with another agent present, `observe` acknowledges the
    // other agent without pretending the social drive is satisfied by TV
    // (spec 019, Req 13). Full `talk_to` requires a real LLM (USE_REAL_LLM).
    if (drive === 'social') {
      if (room === 'living_room') return 'observe';
      return 'go_to_living_room';
    }
    // Hunger — no food affordances in this scene; observe as fallback.
    return 'observe';
  }
}

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

// ── Engine assembly (Req 23) ──────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

export function buildMorningRoutineEngine(): AssembledEngine {
  return buildEngine(MORNING_ROUTINE_SCENE, () => new MorningRoutineMockLLMClient());
}

/** Shared engine builder used by both scene entry points. */
function buildEngine(scene: SceneDefinition, makeMockLLM: () => LLMClient): AssembledEngine {
  const config = makeConfig();

  const vectorStore = new InMemoryVectorStore();
  const embeddingProvider: MemEmbeddingProvider = new MockEmbeddingProvider();
  const memoryStore: MemoryStore = new MemoryStoreImpl({ vectorStore, embeddingProvider });

  const core: EngineCore = createEngineCore(config, memoryStore);
  loadScene(core, scene);
  registerAffordanceHandlers(core);

  // LLM client — real OpenAI-compatible LLM when USE_REAL_LLM=true (spec 019, Req 9),
  // otherwise the drive-aware mock LLM (backward compatible).
  const useRealLLM = process.env['USE_REAL_LLM'] === 'true';
  const reasoningEffort = process.env['LLM_REASONING_EFFORT'] as
    | 'low'
    | 'medium'
    | 'high'
    | 'none'
    | undefined;
  const maxToolCallIterationsEnv = process.env['LLM_MAX_TOOL_CALL_ITERATIONS'];
  const maxToolCallIterations =
    maxToolCallIterationsEnv !== undefined ? Number(maxToolCallIterationsEnv) : undefined;

  let llmClient: LLMClient;
  if (useRealLLM) {
    const cognitiveToolExecutor = new CognitiveToolExecutorImpl({
      stateDataProvider: core.bridges.reflect,
      socialBridge: core.socialManager,
    });
    llmClient = new OpenAICompatibleLLMClient({
      baseUrl: process.env['LLM_BASE_URL'] ?? 'http://localhost:11434/v1',
      model: process.env['LLM_MODEL'] ?? 'llama3.1',
      ...(process.env['LLM_API_KEY'] !== undefined
        ? { apiKey: process.env['LLM_API_KEY'] }
        : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      cognitiveToolExecutor,
      ...(maxToolCallIterations !== undefined ? { maxToolCallIterations } : {}),
    });
  } else {
    llmClient = makeMockLLM();
  }

  const classifier: AffordanceClassifier = makeMockClassifier();

  const guardrail =
    config.guardrailsEnabled
      ? new GuardrailEngineImpl(config.guardrails)
      : undefined;

  const orchestrator = createPPEROrchestrator({
    perceptionProvider: core.bridges.perception,
    planProvider: core.bridges.plan,
    executeProvider: core.bridges.execute,
    reflectProvider: core.bridges.reflect,
    classifier,
    llmClient,
    ...(guardrail !== undefined ? { guardrail } : {}),
  });

  const gameLoop = assembleGameLoop(core, orchestrator);

  return {
    gameLoop,
    agentManager: core.agentManager,
    sceneManager: core.sceneManager,
    smartObjectRegistry: core.smartObjectRegistry,
    affordanceRegistry: core.affordanceRegistry,
    bridges: core.bridges,
    socialManager: core.socialManager,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse the room ID and primary drive name from a perceptionContext string. */
function parseContext(perceptionContext: string): { room: string; drive: string } {
  const roomMatch = perceptionContext.match(/^Room: (.+)$/m);
  const driveMatch = perceptionContext.match(/Primary drive: low (\w+),/);
  return {
    room: roomMatch ? roomMatch[1]! : '',
    drive: driveMatch ? driveMatch[1]! : '',
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const engine = buildMorningRoutineEngine();
  // eslint-disable-next-line no-console
  console.log('Starting Morning Routine scene simulation…');
  engine.gameLoop.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  engine.gameLoop.stop();
  const aliceState = engine.agentManager.getState('agent-alice');
  const bobState = engine.agentManager.getState('agent-bob');
  // eslint-disable-next-line no-console
  console.log(
    `Alice: energy=${aliceState?.drives.energy}, location=${aliceState?.location}, thinking=${aliceState?.isThinking}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `Bob: social=${bobState?.drives.social}, location=${bobState?.location}, thinking=${bobState?.isThinking}`,
  );
}

const isMain = typeof process !== 'undefined' && process.argv[1]?.endsWith('morning-routine.ts');
if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Morning Routine scene failed:', err);
    process.exit(1);
  });
}
