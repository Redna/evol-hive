/**
 * E2E test — a living world on the fully assembled engine (spec 030, #117).
 *
 * Exercises the complete dynamic-world flow through the real assembly
 * (`createEngineCore` + `loadScene` + `assembleGameLoop` with the
 * `scene-mutations` system registered FIRST), covering in one scenario:
 *
 * - AC-2 (E2E): a mid-run SpawnAgent through the mutation port receives PPER
 *   cycles and forms a plan within 20 ticks of the assembled loop.
 * - AC-6 (E2E): an AddObject appears in the VisualizerDataAdapter snapshot on
 *   the next tick, with mutation-log deltas available for the WebSocket channel.
 * - AC-4 (E2E): closing a door updates adjacency, blocks movement per the
 *   TopologyGuard, filters cross-door affordances, and mirrors state.open.
 * - AC-3 (E2E): a DespawnAgent removes the agent from all surfaces and its
 *   full state lands in the DormantAgentStore.
 * - AC-7 (E2E): save → load restores live agents, object placement, connection
 *   state, dormant agents, and the mutation log.
 * - AC-8 (E2E): replaying getMutations(0) over a fresh assembled engine
 *   reproduces the live world projection.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type {
  PPEROrchestratorPort,
  PPERPhase,
  SceneDefinition,
  SceneMutationEvent,
} from '@evol-hive/shared';
import { createEngineCore, loadScene, assembleGameLoop } from '../src/assembly.js';
import type { EngineCore } from '../src/assembly.js';
import { EnginePersistenceImpl } from '../src/persistence/engine-persistence.js';
import { VisualizerDataAdapter } from '../src/visualizer/data-adapter.js';

// ── Fixture ──────────────────────────────────────────────────────────────────

/** garden ↔ workshop (gated doorway) with a workbench and a portable crate. */
function makeScene(): SceneDefinition {
  return {
    id: 'living-world',
    name: 'Living World E2E',
    rooms: [
      {
        id: 'garden',
        name: 'Garden',
        description: '',
        connections: ['workshop'],
        objectIds: ['workbench-1', 'doorway-garden'],
      },
      {
        id: 'workshop',
        name: 'Workshop',
        description: '',
        connections: ['garden'],
        objectIds: ['doorway-workshop'],
      },
    ],
    objects: [
      {
        id: 'workbench-1',
        name: 'Workbench',
        type: 'furniture',
        state: {},
        affordances: [
          { id: 'work', label: 'Work', engineEffect: 'work', preconditions: [], effects: {} },
        ],
        roomId: 'garden',
      },
      {
        id: 'doorway-garden',
        name: 'Doorway',
        type: 'doorway',
        state: { open: true },
        affordances: [
          {
            id: 'go_to_workshop',
            label: 'Go to workshop',
            engineEffect: 'go_to_workshop',
            preconditions: [],
            effects: {},
          },
          {
            id: 'open_door',
            label: 'Open',
            engineEffect: 'open_door',
            preconditions: [],
            effects: {},
          },
          {
            id: 'close_door',
            label: 'Close',
            engineEffect: 'close_door',
            preconditions: [],
            effects: {},
          },
        ],
        roomId: 'garden',
      },
      {
        id: 'doorway-workshop',
        name: 'Doorway',
        type: 'doorway',
        state: { open: true },
        affordances: [
          {
            id: 'go_to_garden',
            label: 'Go to garden',
            engineEffect: 'go_to_garden',
            preconditions: [],
            effects: {},
          },
        ],
        roomId: 'workshop',
      },
    ],
    agents: [
      {
        id: 'gardener-1',
        name: 'Gardener',
        description: 'A methodical gardener.',
        traits: [],
        initialDrives: { curiosity: 70 },
        startRoomId: 'garden',
      },
    ],
  };
}

function helperProfile(id: string): SceneDefinition['agents'][number] {
  return {
    id,
    name: id,
    description: 'A helper spawned mid-run.',
    traits: [],
    initialDrives: { energy: 90 },
    startRoomId: 'garden',
  };
}

/** Fake orchestrator: records cycles and forms a plan synchronously (AC-2). */
class FakeOrchestrator implements PPEROrchestratorPort {
  cycles: string[] = [];
  async runCycle(agentId: string): Promise<void> {
    this.cycles.push(agentId);
    const state = this.agentManager?.getState(agentId);
    if (state) {
      state.currentPlan = {
        id: `plan-${agentId}`,
        description: 'tend the garden',
        steps: [{ description: 'work', completed: true, targetAffordance: 'work' }],
        currentStepIndex: 0,
        createdAt: 0,
      };
    }
  }
  getPhase(_agentId: string): PPERPhase {
    return 'perceive';
  }
  /** Injected after construction (the harness builds it before loadScene). */
  agentManager?: import('../src/agents/state/index.js').AgentManagerImpl;
}

interface Harness {
  core: EngineCore;
  orchestrator: FakeOrchestrator;
  adapter: VisualizerDataAdapter;
  persistence: EnginePersistenceImpl;
}

function buildHarness(): Harness {
  const core = createEngineCore({
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: false,
  });
  const orchestrator = new FakeOrchestrator();
  loadScene(core, makeScene());
  // Explicit concurrency so both the scene agent and the mid-run spawn get
  // cycles during a synchronous multi-tick injection (fire-and-forget cycles
  // only settle between injections; the default of 1 would starve helper-1).
  assembleGameLoop(core, orchestrator, undefined, undefined, { maxConcurrentCycles: 4 });
  orchestrator.agentManager = core.agentManager;

  const adapter = new VisualizerDataAdapter({
    gameLoop: core.gameLoop,
    agentManager: core.agentManager,
    smartObjectRegistry: core.smartObjectRegistry,
    sceneManager: core.sceneManager,
    orchestrator,
    mutationService: core.mutationService,
  });
  const persistence = new EnginePersistenceImpl({
    gameLoop: core.gameLoop,
    agentManager: core.agentManager,
    smartObjectRegistry: core.smartObjectRegistry,
    sceneManager: core.sceneManager,
    vectorStore: { exportAll: async () => [], importAll: async () => undefined },
    mutationService: core.mutationService,
  });
  return { core, orchestrator, adapter, persistence };
}

/** Drive exactly `n` engine ticks and flush the fire-and-forget cycle promises. */
async function driveTicks(h: Harness, n: number): Promise<void> {
  h.core.gameLoop.injectElapsed(n / 60);
  await Promise.resolve();
  await Promise.resolve();
}

/** Project the live world for equality comparison across engine instances. */
function liveProjection(h: Harness) {
  return {
    rooms: h.core.sceneManager.getAllRooms().map((r) => ({
      id: r.id,
      connections: [...r.connections].sort(),
      objectIds: [...r.objectIds].sort(),
    })),
    objects: h.core.smartObjectRegistry.getAll().map((o) => ({
      id: o.id,
      roomId: o.roomId,
      state: { ...o.state },
    })),
    agents: h.core.agentManager.getActiveAgents().map((s) => ({
      agentId: s.agentId,
      location: s.location,
      drives: { ...s.drives },
    })),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Living-world E2E on the assembled engine (spec 030)', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('mid-run spawn through the port joins the PPER loop within 20 ticks (AC-2)', async () => {
    const result = h.core.mutationService.propose({
      type: 'spawn_agent',
      payload: { profile: helperProfile('helper-1') },
    });
    expect(result.accepted).toBe(true);
    await driveTicks(h, 20);

    // Received at least one PPER cycle and formed a plan.
    expect(h.orchestrator.cycles).toContain('helper-1');
    expect(h.core.agentManager.getState('helper-1')?.currentPlan).not.toBeNull();
    expect(h.core.agentManager.getActiveAgents().map((a) => a.agentId)).toContain('helper-1');
  });

  it('added object reaches the visualizer snapshot next tick + deltas stream (AC-6)', async () => {
    const objectsBefore = h.adapter.getSnapshot().rooms[0]!.objects.length;

    const accepted = h.core.mutationService.propose({
      type: 'add_object',
      payload: {
        object: {
          id: 'crate-1',
          name: 'Crate',
          type: 'furniture',
          state: {},
          affordances: [],
          roomId: 'garden',
        },
      },
    });
    expect(accepted.accepted).toBe(true);
    await driveTicks(h, 1);

    const snapshot = h.adapter.getSnapshot();
    expect(snapshot.rooms[0]!.objects.map((o) => o.id)).toContain('crate-1');
    expect(snapshot.rooms[0]!.objects.length).toBe(objectsBefore + 1);

    const deltas: SceneMutationEvent[] = h.adapter.getMutationDeltas(0);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.type).toBe('add_object');
  });

  it('closed door: adjacency, TopologyGuard, cross-door affordances, state.open (AC-4)', async () => {
    const accepted = h.core.mutationService.propose({
      type: 'set_connection_state',
      payload: { roomA: 'garden', roomB: 'workshop', action: 'close' },
    });
    expect(accepted.accepted).toBe(true);
    await driveTicks(h, 1);

    expect(h.core.sceneManager.getConnectedRooms('garden').map((r) => r.id)).not.toContain(
      'workshop',
    );
    expect(h.core.sceneManager.isMovementBlocked('gardener-1', 'go_to_workshop', 'garden')).toBe(
      true,
    );
    expect(
      h.core.smartObjectRegistry.getAffordancesInRoom('garden').map((a) => a.id),
    ).not.toContain('go_to_workshop');
    expect(h.core.smartObjectRegistry.get('doorway-garden')?.state['open']).toBe(false);

    // Re-open restores traversal.
    h.core.mutationService.propose({
      type: 'set_connection_state',
      payload: { roomA: 'garden', roomB: 'workshop', action: 'open' },
    });
    await driveTicks(h, 1);
    expect(h.core.sceneManager.isMovementBlocked('gardener-1', 'go_to_workshop', 'garden')).toBe(
      false,
    );
  });

  it('despawn exports full state to dormancy and leaves all surfaces (AC-3)', async () => {
    h.core.mutationService.propose({
      type: 'spawn_agent',
      payload: { profile: helperProfile('helper-1') },
    });
    await driveTicks(h, 1);
    h.core.agentManager.updateState('helper-1', {
      drives: { energy: 42, hunger: 30, social: 60, comfort: 70, curiosity: 20 },
      currentGoal: 'haul the crate',
    });

    const accepted = h.core.mutationService.propose({
      type: 'despawn_agent',
      payload: { agentId: 'helper-1' },
    });
    expect(accepted.accepted).toBe(true);
    await driveTicks(h, 1);

    expect(h.core.agentManager.getActiveAgents().map((a) => a.agentId)).not.toContain('helper-1');
    expect(h.core.agentManager.getState('helper-1')).toBeNull();
    const dormant = h.core.dormantStore.get('helper-1');
    expect(dormant).not.toBeNull();
    expect(dormant!.state.currentGoal).toBe('haul the crate');
    expect(dormant!.state.drives.energy).toBe(42);
  });

  it('save → load restores the exact living world incl. dormancy and the log (AC-7)', async () => {
    // Build up a mutated world: add + move an object, close the door, spawn →
    // mutate → despawn an agent.
    h.core.mutationService.propose({
      type: 'add_object',
      payload: {
        object: {
          id: 'crate-1',
          name: 'Crate',
          type: 'furniture',
          state: {},
          affordances: [],
          roomId: 'garden',
        },
      },
    });
    await driveTicks(h, 1);
    h.core.mutationService.propose({
      type: 'move_object',
      payload: { objectId: 'crate-1', toRoomId: 'workshop' },
    });
    await driveTicks(h, 1);
    h.core.mutationService.propose({
      type: 'set_connection_state',
      payload: { roomA: 'garden', roomB: 'workshop', action: 'close' },
    });
    await driveTicks(h, 1);
    h.core.mutationService.propose({
      type: 'spawn_agent',
      payload: { profile: helperProfile('helper-1') },
    });
    await driveTicks(h, 1);
    h.core.agentManager.updateState('helper-1', {
      drives: { energy: 33, hunger: 55, social: 40, comfort: 66, curiosity: 10 },
      currentGoal: 'stack crates',
    });
    h.core.mutationService.propose({
      type: 'despawn_agent',
      payload: { agentId: 'helper-1' },
    });
    await driveTicks(h, 1);

    const logLength = h.core.mutationService.getMutations(0).length;
    expect(logLength).toBe(5);

    // Save → destructive load into the same core.
    const saved = await h.persistence.save();
    expect(saved.dynamic).toBeDefined();
    await h.persistence.load(saved);

    // Object placement restored.
    expect(h.core.smartObjectRegistry.get('crate-1')?.roomId).toBe('workshop');
    // Connection state restored (closed, mirrored on the doorway).
    expect(h.core.sceneManager.getConnectedRooms('garden').map((r) => r.id)).not.toContain(
      'workshop',
    );
    expect(h.core.smartObjectRegistry.get('doorway-garden')?.state['open']).toBe(false);
    // Live agents restored (gardener only — helper was despawned).
    expect(h.core.agentManager.getActiveAgents().map((a) => a.agentId)).toEqual(['gardener-1']);
    // Dormant agent restored with full state.
    const dormant = h.core.dormantStore.get('helper-1');
    expect(dormant).not.toBeNull();
    expect(dormant!.state.currentGoal).toBe('stack crates');
    expect(dormant!.state.drives.energy).toBe(33);
    // Mutation log preserved for event-sourcing continuity.
    expect(h.core.mutationService.getMutations(0)).toHaveLength(logLength);
  });

  it('replaying the mutation log over a fresh assembled engine reproduces the world (AC-8)', async () => {
    // Original run: a mixed structural history.
    h.core.mutationService.propose({
      type: 'add_object',
      payload: {
        object: {
          id: 'crate-1',
          name: 'Crate',
          type: 'furniture',
          state: {},
          affordances: [],
          roomId: 'garden',
        },
      },
    });
    await driveTicks(h, 1);
    h.core.mutationService.propose({
      type: 'move_object',
      payload: { objectId: 'crate-1', toRoomId: 'workshop' },
    });
    await driveTicks(h, 1);
    h.core.mutationService.propose({
      type: 'spawn_agent',
      payload: { profile: helperProfile('helper-1') },
    });
    await driveTicks(h, 1);
    h.core.mutationService.propose({
      type: 'set_connection_state',
      payload: { roomA: 'garden', roomB: 'workshop', action: 'close' },
    });
    await driveTicks(h, 1);
    h.core.mutationService.propose({
      type: 'despawn_agent',
      payload: { agentId: 'helper-1' },
    });
    await driveTicks(h, 1);

    const log = h.core.mutationService.getMutations(0);
    expect(log).toHaveLength(5);

    // Replay over a fresh assembled engine from the same base scene: one
    // engine tick per applied event (same total simulated time as the
    // original run, so drive decay is identical too).
    const replay = buildHarness();
    for (const event of log) {
      const result = replay.core.mutationService.propose({
        type: event.type,
        payload: event.payload,
      });
      if (!result.accepted) {
        throw new Error(`replay rejected event ${event.seq}: ${result.error}`);
      }
      replay.core.gameLoop.injectElapsed(1 / 60);
    }

    expect(liveProjection(replay)).toEqual(liveProjection(h));
  });
});
