import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentInternalState, GameTick, SmartObjectProjection } from '@evol-hive/shared';
import { SpatialSystemImpl } from '../src/spatial/index.js';

// AC-5:  When location changes, shouldTriggerPerception returns true.
// AC-6:  When location does not change (idle timer not expired), returns false.
// AC-7:  When idle for spatialDebounceSeconds + 1 seconds, returns true.
// AC-8:  When idle for less than spatialDebounceSeconds, returns false.
// AC-9:  After recordPerceptionTick, lastPerceptionTick equals the passed simulationTime.
// AC-10: When neither debounce condition is met, returns false.

function makeAgent(location: string, lastPerceptionTick = 0): AgentInternalState {
  return {
    agentId: 'agent-1',
    drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    currentGoal: 'survive',
    currentPlan: null,
    isThinking: false,
    location,
    lastPerceptionTick,
  };
}

function makeTick(simulationTime: number): GameTick {
  return { tickNumber: 0, simulationTime, deltaSeconds: 0 };
}

/** Simple in-memory agent state store for testing. */
class TestAgentStore {
  private agents = new Map<string, AgentInternalState>();

  set(agent: AgentInternalState): void {
    this.agents.set(agent.agentId, agent);
  }

  getState(agentId: string): AgentInternalState | null {
    return this.agents.get(agentId) ?? null;
  }

  updateState(agentId: string, updates: Partial<AgentInternalState>): void {
    const current = this.agents.get(agentId);
    if (current) {
      this.agents.set(agentId, { ...current, ...updates });
    }
  }
}

/** Simple in-memory object registry returning projections. */
class TestObjectRegistry {
  private byRoom = new Map<string, SmartObjectProjection[]>();

  setRoomObjects(roomId: string, objects: SmartObjectProjection[]): void {
    this.byRoom.set(roomId, objects);
  }

  getObjectsInRoom(roomId: string): SmartObjectProjection[] {
    return this.byRoom.get(roomId) ?? [];
  }
}

describe('SpatialSystemImpl', () => {
  const DEBOUNCE_SECONDS = 5;
  let store: TestAgentStore;
  let objectRegistry: TestObjectRegistry;
  let spatial: SpatialSystemImpl;

  beforeEach(() => {
    store = new TestAgentStore();
    objectRegistry = new TestObjectRegistry();
    spatial = new SpatialSystemImpl(store, objectRegistry, {
      spatialDebounceSeconds: DEBOUNCE_SECONDS,
    });
  });

  describe('shouldTriggerPerception — room threshold (AC-5, AC-6)', () => {
    it('returns true when location changes from kitchen to lounge — AC-5', () => {
      const agent = makeAgent('kitchen');
      store.set(agent);

      // Record a perception tick at t=0 (records kitchen as last known room)
      spatial.recordPerceptionTick('agent-1', 0);

      // Agent moves to lounge
      store.updateState('agent-1', { location: 'lounge' });

      // Update simulation time to a small delta (not enough for idle timer)
      spatial.update(makeTick(1));

      expect(spatial.shouldTriggerPerception('agent-1')).toBe(true);
    });

    it('returns false when location does not change and idle timer not expired — AC-6', () => {
      const agent = makeAgent('kitchen');
      store.set(agent);

      spatial.recordPerceptionTick('agent-1', 0);
      spatial.update(makeTick(1)); // only 1 second idle, debounce is 5

      expect(spatial.shouldTriggerPerception('agent-1')).toBe(false);
    });
  });

  describe('shouldTriggerPerception — idle timer (AC-7, AC-8)', () => {
    it('returns true when idle for debounceSeconds + 1 — AC-7', () => {
      const agent = makeAgent('kitchen');
      store.set(agent);

      spatial.recordPerceptionTick('agent-1', 0);
      spatial.update(makeTick(DEBOUNCE_SECONDS + 1)); // 6 seconds idle

      expect(spatial.shouldTriggerPerception('agent-1')).toBe(true);
    });

    it('returns false when idle for less than debounceSeconds — AC-8', () => {
      const agent = makeAgent('kitchen');
      store.set(agent);

      spatial.recordPerceptionTick('agent-1', 0);
      spatial.update(makeTick(DEBOUNCE_SECONDS - 1)); // 4 seconds idle

      expect(spatial.shouldTriggerPerception('agent-1')).toBe(false);
    });
  });

  describe('shouldTriggerPerception — debounce skip (AC-10)', () => {
    it('returns false when neither room change nor idle timer conditions are met', () => {
      const agent = makeAgent('kitchen');
      store.set(agent);

      spatial.recordPerceptionTick('agent-1', 0);
      spatial.update(makeTick(2)); // 2 seconds idle, no room change

      expect(spatial.shouldTriggerPerception('agent-1')).toBe(false);
    });
  });

  describe('recordPerceptionTick (AC-9)', () => {
    it('updates AgentInternalState.lastPerceptionTick to the passed simulationTime', () => {
      const agent = makeAgent('kitchen');
      store.set(agent);

      spatial.recordPerceptionTick('agent-1', 42);

      const state = store.getState('agent-1');
      expect(state?.lastPerceptionTick).toBe(42);
    });

    it('records the current room as the last known room for debounce tracking', () => {
      const agent = makeAgent('kitchen');
      store.set(agent);

      spatial.recordPerceptionTick('agent-1', 0);
      // No room change — should not trigger
      spatial.update(makeTick(1));
      expect(spatial.shouldTriggerPerception('agent-1')).toBe(false);

      // Change room — should trigger
      store.updateState('agent-1', { location: 'lounge' });
      expect(spatial.shouldTriggerPerception('agent-1')).toBe(true);
    });
  });

  describe('getObjectsInRoom', () => {
    it('delegates to the object registry and returns projected shape', () => {
      objectRegistry.setRoomObjects('kitchen', [
        { id: 'coffee-machine', name: 'Coffee Machine', type: 'appliance' },
      ]);

      const objects = spatial.getObjectsInRoom('kitchen');

      expect(objects).toHaveLength(1);
      expect(objects[0]?.id).toBe('coffee-machine');
      expect(objects[0]?.name).toBe('Coffee Machine');
      expect(objects[0]?.type).toBe('appliance');
    });
  });

  describe('EngineSystem interface', () => {
    it('has a name property', () => {
      expect(spatial.name).toBe('spatial');
    });

    it('update stores the current simulation time for debounce calculations', () => {
      const agent = makeAgent('kitchen');
      store.set(agent);

      spatial.recordPerceptionTick('agent-1', 0);
      spatial.update(makeTick(3));

      // 3 < 5 debounce, no room change → false
      expect(spatial.shouldTriggerPerception('agent-1')).toBe(false);

      // Advance to 6 > 5 → true
      spatial.update(makeTick(6));
      expect(spatial.shouldTriggerPerception('agent-1')).toBe(true);
    });
  });
});
