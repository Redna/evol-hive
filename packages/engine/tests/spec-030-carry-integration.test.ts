/**
 * Integration test — agent-initiated mutation through a real affordance
 * execution (spec 030, AC-1 full path).
 *
 * AC-1 reads: "An agent executes a carry/move affordance that calls
 * MoveObject; the object's roomId changes, getObjectsInRoom reflects old and
 * new rooms on the next tick, and the per-room affordance lists update." The
 * service-level unit tests cover MoveObject directly; this test covers the
 * agent-initiated integration path end-to-end through the assembled engine:
 *
 *   PhysicsSystem.executeAffordance → AffordanceHandler (carry engine effect)
 *   → SceneMutationService.propose(source: 'agent') → queued
 *   → SceneMutationSystem (registered FIRST) applies at the tick boundary
 *   → registry + room objectIds + live affordance lists all consistent.
 *
 * This mirrors the `createCarryEffect` helper shipped in
 * `examples/dynamic-world.ts` (spec 028 Execute-service pattern).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { PPEROrchestratorPort, PPERPhase, SceneDefinition } from '@evol-hive/shared';
import { createEngineCore, loadScene, assembleGameLoop } from '../src/assembly.js';
import type { EngineCore } from '../src/assembly.js';
import type { AffordanceHandler } from '../src/world/index.js';

// ── Fixture ──────────────────────────────────────────────────────────────────

/** garden ↔ workshop; a portable crate with a `carry` affordance in garden. */
function makeScene(): SceneDefinition {
  return {
    id: 'carry-scene',
    name: 'Carry Integration Scene',
    rooms: [
      {
        id: 'garden',
        name: 'Garden',
        description: '',
        connections: ['workshop'],
        objectIds: ['crate-1', 'doorway-garden'],
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
        id: 'crate-1',
        name: 'Crate',
        type: 'furniture',
        state: { target_room: 'workshop' },
        affordances: [
          {
            id: 'carry',
            label: 'Carry the crate',
            engineEffect: 'carry',
            preconditions: [],
            effects: { energy: -5 },
          },
          {
            id: 'observe',
            label: 'Observe',
            engineEffect: 'observe',
            preconditions: [],
            effects: {},
          },
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

/** The demo's `carry` engine effect: propose a move_object through the funnel. */
function createCarryEffect(core: EngineCore): AffordanceHandler {
  return async (objectId, _agentId, objectState) => {
    const targetRoom = objectState['target_room'];
    if (typeof targetRoom !== 'string' || targetRoom.length === 0) {
      return { success: false, failureReason: `No target_room set on object '${objectId}'.` };
    }
    const result = core.mutationService.propose({
      type: 'move_object',
      payload: { objectId, toRoomId: targetRoom },
      source: 'agent',
    });
    if (!result.accepted) {
      return { success: false, failureReason: result.error ?? 'Move rejected.' };
    }
    return { success: true, newState: { ...objectState, target_room: undefined } };
  };
}

class FakeOrchestrator implements PPEROrchestratorPort {
  calls: string[] = [];
  async runCycle(agentId: string): Promise<void> {
    this.calls.push(agentId);
  }
  getPhase(_agentId: string): PPERPhase {
    return 'perceive';
  }
}

interface Harness {
  core: EngineCore;
}

function buildHarness(): Harness {
  const core = createEngineCore({
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: false,
  });
  loadScene(core, makeScene());
  assembleGameLoop(core, new FakeOrchestrator());
  core.affordanceRegistry.registerHandler('carry', createCarryEffect(core));
  return { core };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AC-1 integration: agent executes a carry affordance → MoveObject at the tick boundary', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('the affordance effect enqueues the move; it is NOT applied mid-phase', async () => {
    const result = await h.core.physics.executeAffordance('crate-1', 'carry', 'gardener-1');
    expect(result.success).toBe(true);

    // Tick-boundary discipline: nothing moved yet.
    expect(h.core.smartObjectRegistry.get('crate-1')?.roomId).toBe('garden');
    expect(h.core.sceneManager.getRoom('garden')?.objectIds).toContain('crate-1');
  });

  it('after the next tick the object has moved and every surface is consistent', async () => {
    await h.core.physics.executeAffordance('crate-1', 'carry', 'gardener-1');
    h.core.gameLoop.injectElapsed(1 / 60); // exactly one tick — SceneMutationSystem runs FIRST

    // Registry: roomId changed.
    expect(h.core.smartObjectRegistry.get('crate-1')?.roomId).toBe('workshop');
    // getObjectsInRoom reflects old and new rooms.
    expect(h.core.smartObjectRegistry.getObjectsInRoom('garden').map((o) => o.id)).not.toContain(
      'crate-1',
    );
    expect(h.core.smartObjectRegistry.getObjectsInRoom('workshop').map((o) => o.id)).toContain(
      'crate-1',
    );
    // Room objectIds stay consistent (no orphans, no duplicates).
    const gardenIds = h.core.sceneManager.getRoom('garden')?.objectIds ?? [];
    const workshopIds = h.core.sceneManager.getRoom('workshop')?.objectIds ?? [];
    expect(gardenIds.filter((id) => id === 'crate-1')).toHaveLength(0);
    expect(workshopIds.filter((id) => id === 'crate-1')).toHaveLength(1);
    // The per-room affordance lists updated — the object's affordances are
    // available in the new room and absent from the old one (what perception reads).
    const gardenAffordances = h.core.smartObjectRegistry
      .getAffordancesInRoom('garden')
      .map((a) => a.id);
    const workshopAffordances = h.core.smartObjectRegistry
      .getAffordancesInRoom('workshop')
      .map((a) => a.id);
    expect(gardenAffordances).not.toContain('carry');
    expect(workshopAffordances).toContain('carry');
  });

  it('the applied event is recorded with source "agent" and the executing tick', async () => {
    await h.core.physics.executeAffordance('crate-1', 'carry', 'gardener-1');
    h.core.gameLoop.injectElapsed(1 / 60);

    const log = h.core.mutationService.getMutations();
    expect(log).toHaveLength(1);
    expect(log[0]!.type).toBe('move_object');
    expect(log[0]!.source).toBe('agent');
    expect(log[0]!.tick).toBe(1);
  });

  it('an invalid carry target surfaces the actionable rejection as affordance feedback', async () => {
    h.core.smartObjectRegistry.updateState('crate-1', { target_room: 'null_room' });

    const result = await h.core.physics.executeAffordance('crate-1', 'carry', 'gardener-1');
    expect(result.success).toBe(false);
    expect(result.failureReason).toContain('null_room');

    // Nothing moved after a tick.
    h.core.gameLoop.injectElapsed(1 / 60);
    expect(h.core.smartObjectRegistry.get('crate-1')?.roomId).toBe('garden');
    expect(h.core.mutationService.getMutations()).toHaveLength(0);
  });
});
