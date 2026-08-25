/**
 * examples/office-day.ts — "Office Day" prototype scene (spec 013, Req 25-29)
 * ────────────────────────────────────────────────────────────────────────────
 * A multi-room, multi-object, multi-agent office scene demonstrating:
 *   - 4 connected rooms (office → break_room → meeting_room → bathroom)
 *   - 3 agents with distinct drives and starting rooms
 *   - Social affordances via objects (Water Cooler, Meeting Table, Whiteboard)
 *   - Object state depletion (Coffee Machine, Printer)
 *   - Drive prioritization via a drive-aware mock LLM
 *
 * Run with: `npx tsx examples/office-day.ts`
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
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '@evol-hive/cognition';
import { createPPEROrchestrator, GuardrailEngineImpl } from '@evol-hive/cognition';
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

// ── Room definitions (Req 25) ─────────────────────────────────────────────────

const office: Room = {
  id: 'office',
  name: 'Office',
  description: 'A workspace with a computer and printer.',
  connections: ['break_room', 'meeting_room'],
  objectIds: ['computer-1', 'printer-1', 'doorway-office'],
};

const breakRoom: Room = {
  id: 'break_room',
  name: 'Break Room',
  description: 'A break room with a coffee machine and water cooler.',
  connections: ['office', 'bathroom'],
  objectIds: ['coffee-2', 'cooler-1', 'doorway-break_room'],
};

const meetingRoom: Room = {
  id: 'meeting_room',
  name: 'Meeting Room',
  description: 'A meeting room with a whiteboard and meeting table.',
  connections: ['office'],
  objectIds: ['whiteboard-1', 'table-1', 'doorway-meeting_room'],
};

const bathroom: Room = {
  id: 'bathroom',
  name: 'Bathroom',
  description: 'A bathroom with a toilet and sink.',
  connections: ['break_room'],
  objectIds: ['toilet-1', 'sink-1', 'doorway-bathroom'],
};

// ── Object definitions (Req 26) ───────────────────────────────────────────────

const computer: SmartObject = {
  id: 'computer-1',
  name: 'Computer',
  type: 'electronics',
  state: { tasks_completed: 0 },
  affordances: [aff('work', 'Work', [], { energy: -15 }), observeAffordance],
  roomId: 'office',
};

const whiteboard: SmartObject = {
  id: 'whiteboard-1',
  name: 'Whiteboard',
  type: 'fixture',
  state: { ideas_generated: 0 },
  affordances: [
    aff('brainstorm', 'Brainstorm', [], { curiosity: 15, social: 5, energy: -10 }),
    observeAffordance,
  ],
  roomId: 'meeting_room',
};

const coffeeMachine: SmartObject = {
  id: 'coffee-2',
  name: 'Coffee Machine',
  type: 'appliance',
  state: { water_level: 8, bean_count: 20 },
  affordances: [
    aff('brew_coffee', 'Brew coffee', ['has_water', 'has_beans'], { energy: 20 }),
    observeAffordance,
  ],
  roomId: 'break_room',
};

const waterCooler: SmartObject = {
  id: 'cooler-1',
  name: 'Water Cooler',
  type: 'fixture',
  state: {},
  affordances: [aff('small_talk', 'Small talk', [], { social: 15, energy: -2 }), observeAffordance],
  roomId: 'break_room',
};

const meetingTable: SmartObject = {
  id: 'table-1',
  name: 'Meeting Table',
  type: 'furniture',
  state: { meetings_held: 0 },
  affordances: [
    aff('hold_meeting', 'Hold a meeting', [], { social: 20, energy: -15, comfort: -5 }),
    observeAffordance,
  ],
  roomId: 'meeting_room',
};

const printer: SmartObject = {
  id: 'printer-1',
  name: 'Printer',
  type: 'electronics',
  state: { paper_count: 50 },
  affordances: [
    aff('print_document', 'Print a document', ['has_paper'], { curiosity: 2 }),
    observeAffordance,
  ],
  roomId: 'office',
};

const toilet: SmartObject = {
  id: 'toilet-1',
  name: 'Toilet',
  type: 'fixture',
  state: {},
  affordances: [aff('use_bathroom', 'Use the bathroom', [], { comfort: 10 }), observeAffordance],
  roomId: 'bathroom',
};

const sink: SmartObject = {
  id: 'sink-1',
  name: 'Sink',
  type: 'fixture',
  state: {},
  affordances: [aff('wash_hands', 'Wash hands', [], { comfort: 5 }), observeAffordance],
  roomId: 'bathroom',
};

// ── Agent definitions (Req 27) ────────────────────────────────────────────────

const alice: AgentProfile = {
  id: 'agent-alice',
  name: 'Alice',
  description: 'A researcher at work.',
  traits: ['diligent', 'caffeine-dependent'],
  initialDrives: { energy: 40, hunger: 50, social: 30, comfort: 50, curiosity: 60 },
  startRoomId: 'office',
};

const bob: AgentProfile = {
  id: 'agent-bob',
  name: 'Bob',
  description: 'A social coworker on break.',
  traits: ['social', 'easygoing'],
  initialDrives: { energy: 60, hunger: 40, social: 20, comfort: 50, curiosity: 40 },
  startRoomId: 'break_room',
};

const carol: AgentProfile = {
  id: 'agent-carol',
  name: 'Carol',
  description: 'The boss who runs meetings.',
  traits: ['assertive', 'organized'],
  initialDrives: { energy: 70, hunger: 30, social: 50, comfort: 40, curiosity: 50 },
  startRoomId: 'meeting_room',
};

// ── Scene definition (Req 28) ─────────────────────────────────────────────────

export const OFFICE_DAY_SCENE: SceneDefinition = {
  id: 'office-day',
  name: 'Office Day',
  rooms: [office, breakRoom, meetingRoom, bathroom],
  objects: [
    computer,
    whiteboard,
    coffeeMachine,
    waterCooler,
    meetingTable,
    printer,
    toilet,
    sink,
    makeDoorway('office', office.connections),
    makeDoorway('break_room', breakRoom.connections),
    makeDoorway('meeting_room', meetingRoom.connections),
    makeDoorway('bathroom', bathroom.connections),
  ],
  agents: [alice, bob, carol],
};

// ── Drive-aware mock LLM (Req 29) ─────────────────────────────────────────────

/**
 * Mock LLM that selects an office-appropriate affordance based on the agent's
 * primary drive and current room. Deterministic heuristic — not real AI.
 */
export class OfficeDayMockLLMClient implements LLMClient {
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
        content: 'Completed an action during the office day.',
        importance: 5,
        type: 'action',
        location: 'office',
      },
    };
  }

  private selectAffordance(room: string, drive: string): string {
    // Social restoration.
    if (drive === 'social') {
      if (room === 'break_room') return 'small_talk';
      if (room === 'meeting_room') return 'hold_meeting';
      // In office or bathroom → move to break_room.
      return 'go_to_break_room';
    }
    // Energy restoration.
    if (drive === 'energy') {
      if (room === 'break_room') return 'brew_coffee';
      return 'go_to_break_room';
    }
    // Curiosity restoration.
    if (drive === 'curiosity') {
      if (room === 'meeting_room') return 'brainstorm';
      if (room === 'office') return 'print_document';
      return 'go_to_office';
    }
    // Comfort restoration.
    if (drive === 'comfort') {
      if (room === 'bathroom') return 'wash_hands';
      return 'go_to_bathroom';
    }
    // Hunger — no food affordances; observe as fallback.
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
  private readonly nodes = new Map<string, import('@evol-hive/shared').MemoryNode>();

  async store(node: import('@evol-hive/shared').MemoryNode): Promise<void> {
    this.nodes.set(node.id, node);
  }
  async get(id: string): Promise<import('@evol-hive/shared').MemoryNode | null> {
    return this.nodes.get(id) ?? null;
  }
  async queryByEmbedding(
    _embedding: number[],
    _topK: number,
  ): Promise<import('@evol-hive/shared').MemoryNode[]> {
    return [...this.nodes.values()];
  }
  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.nodes.delete(id);
  }
  async countRecent(_agentId: string, _sinceTimestamp: number): Promise<number> {
    return 0;
  }
}

// ── Engine assembly (Req 28) ───────────────────────────────────────────────────

function makeConfig(): import('@evol-hive/shared').EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
    driveDecayRate: 0.1,
  };
}

export function buildOfficeDayEngine(): AssembledEngine {
  const config = makeConfig();

  const vectorStore = new InMemoryVectorStore();
  const embeddingProvider: MemEmbeddingProvider = new MockEmbeddingProvider();
  const memoryStore: MemoryStore = new MemoryStoreImpl({ vectorStore, embeddingProvider });

  const core: EngineCore = createEngineCore(config, memoryStore);
  loadScene(core, OFFICE_DAY_SCENE);
  registerAffordanceHandlers(core);

  const llmClient: LLMClient = new OfficeDayMockLLMClient();
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
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const engine = buildOfficeDayEngine();
  // eslint-disable-next-line no-console
  console.log('Starting Office Day scene simulation…');
  engine.gameLoop.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  engine.gameLoop.stop();
  for (const id of ['agent-alice', 'agent-bob', 'agent-carol']) {
    const state = engine.agentManager.getState(id);
    // eslint-disable-next-line no-console
    console.log(
      `${id}: energy=${state?.drives.energy}, social=${state?.drives.social}, location=${state?.location}, thinking=${state?.isThinking}`,
    );
  }
}

const isMain = typeof process !== 'undefined' && process.argv[1]?.endsWith('office-day.ts');
if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Office Day scene failed:', err);
    process.exit(1);
  });
}
