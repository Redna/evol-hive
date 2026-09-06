/**
 * Spec 031 — Execute-Time Co-Location Guard — end-to-end regression (issue #121)
 * ────────────────────────────────────────────────────────────────────────────
 * Reproduces the reported bug against the REAL engine stack (registry,
 * physics, mutation funnel, bridges) driven by the REAL cognition
 * ExecuteServiceImpl + GuardrailEngineImpl:
 *
 *   plan `take_tool` in garden → move_object toolbox-1 to workshop at t+Δ →
 *   execute → graceful { success: false } failure with the co-location
 *   failureReason → the object chip never shows `taken_by: gardener-1`.
 *
 * Covers AC-5 (feedback loop reachability + unfreeze), AC-12 (E2E #121), and
 * AC-13 (the guard is authoritative on direct, non-room-scoped calls).
 *
 * No LLM is involved — the Execute phase is deterministic (AC-14).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Affordance, Room, SmartObject } from '@evol-hive/shared';
import { createEngineCore, loadScene } from '@evol-hive/engine';
import type { AffordanceHandler, EngineCore } from '@evol-hive/engine';
import { ExecuteServiceImpl, GuardrailEngineImpl } from '@evol-hive/cognition';
import type { TopologyGuard, AffordanceGuard } from '@evol-hive/shared';

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

function makeScene(): import('@evol-hive/shared').SceneDefinition {
  const garden: Room = {
    id: GARDEN,
    name: 'Garden',
    description: '',
    connections: [WORKSHOP],
    objectIds: ['toolbox-1'],
  };
  const workshop: Room = {
    id: WORKSHOP,
    name: 'Workshop',
    description: '',
    connections: [GARDEN],
    objectIds: [],
  };
  return {
    id: 'colocation-scene',
    name: 'Co-location Guard Scene',
    rooms: [garden, workshop],
    objects: [JSON.parse(JSON.stringify(toolbox)) as SmartObject],
    agents: [
      {
        id: AGENT_ID,
        name: 'Gardener',
        description: 'Tends the garden',
        traits: ['methodical'],
        initialDrives: { curiosity: 60 },
        startRoomId: GARDEN,
      },
    ],
  };
}

function makeConfig(): import('@evol-hive/shared').EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

/** Register the `take_tool` handler — on success it would stamp taken_by (the object chip). */
function registerTakeToolHandler(core: EngineCore): void {
  const handler: AffordanceHandler = async (objectId, agentId) => {
    core.smartObjectRegistry.updateState(objectId, { taken_by: agentId, tools: 1 });
    return { success: true, driveChanges: { curiosity: 5 } };
  };
  core.affordanceRegistry.registerHandler('take_tool', handler);
}

/** Move toolbox-1 to the workshop through the real mutation funnel (t+Δ). */
function moveToolbox(core: EngineCore): void {
  core.mutationService.propose({
    type: 'move_object',
    payload: { objectId: 'toolbox-1', toRoomId: WORKSHOP },
  });
  core.mutationService.applyPending(1);
}

describe('Issue #121 E2E — execute-time co-location guard (spec 031)', () => {
  let core: EngineCore;

  beforeEach(() => {
    core = createEngineCore(makeConfig());
    loadScene(core, makeScene());
    registerTakeToolHandler(core);
    // Give the agent the stale plan BEFORE the world moves.
    core.bridges.plan.storePlan(AGENT_ID, {
      description: 'Fetch the toolbox and repair the fence',
      steps: [{ description: 'Take the tool', targetAffordance: 'take_tool' }],
    });
  });

  it('AC-12: plan take_tool in garden → move_object toolbox-1 to workshop → execute → graceful co-location failure; the object chip never shows taken_by', async () => {
    moveToolbox(core);

    // Execute with NO guardrail wired — the engine's own co-location check
    // (via the bridge's global lookup) must turn the stale plan into a
    // graceful failure, never a silent skip.
    const execute = new ExecuteServiceImpl({ dataProvider: core.bridges.execute });
    const result = await execute.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'The Toolbox (toolbox-1) is no longer here — it moved to the workshop.',
    );
    expect(result.planComplete).toBe(false);
    expect(result.stepSkipped).toBeUndefined();

    // The object chip never shows taken_by: gardener-1.
    const chip = core.smartObjectRegistry.get('toolbox-1')!;
    expect(chip.roomId).toBe(WORKSHOP);
    expect(chip.state['taken_by']).toBeUndefined();
    expect(chip.state).toEqual({ tools: 2 });
  });

  it('AC-12 (full wiring): with the guardrail + affordanceGuard wired, the stale step is deviation-rejected into a reflection tick', async () => {
    moveToolbox(core);

    // Mirror the examples/assembly.ts wiring: topology + affordance guards
    // backed by the engine's live registry/scene manager.
    const topologyGuard: TopologyGuard = {
      isMovementBlocked: (agentId, action, fromRoom) =>
        core.sceneManager.isMovementBlocked(agentId, action, fromRoom),
    };
    const affordanceGuard: AffordanceGuard = {
      isAffordanceAvailableInRoom: (affordanceId, roomId) =>
        core.smartObjectRegistry.isAffordanceAvailableInRoom(affordanceId, roomId),
    };
    const guardrail = new GuardrailEngineImpl({
      config: {
        affordanceMasking: true,
        contextualForcing: true,
        planValidation: true,
      },
      topologyGuard,
    });

    const execute = new ExecuteServiceImpl({
      dataProvider: core.bridges.execute,
      guardrail,
      affordanceGuard,
    });
    const result = await execute.execute(AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.deviationRejected).toBe(true);
    expect(result.error).toContain('take_tool');
    expect(result.error).toContain('garden');

    const chip = core.smartObjectRegistry.get('toolbox-1')!;
    expect(chip.state['taken_by']).toBeUndefined();
  });

  it('AC-5: the failure reaches the Reflect context — system feedback readable on the next Perceive tick, agent not frozen', async () => {
    moveToolbox(core);

    const execute = new ExecuteServiceImpl({ dataProvider: core.bridges.execute });
    await execute.execute(AGENT_ID);

    const feedback = core.bridges.perception.getSystemFeedback(AGENT_ID);
    expect(feedback).toBe('The Toolbox (toolbox-1) is no longer here — it moved to the workshop.');

    const state = core.agentManager.getState(AGENT_ID)!;
    expect(state.isThinking).toBe(false);
  });

  it('AC-13: a direct, non-room-scoped executeAffordance call hits the physics co-location guard', async () => {
    moveToolbox(core);

    // Direct bridge call — no room-scoped resolution involved.
    const result = await core.bridges.execute.executeAffordance('toolbox-1', 'take_tool', AGENT_ID);

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe(
      'The Toolbox (toolbox-1) is no longer here — it moved to the workshop.',
    );
    expect(core.smartObjectRegistry.get('toolbox-1')!.state['taken_by']).toBeUndefined();
  });

  it('positive control: co-located agent + object executes cleanly through the full stack', async () => {
    // No mutation — the plan is fresh, the object is in the room.
    const execute = new ExecuteServiceImpl({ dataProvider: core.bridges.execute });
    const result = await execute.execute(AGENT_ID);

    expect(result.success).toBe(true);
    expect(core.smartObjectRegistry.get('toolbox-1')!.state['taken_by']).toBe(AGENT_ID);
  });
});
