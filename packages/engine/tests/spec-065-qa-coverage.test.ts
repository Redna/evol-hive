/**
 * Spec 065 — Reachable Offers: QA coverage additions (issue #225, slice 2)
 * ═══════════════════════════════════════════════════════════════════════
 * The Developer's `spec-065-reachable-area-offers.test.ts` covers the primary
 * offer projection for AC-1…AC-6. These tests close the QA-identified gaps:
 *
 * - R3 "knowledge is preserved" beyond `knownDoors` retention: the
 *   `getUnexploredAreas` knowledge projection still lists a door-only room
 *   after the door closes, while the OFFER (`getKnownAreas`) drops it. This is
 *   the knowledge-vs-offer distinction the spec turns on, asserted on a second
 *   projection rather than only on the raw door memory.
 * - R2 + R4 integration: a relocated anchor, once reconciled, resolves through
 *   the injected reachability port to its NEW room — so `canReachArea` and
 *   `navigateToArea` follow the corrected anchor rather than the stale room.
 * - R2 idempotence: anchor correction writes `spatialMemory` once; a repeat
 *   `getKnownAreas` call must not churn state per tick.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Affordance, AgentProfile, SmartObject } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { WorldGrid } from '../src/spatial/grid.js';
import { NavigationSystemImpl } from '../src/spatial/navigation.js';
import { PerceptionDataProviderImpl } from '../src/agents/perception/index.js';

// ─── Shared fixtures (mirrors the Developer's spec-065 fixture) ─────────────

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
  provider.setReachabilityPort(nav);
  return { agents, registry, nav, provider, setDoorOpen: (open) => (doorOpen = open) };
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

// ─── R3 — knowledge ≠ offer, on a second projection ─────────────────────────

describe('spec 065 QA — R3: the knowledge projection survives the offer gate', () => {
  let fx: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fx = buildFixture();
    seedMemory(fx.agents, GARDEN_ONLY);
  });

  it('a door-only room stays in getUnexploredAreas after the door closes, while getKnownAreas drops it', () => {
    fx.setDoorOpen(false);
    // The OFFER is gated...
    expect(fx.provider.getKnownAreas('a1')).not.toContain('workshop');
    // ...but the knowledge ("known but never crossed") is preserved, so the
    // unknown-marker data source still renders the room.
    expect(fx.provider.getUnexploredAreas('a1')).toContain('workshop');
  });

  it('a personally visited room leaves getUnexploredAreas and stays offered when the door closes', () => {
    seedMemory(fx.agents, {
      visitedRooms: ['garden', 'workshop'],
      knownDoors: ['garden|workshop'],
      discoveredAt: { garden: 1, workshop: 2 },
      observedObjects: { 'planter-1': 'garden' },
    });
    fx.setDoorOpen(false);
    expect(fx.provider.getUnexploredAreas('a1')).not.toContain('workshop');
    expect(fx.provider.getKnownAreas('a1')).toContain('workshop');
  });
});

// ─── R2 + R4 — a corrected anchor routes through the shared decision ────────

describe('spec 065 QA — R2 + R4: a relocated anchor routes to its actual room', () => {
  it('canReachArea and navigateToArea follow the re-pointed anchor, not the stale room', () => {
    const fx = buildFixture();
    seedMemory(fx.agents, GARDEN_ONLY);
    fx.registry.setRoom('planter-1', 'workshop');

    // Reconciling via the offer projection corrects the anchor to the new room.
    expect(fx.provider.getKnownAreas('a1')).toContain('planter-1');
    expect(fx.agents.getState('a1')!.spatialMemory!.observedObjects!['planter-1']).toBe('workshop');

    // R4: the port resolves the anchor through the corrected map — the same
    // `openRoute` the walk uses. Closed door to the NEW room → unreachable.
    fx.setDoorOpen(false);
    expect(fx.nav.canReachArea('a1', 'planter-1')).toBe(false);
    expect(fx.nav.navigateToArea('a1', 'planter-1')).toBe('no-route');

    // Reopening makes the relocated anchor executable again, routed to workshop.
    fx.setDoorOpen(true);
    expect(fx.nav.canReachArea('a1', 'planter-1')).toBe(true);
    expect(fx.nav.navigateToArea('a1', 'planter-1')).toBe('walking');
  });

  it('a removed anchor is no longer resolvable by the reachability port', () => {
    const fx = buildFixture();
    seedMemory(fx.agents, GARDEN_ONLY);
    fx.registry.remove('planter-1');

    const offered = fx.provider.getKnownAreas('a1');
    expect(offered).not.toContain('planter-1');
    expect(fx.nav.canReachArea('a1', 'planter-1')).toBe(false);
    expect(fx.nav.navigateToArea('a1', 'planter-1')).toBe('unknown-area');
  });
});

// ─── R2 — correction is idempotent ─────────────────────────────────────────

describe('spec 065 QA — R2: anchor reconciliation writes memory once', () => {
  it('a second getKnownAreas call does not rewrite spatialMemory', () => {
    const fx = buildFixture();
    seedMemory(fx.agents, GARDEN_ONLY);
    fx.registry.setRoom('planter-1', 'workshop');

    const spy = vi.spyOn(fx.agents, 'updateState');
    fx.provider.getKnownAreas('a1'); // correction write
    const afterCorrection = spy.mock.calls.length;
    fx.provider.getKnownAreas('a1'); // no change → no write
    fx.provider.getKnownAreas('a1'); // and again
    expect(spy.mock.calls.length).toBe(afterCorrection);
  });

  it('an unchanged anchor map never triggers a memory write', () => {
    const fx = buildFixture();
    seedMemory(fx.agents, GARDEN_ONLY);
    const spy = vi.spyOn(fx.agents, 'updateState');
    fx.provider.getKnownAreas('a1');
    expect(spy).not.toHaveBeenCalled();
  });
});
