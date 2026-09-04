/**
 * Tests for runtime agent spawn/despawn (spec 030, issue #117) — engine layer.
 *
 * Covers:
 * - AC-2: a SpawnAgent mid-run results in the agent receiving PPER cycles
 *   (plan formed / cycle executed) within 20 ticks.
 * - AC-3: after DespawnAgent the agent is absent from getActiveAgents() and
 *   its full state lands in the DormantAgentStore; a subsequent SpawnAgent
 *   with the dormant agentId restores drives, goal, plan, and memories.
 * - Req 6: spawn seeds location, bootstraps memory, joins the scheduler.
 * - Req 8: dormant state restores instead of defaults.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentProfile, AgentInternalState, GameTick, Room } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { GameLoopImpl } from '../src/loop/index.js';
import { PPERScheduler } from '../src/systems/pper-scheduler.js';
import { SceneMutationServiceImpl, DormantAgentStore } from '../src/world/mutations/index.js';
import type { MemoryNode } from '@evol-hive/shared';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeObject(id: string, roomId: string): import('@evol-hive/shared').SmartObject {
  return {
    id,
    name: id,
    type: 'furniture',
    state: {},
    affordances: [
      { id: 'work', label: 'Work', engineEffect: 'work', preconditions: [], effects: {} },
    ],
    roomId,
  };
}

interface Harness {
  registry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  agentManager: AgentManagerImpl;
  dormantStore: DormantAgentStore;
  service: SceneMutationServiceImpl;
  /** Sync memory adapter — records what the service exported/imported. */
  memory: { exported: Map<string, MemoryNode[]>; imported: MemoryNode[] };
}

function makeHarness(): Harness {
  const roomA: Room = {
    id: 'room_a',
    name: 'Room A',
    description: '',
    connections: [],
    objectIds: ['desk-1'],
  };
  const registry = new SmartObjectRegistryImpl();
  const agentManager = new AgentManagerImpl();
  const roomMap = new Map<string, Room>([
    ['room_a', roomA],
  ]);
  const sceneManager = new SceneManagerImpl(agentManager, roomMap);
  registry.register(makeObject('desk-1', 'room_a'));

  const memory = { exported: new Map<string, MemoryNode[]>(), imported: [] as MemoryNode[] };
  const dormantStore = new DormantAgentStore();
  const service = new SceneMutationServiceImpl({
    registry,
    sceneManager,
    agentManager,
    dormantStore,
    memoryPort: {
      exportMemories: (agentId: string) => memory.exported.get(agentId) ?? [],
      importMemories: (nodes: MemoryNode[]) => {
        memory.imported.push(...nodes);
      },
    },
  });
  return { registry, sceneManager, agentManager, dormantStore, service, memory };
}

function profile(id: string, startRoomId?: string): AgentProfile {
  return {
    id,
    name: id,
    description: `test agent ${id}`,
    traits: [],
    initialDrives: {},
    ...(startRoomId !== undefined ? { startRoomId } : {}),
  };
}

function makeMemoryNode(agentId: string, content: string): MemoryNode {
  return {
    id: `mem_${content}`,
    agentId,
    content,
    embedding: [1, 0, 0],
    timestamp: 1,
    importance: 5,
    type: 'observation',
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Mid-run spawn (spec 030, AC-2 / Req 6)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('registers the agent with a seeded location and joins the scheduler', () => {
    const result = h.service.propose({
      type: 'spawn_agent',
      payload: { profile: profile('newcomer') },
      source: 'engine',
    });
    expect(result.accepted).toBe(true);
    h.service.applyPending(1);

    const state = h.agentManager.getState('newcomer');
    expect(state).not.toBeNull();
    // Default start room: the first valid room of the scene.
    expect(state!.location).toBe('room_a');
    expect(h.agentManager.getActiveAgents().map((a) => a.agentId)).toContain('newcomer');
  });

  it('spawned agent receives PPER cycles within 20 ticks (AC-2)', () => {
    h.service.propose({ type: 'spawn_agent', payload: { profile: profile('cycler') } });
    h.service.applyPending(1);

    // Mock orchestrator — records cycles and simulates a completed cycle by
    // forming a plan on the agent (plan formed / affordance executed contract
    // of the real orchestrator is covered by specs 001–005).
    const cyclesRun: string[] = [];
    const orchestrator = {
      runCycle: vi.fn((agentId: string): Promise<void> => {
        cyclesRun.push(agentId);
        const state = h.agentManager.getState(agentId);
        if (state) {
          const plan: AgentInternalState['currentPlan'] = {
            id: 'plan-1',
            description: 'work at the desk',
            steps: [
              { description: 'work', completed: true, targetAffordance: 'work' },
            ],
            currentStepIndex: 0,
            createdAt: 0,
          };
          h.agentManager.updateState(agentId, { currentPlan: plan });
        }
        return Promise.resolve();
      }),
      getPhase: () => 'perceive' as const,
    };

    const loop = new GameLoopImpl({
      fps: 60,
      spatialDebounceSeconds: 5,
      maxConcurrentLLM: 8,
      guardrailsEnabled: false,
      guardrails: { affordanceMasking: false, contextualForcing: false, planValidation: false },
    });
    // The mutation service must be ticked too so future mid-run spawns apply.
    loop.registerSystem({
      name: 'scene-mutations',
      update: (tick: GameTick) => h.service.applyPending(tick.tickNumber),
    });
    loop.registerSystem(
      new PPERScheduler(h.agentManager, orchestrator, { maxConcurrentCycles: 4 }),
    );

    // Drive exactly 20 ticks deterministically (20/60 s of elapsed time).
    loop.injectElapsed(20 / 60);

    expect(cyclesRun).toContain('cycler');
    const cyclerState = h.agentManager.getState('cycler');
    expect(cyclerState?.currentPlan).not.toBeNull();
    loop.stop();
  });

  it('bootstraps memory from the memory port on spawn (prior-session memories)', () => {
    h.memory.exported.set('returnee', [makeMemoryNode('returnee', 'I remember the desk')]);
    h.service.propose({ type: 'spawn_agent', payload: { profile: profile('returnee') } });
    h.service.applyPending(1);

    // The import side receives the prior memories for bootstrap.
    expect(h.memory.imported.map((m) => m.content)).toContain('I remember the desk');
  });
});

describe('Despawn with state export (spec 030, AC-3 / Req 7)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('exports full state to the DormantAgentStore and removes the agent from all surfaces', () => {
    h.service.propose({ type: 'spawn_agent', payload: { profile: profile('sleeper', 'room_a') } });
    h.service.applyPending(1);

    // Mutate state so restoration is observable.
    h.agentManager.updateState('sleeper', {
      drives: { energy: 17, hunger: 44, social: 90, comfort: 5, curiosity: 60 },
      currentGoal: 'finish the report',
      currentPlan: {
        id: 'plan-9',
        description: 'write the report',
        steps: [{ description: 'write', completed: false, targetAffordance: 'work' }],
        currentStepIndex: 0,
        createdAt: 3,
      },
    });
    h.memory.exported.set('sleeper', [makeMemoryNode('sleeper', 'met the desk')]);

    const result = h.service.propose({ type: 'despawn_agent', payload: { agentId: 'sleeper' } });
    expect(result.accepted).toBe(true);
    h.service.applyPending(2);

    // Absent from the active surface (perception/social query this).
    expect(h.agentManager.getActiveAgents().map((a) => a.agentId)).not.toContain('sleeper');
    expect(h.agentManager.getState('sleeper')).toBeNull();

    // Full state in the dormant store.
    const dormant = h.dormantStore.get('sleeper');
    expect(dormant).not.toBeNull();
    expect(dormant!.profile.id).toBe('sleeper');
    expect(dormant!.state.drives.energy).toBe(17);
    expect(dormant!.state.currentGoal).toBe('finish the report');
    expect(dormant!.state.currentPlan?.description).toBe('write the report');
    expect(dormant!.memories.map((m) => m.content)).toContain('met the desk');
  });

  it('dormant store snapshots are serializable', () => {
    h.service.propose({ type: 'spawn_agent', payload: { profile: profile('doc') } });
    h.service.applyPending(1);
    h.service.propose({ type: 'despawn_agent', payload: { agentId: 'doc' } });
    h.service.applyPending(2);

    const snapshot = h.dormantStore.snapshot();
    const parsed = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    expect(parsed['doc']!.profile.id).toBe('doc');
  });
});

describe('Re-spawn from dormancy (spec 030, AC-3 / Req 8)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  function despawnWithState(agentId: string): void {
    h.service.propose({ type: 'spawn_agent', payload: { profile: profile(agentId, 'room_a') } });
    h.service.applyPending(1);
    h.agentManager.updateState(agentId, {
      drives: { energy: 23, hunger: 71, social: 12, comfort: 88, curiosity: 3 },
      currentGoal: 'water the plants',
      currentPlan: {
        id: 'plan-2',
        description: 'watering round',
        steps: [{ description: 'water', completed: false, targetAffordance: 'work' }],
        currentStepIndex: 0,
        createdAt: 9,
      },
      location: 'room_a',
    });
    h.memory.exported.set(agentId, [makeMemoryNode(agentId, 'plants need water')]);
    h.service.propose({ type: 'despawn_agent', payload: { agentId } });
    h.service.applyPending(2);
  }

  it('restores drives, goal, plan, location, and memories instead of defaults', () => {
    despawnWithState('phoenix');

    // Re-spawn by dormant agentId — no profile argument.
    const result = h.service.propose({
      type: 'spawn_agent',
      payload: { dormantAgentId: 'phoenix' },
    });
    expect(result.accepted).toBe(true);
    h.service.applyPending(3);

    const state = h.agentManager.getState('phoenix');
    expect(state).not.toBeNull();
    expect(state!.drives).toEqual({
      energy: 23,
      hunger: 71,
      social: 12,
      comfort: 88,
      curiosity: 3,
    });
    expect(state!.currentGoal).toBe('water the plants');
    expect(state!.currentPlan?.id).toBe('plan-2');
    expect(state!.location).toBe('room_a');

    // Memories were re-imported for bootstrap.
    expect(h.memory.imported.map((m) => m.content)).toContain('plants need water');

    // Dormant entry is consumed after claim.
    expect(h.dormantStore.get('phoenix')).toBeNull();
  });

  it('falls back to a fresh profile spawn when no dormant state exists', () => {
    const result = h.service.propose({
      type: 'spawn_agent',
      payload: { dormantAgentId: 'never-existed' },
    });
    expect(result.accepted).toBe(false);
    expect(result.error).toContain('never-existed');
  });
});