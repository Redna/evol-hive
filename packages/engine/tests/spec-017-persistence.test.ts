/**
 * Spec 017 — Persistence (engine layer)
 * ─────────────────────────────────────────
 * Covers AC-13 through AC-55: EnginePersistence interface & impl, subsystem
 * export/import methods, AutoSaveSystem, assembly integration, round-trip
 * preservation, edge cases, package boundaries, and error handling.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AgentProfile,
  AgentInternalState,
  AgentPlan,
  Room,
  SmartObject,
  Affordance,
  MemoryNode,
  EngineConfig,
  PPEROrchestratorPort,
  PPERPhase,
  GameTick,
  AutoSaveConfig,
  SaveState,
} from '@evol-hive/shared';
import {
  SAVE_FORMAT_VERSION,
  SaveFormatVersionError,
  defaultAutoSaveConfig,
} from '@evol-hive/shared';
import { InMemoryVectorStore } from '@evol-hive/memory';
import type { VectorStore } from '@evol-hive/memory';
import { GameLoopImpl } from '../src/loop/index.js';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { EnginePersistenceImpl } from '../src/persistence/engine-persistence.js';
import type { EnginePersistence, EnginePersistenceOptions, EngineSystem } from '../src/index.js';
import { AutoSaveSystem } from '../src/systems/auto-save.js';
import type { AutoSaveSystemOptions } from '../src/systems/auto-save.js';
import { createEngineCore, assembleGameLoop, createEngine } from '../src/assembly.js';
import type { EngineCore } from '../src/assembly.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

function makeProfile(id = 'a1', overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id,
    name: id.toUpperCase(),
    description: `Agent ${id}`,
    traits: ['curious'],
    initialDrives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    backstory: `${id}'s backstory`,
    longTermGoals: ['explore the world'],
    behavioralTendencies: ['curious', 'methodical'],
    speechStyle: 'casual',
    relationships: { a2: 'friend' },
    ...overrides,
  };
}

function makeAffordance(id = 'use'): Affordance {
  return {
    id,
    label: `Use ${id}`,
    engineEffect: id,
    preconditions: [],
    effects: { energy: 10 },
  };
}

function makeObject(id: string, roomId: string, state: Record<string, unknown> = {}): SmartObject {
  return {
    id,
    name: `Object ${id}`,
    type: 'item',
    state,
    affordances: [makeAffordance('use')],
    roomId,
  };
}

function makeRoom(id: string, connections: string[] = [], objectIds: string[] = []): Room {
  return {
    id,
    name: `Room ${id}`,
    description: `Room ${id}`,
    connections,
    objectIds,
  };
}

function makeMemoryNode(
  id: string,
  agentId = 'a1',
  embedding: number[] = [1, 0],
  importance = 5,
  type: MemoryNode['type'] = 'observation',
): MemoryNode {
  return {
    id,
    agentId,
    content: `memory ${id}`,
    embedding,
    timestamp: 10,
    importance,
    type,
    lastAccessed: 10,
  };
}

/** Build a full persistence options setup with optional pre-populated state. */
function buildOptions(vectorStore?: VectorStore): EnginePersistenceOptions {
  const vs = vectorStore ?? new InMemoryVectorStore();
  const config = makeConfig();
  const gameLoop = new GameLoopImpl(config);
  const agentManager = new AgentManagerImpl();
  const smartObjectRegistry = new SmartObjectRegistryImpl();
  const sceneManager = new SceneManagerImpl(agentManager, new Map());
  return {
    gameLoop,
    agentManager,
    smartObjectRegistry,
    sceneManager,
    vectorStore: vs,
  };
}

/** A fake orchestrator for assembly tests. */
class FakeOrchestrator implements PPEROrchestratorPort {
  calls: string[] = [];
  async runCycle(agentId: string): Promise<void> {
    this.calls.push(agentId);
  }
  getPhase(_agentId: string): PPERPhase {
    return 'perceive';
  }
}

// ─── AC-13: EnginePersistence interface ──────────────────────────────────────

describe('AC-13: EnginePersistence interface', () => {
  it('is exported from engine index and has all six methods', () => {
    const opts = buildOptions();
    const impl = new EnginePersistenceImpl(opts);
    expect(typeof impl.save).toBe('function');
    expect(typeof impl.load).toBe('function');
    expect(typeof impl.saveToString).toBe('function');
    expect(typeof impl.loadFromString).toBe('function');
    expect(typeof impl.saveToFile).toBe('function');
    expect(typeof impl.loadFromFile).toBe('function');
  });
});

// ─── AC-14: EnginePersistenceImpl export ─────────────────────────────────────

describe('AC-14: EnginePersistenceImpl is defined and exported', () => {
  it('constructs from EnginePersistenceOptions', () => {
    const opts = buildOptions();
    const impl = new EnginePersistenceImpl(opts);
    expect(impl).toBeInstanceOf(EnginePersistenceImpl);
  });
});

// ─── AC-15: save() returns correct SaveState ─────────────────────────────────

describe('AC-15: EnginePersistenceImpl.save() returns a SaveState', () => {
  it('returns a SaveState with formatVersion, savedAt, and game loop state', async () => {
    const opts = buildOptions();
    // Advance the loop 3 ticks.
    opts.gameLoop.injectElapsed(3 / 60 + 0.0001);

    const before = Date.now();
    const state = await new EnginePersistenceImpl(opts).save();
    const after = Date.now();

    expect(state.formatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(state.savedAt).toBeGreaterThanOrEqual(before);
    expect(state.savedAt).toBeLessThanOrEqual(after);
    expect(state.gameLoop.tickNumber).toBe(3);
    expect(state.gameLoop.simulationTime).toBeCloseTo(3 / 60, 5);
  });
});

// ─── AC-16: save() includes all active agents ────────────────────────────────

describe('AC-16: save() includes all active agents', () => {
  it('each AgentSnapshot has profile (from getProfile) and state (from getState)', async () => {
    const opts = buildOptions();
    opts.agentManager.spawn(makeProfile('a1'));
    opts.agentManager.updateState('a1', { location: 'room1', currentGoal: 'find food' });
    opts.agentManager.spawn(makeProfile('a2'));
    opts.agentManager.updateState('a2', { location: 'room2', currentGoal: 'rest' });

    const impl = new EnginePersistenceImpl(opts);
    const state = await impl.save();

    expect(state.agents).toHaveLength(2);
    const ids = state.agents.map((a) => a.profile.id).sort();
    expect(ids).toEqual(['a1', 'a2']);
    for (const snap of state.agents) {
      expect(snap.profile).toEqual(opts.agentManager.getProfile(snap.profile.id));
      expect(snap.state).toEqual(opts.agentManager.getState(snap.profile.id));
    }
  });
});

// ─── AC-17: save() includes all rooms and objects ────────────────────────────

describe('AC-17: save() includes all rooms and objects in WorldSnapshot', () => {
  it('includes all rooms from getAllRooms and all objects from getAllObjects', async () => {
    const opts = buildOptions();
    const r1 = makeRoom('r1', ['r2'], ['obj1']);
    const r2 = makeRoom('r2', ['r1'], ['obj2']);
    const newRooms = new Map<string, Room>([
      ['r1', r1],
      ['r2', r2],
    ]);
    opts.sceneManager.restoreRooms(newRooms);
    opts.smartObjectRegistry.register(makeObject('obj1', 'r1', { level: 5 }));
    opts.smartObjectRegistry.register(makeObject('obj2', 'r2', { open: true }));

    const impl = new EnginePersistenceImpl(opts);
    const state = await impl.save();

    expect(state.world.rooms).toHaveLength(2);
    expect(state.world.objects).toHaveLength(2);
    const roomIds = state.world.rooms.map((r) => r.id).sort();
    expect(roomIds).toEqual(['r1', 'r2']);
    const objIds = state.world.objects.map((o) => o.id).sort();
    expect(objIds).toEqual(['obj1', 'obj2']);
  });
});

// ─── AC-18: save() includes all memory nodes ─────────────────────────────────

describe('AC-18: save() includes all memory nodes with embeddings', async () => {
  it('includes all memory nodes from vectorStore.exportAll()', async () => {
    const vs = new InMemoryVectorStore();
    await vs.store(makeMemoryNode('m1', 'a1', [1, 0], 7));
    await vs.store(makeMemoryNode('m2', 'a1', [0, 1], 3, 'reflection'));

    const opts = buildOptions(vs);
    const impl = new EnginePersistenceImpl(opts);
    const state = await impl.save();

    expect(state.memories).toHaveLength(2);
    const ids = state.memories.map((m) => m.id).sort();
    expect(ids).toEqual(['m1', 'm2']);
    expect(state.memories[0]!.embedding).toEqual([1, 0]);
  });
});

// ─── AC-19: load() restores all subsystems ───────────────────────────────────

describe('AC-19: load() restores tick, agents, world, and memories', () => {
  it('restores the full game state from a SaveState', async () => {
    // Build source state.
    const srcOpts = buildOptions();
    srcOpts.agentManager.spawn(makeProfile('a1'));
    srcOpts.agentManager.updateState('a1', { location: 'r1', currentGoal: 'explore' });
    srcOpts.sceneManager.restoreRooms(new Map([['r1', makeRoom('r1', [], ['obj1'])]]));
    srcOpts.smartObjectRegistry.register(makeObject('obj1', 'r1', { power: true }));
    await srcOpts.vectorStore.store(makeMemoryNode('m1', 'a1', [1, 0], 5));
    srcOpts.gameLoop.injectElapsed(5 / 60 + 0.0001);

    const srcImpl = new EnginePersistenceImpl(srcOpts);
    const state = await srcImpl.save();

    // Load into a fresh set of subsystems.
    const dstOpts = buildOptions();
    // Pre-populate destination with different state to verify it is cleared.
    dstOpts.agentManager.spawn(makeProfile('oldAgent'));
    dstOpts.sceneManager.restoreRooms(new Map([['oldRoom', makeRoom('oldRoom')]]));
    dstOpts.smartObjectRegistry.register(makeObject('oldObj', 'oldRoom'));
    await dstOpts.vectorStore.store(makeMemoryNode('oldMem'));

    const dstImpl = new EnginePersistenceImpl(dstOpts);
    await dstImpl.load(state);

    // Agents restored.
    expect(dstOpts.agentManager.getActiveAgents()).toHaveLength(1);
    expect(dstOpts.agentManager.getState('a1')?.location).toBe('r1');
    expect(dstOpts.agentManager.getState('a1')?.currentGoal).toBe('explore');
    expect(dstOpts.agentManager.getProfile('a1')?.name).toBe('A1');

    // World restored.
    expect(dstOpts.sceneManager.getRoom('r1')).not.toBeNull();
    expect(dstOpts.sceneManager.getRoom('oldRoom')).toBeNull();
    expect(dstOpts.smartObjectRegistry.get('obj1')).not.toBeNull();
    expect(dstOpts.smartObjectRegistry.get('obj1')?.state).toEqual({ power: true });
    expect(dstOpts.smartObjectRegistry.get('oldObj')).toBeNull();

    // Memories restored.
    const allMem = await dstOpts.vectorStore.exportAll();
    expect(allMem).toHaveLength(1);
    expect(allMem[0]!.id).toBe('m1');

    // Game loop restored.
    expect(dstOpts.gameLoop.currentTick().tickNumber).toBe(5);
  });
});

// ─── AC-20: load() throws SaveFormatVersionError ─────────────────────────────

describe('AC-20 & AC-53: load() throws SaveFormatVersionError on version mismatch', () => {
  it('throws when formatVersion does not equal SAVE_FORMAT_VERSION', async () => {
    const opts = buildOptions();
    const impl = new EnginePersistenceImpl(opts);
    const badState: SaveState = {
      formatVersion: 0,
      savedAt: 0,
      gameLoop: { tickNumber: 0, simulationTime: 0, deltaSeconds: 1 / 60 },
      agents: [],
      world: { rooms: [], objects: [] },
      memories: [],
    };
    expect(() => impl.load(badState)).rejects.toThrow(SaveFormatVersionError);
  });

  it('the error has expected=1 and actual=the received version', async () => {
    const opts = buildOptions();
    const impl = new EnginePersistenceImpl(opts);
    const badState: SaveState = {
      formatVersion: 99,
      savedAt: 0,
      gameLoop: { tickNumber: 0, simulationTime: 0, deltaSeconds: 1 / 60 },
      agents: [],
      world: { rooms: [], objects: [] },
      memories: [],
    };
    try {
      await impl.load(badState);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SaveFormatVersionError);
      expect((e as SaveFormatVersionError).expected).toBe(1);
      expect((e as SaveFormatVersionError).actual).toBe(99);
    }
  });
});

// ─── AC-21: load() sets isThinking: false ────────────────────────────────────

describe('AC-21 & AC-44: load() sets isThinking: false for all loaded agents', () => {
  it('clears stale isThinking from saved state', async () => {
    const opts = buildOptions();
    opts.agentManager.spawn(makeProfile('a1'));
    opts.agentManager.updateState('a1', { isThinking: true });
    const impl = new EnginePersistenceImpl(opts);
    const state = await impl.save();
    expect(state.agents[0]!.state.isThinking).toBe(true);

    const dstOpts = buildOptions();
    await new EnginePersistenceImpl(dstOpts).load(state);

    const loaded = dstOpts.agentManager.getState('a1');
    expect(loaded).not.toBeNull();
    expect(loaded!.isThinking).toBe(false);
  });
});

// ─── AC-22: load() does not restart the game loop ────────────────────────────

describe('AC-22: load() does NOT call gameLoop.start()', () => {
  it('the loop remains stopped after load', async () => {
    const opts = buildOptions();
    opts.agentManager.spawn(makeProfile('a1'));
    const impl = new EnginePersistenceImpl(opts);
    const state = await impl.save();

    const dstOpts = buildOptions();
    // Spy on start to ensure it is never called.
    const startSpy = vi.spyOn(dstOpts.gameLoop, 'start');
    await new EnginePersistenceImpl(dstOpts).load(state);
    expect(startSpy).not.toHaveBeenCalled();
  });
});

// ─── AC-23: saveToString / loadFromString round-trip ─────────────────────────

describe('AC-23: saveToString / loadFromString round-trip', () => {
  it('saveToString returns pretty-printed JSON', async () => {
    const opts = buildOptions();
    const impl = new EnginePersistenceImpl(opts);
    const json = await impl.saveToString();
    expect(typeof json).toBe('string');
    // Pretty-printed (contains newlines / indentation).
    expect(json).toContain('\n');
    const parsed = JSON.parse(json);
    expect(parsed.formatVersion).toBe(SAVE_FORMAT_VERSION);
  });

  it('loadFromString parses JSON and calls load()', async () => {
    const opts = buildOptions();
    opts.agentManager.spawn(makeProfile('a1'));
    opts.sceneManager.restoreRooms(new Map([['r1', makeRoom('r1')]]));
    const impl = new EnginePersistenceImpl(opts);
    const json = await impl.saveToString();

    const dstOpts = buildOptions();
    await new EnginePersistenceImpl(dstOpts).loadFromString(json);
    expect(dstOpts.agentManager.getActiveAgents()).toHaveLength(1);
    expect(dstOpts.sceneManager.getRoom('r1')).not.toBeNull();
  });
});

// ─── AC-24: saveToFile / loadFromFile round-trip ─────────────────────────────

describe('AC-24: saveToFile / loadFromFile round-trip', () => {
  const tmpFile = join(tmpdir(), `evol-hive-test-${Date.now()}.json`);

  afterEach(() => {
    if (existsSync(tmpFile)) rmSync(tmpFile);
  });

  it('writes JSON to a file and reads it back', async () => {
    const opts = buildOptions();
    opts.agentManager.spawn(makeProfile('a1'));
    opts.sceneManager.restoreRooms(new Map([['r1', makeRoom('r1')]]));
    const impl = new EnginePersistenceImpl(opts);

    await impl.saveToFile(tmpFile);
    expect(existsSync(tmpFile)).toBe(true);

    const dstOpts = buildOptions();
    await new EnginePersistenceImpl(dstOpts).loadFromFile(tmpFile);
    expect(dstOpts.agentManager.getActiveAgents()).toHaveLength(1);
    expect(dstOpts.sceneManager.getRoom('r1')).not.toBeNull();
  });
});

// ─── AC-25: GameLoopImpl.restoreState ────────────────────────────────────────

describe('AC-25: GameLoopImpl.restoreState()', () => {
  it('sets tickNumber and simulationTime and updates currentGameTick', () => {
    const loop = new GameLoopImpl(makeConfig());
    loop.restoreState(42, 123.45);
    const tick = loop.currentTick();
    expect(tick.tickNumber).toBe(42);
    expect(tick.simulationTime).toBe(123.45);
    // deltaSeconds is the construction-time constant (1/60).
    expect(tick.deltaSeconds).toBeCloseTo(1 / 60, 10);
  });
});

// ─── AC-26: SceneManagerImpl.getAllRooms ─────────────────────────────────────

describe('AC-26: SceneManagerImpl.getAllRooms()', () => {
  it('returns all rooms as an array', () => {
    const am = new AgentManagerImpl();
    const sm = new SceneManagerImpl(am, new Map());
    sm.restoreRooms(
      new Map([
        ['r1', makeRoom('r1')],
        ['r2', makeRoom('r2')],
      ]),
    );
    const rooms = sm.getAllRooms();
    expect(rooms).toHaveLength(2);
    const ids = rooms.map((r) => r.id).sort();
    expect(ids).toEqual(['r1', 'r2']);
  });
});

// ─── AC-27: SceneManagerImpl.restoreRooms ────────────────────────────────────

describe('AC-27: SceneManagerImpl.restoreRooms()', () => {
  it('replaces the internal room map', () => {
    const am = new AgentManagerImpl();
    const sm = new SceneManagerImpl(am, new Map([['old', makeRoom('old')]]));
    expect(sm.getRoom('old')).not.toBeNull();

    sm.restoreRooms(new Map([['new', makeRoom('new')]]));
    expect(sm.getRoom('new')).not.toBeNull();
    expect(sm.getRoom('old')).toBeNull();
  });
});

// ─── AC-28: SmartObjectRegistryImpl.getAllObjects ────────────────────────────

describe('AC-28: SmartObjectRegistryImpl.getAllObjects()', () => {
  it('returns all objects including their current runtime state', () => {
    const reg = new SmartObjectRegistryImpl();
    reg.register(makeObject('obj1', 'r1', { level: 5 }));
    reg.register(makeObject('obj2', 'r2', { open: true }));
    // Mutate one object's state.
    reg.updateState('obj1', { level: 0 });

    const all = reg.getAllObjects();
    expect(all).toHaveLength(2);
    const obj1 = all.find((o) => o.id === 'obj1');
    expect(obj1?.state).toEqual({ level: 0 });
  });
});

// ─── AC-29: AutoSaveSystem definition ────────────────────────────────────────

describe('AC-29: AutoSaveSystem definition', () => {
  it('is defined in systems/auto-save.ts and exported from engine index', () => {
    const opts = buildOptions();
    const persistence = new EnginePersistenceImpl(opts);
    const autoSave = new AutoSaveSystem({ persistence, config: defaultAutoSaveConfig });
    expect(autoSave).toBeDefined();
    expect(autoSave.name).toBe('auto-save');
  });
});

// ─── AC-30: AutoSaveSystem no-op when disabled ───────────────────────────────

describe('AC-30: AutoSaveSystem.update() is a no-op when disabled', () => {
  it('does not call save when enabled is false', () => {
    const opts = buildOptions();
    const persistence = new EnginePersistenceImpl(opts);
    const saveSpy = vi.spyOn(persistence, 'saveToFile');
    const saveObjSpy = vi.spyOn(persistence, 'save');
    const autoSave = new AutoSaveSystem({
      persistence,
      config: { enabled: false, intervalTicks: 2 },
    });
    const tick: GameTick = { tickNumber: 1, simulationTime: 0.01, deltaSeconds: 1 / 60 };
    for (let i = 0; i < 10; i++) autoSave.update(tick);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(saveObjSpy).not.toHaveBeenCalled();
  });
});

// ─── AC-31: AutoSaveSystem calls saveToFile on interval ──────────────────────

describe('AC-31: AutoSaveSystem calls saveToFile every intervalTicks', () => {
  it('calls persistence.saveToFile when enabled and filePath is set', () => {
    const opts = buildOptions();
    const persistence = new EnginePersistenceImpl(opts);
    const saveSpy = vi.spyOn(persistence, 'saveToFile').mockResolvedValue(undefined);
    const config: AutoSaveConfig = { enabled: true, intervalTicks: 3, filePath: '/tmp/save.json' };
    const autoSave = new AutoSaveSystem({ persistence, config });
    const tick: GameTick = { tickNumber: 1, simulationTime: 0.01, deltaSeconds: 1 / 60 };

    autoSave.update(tick); // tick 1
    autoSave.update(tick); // tick 2
    expect(saveSpy).not.toHaveBeenCalled();
    autoSave.update(tick); // tick 3 → fires
    expect(saveSpy).toHaveBeenCalledTimes(1);
    autoSave.update(tick); // tick 4
    autoSave.update(tick); // tick 5
    autoSave.update(tick); // tick 6 → fires
    expect(saveSpy).toHaveBeenCalledTimes(2);
  });
});

// ─── AC-32: AutoSaveSystem calls save() when no filePath ─────────────────────

describe('AC-32: AutoSaveSystem calls save() when filePath not set', () => {
  it('calls persistence.save every intervalTicks when no filePath', () => {
    const opts = buildOptions();
    const persistence = new EnginePersistenceImpl(opts);
    const saveSpy = vi.spyOn(persistence, 'save').mockResolvedValue({
      formatVersion: 1,
      savedAt: 0,
      gameLoop: { tickNumber: 0, simulationTime: 0, deltaSeconds: 1 / 60 },
      agents: [],
      world: { rooms: [], objects: [] },
      memories: [],
    });
    const config: AutoSaveConfig = { enabled: true, intervalTicks: 2 };
    const autoSave = new AutoSaveSystem({ persistence, config });
    const tick: GameTick = { tickNumber: 1, simulationTime: 0.01, deltaSeconds: 1 / 60 };

    autoSave.update(tick); // tick 1
    expect(saveSpy).not.toHaveBeenCalled();
    autoSave.update(tick); // tick 2 → fires
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── AC-33: AutoSaveSystem never awaits ──────────────────────────────────────

describe('AC-33: AutoSaveSystem.update() is fire-and-forget', () => {
  it('update() returns synchronously (does not return a promise)', () => {
    const opts = buildOptions();
    const persistence = new EnginePersistenceImpl(opts);
    vi.spyOn(persistence, 'save').mockResolvedValue({
      formatVersion: 1,
      savedAt: 0,
      gameLoop: { tickNumber: 0, simulationTime: 0, deltaSeconds: 1 / 60 },
      agents: [],
      world: { rooms: [], objects: [] },
      memories: [],
    });
    const autoSave = new AutoSaveSystem({
      persistence,
      config: { enabled: true, intervalTicks: 1 },
    });
    const tick: GameTick = { tickNumber: 1, simulationTime: 0.01, deltaSeconds: 1 / 60 };
    const result = autoSave.update(tick);
    // update() should return void, not a Promise.
    expect(result).toBeUndefined();
  });

  it('errors in save are caught and logged (fire-and-forget .catch)', async () => {
    const opts = buildOptions();
    const persistence = new EnginePersistenceImpl(opts);
    vi.spyOn(persistence, 'save').mockRejectedValue(new Error('save failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const autoSave = new AutoSaveSystem({
      persistence,
      config: { enabled: true, intervalTicks: 1 },
    });
    const tick: GameTick = { tickNumber: 1, simulationTime: 0.01, deltaSeconds: 1 / 60 };
    autoSave.update(tick); // fires save → rejected
    // Allow the microtask queue to flush.
    await new Promise((r) => setTimeout(r, 10));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ─── AC-34: EngineCore has persistence and autoSaveConfig fields ─────────────

describe('AC-34: EngineCore interface includes persistence and autoSaveConfig', () => {
  it('EngineCore type allows optional persistence and autoSaveConfig', () => {
    const core = createEngineCore(makeConfig());
    // persistence is optional and not set when no vectorStore is provided.
    expect(core.persistence).toBeUndefined();
    // autoSaveConfig is optional.
    expect(core.autoSaveConfig).toBeUndefined();
  });
});

// ─── AC-35: createEngineCore constructs EnginePersistenceImpl ────────────────

describe('AC-35: createEngineCore constructs EnginePersistenceImpl when VectorStore provided', () => {
  it('constructs persistence when a VectorStore is provided', () => {
    const vs = new InMemoryVectorStore();
    const core = createEngineCore(makeConfig(), undefined, vs);
    expect(core.persistence).toBeDefined();
    expect(core.persistence).toBeInstanceOf(EnginePersistenceImpl);
  });

  it('does not set persistence when no VectorStore is available', () => {
    const core = createEngineCore(makeConfig());
    expect(core.persistence).toBeUndefined();
  });
});

// ─── AC-36: assembleGameLoop registers AutoSaveSystem ────────────────────────

describe('AC-36: assembleGameLoop registers AutoSaveSystem', () => {
  it('registers AutoSaveSystem as the last system when enabled and persistence is set', () => {
    const vs = new InMemoryVectorStore();
    const core = createEngineCore(makeConfig(), undefined, vs);
    const orch = new FakeOrchestrator();
    assembleGameLoop(core, orch, undefined, {
      config: { enabled: true, intervalTicks: 600 },
    });
    const names = core.gameLoop.systemNames();
    expect(names[names.length - 1]).toBe('auto-save');
  });

  it('does not register AutoSaveSystem when persistence is not set but auto-save enabled', () => {
    const core = createEngineCore(makeConfig());
    const orch = new FakeOrchestrator();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    assembleGameLoop(core, orch, undefined, {
      config: { enabled: true, intervalTicks: 600 },
    });
    const names = core.gameLoop.systemNames();
    expect(names).not.toContain('auto-save');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─── AC-37: AssembledEngine includes persistence ─────────────────────────────

describe('AC-37: AssembledEngine includes persistence', () => {
  it('createEngine returns the persistence field when a VectorStore is provided', () => {
    const vs = new InMemoryVectorStore();
    const orch = new FakeOrchestrator();
    const engine = createEngine(makeConfig(), orch, undefined, vs);
    expect(engine.persistence).toBeDefined();
    expect(engine.persistence).toBeInstanceOf(EnginePersistenceImpl);
  });
});

// ─── AC-38: Round-trip preserves AgentInternalState ───────────────────────────

describe('AC-38: Round-trip preserves AgentInternalState', () => {
  it('drives, currentGoal, currentPlan, location, lastPerceptionTick match', async () => {
    const opts = buildOptions();
    const plan: AgentPlan = {
      id: 'plan1',
      description: 'do stuff',
      steps: [{ description: 'step 1', completed: false, targetAffordance: 'use' }],
      currentStepIndex: 0,
      createdAt: 5,
    };
    opts.agentManager.spawn(makeProfile('a1'));
    opts.agentManager.updateState('a1', {
      location: 'r2',
      currentGoal: 'find food',
      currentPlan: plan,
      lastPerceptionTick: 42,
      drives: { energy: 10, hunger: 20, social: 30, comfort: 40, curiosity: 50 },
    });
    const impl = new EnginePersistenceImpl(opts);
    const state = await impl.save();

    const dstOpts = buildOptions();
    await new EnginePersistenceImpl(dstOpts).load(state);

    const before = opts.agentManager.getState('a1')!;
    const after = dstOpts.agentManager.getState('a1')!;
    expect(after.drives).toEqual(before.drives);
    expect(after.currentGoal).toBe(before.currentGoal);
    expect(after.currentPlan).toEqual(before.currentPlan);
    expect(after.location).toBe(before.location);
    expect(after.lastPerceptionTick).toBe(before.lastPerceptionTick);
  });
});

// ─── AC-39: Round-trip preserves AgentProfile (incl. persona) ────────────────

describe('AC-39: Round-trip preserves AgentProfile including persona', () => {
  it('profile fields match after round-trip', async () => {
    const opts = buildOptions();
    opts.agentManager.spawn(makeProfile('a1'));
    const impl = new EnginePersistenceImpl(opts);
    const state = await impl.save();

    const dstOpts = buildOptions();
    await new EnginePersistenceImpl(dstOpts).load(state);

    const before = opts.agentManager.getProfile('a1')!;
    const after = dstOpts.agentManager.getProfile('a1')!;
    expect(after).toEqual(before);
    expect(after.backstory).toBe("a1's backstory");
    expect(after.longTermGoals).toEqual(['explore the world']);
    expect(after.behavioralTendencies).toEqual(['curious', 'methodical']);
    expect(after.speechStyle).toBe('casual');
    expect(after.relationships).toEqual({ a2: 'friend' });
  });
});

// ─── AC-40: Round-trip preserves object state ────────────────────────────────

describe('AC-40: Round-trip preserves object state', () => {
  it('object state is the saved runtime state, not the initial scene state', async () => {
    const opts = buildOptions();
    opts.smartObjectRegistry.register(makeObject('obj1', 'r1', { water: 'full' }));
    opts.smartObjectRegistry.updateState('obj1', { water: 'low' });
    const impl = new EnginePersistenceImpl(opts);
    const state = await impl.save();

    const dstOpts = buildOptions();
    await new EnginePersistenceImpl(dstOpts).load(state);

    const obj = dstOpts.smartObjectRegistry.get('obj1');
    expect(obj).not.toBeNull();
    expect(obj!.state).toEqual({ water: 'low' });
  });
});

// ─── AC-41: Round-trip preserves rooms ───────────────────────────────────────

describe('AC-41: Round-trip preserves rooms', () => {
  it('room connections and objectIds match after round-trip', async () => {
    const opts = buildOptions();
    opts.sceneManager.restoreRooms(
      new Map([
        ['r1', makeRoom('r1', ['r2', 'r3'], ['obj1', 'obj2'])],
        ['r2', makeRoom('r2', ['r1'], [])],
        ['r3', makeRoom('r3', ['r1'], ['obj3'])],
      ]),
    );
    const impl = new EnginePersistenceImpl(opts);
    const state = await impl.save();

    const dstOpts = buildOptions();
    await new EnginePersistenceImpl(dstOpts).load(state);

    const r1 = dstOpts.sceneManager.getRoom('r1');
    expect(r1).not.toBeNull();
    expect(r1!.connections).toEqual(['r2', 'r3']);
    expect(r1!.objectIds).toEqual(['obj1', 'obj2']);
    expect(dstOpts.sceneManager.getRoom('r2')).not.toBeNull();
    expect(dstOpts.sceneManager.getRoom('r3')).not.toBeNull();
  });
});

// ─── AC-42: Round-trip preserves memory nodes ────────────────────────────────

describe('AC-42: Round-trip preserves memory nodes including embeddings', () => {
  it('all memory fields match after round-trip', async () => {
    const opts = buildOptions();
    await opts.vectorStore.store(makeMemoryNode('m1', 'a1', [1, 0], 7, 'observation'));
    await opts.vectorStore.store(makeMemoryNode('m2', 'a1', [0, 1], 3, 'reflection'));
    const impl = new EnginePersistenceImpl(opts);
    const state = await impl.save();

    const dstOpts = buildOptions();
    await new EnginePersistenceImpl(dstOpts).load(state);

    const before = (await opts.vectorStore.exportAll()).sort((a, b) => a.id.localeCompare(b.id));
    const after = (await dstOpts.vectorStore.exportAll()).sort((a, b) => a.id.localeCompare(b.id));
    expect(after).toEqual(before);
    expect(after[0]!.embedding).toEqual([1, 0]);
    expect(after[1]!.embedding).toEqual([0, 1]);
    expect(after[0]!.importance).toBe(7);
    expect(after[0]!.lastAccessed).toBe(10);
  });
});

// ─── AC-43: Round-trip preserves game loop tick ──────────────────────────────

describe('AC-43: Round-trip preserves game loop tick', () => {
  it('tickNumber and simulationTime match after round-trip', async () => {
    const opts = buildOptions();
    opts.gameLoop.injectElapsed(10 / 60 + 0.0001);
    const impl = new EnginePersistenceImpl(opts);
    const state = await impl.save();

    const dstOpts = buildOptions();
    await new EnginePersistenceImpl(dstOpts).load(state);

    expect(dstOpts.gameLoop.currentTick().tickNumber).toBe(opts.gameLoop.currentTick().tickNumber);
    expect(dstOpts.gameLoop.currentTick().simulationTime).toBeCloseTo(
      opts.gameLoop.currentTick().simulationTime,
      5,
    );
  });
});

// ─── AC-45: Round-trip preserves consolidated memory importance ──────────────

describe('AC-45: Round-trip preserves consolidated memory importance', () => {
  it('memory nodes with reduced importance are preserved', async () => {
    const opts = buildOptions();
    // Simulate consolidated nodes with halved importance.
    await opts.vectorStore.store(makeMemoryNode('raw1', 'a1', [1, 0], 2, 'observation'));
    await opts.vectorStore.store(makeMemoryNode('consolidated1', 'a1', [0, 1], 8, 'reflection'));
    const impl = new EnginePersistenceImpl(opts);
    const state = await impl.save();

    const dstOpts = buildOptions();
    await new EnginePersistenceImpl(dstOpts).load(state);

    const all = await dstOpts.vectorStore.exportAll();
    const raw = all.find((m) => m.id === 'raw1');
    const consolidated = all.find((m) => m.id === 'consolidated1');
    expect(raw?.importance).toBe(2);
    expect(consolidated?.importance).toBe(8);
  });
});

// ─── AC-46: load() with empty SaveState clears state ─────────────────────────

describe('AC-46: load() with empty SaveState clears all existing state', () => {
  it('results in an empty simulation', async () => {
    const opts = buildOptions();
    opts.agentManager.spawn(makeProfile('a1'));
    opts.sceneManager.restoreRooms(new Map([['r1', makeRoom('r1')]]));
    opts.smartObjectRegistry.register(makeObject('obj1', 'r1'));
    await opts.vectorStore.store(makeMemoryNode('m1'));

    const impl = new EnginePersistenceImpl(opts);
    const emptyState: SaveState = {
      formatVersion: SAVE_FORMAT_VERSION,
      savedAt: 0,
      gameLoop: { tickNumber: 0, simulationTime: 0, deltaSeconds: 1 / 60 },
      agents: [],
      world: { rooms: [], objects: [] },
      memories: [],
    };
    await impl.load(emptyState);

    expect(opts.agentManager.getActiveAgents()).toHaveLength(0);
    // Rooms cleared (but the sceneManager is reconstructed — verify getRoom returns null for old rooms).
    // Note: restoreRooms with an empty map clears all rooms.
    expect(opts.sceneManager.getRoom('r1')).toBeNull();
    expect(opts.smartObjectRegistry.get('obj1')).toBeNull();
    expect(await opts.vectorStore.exportAll()).toEqual([]);
  });
});

// ─── AC-47: save() with no state returns valid empty SaveState ───────────────

describe('AC-47: save() with no agents/objects/memories returns valid empty SaveState', () => {
  it('returns a SaveState with empty arrays', async () => {
    const opts = buildOptions();
    const state = await new EnginePersistenceImpl(opts).save();
    expect(state.formatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(state.agents).toEqual([]);
    expect(state.world.rooms).toEqual([]);
    expect(state.world.objects).toEqual([]);
    expect(state.memories).toEqual([]);
  });
});

// ─── AC-48: EnginePersistenceImpl package boundaries ─────────────────────────

describe('AC-48: EnginePersistenceImpl imports from shared and memory, not cognition', () => {
  it('does not import from @evol-hive/cognition', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'persistence', 'engine-persistence.ts'),
      'utf-8',
    );
    // Check that no import statement references cognition.
    const importLines = source.match(/^import .*$/gm) ?? [];
    for (const line of importLines) {
      expect(line).not.toContain("'@evol-hive/cognition'");
    }
    // Verify it does import from shared and memory.
    const allImports = importLines.join('\n');
    expect(allImports).toContain("'@evol-hive/shared'");
    expect(allImports).toContain("'@evol-hive/memory'");
  });
});

// ─── AC-49: AutoSaveSystem package boundaries ────────────────────────────────

describe('AC-49: AutoSaveSystem imports from shared and engine, not cognition/memory', () => {
  it('does not import from @evol-hive/cognition or @evol-hive/memory', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'systems', 'auto-save.ts'), 'utf-8');
    const importLines = source.match(/^import .*$/gm) ?? [];
    for (const line of importLines) {
      expect(line).not.toContain("'@evol-hive/cognition'");
      expect(line).not.toContain("'@evol-hive/memory'");
    }
    // Verify it imports from shared.
    const allImports = importLines.join('\n');
    expect(allImports).toContain("'@evol-hive/shared'");
  });
});

// ─── AC-51: loadFromString throws SyntaxError on invalid JSON ────────────────

describe('AC-51: loadFromString throws SyntaxError on invalid JSON', () => {
  it('propagates the JSON.parse error', () => {
    const opts = buildOptions();
    const impl = new EnginePersistenceImpl(opts);
    expect(impl.loadFromString('not valid json')).rejects.toThrow(SyntaxError);
  });
});

// ─── AC-52: loadFromFile throws on nonexistent file ──────────────────────────

describe('AC-52: loadFromFile throws on nonexistent file', () => {
  it('propagates the fs.readFile error', () => {
    const opts = buildOptions();
    const impl = new EnginePersistenceImpl(opts);
    expect(impl.loadFromFile(join(tmpdir(), 'nonexistent-xyz-123.json'))).rejects.toThrow();
  });
});

// ─── AC-54: saveToFile writes formatVersion and savedAt ──────────────────────

describe('AC-54: saveToFile writes formatVersion and savedAt', () => {
  const tmpFile = join(tmpdir(), `evol-hive-test-${Date.now()}.json`);

  afterEach(() => {
    if (existsSync(tmpFile)) rmSync(tmpFile);
  });

  it('file contains "formatVersion": 1 and "savedAt": <number>', async () => {
    const opts = buildOptions();
    const impl = new EnginePersistenceImpl(opts);
    await impl.saveToFile(tmpFile);
    const content = readFileSync(tmpFile, 'utf-8');
    expect(content).toContain('"formatVersion": 1');
    expect(content).toMatch(/"savedAt":\s*\d+/);
  });
});

// ─── AC-55: Full simulation round-trip ───────────────────────────────────────

describe('AC-55: Full simulation with 2 agents, 3 rooms, 5 objects, 20 memories', () => {
  it('preserves all state after save and load', async () => {
    const srcOpts = buildOptions();
    // 3 rooms.
    srcOpts.sceneManager.restoreRooms(
      new Map([
        ['r1', makeRoom('r1', ['r2', 'r3'], ['o1', 'o2'])],
        ['r2', makeRoom('r2', ['r1'], ['o3'])],
        ['r3', makeRoom('r3', ['r1'], ['o4', 'o5'])],
      ]),
    );
    // 5 objects.
    for (let i = 1; i <= 5; i++) {
      srcOpts.smartObjectRegistry.register(
        makeObject(`o${i}`, i <= 2 ? 'r1' : i === 3 ? 'r2' : 'r3', { index: i }),
      );
    }
    // 2 agents.
    srcOpts.agentManager.spawn(makeProfile('a1'));
    srcOpts.agentManager.updateState('a1', { location: 'r1', currentGoal: 'g1' });
    srcOpts.agentManager.spawn(makeProfile('a2'));
    srcOpts.agentManager.updateState('a2', { location: 'r2', currentGoal: 'g2' });
    // 20 memory nodes.
    for (let i = 0; i < 20; i++) {
      await srcOpts.vectorStore.store(
        makeMemoryNode(`mem${i}`, i % 2 === 0 ? 'a1' : 'a2', [i, i + 1], (i % 10) + 1),
      );
    }
    // Advance the loop.
    srcOpts.gameLoop.injectElapsed(7 / 60 + 0.0001);

    const srcImpl = new EnginePersistenceImpl(srcOpts);
    const state = await srcImpl.save();

    const dstOpts = buildOptions();
    await new EnginePersistenceImpl(dstOpts).load(state);

    // 2 agents.
    expect(dstOpts.agentManager.getActiveAgents()).toHaveLength(2);
    expect(dstOpts.agentManager.getProfile('a1')).toEqual(srcOpts.agentManager.getProfile('a1'));
    expect(dstOpts.agentManager.getState('a2')?.location).toBe('r2');
    // 3 rooms.
    expect(dstOpts.sceneManager.getAllRooms()).toHaveLength(3);
    // 5 objects.
    expect(dstOpts.smartObjectRegistry.getAllObjects()).toHaveLength(5);
    // 20 memories.
    expect(await dstOpts.vectorStore.exportAll()).toHaveLength(20);
    // Game loop tick.
    expect(dstOpts.gameLoop.currentTick().tickNumber).toBe(
      srcOpts.gameLoop.currentTick().tickNumber,
    );
  });
});
