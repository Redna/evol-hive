/**
 * Spec 065 — Reachable Offers (issue #225, findings 2 and 3): the `targetArea`
 * enum (`getKnownAreas`) must only offer destinations that are executable
 * this cycle. Knowledge ≠ offer: a closed door must not unlearn a room, but
 * the room must drop out of the OFFER while the door is shut; a stale object
 * anchor (removed / relocated) must be corrected rather than offered.
 *
 * AC coverage:
 * - AC-1 (R1, finding 3): door open → neighbour offered; door closed → not
 *   offered while `knownDoors` retains the pair.
 * - AC-2 (R3): reopening re-offers without re-observation; a personally
 *   visited room stays offered even with the door closed.
 * - AC-3 (R2, finding 2): a removed object's anchor is pruned from the enum
 *   and from memory; a relocated object's anchor is re-pointed at its room.
 * - AC-4 (R1): visited rooms, open-door neighbours and live anchors are all
 *   still offered (spec 039 R1 regression).
 * - AC-5 (R4): the reachability decision comes from the spatial authority —
 *   flipping door state flips the enum, through the injected port.
 * - AC-6 (R5): the guard (enum vs same-cycle navigation) fails when a stale
 *   door-only area is re-admitted.
 *
 * RED-FIRST NOTE: `wirePort` calls `setReachabilityPort` *optionally* so this
 * file compiles and runs against pre-065 `main`. There the call is a no-op,
 * the provider degrades to the old projection, and the door/anchor assertions
 * fail for the stated behavioural reason (not a missing-method crash). Once
 * the port exists it is exercised for real.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  AgentProfile,
  Affordance,
  EngineConfig,
  Room,
  SceneDefinition,
  SmartObject,
} from '@evol-hive/shared';
import { createEngineCore, assembleGameLoop, loadScene } from '../src/assembly.js';
import type { EngineCore } from '../src/assembly.js';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { WorldGrid } from '../src/spatial/grid.js';
import { NavigationSystemImpl } from '../src/spatial/navigation.js';
import { PerceptionDataProviderImpl } from '../src/agents/perception/index.js';
import type { AreaReachabilityPort } from '../src/agents/perception/index.js';

// ─── Shared fixtures ────────────────────────────────────────────────────────

function makeProfile(id: string, startRoomId: string): AgentProfile {
  return {
    id,
    name: id,
    description: `${id} desc`,
    traits: [],
    initialDrives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 70 },
    startRoomId,
  };
}

function makeAffordance(id: string): Affordance {
  return { id, label: id, engineEffect: id, preconditions: [], effects: {} };
}

function makeObject(id: string, roomId: string): SmartObject {
  return {
    id,
    name: id,
    type: 'furniture',
    state: {},
    affordances: [makeAffordance(`use_${id}`)],
    roomId,
  };
}

const legacyFeedback = { getSystemFeedback: () => undefined } as never;

/**
 * A two-room world built directly from the spatial authority + provider so
 * door state can be flipped without going through scene mutations. The grid's
 * `isConnectionOpen` predicate and the scene manager both read the same flag —
 * one notion of "passable" (R4).
 */
function buildFixture(): {
  agents: AgentManagerImpl;
  registry: SmartObjectRegistryImpl;
  nav: NavigationSystemImpl;
  provider: PerceptionDataProviderImpl;
  setDoorOpen: (open: boolean) => void;
} {
  let doorOpen = true;
  const agents = new AgentManagerImpl();
  agents.spawn(makeProfile('a1', 'garden'));
  agents.updateState('a1', { location: 'garden' });

  const registry = new SmartObjectRegistryImpl();
  registry.register(makeObject('planter-1', 'garden'));
  registry.register(makeObject('workbench-1', 'workshop'));

  const grid = new WorldGrid(
    [
      { id: 'garden', connections: ['workshop'] },
      { id: 'workshop', connections: ['garden'] },
    ],
    new Map([
      ['garden', ['planter-1']],
      ['workshop', ['workbench-1']],
    ]),
    (a, b) =>
      doorOpen && ((a === 'garden' && b === 'workshop') || (a === 'workshop' && b === 'garden')),
  );
  const nav = new NavigationSystemImpl({
    agentManager: agents,
    sceneManager: {
      moveAgent: (agentId, toRoomId) => agents.updateState(agentId, { location: toRoomId }),
      getConnectedRooms: (roomId) =>
        doorOpen ? (roomId === 'garden' ? [{ id: 'workshop' }] : [{ id: 'garden' }]) : [],
    },
    grid,
  });
  const provider = new PerceptionDataProviderImpl(
    agents,
    registry,
    new DriveSystemImpl(agents),
    legacyFeedback,
  );
  wirePort(provider, nav);
  return { agents, registry, nav, provider, setDoorOpen: (open) => (doorOpen = open) };
}

/** See the RED-FIRST NOTE at the top of this file. */
function wirePort(provider: PerceptionDataProviderImpl, port: AreaReachabilityPort): void {
  (
    provider as unknown as { setReachabilityPort?: (p: AreaReachabilityPort) => void }
  ).setReachabilityPort?.(port);
}

function seedMemory(
  agents: AgentManagerImpl,
  memory: {
    visitedRooms: string[];
    knownDoors: string[];
    discoveredAt: Record<string, number>;
    observedObjects?: Record<string, string>;
  },
): void {
  agents.updateState('a1', { spatialMemory: memory });
}

const GARDEN_ONLY = {
  visitedRooms: ['garden'],
  knownDoors: ['garden|workshop'],
  discoveredAt: { garden: 1 },
  observedObjects: { 'planter-1': 'garden' },
};

/**
 * Guard (spec 065, R5/AC-6): the enum and the same cycle's navigation must
 * agree. Every offered area must be routable this cycle OR be knowledge the
 * spec exempts from the reachability filter — a personally visited room
 * (AC-2) or a live object anchor (R1). A door-only room with no route fails.
 */
function expectEnumNavigationAgreement(
  provider: PerceptionDataProviderImpl,
  nav: NavigationSystemImpl,
  agents: AgentManagerImpl,
  agentId: string,
): void {
  const offered = provider.getKnownAreas(agentId);
  const memory = agents.getState(agentId)?.spatialMemory;
  const visited = new Set(memory?.visitedRooms ?? []);
  const anchored = new Set(Object.keys(memory?.observedObjects ?? {}));
  for (const area of offered) {
    if (visited.has(area) || anchored.has(area)) continue; // exempt knowledge
    expect(
      nav.navigateToArea(agentId, area),
      `offered area '${area}' is not routable this cycle`,
    ).not.toBe('no-route');
  }
}

// ─── AC-1 / AC-2 / AC-3 / AC-4 — the projection as data ─────────────────────

describe('getKnownAreas restricts the offer, not the knowledge (spec 065)', () => {
  let fx: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fx = buildFixture();
    seedMemory(fx.agents, GARDEN_ONLY);
  });

  it('AC-1: a room seen only through an OPEN door is offered', () => {
    fx.setDoorOpen(true);
    expect(fx.provider.getKnownAreas('a1')).toContain('workshop');
  });

  it('AC-1: a room seen only through a CLOSED door is not offered, but stays known', () => {
    fx.setDoorOpen(false);
    const offered = fx.provider.getKnownAreas('a1');
    expect(offered).not.toContain('workshop'); // the OFFER is gated
    expect(offered).toContain('garden'); // visited room still offered
    expect(offered).toContain('planter-1'); // live anchor still offered
    // The KNOWLEDGE is preserved (R3): the door pair is untouched.
    const memory = fx.agents.getState('a1')!.spatialMemory!;
    expect(memory.knownDoors).toContain('garden|workshop');
  });

  it('AC-2: reopening the door re-offers the neighbour without re-observation', () => {
    fx.setDoorOpen(false);
    expect(fx.provider.getKnownAreas('a1')).not.toContain('workshop');
    fx.setDoorOpen(true);
    expect(fx.provider.getKnownAreas('a1')).toContain('workshop');
  });

  it('AC-2: a personally visited room stays offered even with the door closed', () => {
    seedMemory(fx.agents, {
      visitedRooms: ['garden', 'workshop'],
      knownDoors: ['garden|workshop'],
      discoveredAt: { garden: 1, workshop: 2 },
      observedObjects: { 'planter-1': 'garden' },
    });
    fx.setDoorOpen(false);
    expect(fx.provider.getKnownAreas('a1')).toContain('workshop');
  });

  it('AC-3: a removed object anchor is pruned from the offer and from memory', () => {
    fx.registry.remove('planter-1');
    const offered = fx.provider.getKnownAreas('a1');
    expect(offered).not.toContain('planter-1');
    const memory = fx.agents.getState('a1')!.spatialMemory!;
    expect(Object.keys(memory.observedObjects ?? {})).not.toContain('planter-1');
  });

  it('AC-3: a relocated object anchor is re-pointed at its current room', () => {
    fx.registry.setRoom('planter-1', 'workshop');
    const offered = fx.provider.getKnownAreas('a1');
    expect(offered).toContain('planter-1'); // still a live anchor
    const memory = fx.agents.getState('a1')!.spatialMemory!;
    expect(memory.observedObjects?.['planter-1']).toBe('workshop'); // corrected
  });

  it('AC-4: visited rooms, open-door neighbours and live anchors are all offered', () => {
    fx.setDoorOpen(true);
    seedMemory(fx.agents, {
      visitedRooms: ['garden'],
      knownDoors: ['garden|workshop'],
      discoveredAt: { garden: 1 },
      observedObjects: { 'planter-1': 'garden', 'workbench-1': 'workshop' },
    });
    const offered = fx.provider.getKnownAreas('a1');
    expect(offered).toContain('garden');
    expect(offered).toContain('workshop');
    expect(offered).toContain('planter-1');
    expect(offered).toContain('workbench-1');
  });

  it('degrades to the pre-065 projection when no reachability port is wired', () => {
    const bare = new PerceptionDataProviderImpl(
      fx.agents,
      fx.registry,
      new DriveSystemImpl(fx.agents),
      legacyFeedback,
    );
    fx.setDoorOpen(false);
    // No port → today's behaviour: the closed-door room is still offered.
    expect(bare.getKnownAreas('a1')).toContain('workshop');
  });
});

// ─── AC-5 — one reachability decision (R4) ──────────────────────────────────

describe('one reachability decision, reused from the spatial authority (spec 065, AC-5)', () => {
  it('the port and requestWalk agree on passability across a door flip', () => {
    const fx = buildFixture();
    seedMemory(fx.agents, GARDEN_ONLY);

    fx.setDoorOpen(false);
    expect(fx.nav.canReachArea('a1', 'workshop')).toBe(false);
    expect(fx.nav.requestWalk('a1', 'workshop')).toBe(false); // same decision

    fx.setDoorOpen(true);
    expect(fx.nav.canReachArea('a1', 'workshop')).toBe(true);
    expect(fx.nav.requestWalk('a1', 'workshop')).toBe(true); // same decision
  });

  it('flipping door state flips the offered enum (the provider asks the authority)', () => {
    const fx = buildFixture();
    seedMemory(fx.agents, GARDEN_ONLY);
    const before = fx.provider.getKnownAreas('a1');
    fx.setDoorOpen(false);
    const after = fx.provider.getKnownAreas('a1');
    expect(before).toContain('workshop');
    expect(after).not.toContain('workshop');
  });

  it('accepts the reachability port as an optional constructor argument', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('a1', 'garden'));
    agents.updateState('a1', { location: 'garden' });
    seedMemory(agents, GARDEN_ONLY);
    const registry = new SmartObjectRegistryImpl();
    registry.register(makeObject('planter-1', 'garden'));
    const provider = new PerceptionDataProviderImpl(
      agents,
      registry,
      new DriveSystemImpl(agents),
      legacyFeedback,
      { canReachArea: () => false },
    );
    expect(provider.getKnownAreas('a1')).not.toContain('workshop');
  });
});

// ─── AC-6 — the guard ───────────────────────────────────────────────────────

describe('enum-vs-navigation guard (spec 065, R5/AC-6)', () => {
  it('the enum and the same cycle navigation agree when the door is closed', () => {
    const fx = buildFixture();
    seedMemory(fx.agents, GARDEN_ONLY);
    fx.setDoorOpen(false);
    // Fresh fixture: the only offered areas are the visited garden and the
    // live garden anchor, both routable/current — the guard passes.
    expectEnumNavigationAgreement(fx.provider, fx.nav, fx.agents, 'a1');
    // And it is not vacuous: navigation really reports no route to workshop.
    expect(fx.nav.navigateToArea('a1', 'workshop')).toBe('no-route');
  });

  it('the guard FAILS when a stale door-only area is re-admitted (verified red)', () => {
    const fx = buildFixture();
    seedMemory(fx.agents, GARDEN_ONLY);
    fx.setDoorOpen(false);
    // A provider with NO port reproduces the pre-065 projection: workshop is
    // re-admitted while navigation reports 'no-route' — the guard must catch it.
    const stale = new PerceptionDataProviderImpl(
      fx.agents,
      fx.registry,
      new DriveSystemImpl(fx.agents),
      legacyFeedback,
    );
    expect(() => expectEnumNavigationAgreement(stale, fx.nav, fx.agents, 'a1')).toThrow(
      /not routable/,
    );
  });
});

// ─── Assembly wiring (spec 065 R4) ──────────────────────────────────────────

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

function makeScene(): SceneDefinition {
  return {
    id: 'two-room-world',
    name: 'Two Room World',
    rooms: [garden, workshop],
    objects: [
      makeObject('planter-1', 'garden'),
      makeObject('workbench-1', 'workshop'),
      makeObject('door-garden', 'garden'),
      makeObject('door-workshop', 'workshop'),
    ],
    agents: [makeProfile('a1', 'garden')],
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

function buildEngine(): EngineCore {
  const core = createEngineCore(makeConfig(), undefined, undefined);
  loadScene(core, makeScene());
  assembleGameLoop(core, noopOrchestrator as never);
  return core;
}

describe('assembly wires the reachability port to navigation (spec 065, R4)', () => {
  it('a closed door removes the neighbour from the assembled enum, reopening restores it', () => {
    const core = buildEngine();
    // Spawn seeding: garden visited, the garden|workshop door seen, garden
    // anchors observed — workshop is door-derived only.
    expect(core.agentManager.getState('a1')!.spatialMemory!.visitedRooms).toEqual(['garden']);
    expect(core.bridges.perception.getKnownAreas('a1')).toContain('workshop');

    core.sceneManager.setConnectionOpen('garden', 'workshop', false);
    expect(core.bridges.perception.getKnownAreas('a1')).not.toContain('workshop');
    expect(core.agentManager.getState('a1')!.spatialMemory!.knownDoors).toContain(
      'garden|workshop',
    );

    core.sceneManager.setConnectionOpen('garden', 'workshop', true);
    expect(core.bridges.perception.getKnownAreas('a1')).toContain('workshop');
  });
});
