/**
 * Tests for spec 031 — Execute-Time Co-Location Guard & Stale Plan Re-Validation
 * (issue #121) — engine layer.
 *
 * Covers:
 * - AC-1 (Req 1, 2): executeAffordance rejects when the object's live roomId
 *   differs from the agent's live location, with the exact actionable
 *   failureReason; the handler is never invoked.
 * - AC-2 (Req 1, 7): no state mutation on co-location failure.
 * - AC-10 (Req 8): move_object mutation/registry consistency (spec 030 Req 2
 *   regression net).
 * - AC-13 (Req 1): the guard runs on direct (non-room-scoped) calls, and reads
 *   the agent location LIVE (not a cached/perception-time snapshot).
 * - AC-14 (Req 1–6): the guard is pure deterministic engine logic.
 * - Req 3 (physics level): each compound sub-step funnels through
 *   executeAffordance, so a moved sub-step target is rejected by the guard.
 * - Req 5 (engine side): the registry backs the shared `AffordanceGuard`
 *   interface via getByRoom.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Affordance, AffordanceResult, Room, SmartObject } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { AffordanceRegistryImpl } from '../src/world/affordances/index.js';
import { PhysicsSystemImpl } from '../src/physics/index.js';
import { ExecuteDataProviderImpl } from '../src/agents/execute/index.js';
import { PlanManagerImpl } from '../src/agents/plans/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { SystemFeedbackStore } from '../src/agents/feedback/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { SceneMutationServiceImpl, DormantAgentStore } from '../src/world/mutations/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'gardener-1';
const GARDEN = 'garden';
const WORKSHOP = 'workshop';

const takeTool: Affordance = {
  id: 'take_tool',
  label: 'Take the tool',
  engineEffect: 'take_tool',
  preconditions: [],
  effects: {},
};

const toolbox: SmartObject = {
  id: 'toolbox-1',
  name: 'Toolbox',
  type: 'container',
  state: { tools: 2 },
  affordances: [takeTool],
  roomId: GARDEN,
};

function makeRoom(id: string, connections: string[] = []): Room {
  return { id, name: id, description: '', connections, objectIds: [] };
}

/** Registry + affordances + physics wired with a LIVE agent-location resolver. */
function buildPhysics(agentManager: AgentManagerImpl): {
  registry: SmartObjectRegistryImpl;
  affordances: AffordanceRegistryImpl;
  physics: PhysicsSystemImpl;
} {
  const registry = new SmartObjectRegistryImpl();
  const affordances = new AffordanceRegistryImpl(registry);
  const physics = new PhysicsSystemImpl(registry, affordances, (agentId) =>
    agentManager.getState(agentId)?.location,
  );
  return { registry, affordances, physics };
}

// ── AC-1 / AC-2 / AC-13 — the execute-time co-location guard ────────────────

describe('PhysicsSystemImpl co-location guard (spec 031, Req 1/2 — AC-1, AC-2, AC-13)', () => {
  let agentManager: AgentManagerImpl;
  let registry: SmartObjectRegistryImpl;
  let affordances: AffordanceRegistryImpl;
  let physics: PhysicsSystemImpl;
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    agentManager = new AgentManagerImpl();
    agentManager.spawn({
      id: AGENT_ID,
      name: 'Gardener',
      description: '',
      traits: [],
      initialDrives: {},
    });
    agentManager.updateState(AGENT_ID, { location: GARDEN });

    ({ registry, affordances, physics } = buildPhysics(agentManager));
    registry.register(JSON.parse(JSON.stringify(toolbox)) as SmartObject);

    handler = vi.fn().mockImplementation(async (): Promise<AffordanceResult> => {
      return {
        success: true,
        newState: { tools: 1, taken_by: AGENT_ID },
        driveChanges: { curiosity: 5 },
      };
    });
    affordances.registerHandler('take_tool', handler);
  });

  it('AC-1: rejects with the exact co-location failureReason when the object moved to another room, and never invokes the handler', async () => {
    // The world moved on: toolbox-1 now lives in the workshop.
    registry.setRoom('toolbox-1', WORKSHOP);

    const result = await physics.executeAffordance('toolbox-1', 'take_tool', AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe(
      'The Toolbox (toolbox-1) is no longer here — it moved to the workshop.',
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('AC-2: on co-location failure the object state is unchanged and no newState is applied', async () => {
    registry.setRoom('toolbox-1', WORKSHOP);
    const before = registry.get('toolbox-1')!.state;

    await physics.executeAffordance('toolbox-1', 'take_tool', AGENT_ID);

    const after = registry.get('toolbox-1')!.state;
    expect(after).toEqual(before);
    expect(after['taken_by']).toBeUndefined();
    // No drive changes either — the handler result is never produced.
    expect(registry.get('toolbox-1')!.roomId).toBe(WORKSHOP);
  });

  it('AC-13: the guard runs on direct executeAffordance(objectId, …) calls (non-room-scoped resolution path)', async () => {
    // The caller bypasses room-scoped resolution entirely — the guard must
    // still compare live object.roomId vs live agent location.
    registry.setRoom('toolbox-1', WORKSHOP);
    const result = await physics.executeAffordance('toolbox-1', 'take_tool', AGENT_ID);
    expect(result.success).toBe(false);
    expect(result.failureReason).toContain('no longer here');
    expect(handler).not.toHaveBeenCalled();
  });

  it('reads the agent location LIVE: when the agent follows the object, execution succeeds (no cached location)', async () => {
    registry.setRoom('toolbox-1', WORKSHOP);
    // The agent walked to the workshop after the object moved.
    agentManager.updateState(AGENT_ID, { location: WORKSHOP });

    const result = await physics.executeAffordance('toolbox-1', 'take_tool', AGENT_ID);

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(registry.get('toolbox-1')!.state['taken_by']).toBe(AGENT_ID);
  });

  it('AC-14: the guard is deterministic — identical inputs produce identical results', async () => {
    registry.setRoom('toolbox-1', WORKSHOP);
    const r1 = await physics.executeAffordance('toolbox-1', 'take_tool', AGENT_ID);
    const r2 = await physics.executeAffordance('toolbox-1', 'take_tool', AGENT_ID);
    expect(r1).toEqual(r2);
    expect(r1.failureReason).toBe(r2.failureReason);
  });

  it('back-compat: without an injected resolver the guard is inert (existing constructions unchanged)', async () => {
    const bareRegistry = new SmartObjectRegistryImpl();
    const bareAffordances = new AffordanceRegistryImpl(bareRegistry);
    const barePhysics = new PhysicsSystemImpl(bareRegistry, bareAffordances);
    bareRegistry.register(JSON.parse(JSON.stringify(toolbox)) as SmartObject);
    const bareHandler = vi.fn().mockResolvedValue({ success: true });
    bareAffordances.registerHandler('take_tool', bareHandler);

    bareRegistry.setRoom('toolbox-1', WORKSHOP);
    const result = await barePhysics.executeAffordance('toolbox-1', 'take_tool', AGENT_ID);
    expect(result.success).toBe(true);
    expect(bareHandler).toHaveBeenCalledTimes(1);
  });
});

// ── Req 3 (physics level) — compound sub-steps funnel through the guard ──────

describe('Co-location guard covers compound sub-step execution paths (spec 031, Req 3 — AC-12 funnel)', () => {
  it('a sub-step executeAffordance call on a moved object is rejected with the co-location reason', async () => {
    const agentManager = new AgentManagerImpl();
    agentManager.spawn({
      id: AGENT_ID,
      name: 'Gardener',
      description: '',
      traits: [],
      initialDrives: {},
    });
    agentManager.updateState(AGENT_ID, { location: GARDEN });

    const { registry, affordances, physics } = buildPhysics(agentManager);
    registry.register(JSON.parse(JSON.stringify(toolbox)) as SmartObject);
    const handler = vi.fn().mockResolvedValue({ success: true });
    affordances.registerHandler('take_tool', handler);

    // Mid-compound, the owning object is relocated; the next sub-step's
    // executeAffordance call must hit the guard.
    registry.setRoom('toolbox-1', WORKSHOP);
    const result = await physics.executeAffordance('toolbox-1', 'take_tool', AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe(
      'The Toolbox (toolbox-1) is no longer here — it moved to the workshop.',
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

// ── AC-10 — mutation/registry consistency (spec 030 Req 2 regression net) ────

describe('move_object mutation/registry consistency (spec 031, Req 8 — AC-10)', () => {
  it('after move_object: getByRoom(from) excludes, getByRoom(to) includes, roomId equals toRoomId', () => {
    const agentManager = new AgentManagerImpl();
    const garden = makeRoom(GARDEN, [WORKSHOP]);
    const workshop = makeRoom(WORKSHOP, [GARDEN]);
    const roomMap = new Map<string, Room>([
      [GARDEN, { ...garden, connections: [...garden.connections], objectIds: [...garden.objectIds] }],
      [
        WORKSHOP,
        { ...workshop, connections: [...workshop.connections], objectIds: [...workshop.objectIds] },
      ],
    ]);
    const sceneManager = new SceneManagerImpl(agentManager, roomMap);
    const registry = new SmartObjectRegistryImpl();
    registry.register(JSON.parse(JSON.stringify(toolbox)) as SmartObject);
    const service = new SceneMutationServiceImpl({
      registry,
      sceneManager,
      agentManager,
      dormantStore: new DormantAgentStore(),
    });

    service.propose({
      type: 'move_object',
      payload: { objectId: 'toolbox-1', toRoomId: WORKSHOP },
    });
    service.applyPending(1);

    expect(registry.getByRoom(GARDEN).map((o) => o.id)).not.toContain('toolbox-1');
    expect(registry.getByRoom(WORKSHOP).map((o) => o.id)).toContain('toolbox-1');
    expect(registry.get('toolbox-1')!.roomId).toBe(WORKSHOP);
  });
});

// ── Req 5 (engine side) — registry-backed AffordanceGuard ────────────────────

describe('SmartObjectRegistry affordance guard backing (spec 031, Req 5)', () => {
  it('isAffordanceAvailableInRoom tracks the live registry as objects move', () => {
    const registry = new SmartObjectRegistryImpl();
    registry.register(JSON.parse(JSON.stringify(toolbox)) as SmartObject);

    expect(registry.isAffordanceAvailableInRoom('take_tool', GARDEN)).toBe(true);
    expect(registry.isAffordanceAvailableInRoom('take_tool', WORKSHOP)).toBe(false);

    registry.setRoom('toolbox-1', WORKSHOP);

    expect(registry.isAffordanceAvailableInRoom('take_tool', GARDEN)).toBe(false);
    expect(registry.isAffordanceAvailableInRoom('take_tool', WORKSHOP)).toBe(true);
    // Unknown affordances are never "available".
    expect(registry.isAffordanceAvailableInRoom('nonexistent', GARDEN)).toBe(false);
  });
});

// ── Req 4 support — the engine bridge exposes the global (any-room) lookup ───

describe('ExecuteDataProviderImpl.resolveAffordanceAnywhere (spec 031, Req 4 support)', () => {
  it('finds the affordance on an object in ANY room, with name and current roomId', () => {
    const agentManager = new AgentManagerImpl();
    agentManager.spawn({
      id: AGENT_ID,
      name: 'Gardener',
      description: '',
      traits: [],
      initialDrives: {},
    });
    agentManager.updateState(AGENT_ID, { location: GARDEN });

    const registry = new SmartObjectRegistryImpl();
    registry.register(JSON.parse(JSON.stringify(toolbox)) as SmartObject);
    const affordances = new AffordanceRegistryImpl(registry);
    const { physics } = buildPhysics(agentManager);
    const driveSystem = new DriveSystemImpl(agentManager, 0.1);
    const planManager = new PlanManagerImpl(agentManager, () => 0);
    const feedbackStore = new SystemFeedbackStore();

    const bridge = new ExecuteDataProviderImpl({
      agentManager,
      planManager,
      driveSystem,
      smartRegistry: registry,
      affordanceRegistry: affordances,
      physics,
      feedbackStore,
    });

    // Before the move: resolvable in the agent's own room.
    const here = bridge.resolveAffordanceAnywhere('take_tool');
    expect(here).toEqual({
      objectId: 'toolbox-1',
      objectName: 'Toolbox',
      roomId: GARDEN,
    });

    registry.setRoom('toolbox-1', WORKSHOP);

    const elsewhere = bridge.resolveAffordanceAnywhere('take_tool');
    expect(elsewhere).toEqual({
      objectId: 'toolbox-1',
      objectName: 'Toolbox',
      roomId: WORKSHOP,
    });

    // Truly-unresolvable affordances return null (skip path stays reachable).
    expect(bridge.resolveAffordanceAnywhere('no_such_affordance')).toBeNull();
  });
});