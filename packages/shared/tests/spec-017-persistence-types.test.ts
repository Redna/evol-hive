/**
 * Spec 017 — Persistence types (shared layer)
 * ──────────────────────────────────────────────
 * Covers AC-1 through AC-8 and AC-50.
 */
import { describe, it, expect } from 'vitest';
import {
  SAVE_FORMAT_VERSION,
  SaveFormatVersionError,
  defaultAutoSaveConfig,
} from '../src/types/persistence.js';
import type {
  SaveState,
  GameLoopSnapshot,
  AgentSnapshot,
  WorldSnapshot,
  AutoSaveConfig,
} from '../src/types/persistence.js';
import type {
  AgentProfile,
  AgentInternalState,
  Room,
  SmartObject,
  MemoryNode,
} from '../src/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProfile(id = 'a1'): AgentProfile {
  return {
    id,
    name: id,
    description: 'test agent',
    traits: ['curious'],
    initialDrives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

function makeState(id = 'a1'): AgentInternalState {
  return {
    agentId: id,
    drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    currentGoal: 'survive',
    currentPlan: null,
    isThinking: false,
    location: 'room1',
    lastPerceptionTick: 0,
  };
}

// ─── AC-1: SaveState interface ───────────────────────────────────────────────

describe('AC-1: SaveState interface', () => {
  it('is exported from shared and has all required fields', () => {
    const state: SaveState = {
      formatVersion: 1,
      savedAt: 1234567890,
      gameLoop: { tickNumber: 0, simulationTime: 0, deltaSeconds: 1 / 60 },
      agents: [],
      world: { rooms: [], objects: [] },
      memories: [],
    };
    expect(state).toBeDefined();
    expect(state.formatVersion).toBe(1);
    expect(state.savedAt).toBe(1234567890);
    expect(state.gameLoop).toBeDefined();
    expect(Array.isArray(state.agents)).toBe(true);
    expect(state.world).toBeDefined();
    expect(Array.isArray(state.memories)).toBe(true);
  });
});

// ─── AC-2: GameLoopSnapshot interface ────────────────────────────────────────

describe('AC-2: GameLoopSnapshot interface', () => {
  it('is exported and has tickNumber, simulationTime, deltaSeconds', () => {
    const snap: GameLoopSnapshot = {
      tickNumber: 42,
      simulationTime: 0.7,
      deltaSeconds: 1 / 60,
    };
    expect(snap.tickNumber).toBe(42);
    expect(snap.simulationTime).toBe(0.7);
    expect(snap.deltaSeconds).toBe(1 / 60);
  });
});

// ─── AC-3: AgentSnapshot interface ───────────────────────────────────────────

describe('AC-3: AgentSnapshot interface', () => {
  it('is exported and has profile and state', () => {
    const snap: AgentSnapshot = {
      profile: makeProfile('a1'),
      state: makeState('a1'),
    };
    expect(snap.profile.id).toBe('a1');
    expect(snap.state.agentId).toBe('a1');
  });
});

// ─── AC-4: WorldSnapshot interface ───────────────────────────────────────────

describe('AC-4: WorldSnapshot interface', () => {
  it('is exported and has rooms and objects', () => {
    const snap: WorldSnapshot = {
      rooms: [],
      objects: [],
    };
    expect(Array.isArray(snap.rooms)).toBe(true);
    expect(Array.isArray(snap.objects)).toBe(true);
  });
});

// ─── AC-5: SAVE_FORMAT_VERSION ───────────────────────────────────────────────

describe('AC-5: SAVE_FORMAT_VERSION constant', () => {
  it('is exported and equals 1', () => {
    expect(SAVE_FORMAT_VERSION).toBe(1);
  });
});

// ─── AC-6: SaveFormatVersionError ────────────────────────────────────────────

describe('AC-6: SaveFormatVersionError class', () => {
  it('is exported, extends Error, and has expected/actual properties', () => {
    const err = new SaveFormatVersionError(1, 2);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SaveFormatVersionError');
    expect(err.expected).toBe(1);
    expect(err.actual).toBe(2);
    expect(err.message).toContain('1');
    expect(err.message).toContain('2');
  });
});

// ─── AC-7: AutoSaveConfig interface ──────────────────────────────────────────

describe('AC-7: AutoSaveConfig interface', () => {
  it('is exported and has enabled, intervalTicks, and optional filePath', () => {
    const config: AutoSaveConfig = {
      enabled: true,
      intervalTicks: 120,
    };
    expect(config.enabled).toBe(true);
    expect(config.intervalTicks).toBe(120);
    // filePath is optional
    const configWithFile: AutoSaveConfig = {
      enabled: true,
      intervalTicks: 60,
      filePath: '/tmp/save.json',
    };
    expect(configWithFile.filePath).toBe('/tmp/save.json');
  });
});

// ─── AC-8: defaultAutoSaveConfig ─────────────────────────────────────────────

describe('AC-8: defaultAutoSaveConfig constant', () => {
  it('is exported with enabled: false and intervalTicks: 600', () => {
    expect(defaultAutoSaveConfig.enabled).toBe(false);
    expect(defaultAutoSaveConfig.intervalTicks).toBe(600);
  });
});

// ─── AC-50: JSON serialization ───────────────────────────────────────────────

describe('AC-50: JSON.stringify / JSON.parse round-trip', () => {
  it('produces valid JSON with no replacer and parses back to a SaveState-compatible object', () => {
    const room: Room = {
      id: 'r1',
      name: 'Room 1',
      description: 'A room',
      connections: ['r2'],
      objectIds: ['obj1'],
    };
    const obj: SmartObject = {
      id: 'obj1',
      name: 'Object 1',
      type: 'item',
      state: { count: 5 },
      affordances: [
        {
          id: 'use',
          label: 'Use',
          engineEffect: 'use',
          preconditions: [],
          effects: { energy: 10 },
        },
      ],
      roomId: 'r1',
    };
    const memNode: MemoryNode = {
      id: 'mem1',
      agentId: 'a1',
      content: 'saw a thing',
      embedding: [0.1, 0.2, 0.3],
      timestamp: 10,
      importance: 7,
      type: 'observation',
    };
    const state: SaveState = {
      formatVersion: SAVE_FORMAT_VERSION,
      savedAt: Date.now(),
      gameLoop: { tickNumber: 5, simulationTime: 0.0833, deltaSeconds: 1 / 60 },
      agents: [{ profile: makeProfile('a1'), state: makeState('a1') }],
      world: { rooms: [room], objects: [obj] },
      memories: [memNode],
    };

    const json = JSON.stringify(state);
    expect(typeof json).toBe('string');

    const parsed = JSON.parse(json) as SaveState;
    expect(parsed.formatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.world.rooms).toHaveLength(1);
    expect(parsed.world.objects).toHaveLength(1);
    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
  });
});
