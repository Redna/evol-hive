/**
 * Spec 065 — Reachable Offers: assembled end-to-end coverage (issue #225,
 * slice 2)
 * ═══════════════════════════════════════════════════════════════════════
 * The engine tests assert the `getKnownAreas` projection directly and at the
 * engine's own assembly. This test drives the PRODUCTION composition root
 * (`assembleWorld` → engine core + cognition) and asserts the value the LLM
 * actually receives: the `targetArea` enum on the `formulate_plan` tool.
 *
 * - AC-5 (R4): flipping door state flips the enum through the injected port.
 * - AC-4 (R1): reachable neighbours / visited rooms / live anchors stay.
 * - AC-3 (R2): a removed object's anchor leaves both `knownAreas` and the
 *   `targetArea` enum — it no longer renders as current perception.
 *
 * Deterministic throughout — the classifier is a pass-through stub and no LLM
 * is invoked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  Affordance,
  AgentProfile,
  EngineConfig,
  Room,
  SceneDefinition,
  SmartObject,
  ToolDefinition,
} from '@evol-hive/shared';
import type { AffordanceClassifier } from '@evol-hive/cognition';
import { PerceptionServiceImpl, PlanBuilderImpl } from '@evol-hive/cognition';
import type { EngineCore } from '@evol-hive/engine';
import { loadScene } from '@evol-hive/engine';
import { assembleWorld } from '@evol-hive/assembly';

const ENV_KEYS = ['USE_REAL_LLM', 'USE_REAL_EMBEDDINGS', 'ENGINE_MAX_CONCURRENT_LLM'] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 30,
    spatialDebounceSeconds: 2,
    maxConcurrentLLM: 8,
    guardrailsEnabled: false,
  };
}

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
  return { id, label: id, engineEffect: id, preconditions: [], effects: { comfort: 5 } };
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
    id: 'spec-065-two-room-world',
    name: 'Spec 065 Two Room World',
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

function stubClassifier(): AffordanceClassifier {
  return { prune: async (_driveLabel: string, affordances: Affordance[]) => affordances };
}

async function perceive(core: EngineCore, agentId: string) {
  const service = new PerceptionServiceImpl({
    provider: core.bridges.perception,
    classifier: stubClassifier(),
  });
  return service.perceive(agentId);
}

/** Extract the `targetArea` enum the LLM sees on the `formulate_plan` tool. */
function targetAreaEnum(tools: ToolDefinition[]): string[] {
  const planTool = tools.find((t) => t.function.name === 'formulate_plan');
  const parameters = (planTool?.function.parameters ?? {}) as unknown as {
    properties?: {
      steps?: {
        items?: { properties?: { targetArea?: { enum?: string[] } } };
      };
    };
  };
  return parameters.properties?.steps?.items?.properties?.targetArea?.enum ?? [];
}

function buildWorld(): EngineCore {
  const world = assembleWorld({
    config: makeConfig(),
    sceneSetup: (core) => loadScene(core, makeScene()),
  });
  return world.core;
}

// ─── AC-5 / AC-4 — the LLM's enum follows door state ────────────────────────

describe('spec 065 E2E — the formulated targetArea enum only offers reachable areas', () => {
  it('an open door offers the neighbour; closing it removes the row; reopening restores it', async () => {
    const core = buildWorld();

    // Spawn seeding (spec 039 AC-8): garden visited, the garden|workshop door
    // seen, garden anchors observed — workshop is door-derived only.
    expect(core.agentManager.getState('a1')!.spatialMemory!.visitedRooms).toEqual(['garden']);
    expect(core.agentManager.getState('a1')!.spatialMemory!.knownDoors).toContain(
      'garden|workshop',
    );

    const before = targetAreaEnum(new PlanBuilderImpl().build(await perceive(core, 'a1')).tools);
    expect(before).toContain('garden'); // visited
    expect(before).toContain('workshop'); // open-door neighbour
    expect(before).toContain('planter-1'); // live anchor

    core.sceneManager.setConnectionOpen('garden', 'workshop', false);
    const closed = targetAreaEnum(new PlanBuilderImpl().build(await perceive(core, 'a1')).tools);
    expect(closed).not.toContain('workshop'); // the OFFER is gated
    expect(closed).toContain('garden'); // visited room stays (AC-2/AC-4)
    expect(closed).toContain('planter-1'); // live anchor stays (AC-4)
    // R3: the knowledge survives the gate.
    expect(core.agentManager.getState('a1')!.spatialMemory!.knownDoors).toContain(
      'garden|workshop',
    );

    core.sceneManager.setConnectionOpen('garden', 'workshop', true);
    const reopened = targetAreaEnum(new PlanBuilderImpl().build(await perceive(core, 'a1')).tools);
    expect(reopened).toContain('workshop'); // re-offered without re-observation
  });

  it('a removed object anchor disappears from knownAreas and from the targetArea enum', async () => {
    const core = buildWorld();
    // The spawn anchor is present to begin with.
    expect(targetAreaEnum(new PlanBuilderImpl().build(await perceive(core, 'a1')).tools)).toContain(
      'planter-1',
    );

    core.smartObjectRegistry.remove('planter-1');

    const perception = await perceive(core, 'a1');
    expect(perception.knownAreas ?? []).not.toContain('planter-1');
    expect(targetAreaEnum(new PlanBuilderImpl().build(perception).tools)).not.toContain(
      'planter-1',
    );
    // And the false memory is actually corrected, not merely hidden.
    expect(
      Object.keys(core.agentManager.getState('a1')!.spatialMemory!.observedObjects ?? {}),
    ).not.toContain('planter-1');
  });

  it('the formulated enum never disagrees with the same cycle navigation (guard)', async () => {
    const core = buildWorld();
    core.sceneManager.setConnectionOpen('garden', 'workshop', false);
    const perception = await perceive(core, 'a1');
    const enumAreas = targetAreaEnum(new PlanBuilderImpl().build(perception).tools);
    const memory = core.agentManager.getState('a1')!.spatialMemory!;
    const visited = new Set(memory.visitedRooms);
    const anchored = new Set(Object.keys(memory.observedObjects ?? {}));
    // Every offered area is either exempt knowledge (visited room / live
    // anchor, per the spec's AC-2 + R1) or actually routable on the grid.
    for (const area of enumAreas) {
      if (visited.has(area) || anchored.has(area)) continue;
      const route = core.navigation!.grid.route(memory.visitedRooms[0] ?? 'garden', area);
      expect(route.length, `formulated area '${area}' has no open route`).toBeGreaterThan(0);
    }
  });
});
