/**
 * Spec 017 — Shared layer persistence types
 * ─────────────────────────────────────────
 * Covers AC-1 through AC-8, AC-50, AC-53 (shared-owned error/type pieces).
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

describe('AC-1: SaveState interface', () => {
  it('a SaveState object with all required fields is assignable and JSON-serializable', () => {
    const profile: AgentProfile = {
      id: 'a1',
      name: 'a1',
      description: 'd',
      traits: [],
      initialDrives: { energy: 50 },
    };
    const state: AgentInternalState = {
      agentId: 'a1',
      drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      currentGoal: '',
      currentPlan: null,
      isThinking: false,
      location: 'kitchen',
      lastPerceptionTick: 0,
    };
    const save: SaveState = {
      formatVersion: SAVE_FORMAT_VERSION,
      savedAt: 12345,
      gameLoop: { tickNumber: 1, simulationTime: 0.5, deltaSeconds: 0.016 },
      agents: [{ profile, state }],
      world: { rooms: [], objects: [] },
      memories: [],
    };
    expect(save.formatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(save.agents).toHaveLength(1);
    // AC-50: JSON round-trip without a replacer.
    const json = JSON.stringify(save);
    const parsed = JSON.parse(json) as SaveState;
    expect(parsed.formatVersion).toBe(save.formatVersion);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]?.profile.id).toBe('a1');
  });
});

describe('AC-2: GameLoopSnapshot interface', () => {
  it('has tickNumber, simulationTime, and deltaSeconds', () => {
    const snap: GameLoopSnapshot = {
      tickNumber: 42,
      simulationTime: 123.45,
      deltaSeconds: 0.016,
    };
    expect(snap.tickNumber).toBe(42);
    expect(snap.simulationTime).toBe(123.45);
    expect(snap.deltaSeconds).toBe(0.016);
  });
});

describe('AC-3: AgentSnapshot interface', () => {
  it('bundles profile and state', () => {
    const profile: AgentProfile = {
      id: 'a1',
      name: 'a1',
      description: 'd',
      traits: [],
      initialDrives: { energy: 50 },
    };
    const state: AgentInternalState = {
      agentId: 'a1',
      drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      currentGoal: 'g',
      currentPlan: null,
      isThinking: false,
      location: 'kitchen',
      lastPerceptionTick: 3,
    };
    const snap: AgentSnapshot = { profile, state };
    expect(snap.profile.id).toBe('a1');
    expect(snap.state.currentGoal).toBe('g');
  });
});

describe('AC-4: WorldSnapshot interface', () => {
  it('has rooms: Room[] and objects: SmartObject[]', () => {
    const room: Room = {
      id: 'kitchen',
      name: 'Kitchen',
      description: 'A kitchen',
      connections: [],
      objectIds: [],
    };
    const obj: SmartObject = {
      id: 'coffee',
      name: 'Coffee Machine',
      type: 'machine',
      state: { water_level: 'low' },
      affordances: [],
      roomId: 'kitchen',
    };
    const world: WorldSnapshot = { rooms: [room], objects: [obj] };
    expect(world.rooms).toHaveLength(1);
    expect(world.objects).toHaveLength(1);
    expect(world.rooms[0]?.id).toBe('kitchen');
    expect(world.objects[0]?.state['water_level']).toBe('low');
  });
});

describe('AC-5: SAVE_FORMAT_VERSION constant', () => {
  it('is defined with the current format version (bumped to 2 by spec 030)', () => {
    expect(SAVE_FORMAT_VERSION).toBe(2);
  });
});

describe('AC-6: SaveFormatVersionError class', () => {
  it('extends Error and has expected and actual number properties', () => {
    const err = new SaveFormatVersionError(1, 0);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SaveFormatVersionError');
    expect(err.expected).toBe(1);
    expect(err.actual).toBe(0);
    expect(err.message).toContain('1');
    expect(err.message).toContain('0');
  });

  it('AC-53: message includes both expected and actual version', () => {
    const err = new SaveFormatVersionError(1, 99);
    expect(err.expected).toBe(1);
    expect(err.actual).toBe(99);
    expect(err.message).toMatch(/expected 1.*got 99|expected 1, got 99/);
  });
});

describe('AC-7: AutoSaveConfig interface', () => {
  it('has enabled, intervalTicks, and optional filePath', () => {
    const cfg: AutoSaveConfig = { enabled: true, intervalTicks: 600, filePath: 'save.json' };
    expect(cfg.enabled).toBe(true);
    expect(cfg.intervalTicks).toBe(600);
    expect(cfg.filePath).toBe('save.json');
    // filePath is optional
    const cfg2: AutoSaveConfig = { enabled: false, intervalTicks: 100 };
    expect(cfg2.filePath).toBeUndefined();
  });
});

describe('AC-8: defaultAutoSaveConfig constant', () => {
  it('has enabled: false and intervalTicks: 600', () => {
    expect(defaultAutoSaveConfig.enabled).toBe(false);
    expect(defaultAutoSaveConfig.intervalTicks).toBe(600);
  });
});

describe('AC-50: JSON serialization round-trip', () => {
  it('JSON.stringify + JSON.parse preserves a SaveState with memory embeddings', () => {
    const mem: MemoryNode = {
      id: 'm1',
      agentId: 'a1',
      content: 'saw a cat',
      embedding: [0.1, 0.2, 0.3],
      timestamp: 5,
      importance: 7,
      type: 'observation',
      lastAccessed: 5,
    };
    const save: SaveState = {
      formatVersion: SAVE_FORMAT_VERSION,
      savedAt: 999,
      gameLoop: { tickNumber: 5, simulationTime: 1.0, deltaSeconds: 0.016 },
      agents: [],
      world: { rooms: [], objects: [] },
      memories: [mem],
    };
    const json = JSON.stringify(save);
    const parsed = JSON.parse(json) as SaveState;
    expect(parsed.memories[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(parsed.memories[0]?.importance).toBe(7);
  });
});
