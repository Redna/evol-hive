/**
 * Tests for Dynamic Scenes / Living Worlds (spec 030, issue #117) — shared types.
 *
 * Verifies the mutation event-sourcing types, the SceneMutationError with
 * actionable messages, the SaveState extension with the dynamic world
 * snapshot + version bump, the GuardrailConfig extension, and the
 * modify_scene cognitive tool name (Req 2, 3, 11, 13, 14).
 */
import { describe, it, expect } from 'vitest';
import type {
  SceneMutationEvent,
  SceneMutationProposal,
  SceneMutationPort,
  DynamicWorldSnapshot,
  DormantAgentSnapshot,
  TopologyGuard,
} from '../src/types/mutations.js';
import { SceneMutationError } from '../src/types/mutations.js';
import { SAVE_FORMAT_VERSION } from '../src/types/persistence.js';
import type { SaveState } from '../src/types/persistence.js';
import type { GuardrailConfig } from '../src/types/cognition.js';

describe('SceneMutationEvent (spec 030, Req 2)', () => {
  it('carries seq, tick, type, payload, source fields', () => {
    const event: SceneMutationEvent = {
      seq: 1,
      tick: 42,
      type: 'add_object',
      payload: {
        object: {
          id: 'crate-1',
          name: 'Crate',
          type: 'furniture',
          state: {},
          affordances: [],
          roomId: 'room_a',
        },
      },
      source: 'engine',
    };
    expect(event.seq).toBe(1);
    expect(event.tick).toBe(42);
    expect(event.type).toBe('add_object');
    expect(event.source).toBe('engine');
  });

  it('accepts all six mutation types', () => {
    const types: SceneMutationEvent['type'][] = [
      'add_object',
      'remove_object',
      'move_object',
      'spawn_agent',
      'despawn_agent',
      'set_connection_state',
    ];
    expect(types).toHaveLength(6);
  });

  it('round-trips through JSON (event log is serializable)', () => {
    const event: SceneMutationEvent = {
      seq: 7,
      tick: 3,
      type: 'set_connection_state',
      payload: { roomA: 'room_a', roomB: 'room_b', action: 'close' },
      source: 'llm',
    };
    const parsed = JSON.parse(JSON.stringify(event)) as SceneMutationEvent;
    expect(parsed).toEqual(event);
  });
});

describe('SceneMutationError (spec 030, Req 3)', () => {
  it('names the offending IDs and the violated rule', () => {
    const err = new SceneMutationError(
      'duplicate_object_id',
      "Cannot add object 'crate-1': an object with ID 'crate-1' already exists.",
      ['crate-1'],
    );
    expect(err.name).toBe('SceneMutationError');
    expect(err.rule).toBe('duplicate_object_id');
    expect(err.offendingIds).toEqual(['crate-1']);
    expect(err.message).toContain('crate-1');
  });

  it('is catchable as an Error', () => {
    expect(() => {
      throw new SceneMutationError('test_rule', 'boom', []);
    }).toThrow(Error);
  });
});

describe('SceneMutationPort bridge (spec 030, Req 13)', () => {
  it('exposes propose() and getMutations()', () => {
    // The port is a bridge interface implemented by the engine and consumed
    // by cognition (per ADR-0001). Verify the shape structurally.
    const port: SceneMutationPort = {
      propose(_mutation: SceneMutationProposal) {
        return { accepted: true, seq: 1 };
      },
      getMutations(_sinceSeq?: number) {
        return [];
      },
    };
    const result = port.propose({ type: 'despawn_agent', payload: { agentId: 'a1' } });
    expect(result.accepted).toBe(true);
    expect(port.getMutations(0)).toEqual([]);
  });
});

describe('SaveState dynamic extension (spec 030, Req 11)', () => {
  it('bumps SAVE_FORMAT_VERSION to 2', () => {
    expect(SAVE_FORMAT_VERSION).toBe(2);
  });

  it('SaveState.dynamic is optional (static scenes unchanged)', () => {
    const state: SaveState = {
      formatVersion: SAVE_FORMAT_VERSION,
      savedAt: 0,
      gameLoop: { tickNumber: 0, simulationTime: 0, deltaSeconds: 1 / 60 },
      agents: [],
      world: { rooms: [], objects: [] },
      memories: [],
    };
    expect('dynamic' in state).toBe(false);
  });

  it('DynamicWorldSnapshot holds the mutation log and dormant agents, serializable', () => {
    const snapshot: DynamicWorldSnapshot = {
      mutationLog: [],
      dormantAgents: [
        {
          profile: {
            id: 'a1',
            name: 'A',
            description: '',
            traits: [],
            initialDrives: {},
          },
          state: {
            agentId: 'a1',
            drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
            currentGoal: 'rest',
            currentPlan: null,
            isThinking: false,
            location: 'room_a',
            lastPerceptionTick: 0,
          },
          memories: [],
        },
      ],
    };
    const parsed = JSON.parse(JSON.stringify(snapshot)) as DynamicWorldSnapshot;
    expect(parsed.dormantAgents).toHaveLength(1);
    expect(parsed.dormantAgents[0]!.state.currentGoal).toBe('rest');
  });
});

describe('GuardrailConfig.maxSceneMutationsPerCycle (spec 030, Req 14d)', () => {
  it('is an optional field on GuardrailConfig', () => {
    const base: GuardrailConfig = {
      affordanceMasking: true,
      contextualForcing: true,
      planValidation: true,
    };
    expect('maxSceneMutationsPerCycle' in base).toBe(false);
    const extended: GuardrailConfig = { ...base, maxSceneMutationsPerCycle: 3 };
    expect(extended.maxSceneMutationsPerCycle).toBe(3);
  });
});

describe('modify_scene cognitive tool name (spec 030, Req 13)', () => {
  it("CognitiveToolName includes 'modify_scene'", () => {
    const name: import('../src/types/cognition.js').CognitiveToolName = 'modify_scene';
    expect(name).toBe('modify_scene');
  });
});

describe('TopologyGuard port (spec 030, Req 10)', () => {
  it('is a structural interface the engine implements and guardrails consume', () => {
    const guard: TopologyGuard = {
      isMovementBlocked(_agentId: string, _action: string, _fromRoom: string): boolean {
        return true;
      },
    };
    expect(guard.isMovementBlocked('a1', 'go_to_kitchen', 'office')).toBe(true);
  });
});
