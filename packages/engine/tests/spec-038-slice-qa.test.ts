/**
 * Spec 039 R9 — QA pass over the whole spec 038 slice (AC-1..AC-7).
 *
 * Fills the coverage gaps found while auditing the slice end-to-end (the
 * spec-039 phase-2 suites cover 038 AC-2..AC-6 via 039 AC-1..AC-7; the gaps
 * left were the first-slice ACs):
 *
 * - 038 AC-1: agents occupy grid cells; walking is cell-by-cell per tick
 *   (deterministic, verifiable) — asserted per-tick, not just via trace
 *   equality
 * - 038 AC-5: the visualizer data adapter projects anchor-positioned
 *   objects, agents at their true grid cells, and the fog of war
 * - 038 AC-7 (spec 030 integration): a closed door blocks the path and
 *   opening it re-routes live — no rebuild, same engine instance
 *
 * (038 AC-2/AC-3/AC-4/AC-6 are exercised by the spec-039 suites: 039 AC-1
 * ≙ 038 AC-2, 039 AC-2 ≙ 038 AC-3, 039 AC-4 ≙ 038 AC-4, 039 AC-6 ≙ 038 AC-6.)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  AgentProfile,
  Room,
  SmartObject,
  Affordance,
  SceneDefinition,
  EngineConfig,
} from '@evol-hive/shared';
import { createEngineCore, assembleGameLoop, loadScene } from '../src/assembly.js';
import type { EngineCore } from '../src/assembly.js';
import { GameLoopImpl } from '../src/loop/index.js';
import { VisualizerDataAdapter } from '../src/visualizer/data-adapter.js';

// ─── World fixture: garden ↔ workshop ↔ cellar ──────────────────────────────

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
  connections: ['garden', 'cellar'],
  objectIds: ['workbench-1'],
};

const cellar: Room = {
  id: 'cellar',
  name: 'Cellar',
  description: 'A damp cellar',
  connections: ['workshop'],
  objectIds: ['crate-1'],
};

function makeScene(agentId = 'a1'): SceneDefinition {
  return {
    id: 'three-room-world',
    name: 'Three Room World',
    rooms: [garden, workshop, cellar],
    objects: [
      makeObject('planter-1', 'garden', [makeAffordance('harvest', { hunger: 10 })]),
      makeObject('workbench-1', 'workshop', [makeAffordance('craft', { comfort: 8 })]),
      makeObject('crate-1', 'cellar', [makeAffordance('stash', { comfort: 5 })]),
      // Doorway objects carry the cross-room movement affordances (spec
      // 022/030 builtin go_to handler path).
      makeObject('door-garden', 'garden', [makeAffordance('go_to_workshop', {})]),
      makeObject('door-workshop', 'workshop', [
        makeAffordance('go_to_garden', {}),
        makeAffordance('go_to_cellar', {}),
      ]),
      makeObject('door-cellar', 'cellar', [makeAffordance('go_to_workshop', {})]),
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

/** Build + assemble a three-room engine; the agent spawns in the garden. */
function buildEngine(agentId = 'a1'): EngineCore & { loop: GameLoopImpl } {
  const core = createEngineCore(makeConfig(), undefined, undefined);
  void agentId;
  loadScene(core, makeScene());
  const loop = assembleGameLoop(core, noopOrchestrator as never);
  return Object.assign(core, { loop }) as EngineCore & { loop: GameLoopImpl };
}

// ─── 038 AC-7 — closed door blocks the path; opening re-routes live ─────────

describe('closed-door topology vs navigation (spec 038 AC-7, spec 030 integration)', () => {
  let core: EngineCore & { loop: GameLoopImpl };

  beforeEach(() => {
    core = buildEngine();
  });

  it('a closed door blocks the route: requestWalk refuses and the agent stays', () => {
    core.sceneManager.setConnectionOpen('garden', 'workshop', false);

    // The room graph no longer routes through the closed door.
    expect(core.navigation!.grid.route('garden', 'workshop')).toEqual([]);

    // A direct walk request fails without moving the agent (no teleport).
    expect(core.sceneManager.requestWalk('a1', 'workshop')).toBe(false);
    expect(core.agentManager.getState('a1')!.location).toBe('garden');
  });

  it('a closed door yields no-route for a KNOWN area via navigateToArea (graceful)', () => {
    // 'workshop' is known (door seen at spawn seeding) — fog passes it, but
    // the topology does not: the walk must fail gracefully, not teleport.
    expect(core.bridges.execute.navigateToArea!('a1', 'workshop')).toBe('walking');
    // Let the walk finish, then close the door behind us and try again.
    for (let i = 0; i < 30; i++) core.loop.injectElapsed(1 / 60);
    expect(core.agentManager.getState('a1')!.location).toBe('workshop');

    core.sceneManager.setConnectionOpen('garden', 'workshop', false);
    core.agentManager.updateState('a1', { location: 'garden' });
    core.navigation!.grid.enterRoom('a1', 'workshop', 'garden');
    expect(core.bridges.execute.navigateToArea!('a1', 'workshop')).toBe('no-route');
    expect(core.agentManager.getState('a1')!.location).toBe('garden');
  });

  it('opening the door re-routes LIVE — the same engine instance completes the walk', () => {
    core.sceneManager.setConnectionOpen('garden', 'workshop', false);
    expect(core.sceneManager.requestWalk('a1', 'workshop')).toBe(false);

    // Re-open: no rebuild, no new grid — the topology-driven predicate
    // consults the live scene manager, so the very next request routes.
    core.sceneManager.setConnectionOpen('garden', 'workshop', true);
    expect(core.navigation!.grid.route('garden', 'workshop')).toEqual(['garden', 'workshop']);
    expect(core.sceneManager.requestWalk('a1', 'workshop')).toBe(true);
    for (let i = 0; i < 30; i++) core.loop.injectElapsed(1 / 60);
    expect(core.agentManager.getState('a1')!.location).toBe('workshop');
  });

  it('a multi-hop route re-routes live when an intermediate door closes/opens', () => {
    // garden → cellar spans two doors (garden|workshop, workshop|cellar).
    expect(core.navigation!.grid.route('garden', 'cellar')).toEqual([
      'garden',
      'workshop',
      'cellar',
    ]);

    core.sceneManager.setConnectionOpen('workshop', 'cellar', false);
    expect(core.navigation!.grid.route('garden', 'cellar')).toEqual([]);
    expect(core.sceneManager.requestWalk('a1', 'cellar')).toBe(false);

    core.sceneManager.setConnectionOpen('workshop', 'cellar', true);
    expect(core.navigation!.grid.route('garden', 'cellar')).toEqual([
      'garden',
      'workshop',
      'cellar',
    ]);
    expect(core.sceneManager.requestWalk('a1', 'cellar')).toBe(true);
    for (let i = 0; i < 90; i++) core.loop.injectElapsed(1 / 60);
    expect(core.agentManager.getState('a1')!.location).toBe('cellar');
  });
});

// ─── 038 AC-1 — agents occupy grid cells; walking is cell-by-cell per tick ──

describe('cell-by-cell walking, per-tick verifiable (spec 038 AC-1)', () => {
  let core: EngineCore & { loop: GameLoopImpl };

  beforeEach(() => {
    core = buildEngine();
  });

  it('each tick advances the walking agent at most one 4-adjacent cell (no skipping)', () => {
    const state = core.agentManager.getState('a1')!;
    expect(state.position).toBeDefined(); // agents OCCUPY grid cells

    // Walk to the planter anchor — a multi-cell in-room path from the
    // door-adjacent spawn cell, so per-tick progress is actually observable.
    const anchor = core.navigation!.grid.grid('garden')!.getAnchor('planter-1')!;
    expect(core.bridges.execute.navigateToArea!('a1', 'planter-1')).toBe('walking');

    let singleCellSteps = 0;
    let prev = state.position!;
    for (let i = 0; i < 40; i++) {
      core.loop.injectElapsed(1 / 60); // exactly one sim tick per call
      const s = core.agentManager.getState('a1')!;
      if (s.position === undefined) throw new Error('agent lost its grid cell');
      // Cells stay inside the room bounds; the walk stays in the garden.
      expect(s.location).toBe('garden');
      expect(s.position.x).toBeGreaterThanOrEqual(0);
      expect(s.position.x).toBeLessThan(core.navigation!.grid.grid('garden')!.width);
      expect(s.position.y).toBeGreaterThanOrEqual(0);
      expect(s.position.y).toBeLessThan(core.navigation!.grid.grid('garden')!.height);

      // At most one cell of progress per tick: the walk is cell-by-cell,
      // never a multi-cell jump (the path's start cell makes the first step
      // a stationary beat).
      const manhattan = Math.abs(s.position.x - prev.x) + Math.abs(s.position.y - prev.y);
      expect(manhattan).toBeLessThanOrEqual(1);
      if (manhattan === 1) singleCellSteps += 1;
      prev = s.position;
      if (core.bridges.execute.navigateToArea!('a1', 'planter-1') === 'arrived') break;
    }
    // The walk genuinely moved cell-by-cell and stopped adjacent to the anchor.
    expect(singleCellSteps).toBeGreaterThan(0);
    const final = core.agentManager.getState('a1')!.position!;
    expect(Math.abs(final.x - anchor.x) + Math.abs(final.y - anchor.y)).toBeLessThanOrEqual(1);
  });

  it('a cross-room walk crosses exactly once, landing on the destination door cell', () => {
    expect(core.sceneManager.requestWalk('a1', 'workshop')).toBe(true);

    const grid = core.navigation!.grid;
    const doorCell = grid.grid('workshop')!.getDoorCell();
    let crossings = 0;
    let prev = {
      location: core.agentManager.getState('a1')!.location,
      position: core.agentManager.getState('a1')!.position!,
    };
    for (let i = 0; i < 40; i++) {
      core.loop.injectElapsed(1 / 60); // exactly one sim tick per call
      const s = core.agentManager.getState('a1')!;
      if (s.position === undefined) throw new Error('agent lost its grid cell');
      // Cells stay inside the room bounds.
      expect(s.position.x).toBeGreaterThanOrEqual(0);
      expect(s.position.x).toBeLessThan(grid.grid(s.location)!.width);
      expect(s.position.y).toBeGreaterThanOrEqual(0);
      expect(s.position.y).toBeLessThan(grid.grid(s.location)!.height);

      if (s.location === prev.location) {
        // No door crossing this tick → at most one cell of progress.
        const manhattan =
          Math.abs(s.position.x - prev.position.x) + Math.abs(s.position.y - prev.position.y);
        expect(manhattan).toBeLessThanOrEqual(1);
      } else {
        // Door crossing: location changed and the agent stands on the new
        // room's door cell (crossing is a single, explicit event).
        crossings += 1;
        expect(s.location).toBe('workshop');
        expect(s.position).toEqual(doorCell);
      }
      prev = { location: s.location, position: s.position };
    }
    expect(crossings).toBe(1);
    expect(prev.location).toBe('workshop');
  });

  it('a stopped agent keeps its cell — no drift without an active walk', () => {
    const before = core.agentManager.getState('a1')!.position;
    for (let i = 0; i < 10; i++) core.loop.injectElapsed(1 / 60);
    expect(core.agentManager.getState('a1')!.position).toEqual(before);
  });
});

// ─── 038 AC-5 (+ 039 R8) — visualizer adapter projects anchors, cells, fog ──

describe('visualizer data adapter spatial projection (spec 038 AC-5, 039 R8)', () => {
  let core: EngineCore & { loop: GameLoopImpl };

  beforeEach(() => {
    core = buildEngine();
  });

  it('objects project at their anchor cells; agents project at their grid cells', () => {
    const adapter = new VisualizerDataAdapter({
      gameLoop: core.gameLoop,
      agentManager: core.agentManager,
      smartObjectRegistry: core.smartObjectRegistry,
      sceneManager: core.sceneManager,
      orchestrator: noopOrchestrator as never,
      navigation: core.navigation,
    });
    const snap = adapter.getSnapshot();

    const gardenRoom = snap.rooms.find((r) => r.id === 'garden')!;
    expect(gardenRoom).toBeDefined();
    const planter = gardenRoom.objects.find((o) => o.id === 'planter-1')!;
    expect(planter).toBeDefined();
    const anchor = core.navigation!.grid.grid('garden')!.getAnchor('planter-1');
    expect(anchor).not.toBeNull();
    expect(planter.cell).toEqual(anchor);

    const agent = snap.agents.find((a) => a.agentId === 'a1')!;
    expect(agent).toBeDefined();
    expect(agent.location).toBe('garden');
    expect(agent.position).toEqual(core.agentManager.getState('a1')!.position);
  });

  it('the fog of war projects into the snapshot (visitedRooms + exploredCells)', () => {
    const adapter = new VisualizerDataAdapter({
      gameLoop: core.gameLoop,
      agentManager: core.agentManager,
      smartObjectRegistry: core.smartObjectRegistry,
      sceneManager: core.sceneManager,
      orchestrator: noopOrchestrator as never,
      navigation: core.navigation,
    });
    const snap = adapter.getSnapshot();

    const agent = snap.agents.find((a) => a.agentId === 'a1')!;
    const mem = core.agentManager.getState('a1')!.spatialMemory!;
    expect(agent.fog).toBeDefined();
    expect(agent.fog!.visitedRooms).toEqual(mem.visitedRooms);
    expect(agent.fog!.visitedRooms).toContain('garden');
    // Spawn seeding explored the spawn cell + free neighbours.
    const spawn = mem.exploredCells?.garden ?? [];
    expect(spawn.length).toBeGreaterThan(0);
    expect(agent.fog!.exploredCells.garden).toEqual(spawn);
    // The unvisited workshop contributes no explored cells yet.
    expect(agent.fog!.exploredCells.workshop).toBeUndefined();
  });
});
