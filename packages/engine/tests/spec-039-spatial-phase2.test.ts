/**
 * Spec 039 — Spatial Phase 2 (engine side): fog-gated perception,
 * navigation-then-execution, social fog-lifting, persistence round-trip,
 * determinism (issue #144).
 *
 * AC coverage:
 * - AC-1 (R1/R2): a plan step with targetArea walks the agent through the
 *   door graph over multiple ticks; the affordance executes on arrival;
 *   same-cell targetAffordance-only steps behave as in spec 037
 * - AC-2 (R3): a never-visited room produces no affordances/objects in
 *   perception; after exploration (or a talk_to transfer) they appear
 * - AC-4 (R5): talk_to transfers the speaker's sightings into the
 *   listener's spatial memory (targetArea enum + perception pick it up)
 * - AC-5 (R6): save → load round-trip restores spatialMemory + position
 *   exactly; fog-limited perception matches pre-save perception
 * - AC-6 (R7): same initial state + same plan → identical cell paths
 * - AC-8: spawn seeding is deterministic; anchors auto-assign deterministically
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  AgentProfile,
  Room,
  SmartObject,
  Affordance,
  SceneDefinition,
  EngineConfig,
  SaveState,
} from '@evol-hive/shared';
import { InMemoryVectorStore } from '@evol-hive/memory';
import { createEngineCore, assembleGameLoop, loadScene } from '../src/assembly.js';
import type { EngineCore } from '../src/assembly.js';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { WorldGrid } from '../src/spatial/grid.js';
import { NavigationSystemImpl } from '../src/spatial/navigation.js';
import { PerceptionDataProviderImpl } from '../src/agents/perception/index.js';
import { SocialManager } from '../src/social/social-manager.js';
import { GameLoopImpl } from '../src/loop/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { ExecuteServiceImpl } from '../../cognition/src/pper/execute-service.js';

// ─── World fixture: garden ↔ workshop ───────────────────────────────────────

function makeProfile(id = 'a1', startRoomId = 'garden'): AgentProfile {
  return {
    id,
    name: id,
    description: `${id} desc`,
    traits: [],
    initialDrives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 70 },
    startRoomId,
  };
}

function makeAffordance(id: string, effects: Partial<Record<string, number>>): Affordance {
  return { id, label: id, engineEffect: id, preconditions: [], effects };
}

function makeObject(id: string, roomId: string, affordances: Affordance[]): SmartObject {
  return {
    id,
    name: id.replace(/-\d+$/, ''),
    type: 'furniture',
    state: {},
    affordances,
    roomId,
  };
}

const garden: Room = {
  id: 'garden',
  name: 'Garden',
  description: 'A walled garden',
  connections: ['workshop'],
  objectIds: ['planter-1'],
};

const workshop: Room = {
  id: 'workshop',
  name: 'Workshop',
  description: 'A cluttered workshop',
  connections: ['garden'],
  objectIds: ['workbench-1'],
};

function makeScene(agentId = 'a1'): SceneDefinition {
  return {
    id: 'two-room-world',
    name: 'Two Room World',
    rooms: [garden, workshop],
    objects: [
      makeObject('planter-1', 'garden', [makeAffordance('harvest', { hunger: 10 })]),
      makeObject('workbench-1', 'workshop', [makeAffordance('craft', { comfort: 8 })]),
      // Doorway objects carry the cross-room movement affordances (the
      // builtin go_to_* handler path — spec 022/030).
      makeObject('door-garden', 'garden', [makeAffordance('go_to_workshop', {})]),
      makeObject('door-workshop', 'workshop', [makeAffordance('go_to_garden', {})]),
    ],
    agents: [makeProfile(agentId)],
  };
}

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: false,
  };
}

const noopOrchestrator = { getPhase: () => 'perceive' as const, runCycle: async () => {} };

/** Build + assemble a two-room engine; agents are seeded by assembly. */
function buildEngine(agentId = 'a1'): EngineCore & { loop: GameLoopImpl } {
  const core = createEngineCore(makeConfig(), undefined, undefined);
  void agentId;
  loadScene(core, makeScene());
  const loop = assembleGameLoop(core, noopOrchestrator as never);
  return Object.assign(core, { loop }) as EngineCore & { loop: GameLoopImpl };
}

// ─── AC-2 (R3) — fog-gated perception ───────────────────────────────────────

describe('fog-gated perception (spec 039, AC-2)', () => {
  let core: EngineCore & { loop: GameLoopImpl };

  beforeEach(() => {
    core = buildEngine();
  });

  it('a visited room is perceivable: objects and affordances surface', () => {
    const objects = core.bridges.perception.getVisibleObjectsInRoom!('a1', 'garden');
    expect(objects.map((o) => o.id).sort()).toEqual(['door-garden', 'planter-1']);
    const affordances = core.bridges.perception.getVisibleAffordancesInRoom!('a1', 'garden');
    expect(affordances.map((a) => a.id)).toContain('harvest');
  });

  it('a never-visited (unexplored) room the agent does NOT occupy produces NO objects or affordances', () => {
    // Amended by spec 052's live-run finding (issue #183): the unexplored-room
    // gate only hides rooms the agent is not standing in — occupancy makes a
    // room self-evidently known (see the occupied-room test below). The agent
    // therefore waits in `workshop` while querying the unexplored `garden`.
    core.agentManager.updateState('a1', {
      location: 'workshop',
      spatialMemory: { visitedRooms: [], knownDoors: [], discoveredAt: {} },
    });
    expect(core.bridges.perception.getVisibleObjectsInRoom!('a1', 'garden')).toEqual([]);
    expect(core.bridges.perception.getVisibleAffordancesInRoom!('a1', 'garden')).toEqual([]);
  });

  it('an agent standing in a room perceives it even when the fog never recorded the visit (spec 052 finding)', () => {
    // Spec 052 live run (issue #183): apprentice-1 executed the go_to_garden
    // teleport handler (moveAgent — no discover/walk), then perceived an
    // EMPTY garden forever: `inRoom=0 … enum=[] … chosen=[wait]` while his
    // drives decayed to zero — the #183 headline symptom through a new path.
    // Fog models knowledge of the world; the room the agent physically
    // occupies is self-evidently known ("you perceive your surroundings
    // passively"), so occupancy overrides the unexplored-room gate.
    core.agentManager.updateState('a1', {
      spatialMemory: { visitedRooms: [], knownDoors: [], discoveredAt: {} },
    });
    expect(
      core.bridges.perception.getVisibleObjectsInRoom!('a1', 'garden').length,
    ).toBeGreaterThan(0);
    expect(
      core.bridges.perception.getVisibleAffordancesInRoom!('a1', 'garden').length,
    ).toBeGreaterThan(0);
  });

  it('exploration unlocks perception — only the fog set changes, no code change', () => {
    core.agentManager.updateState('a1', {
      location: 'workshop',
      spatialMemory: { visitedRooms: [], knownDoors: [], discoveredAt: {} },
    });
    expect(core.bridges.perception.getVisibleObjectsInRoom!('a1', 'garden')).toEqual([]);

    // The agent explores the garden (personal visit writes the same
    // representation social transfer writes).
    core.agentManager.updateState('a1', {
      spatialMemory: {
        visitedRooms: ['garden'],
        knownDoors: ['garden|workshop'],
        discoveredAt: { garden: 1 },
        observedObjects: { 'planter-1': 'garden' },
      },
    });
    expect(core.bridges.perception.getVisibleObjectsInRoom!('a1', 'garden')).toHaveLength(2);
    expect(
      core.bridges.perception.getVisibleAffordancesInRoom!('a1', 'garden').map((a) => a.id),
    ).toContain('harvest');
  });

  it('go_to affordances for UNKNOWN destinations are fogged out of perception', () => {
    // An agent that never saw the garden→workshop door: memory knows the
    // room it stands in but not the door beyond.
    core.agentManager.updateState('a1', {
      spatialMemory: {
        visitedRooms: ['garden'],
        knownDoors: [],
        discoveredAt: { garden: 1 },
        observedObjects: { 'planter-1': 'garden' },
      },
    });
    const ids = core.bridges.perception.getVisibleAffordancesInRoom!('a1', 'garden').map(
      (a) => a.id,
    );
    expect(ids).toContain('harvest');
    expect(ids).not.toContain('go_to_workshop');
  });

  it('go_to affordances become perceivable once the door is known (visit or transfer)', () => {
    core.agentManager.updateState('a1', {
      spatialMemory: {
        visitedRooms: ['garden'],
        knownDoors: ['garden|workshop'],
        discoveredAt: { garden: 1 },
        observedObjects: { 'planter-1': 'garden' },
      },
    });
    const ids = core.bridges.perception.getVisibleAffordancesInRoom!('a1', 'garden').map(
      (a) => a.id,
    );
    expect(ids).toContain('go_to_workshop');
  });

  it('legacy agents without spatialMemory perceive everything (backward compat)', () => {
    core.agentManager.updateState('a1', { spatialMemory: undefined });
    expect(core.bridges.perception.getVisibleObjectsInRoom!('a1', 'garden')).toHaveLength(2);
  });

  it('knownAreas lists visited + door-adjacent rooms and observed object anchors', () => {
    const known = core.bridges.perception.getKnownAreas!('a1');
    expect(known).toContain('garden');
    expect(known).toContain('workshop'); // door seen at spawn seeding
    expect(known).toContain('planter-1');
    expect(known).not.toContain('cellar'); // never seen — fog holds
  });

  it('unexploredAreas lists known-but-unvisited rooms only', () => {
    const unexplored = core.bridges.perception.getUnexploredAreas!('a1');
    expect(unexplored).toEqual(['workshop']);
  });
});

// ─── AC-1 (R2) — navigation-then-execution through the door graph ───────────

describe('targetArea navigation-then-execution (spec 039, AC-1)', () => {
  let core: EngineCore & { loop: GameLoopImpl };

  beforeEach(() => {
    core = buildEngine();
  });

  it('spawn seeding marks the start room, its doors, and its object anchors', () => {
    const state = core.agentManager.getState('a1')!;
    expect(state.spatialMemory).toBeDefined();
    expect(state.spatialMemory!.visitedRooms).toEqual(['garden']);
    expect(state.spatialMemory!.knownDoors).toContain('garden|workshop');
    expect(state.spatialMemory!.observedObjects?.['planter-1']).toBe('garden');
    expect(state.position).toBeDefined();
  });

  it('spawn seeding is deterministic across rebuilds (AC-8)', () => {
    const a = buildEngine('a1');
    const b = buildEngine('a1');
    const sa = a.agentManager.getState('a1')!;
    const sb = b.agentManager.getState('a1')!;
    expect(sa.position).toEqual(sb.position);
    // QA note (spec 039 R9): `discoveredAt` is wall-clock audit data
    // (`Date.now()` at seeding), NOT a deterministic field — deep-equality
    // across two rebuilds flakes whenever the builds straddle a ms boundary
    // (observed under full-suite load). Compare the deterministic structure;
    // timestamps only need to be present.
    const stripTimestamps = (mem: NonNullable<typeof sa.spatialMemory>) => ({
      ...mem,
      discoveredAt: Object.fromEntries(Object.keys(mem.discoveredAt).map((k) => [k, 0])),
    });
    expect(stripTimestamps(sa.spatialMemory!)).toEqual(stripTimestamps(sb.spatialMemory!));
    for (const v of Object.values(sa.spatialMemory!.discoveredAt)) expect(v).toBeGreaterThan(0);
    expect(Object.keys(sa.spatialMemory!.discoveredAt).sort()).toEqual(
      Object.keys(sb.spatialMemory!.discoveredAt).sort(),
    );
  });

  it('scenes without anchors auto-assign anchor cells deterministically (AC-8)', () => {
    const ids = ['obj-b', 'obj-a', 'obj-c'];
    const g1 = new WorldGrid([{ id: 'r', connections: [] }], new Map([['r', ids]]), () => true);
    const g2 = new WorldGrid([{ id: 'r', connections: [] }], new Map([['r', ids]]), () => true);
    for (const id of ids) {
      expect(g1.grid('r')!.getAnchor(id)).toEqual(g2.grid('r')!.getAnchor(id));
      expect(g1.grid('r')!.getAnchor(id)).not.toBeNull();
    }
  });
});

// ─── AC-4 (R5) — social fog-lifting via talk_to delivery ────────────────────

describe('social fog-lifting via talk_to (spec 039, AC-4)', () => {
  it("a speaker's sightings enter the listener's spatial memory on message delivery", () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('speaker', 'garden'));
    agents.spawn(makeProfile('listener', 'garden'));
    agents.updateState('speaker', {
      location: 'garden',
      spatialMemory: {
        visitedRooms: ['garden', 'workshop'],
        knownDoors: ['garden|workshop'],
        discoveredAt: { garden: 1, workshop: 5 },
        observedObjects: { 'workbench-1': 'workshop', 'planter-1': 'garden' },
        exploredCells: { workshop: ['11,4', '10,4'] },
      },
    });
    agents.updateState('listener', {
      location: 'garden',
      spatialMemory: { visitedRooms: ['garden'], knownDoors: [], discoveredAt: { garden: 1 } },
    });

    const social = new SocialManager(agents);
    social.queueMessage('speaker', 'listener', 'I found the workshop');

    const listenerState = agents.getState('listener')!;
    expect(listenerState.spatialMemory!.visitedRooms).toContain('workshop');
    expect(listenerState.spatialMemory!.knownDoors).toContain('garden|workshop');
    expect(listenerState.spatialMemory!.observedObjects?.['workbench-1']).toBe('workshop');
    expect(listenerState.spatialMemory!.exploredCells?.['workshop']).toBeDefined();
  });

  it("the listener's targetArea enum picks up the transferred area automatically", () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('speaker', 'garden'));
    agents.spawn(makeProfile('listener', 'garden'));
    agents.updateState('speaker', {
      location: 'garden',
      spatialMemory: {
        visitedRooms: ['garden', 'workshop'],
        knownDoors: ['garden|workshop'],
        discoveredAt: { garden: 1, workshop: 5 },
        observedObjects: { 'workbench-1': 'workshop' },
      },
    });
    agents.updateState('listener', {
      location: 'garden',
      spatialMemory: { visitedRooms: ['garden'], knownDoors: [], discoveredAt: { garden: 1 } },
    });

    const registry = new SmartObjectRegistryImpl();
    const perception = new PerceptionDataProviderImpl(
      agents,
      registry,
      new DriveSystemImpl(agents),
      {
        getSystemFeedback: () => undefined,
      } as never,
    );
    const social = new SocialManager(agents);
    social.queueMessage('speaker', 'listener', 'the workshop has a workbench');

    const known = perception.getKnownAreas!('listener');
    expect(known).toContain('workshop');
    expect(known).toContain('workbench-1'); // the observed anchor is targetable
  });

  it('transfer is idempotent — no duplicate rooms/doors/objects', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('speaker', 'garden'));
    agents.spawn(makeProfile('listener', 'garden'));
    agents.updateState('speaker', {
      location: 'garden',
      spatialMemory: {
        visitedRooms: ['garden', 'workshop'],
        knownDoors: ['garden|workshop'],
        discoveredAt: { garden: 1, workshop: 5 },
        observedObjects: { 'workbench-1': 'workshop' },
      },
    });
    agents.updateState('listener', {
      location: 'garden',
      spatialMemory: { visitedRooms: ['garden'], knownDoors: [], discoveredAt: { garden: 1 } },
    });

    const social = new SocialManager(agents);
    social.queueMessage('speaker', 'listener', 'again');
    social.queueMessage('speaker', 'listener', 'and again');

    const mem = agents.getState('listener')!.spatialMemory!;
    expect(mem.visitedRooms.filter((r) => r === 'workshop')).toHaveLength(1);
    expect(mem.knownDoors.filter((d) => d === 'garden|workshop')).toHaveLength(1);
    expect(Object.keys(mem.observedObjects ?? {})).toEqual(['workbench-1']);
  });

  it('after a talk_to transfer the transferred room is perceivable by the listener (fog lifted socially)', () => {
    // QA-added (R9): AC-2's "(or receives a talk_to transfer)" clause and
    // AC-4's "perception include the discovered area" — the transfer is
    // asserted at the PERCEPTION level, through the real fog gate, on a
    // single engine instance (no code change, only the fog set changes).
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('speaker', 'garden'));
    agents.spawn(makeProfile('listener', 'garden'));
    agents.updateState('speaker', {
      location: 'garden',
      spatialMemory: {
        visitedRooms: ['garden', 'workshop'],
        knownDoors: ['garden|workshop'],
        discoveredAt: { garden: 1, workshop: 5 },
        observedObjects: { 'workbench-1': 'workshop' },
      },
    });
    agents.updateState('listener', {
      location: 'garden',
      spatialMemory: { visitedRooms: ['garden'], knownDoors: [], discoveredAt: { garden: 1 } },
    });

    // The world has the workshop workbench (craft) and the garden doorway
    // (go_to_workshop) registered, so perception has something to gate.
    const registry = new SmartObjectRegistryImpl();
    registry.register(
      makeObject('workbench-1', 'workshop', [makeAffordance('craft', { comfort: 8 })]),
    );
    registry.register(makeObject('door-garden', 'garden', [makeAffordance('go_to_workshop', {})]));
    const perception = new PerceptionDataProviderImpl(
      agents,
      registry,
      new DriveSystemImpl(agents),
      { getSystemFeedback: () => undefined } as never,
    );

    // BEFORE the transfer: the listener has never seen the workshop — the
    // room is fogged and the go_to affordance for the unknown side is hidden.
    expect(perception.getVisibleObjectsInRoom!('listener', 'workshop')).toEqual([]);
    const gardenBefore = perception.getVisibleAffordancesInRoom!('listener', 'garden').map(
      (a) => a.id,
    );
    expect(gardenBefore).not.toContain('go_to_workshop');

    // The talk_to delivery lifts the listener's fog (same representation as
    // personal discovery).
    const social = new SocialManager(agents);
    social.queueMessage('speaker', 'listener', 'the workshop has a workbench');

    // AFTER: the workshop's objects/affordances surface for the listener —
    // no code change, only the fog set changed.
    const workshopObjects = perception.getVisibleObjectsInRoom!('listener', 'workshop').map(
      (o) => o.id,
    );
    expect(workshopObjects).toContain('workbench-1');
    const workshopAffordances = perception.getVisibleAffordancesInRoom!('listener', 'workshop').map(
      (a) => a.id,
    );
    expect(workshopAffordances).toContain('craft');

    // And the movement affordance toward the now-known room surfaces in the
    // listener's CURRENT room (door-sighting gate satisfied by the transfer).
    const gardenAfter = perception.getVisibleAffordancesInRoom!('listener', 'garden').map(
      (a) => a.id,
    );
    expect(gardenAfter).toContain('go_to_workshop');
  });
});

// ─── AC-5 (R6) — persistence round-trip ─────────────────────────────────────

describe('spatialMemory + position persistence round-trip (spec 039, AC-5)', () => {
  function buildPersistedEngine(): EngineCore & { loop: GameLoopImpl } {
    const core = createEngineCore(makeConfig(), undefined, new InMemoryVectorStore());
    loadScene(core, makeScene());
    const loop = assembleGameLoop(core, noopOrchestrator as never);
    return Object.assign(core, { loop }) as EngineCore & { loop: GameLoopImpl };
  }

  it('save → load restores spatialMemory and position exactly', async () => {
    const core = buildPersistedEngine();
    const before = core.agentManager.getState('a1')!;
    expect(before.spatialMemory).toBeDefined();
    expect(before.position).toBeDefined();

    const saved: SaveState = await core.persistence!.save();
    const restored = JSON.parse(JSON.stringify(saved)) as SaveState;

    await core.persistence!.load(restored);
    const after = core.agentManager.getState('a1')!;

    expect(after.spatialMemory).toEqual(before.spatialMemory);
    expect(after.position).toEqual(before.position);
  });

  it('fog-limited perception after load matches pre-save perception', async () => {
    const core = buildPersistedEngine();
    const preObjects = core.bridges.perception.getVisibleObjectsInRoom!('a1', 'garden');
    const preKnown = core.bridges.perception.getKnownAreas!('a1');

    const saved = JSON.parse(JSON.stringify(await core.persistence!.save())) as SaveState;
    await core.persistence!.load(saved);

    expect(core.bridges.perception.getVisibleObjectsInRoom!('a1', 'garden')).toEqual(preObjects);
    expect(core.bridges.perception.getKnownAreas!('a1')).toEqual(preKnown);
  });

  it('v3 saves WITHOUT spatial extensions still load (backward compat)', async () => {
    const core = buildPersistedEngine();
    const saved = JSON.parse(JSON.stringify(await core.persistence!.save())) as SaveState;
    // Simulate a pre-phase-2 save: strip the spatial fields.
    for (const agent of saved.agents) {
      delete (agent.state as Record<string, unknown>).spatialMemory;
      delete (agent.state as Record<string, unknown>).position;
    }
    await core.persistence!.load(saved);
    const state = core.agentManager.getState('a1')!;
    expect(state.location).toBe('garden');
    // Pre-phase-2 records carry no spatial fields — the agent loads WITHOUT
    // spatialMemory (fog stays open for it until its next navigation
    // discovery). Optional fields, never a load error.
    expect(state.spatialMemory).toBeUndefined();
  });
});

// ─── AC-6 (R7) — determinism: paths are pure functions of grid + doors ──────

describe('determinism — identical state + plan → identical paths (spec 039, AC-6)', () => {
  function buildFixture(): {
    agents: AgentManagerImpl;
    grid: WorldGrid;
    nav: NavigationSystemImpl;
  } {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('a1', 'garden'));
    agents.updateState('a1', { location: 'garden', lastPerceptionTick: 0 });
    const grid = new WorldGrid(
      [
        { id: 'garden', connections: ['workshop'] },
        { id: 'workshop', connections: ['garden'] },
      ],
      new Map([
        ['garden', ['planter-1']],
        ['workshop', ['workbench-1']],
      ]),
      (a, b) => (a === 'garden' && b === 'workshop') || (a === 'workshop' && b === 'garden'),
    );
    const nav = new NavigationSystemImpl({
      agentManager: agents,
      sceneManager: {
        moveAgent: (agentId, toRoomId) => agents.updateState(agentId, { location: toRoomId }),
        getConnectedRooms: (roomId) =>
          roomId === 'garden' ? [{ id: 'workshop' }] : [{ id: 'garden' }],
      },
      grid,
    });
    return { agents, grid, nav };
  }

  function tracePath(nav: NavigationSystemImpl, agents: AgentManagerImpl): string[] {
    const trace: string[] = [];
    nav.requestWalk('a1', 'workshop');
    for (let i = 0; i < 40; i++) {
      nav.update({ tickNumber: i, simulationTime: i / 60, deltaSeconds: 1 / 60 });
      const pos = agents.getState('a1')!.position;
      trace.push(pos ? `${pos.x},${pos.y}` : 'none');
    }
    return trace;
  }

  it('two identical fixtures produce identical cell paths', () => {
    const f1 = buildFixture();
    const f2 = buildFixture();
    const t1 = tracePath(f1.nav, f1.agents);
    const t2 = tracePath(f2.nav, f2.agents);
    expect(t1).toEqual(t2);
    // The walk actually crossed into the workshop.
    expect(f1.agents.getState('a1')!.location).toBe('workshop');
  });

  it('BFS tie-breaks are deterministic (lowest index) across grid rebuilds', () => {
    const g1 = new WorldGrid(
      [{ id: 'r', connections: [] }],
      new Map([['r', ['o1', 'o2']]]),
      () => true,
    );
    const g2 = new WorldGrid(
      [{ id: 'r', connections: [] }],
      new Map([['r', ['o1', 'o2']]]),
      () => true,
    );
    const p1 = g1.grid('r')!.path({ x: 0, y: 0 }, { x: 11, y: 7 });
    const p2 = g2.grid('r')!.path({ x: 0, y: 0 }, { x: 11, y: 7 });
    expect(p1).toEqual(p2);
    expect(p1.length).toBeGreaterThan(0);
  });
});

// ─── Engine execute bridge wiring (AC-1, integration) ───────────────────────

describe('engine execute bridge navigation port (spec 039, AC-1)', () => {
  it('the assembled execute provider exposes navigateToArea backed by the grid', () => {
    const core = buildEngine();
    expect(typeof core.bridges.execute.navigateToArea).toBe('function');

    // Request navigation to the workshop (a known area after spawn seeding).
    const status = core.bridges.execute.navigateToArea!('a1', 'workshop');
    expect(status).toBe('walking');

    // The agent stays in the garden until the door is crossed.
    expect(core.agentManager.getState('a1')!.location).toBe('garden');
    for (let i = 0; i < 20; i++) core.loop.injectElapsed(1 / 60);
    expect(core.agentManager.getState('a1')!.location).toBe('workshop');

    // Now the agent is at the target — the next request reports arrival.
    expect(core.bridges.execute.navigateToArea!('a1', 'workshop')).toBe('arrived');
  });

  it('an unknown area fails gracefully (no route, no teleport)', () => {
    const core = buildEngine();
    const status = core.bridges.execute.navigateToArea!('a1', 'never-heard-of-it');
    expect(status).toBe('unknown-area');
    expect(core.agentManager.getState('a1')!.location).toBe('garden');
  });

  it('navigating to an observed object anchor walks adjacent to it', () => {
    const core = buildEngine();
    // The agent knows planter-1 (spawn-room object, observed at seeding).
    const status = core.bridges.execute.navigateToArea!('a1', 'planter-1');
    expect(status).toBe('walking');
    for (let i = 0; i < 30; i++) core.loop.injectElapsed(1 / 60);
    const state = core.agentManager.getState('a1')!;
    expect(state.location).toBe('garden');
    // Arrival: the agent stands adjacent to the anchor cell.
    expect(core.bridges.execute.navigateToArea!('a1', 'planter-1')).toBe('arrived');
    const anchor = core.navigation!.grid.grid('garden')!.getAnchor('planter-1')!;
    const dx = Math.abs(state.position!.x - anchor.x);
    const dy = Math.abs(state.position!.y - anchor.y);
    expect(dx + dy).toBeLessThanOrEqual(1);
  });
});

// ─── Full PPER-Execute cycle: affordance fires on arrival (AC-1) ────────────

describe('navigation-then-execution via the Execute service (spec 039, AC-1)', () => {
  function makeEngineWithExecutedAffordance(): {
    core: EngineCore & { loop: GameLoopImpl };
    executed: string[];
  } {
    const core = buildEngine();
    // Register a handler for the workshop affordance that records executions.
    core.affordanceRegistry.registerHandler('craft', async () => ({ success: true }));
    const executed: string[] = [];
    const physicsExecute = core.physics.executeAffordance.bind(core.physics);
    core.physics.executeAffordance = async (
      objectId: string,
      affordanceId: string,
      agentId: string,
    ) => {
      executed.push(affordanceId);
      return physicsExecute(objectId, affordanceId, agentId);
    };
    return { core, executed };
  }

  it('craft executes only after the agent crosses into the workshop', async () => {
    const { core, executed } = makeEngineWithExecutedAffordance();
    core.bridges.plan.storePlan('a1', {
      description: 'Go to the workshop and craft',
      steps: [
        {
          description: 'Go to the workshop and craft',
          completed: false,
          targetArea: 'workshop',
          targetAffordance: 'craft',
        },
      ],
    });
    const service = new ExecuteServiceImpl({ dataProvider: core.bridges.execute });

    // Tick 1: the step navigates — no execution yet.
    const r1 = await service.execute('a1');
    expect(r1.success).toBe(true);
    expect(r1.navigating).toBe(true);
    expect(executed).toEqual([]);
    expect(core.agentManager.getState('a1')!.location).toBe('garden');

    // Walk through the door graph (multiple ticks).
    for (let i = 0; i < 25; i++) core.loop.injectElapsed(1 / 60);
    expect(core.agentManager.getState('a1')!.location).toBe('workshop');

    // Arrival: the same step now executes the affordance exactly once.
    const r2 = await service.execute('a1');
    expect(r2.success).toBe(true);
    expect(r2.navigating).toBeUndefined();
    expect(executed).toEqual(['craft']);
    expect(core.bridges.execute.isPlanComplete('a1')).toBe(true);
  });
});
