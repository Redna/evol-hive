/**
 * Spec 017 — Engine layer persistence implementation
 * ───────────────────────────────────────────────────
 * Covers AC-13 through AC-49, AC-51 through AC-55 (engine-owned behavior).
 *
 * Tests are written BEFORE the implementation per the TDD workflow.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentProfile,
  AgentInternalState,
  Room,
  SmartObject,
  MemoryNode,
  EngineConfig,
  AutoSaveConfig,
  PPEROrchestratorPort,
  PPERPhase,
  GameTick,
} from '@evol-hive/shared';
import {
  SAVE_FORMAT_VERSION,
  SaveFormatVersionError,
  defaultAutoSaveConfig,
} from '@evol-hive/shared';
import { InMemoryVectorStore } from '@evol-hive/memory';
import { createEngineCore, createEngine, assembleGameLoop, loadScene } from '../src/assembly.js';
import { GameLoopImpl } from '../src/loop/index.js';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { EnginePersistenceImpl } from '../src/persistence/engine-persistence.js';
import type { EnginePersistence, EngineSystem } from '../src/index.js';
import { AutoSaveSystem } from '../src/systems/auto-save.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

function makeProfile(id = 'a1', startRoomId = 'kitchen'): AgentProfile {
  return {
    id,
    name: id,
    description: `${id} desc`,
    traits: ['curious'],
    initialDrives: { energy: 30, hunger: 60 },
    backstory: 'A test agent',
    longTermGoals: ['explore the world'],
    behavioralTendencies: ['curious'],
    speechStyle: 'casual',
    relationships: { a2: 'friend' },
    startRoomId,
  };
}

function makeRoom(id: string, connections: string[] = [], objectIds: string[] = []): Room {
  return { id, name: id, description: `room ${id}`, connections, objectIds };
}

function makeObject(id: string, roomId: string, state: Record<string, unknown> = {}): SmartObject {
  return {
    id,
    name: id,
    type: 'machine',
    state,
    affordances: [
      {
        id: `${id}_action`,
        label: `${id} action`,
        engineEffect: 'noop',
        preconditions: [],
        effects: { energy: 10 },
      },
    ],
    roomId,
  };
}

function makeMemory(
  id: string,
  agentId: string,
  embedding: number[],
  importance = 5,
  lastAccessed?: number,
  type: MemoryNode['type'] = 'observation',
): MemoryNode {
  return {
    id,
    agentId,
    content: `content-${id}`,
    embedding,
    timestamp: 10,
    importance,
    type,
    lastAccessed,
  };
}

/** Build a fully wired EnginePersistenceImpl against fresh in-memory subsystems. */
function makePersistence(): {
  persistence: EnginePersistenceImpl;
  gameLoop: GameLoopImpl;
  agentManager: AgentManagerImpl;
  sceneManager: SceneManagerImpl;
  smartObjectRegistry: SmartObjectRegistryImpl;
  vectorStore: InMemoryVectorStore;
} {
  const config = makeConfig();
  const gameLoop = new GameLoopImpl(config);
  const agentManager = new AgentManagerImpl();
  const sceneManager = new SceneManagerImpl(agentManager, new Map());
  const smartObjectRegistry = new SmartObjectRegistryImpl();
  const vectorStore = new InMemoryVectorStore();
  const persistence = new EnginePersistenceImpl({
    gameLoop,
    agentManager,
    smartObjectRegistry,
    sceneManager,
    vectorStore,
  });
  return { persistence, gameLoop, agentManager, sceneManager, smartObjectRegistry, vectorStore };
}

class FakeOrchestrator implements PPEROrchestratorPort {
  async runCycle(_agentId: string): Promise<void> {}
  getPhase(_agentId: string): PPERPhase {
    return 'perceive';
  }
}

// ─── AC-13: EnginePersistence interface ───────────────────────────────────────

describe('AC-13: EnginePersistence interface', () => {
  it('EnginePersistenceImpl satisfies the EnginePersistence interface shape', () => {
    const { persistence } = makePersistence();
    const ep: EnginePersistence = persistence;
    expect(typeof ep.save).toBe('function');
    expect(typeof ep.load).toBe('function');
    expect(typeof ep.saveToString).toBe('function');
    expect(typeof ep.loadFromString).toBe('function');
    expect(typeof ep.saveToFile).toBe('function');
    expect(typeof ep.loadFromFile).toBe('function');
  });
});

// ─── AC-14: EnginePersistenceImpl defined and exported ────────────────────────

describe('AC-14: EnginePersistenceImpl is defined and exported', () => {
  it('is constructable from packages/engine/src/persistence/engine-persistence.ts', () => {
    const { persistence } = makePersistence();
    expect(persistence).toBeInstanceOf(EnginePersistenceImpl);
  });
});

// ─── AC-15: save() returns a well-formed SaveState ────────────────────────────

describe('AC-15: save() returns a well-formed SaveState', () => {
  it('returns SaveState with formatVersion = SAVE_FORMAT_VERSION and a savedAt timestamp', async () => {
    const { persistence, gameLoop } = makePersistence();
    gameLoop.injectElapsed(1);
    const before = Date.now();
    const state = await persistence.save();
    const after = Date.now();
    expect(state.formatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(state.savedAt).toBeGreaterThanOrEqual(before);
    expect(state.savedAt).toBeLessThanOrEqual(after);
  });

  it('includes the game loop snapshot (tickNumber, simulationTime, deltaSeconds)', async () => {
    const { persistence, gameLoop } = makePersistence();
    gameLoop.injectElapsed(1); // 60 ticks at 60fps → tickNumber 60, simTime ~1.0
    const state = await persistence.save();
    expect(state.gameLoop.tickNumber).toBe(gameLoop.currentTick().tickNumber);
    expect(state.gameLoop.simulationTime).toBeCloseTo(gameLoop.currentTick().simulationTime, 5);
    expect(state.gameLoop.deltaSeconds).toBeCloseTo(1 / 60, 5);
  });
});

// ─── AC-16: save() includes all active agents ─────────────────────────────────

describe('AC-16: save() includes all active agents (profile + state)', () => {
  it('each AgentSnapshot has the profile and state from the manager', async () => {
    const { persistence, agentManager } = makePersistence();
    const p1 = makeProfile('a1');
    const p2 = makeProfile('a2', 'bedroom');
    agentManager.spawn(p1);
    agentManager.spawn(p2);
    agentManager.updateState('a1', { currentGoal: 'find coffee', location: 'kitchen' });
    agentManager.updateState('a2', { currentGoal: 'rest', location: 'bedroom' });

    const state = await persistence.save();
    expect(state.agents).toHaveLength(2);
    const a1 = state.agents.find((a) => a.profile.id === 'a1');
    const a2 = state.agents.find((a) => a.profile.id === 'a2');
    expect(a1).toBeDefined();
    expect(a1?.state.currentGoal).toBe('find coffee');
    expect(a1?.state.location).toBe('kitchen');
    expect(a1?.profile.backstory).toBe('A test agent');
    expect(a2?.state.location).toBe('bedroom');
  });

  it('skips agents with a null profile (defensive)', async () => {
    const { persistence, agentManager } = makePersistence();
    agentManager.spawn(makeProfile('a1'));
    // No way to have an active agent with no profile via public API; this is a defensive check.
    const state = await persistence.save();
    expect(state.agents).toHaveLength(1);
  });
});

// ─── AC-17: save() includes all rooms and objects ─────────────────────────────

describe('AC-17: save() includes all rooms and objects in WorldSnapshot', () => {
  it('returns all rooms (getAllRooms) and all objects (getAllObjects)', async () => {
    const { persistence, sceneManager, smartObjectRegistry } = makePersistence();
    const rooms = [
      makeRoom('kitchen', ['bedroom'], ['coffee']),
      makeRoom('bedroom', ['kitchen'], []),
    ];
    sceneManager.restoreRooms(new Map(rooms.map((r) => [r.id, r])));
    smartObjectRegistry.register(makeObject('coffee', 'kitchen', { water_level: 'low' }));

    const state = await persistence.save();
    expect(state.world.rooms).toHaveLength(2);
    expect(state.world.objects).toHaveLength(1);
    expect(state.world.objects[0]?.state['water_level']).toBe('low');
  });
});

// ─── AC-18: save() includes all memory nodes with embeddings ──────────────────

describe('AC-18: save() includes all memory nodes (with embeddings)', () => {
  it('includes all memory nodes from vectorStore.exportAll()', async () => {
    const { persistence, vectorStore } = makePersistence();
    await vectorStore.store(makeMemory('m1', 'a1', [0.1, 0.2], 7));
    await vectorStore.store(makeMemory('m2', 'a1', [0.3, 0.4], 3));

    const state = await persistence.save();
    expect(state.memories).toHaveLength(2);
    const m1 = state.memories.find((m) => m.id === 'm1');
    expect(m1?.embedding).toEqual([0.1, 0.2]);
    expect(m1?.importance).toBe(7);
  });
});

// ─── AC-19: load() restores all subsystems ────────────────────────────────────

describe('AC-19: load() restores loop, agents, world, memories', () => {
  it('restores tickNumber/simulationTime, agents, world, and memories', async () => {
    const ctx = makePersistence();
    // Seed the source simulation.
    ctx.agentManager.spawn(makeProfile('a1'));
    ctx.agentManager.updateState('a1', { currentGoal: 'g', location: 'kitchen' });
    ctx.sceneManager.restoreRooms(
      new Map([['kitchen', makeRoom('kitchen', ['bedroom'], ['coffee'])]]),
    );
    ctx.smartObjectRegistry.register(makeObject('coffee', 'kitchen', { water_level: 'low' }));
    await ctx.vectorStore.store(makeMemory('m1', 'a1', [0.5, 0.5], 8));
    ctx.gameLoop.injectElapsed(2);

    const saved = await ctx.persistence.save();

    // Build a fresh target persistence with some pre-existing state that must be replaced.
    const target = makePersistence();
    target.agentManager.spawn(makeProfile('old'));
    target.sceneManager.restoreRooms(new Map([['old', makeRoom('old')]]));
    target.smartObjectRegistry.register(makeObject('oldobj', 'old'));
    await target.vectorStore.store(makeMemory('oldmem', 'old', [1, 1]));
    target.gameLoop.injectElapsed(5);

    await target.persistence.load(saved);

    // Game loop restored.
    expect(target.gameLoop.currentTick().tickNumber).toBe(ctx.gameLoop.currentTick().tickNumber);
    expect(target.gameLoop.currentTick().simulationTime).toBeCloseTo(
      ctx.gameLoop.currentTick().simulationTime,
      5,
    );
    // Agents replaced.
    expect(
      target.agentManager
        .getActiveAgents()
        .map((a) => a.agentId)
        .sort(),
    ).toEqual(['a1']);
    expect(target.agentManager.getState('a1')?.currentGoal).toBe('g');
    expect(target.agentManager.getState('a1')?.location).toBe('kitchen');
    // World replaced.
    expect(target.sceneManager.getRoom('old')).toBeNull();
    expect(target.sceneManager.getRoom('kitchen')?.connections).toEqual(['bedroom']);
    expect(target.smartObjectRegistry.get('oldobj')).toBeNull();
    expect(target.smartObjectRegistry.get('coffee')?.state['water_level']).toBe('low');
    // Memories replaced.
    const mems = await target.vectorStore.exportAll();
    expect(mems.map((m) => m.id).sort()).toEqual(['m1']);
  });
});

// ─── AC-20: load() throws SaveFormatVersionError on mismatch ──────────────────

describe('AC-20 / AC-53: load() throws SaveFormatVersionError on version mismatch', () => {
  it('throws SaveFormatVersionError when formatVersion is wrong', async () => {
    const { persistence } = makePersistence();
    const bad = {
      formatVersion: 0,
      savedAt: 1,
      gameLoop: { tickNumber: 0, simulationTime: 0, deltaSeconds: 0.016 },
      agents: [],
      world: { rooms: [], objects: [] },
      memories: [],
    };
    await expect(persistence.load(bad)).rejects.toBeInstanceOf(SaveFormatVersionError);
  });

  it('error has expected=SAVE_FORMAT_VERSION (2 since spec 030) and actual=received version', async () => {
    const { persistence } = makePersistence();
    const bad = {
      formatVersion: 99,
      savedAt: 1,
      gameLoop: { tickNumber: 0, simulationTime: 0, deltaSeconds: 0.016 },
      agents: [],
      world: { rooms: [], objects: [] },
      memories: [],
    };
    try {
      await persistence.load(bad);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SaveFormatVersionError);
      const e = err as SaveFormatVersionError;
      expect(e.expected).toBe(SAVE_FORMAT_VERSION);
      expect(e.actual).toBe(99);
    }
  });
});

// ─── AC-21: load() sets isThinking: false for every loaded agent ──────────────

describe('AC-21: load() sets isThinking: false for every loaded agent', () => {
  it('clears stale isThinking from the saved state', async () => {
    const { persistence, agentManager } = makePersistence();
    const profile = makeProfile('a1');
    agentManager.spawn(profile);
    agentManager.updateState('a1', { isThinking: true });
    const saved = await persistence.save();
    // saved.agents[0].state.isThinking is true
    expect(saved.agents[0]?.state.isThinking).toBe(true);

    const target = makePersistence();
    await target.persistence.load(saved);
    expect(target.agentManager.getState('a1')?.isThinking).toBe(false);
  });
});

// ─── AC-22: load() does NOT restart the game loop ─────────────────────────────

describe('AC-22: load() does NOT call gameLoop.start()', () => {
  it('the loop remains stopped after load', async () => {
    const ctx = makePersistence();
    ctx.agentManager.spawn(makeProfile('a1'));
    const saved = await ctx.persistence.save();

    const target = makePersistence();
    // Spy before load; load must not call start().
    const startSpy = vi.spyOn(target.gameLoop, 'start');
    await target.persistence.load(saved);
    expect(startSpy).not.toHaveBeenCalled();
    // Loop is not running after load.
    // We can't directly observe running state, but start() was not called.
  });
});

// ─── AC-23: string round-trip ─────────────────────────────────────────────────

describe('AC-23: saveToString / loadFromString round-trip', () => {
  it('saveToString returns pretty-printed JSON', async () => {
    const { persistence } = makePersistence();
    const json = await persistence.saveToString();
    expect(typeof json).toBe('string');
    // pretty-printed → contains newlines and 2-space indentation
    expect(json).toContain('\n');
    expect(json).toContain('  "formatVersion"');
  });

  it('round-trip loadFromString(saveToString()) restores exact same state', async () => {
    const ctx = makePersistence();
    ctx.agentManager.spawn(makeProfile('a1'));
    ctx.agentManager.updateState('a1', { currentGoal: 'g', location: 'kitchen' });
    ctx.sceneManager.restoreRooms(new Map([['kitchen', makeRoom('kitchen')]]));
    ctx.smartObjectRegistry.register(makeObject('coffee', 'kitchen', { water: 'low' }));
    await ctx.vectorStore.store(makeMemory('m1', 'a1', [0.1, 0.2], 6));
    ctx.gameLoop.injectElapsed(1);

    const json = await ctx.persistence.saveToString();

    const target = makePersistence();
    await target.persistence.loadFromString(json);

    expect(target.agentManager.getActiveAgents()).toHaveLength(1);
    expect(target.agentManager.getState('a1')?.currentGoal).toBe('g');
    expect(target.sceneManager.getRoom('kitchen')).not.toBeNull();
    expect(target.smartObjectRegistry.get('coffee')?.state['water']).toBe('low');
    const mems = await target.vectorStore.exportAll();
    expect(mems[0]?.embedding).toEqual([0.1, 0.2]);
  });
});

// ─── AC-24: file round-trip ───────────────────────────────────────────────────

describe('AC-24: saveToFile / loadFromFile round-trip', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `evol-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(async () => {
    try {
      await fs.unlink(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it('round-trip loadFromFile(saveToFile()) restores the exact same state', async () => {
    const ctx = makePersistence();
    ctx.agentManager.spawn(makeProfile('a1'));
    ctx.agentManager.updateState('a1', { currentGoal: 'g', location: 'kitchen' });
    ctx.sceneManager.restoreRooms(new Map([['kitchen', makeRoom('kitchen')]]));
    ctx.smartObjectRegistry.register(makeObject('coffee', 'kitchen', { water: 'low' }));
    await ctx.vectorStore.store(makeMemory('m1', 'a1', [0.1, 0.2], 6));
    ctx.gameLoop.injectElapsed(1);

    await ctx.persistence.saveToFile(tmpFile);

    const target = makePersistence();
    await target.persistence.loadFromFile(tmpFile);

    expect(target.agentManager.getState('a1')?.currentGoal).toBe('g');
    expect(target.sceneManager.getRoom('kitchen')).not.toBeNull();
    expect(target.smartObjectRegistry.get('coffee')?.state['water']).toBe('low');
    const mems = await target.vectorStore.exportAll();
    expect(mems[0]?.embedding).toEqual([0.1, 0.2]);
  });

  it('AC-54: the written file contains the formatVersion (2 since spec 030) and "savedAt":', async () => {
    const { persistence } = makePersistence();
    await persistence.saveToFile(tmpFile);
    const content = await fs.readFile(tmpFile, 'utf8');
    expect(content).toContain(`"formatVersion": ${SAVE_FORMAT_VERSION}`);
    expect(content).toMatch(/"savedAt":\s*\d+/);
  });
});

// ─── AC-25: GameLoopImpl.restoreState ─────────────────────────────────────────

describe('AC-25: GameLoopImpl.restoreState', () => {
  it('sets tickNumber and simulationTime and updates currentGameTick', () => {
    const loop = new GameLoopImpl(makeConfig());
    loop.injectElapsed(1); // advance a bit
    loop.restoreState(42, 123.45);
    const tick = loop.currentTick();
    expect(tick.tickNumber).toBe(42);
    expect(tick.simulationTime).toBe(123.45);
    // deltaSeconds is derived from config and preserved.
    expect(tick.deltaSeconds).toBeCloseTo(1 / 60, 5);
  });
});

// ─── AC-26 / AC-27: SceneManagerImpl.getAllRooms / restoreRooms ───────────────

describe('AC-26 / AC-27: SceneManagerImpl.getAllRooms / restoreRooms', () => {
  it('getAllRooms returns all rooms as an array', () => {
    const am = new AgentManagerImpl();
    const sm = new SceneManagerImpl(am, new Map());
    sm.restoreRooms(
      new Map([
        ['kitchen', makeRoom('kitchen')],
        ['bedroom', makeRoom('bedroom')],
      ]),
    );
    const rooms = sm.getAllRooms();
    expect(rooms).toHaveLength(2);
    expect(rooms.map((r) => r.id).sort()).toEqual(['bedroom', 'kitchen']);
  });

  it('restoreRooms replaces the internal map — getRoom reads from the new map', () => {
    const am = new AgentManagerImpl();
    const sm = new SceneManagerImpl(am, new Map([['old', makeRoom('old')]]));
    expect(sm.getRoom('old')).not.toBeNull();
    sm.restoreRooms(new Map([['new', makeRoom('new')]]));
    expect(sm.getRoom('old')).toBeNull();
    expect(sm.getRoom('new')?.id).toBe('new');
  });
});

// ─── AC-28: SmartObjectRegistryImpl.getAllObjects ─────────────────────────────

describe('AC-28: SmartObjectRegistryImpl.getAllObjects', () => {
  it('returns all objects including their current runtime state', () => {
    const reg = new SmartObjectRegistryImpl();
    reg.register(makeObject('o1', 'kitchen', { water: 'low' }));
    reg.register(makeObject('o2', 'bedroom', { on: true }));
    const objs = reg.getAllObjects();
    expect(objs).toHaveLength(2);
    const o1 = objs.find((o) => o.id === 'o1');
    expect(o1?.state['water']).toBe('low');
  });
});

// ─── AC-29 through AC-33: AutoSaveSystem ──────────────────────────────────────

describe('AC-29: AutoSaveSystem is defined and exported', () => {
  it('name is "auto-save"', () => {
    const { persistence } = makePersistence();
    const sys = new AutoSaveSystem({ persistence, config: { enabled: false, intervalTicks: 10 } });
    expect(sys.name).toBe('auto-save');
  });

  it('implements EngineSystem', () => {
    const { persistence } = makePersistence();
    const sys: EngineSystem = new AutoSaveSystem({
      persistence,
      config: { enabled: false, intervalTicks: 10 },
    });
    expect(typeof sys.update).toBe('function');
  });
});

describe('AC-30: AutoSaveSystem.update() is a no-op when config.enabled is false', () => {
  it('does not call persistence.save when disabled', () => {
    const { persistence } = makePersistence();
    const saveSpy = vi.spyOn(persistence, 'save');
    const sys = new AutoSaveSystem({ persistence, config: { enabled: false, intervalTicks: 2 } });
    const tick: GameTick = { tickNumber: 1, simulationTime: 0, deltaSeconds: 0.016 };
    for (let i = 0; i < 10; i++) sys.update(tick);
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

describe('AC-31: AutoSaveSystem calls saveToFile every intervalTicks when filePath set', () => {
  it('calls persistence.saveToFile on the interval (fire-and-forget)', () => {
    const { persistence } = makePersistence();
    const saveToFileSpy = vi.spyOn(persistence, 'saveToFile').mockResolvedValue(undefined);
    const saveSpy = vi.spyOn(persistence, 'save');
    const sys = new AutoSaveSystem({
      persistence,
      config: { enabled: true, intervalTicks: 3, filePath: 'save.json' },
    });
    const tick: GameTick = { tickNumber: 0, simulationTime: 0, deltaSeconds: 0.016 };
    // ticks 1, 2 → no save; tick 3 → save.
    sys.update(tick);
    sys.update(tick);
    expect(saveToFileSpy).not.toHaveBeenCalled();
    sys.update(tick);
    expect(saveToFileSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).not.toHaveBeenCalled();
    // tick 6 → another save.
    sys.update(tick);
    sys.update(tick);
    sys.update(tick);
    expect(saveToFileSpy).toHaveBeenCalledTimes(2);
  });
});

describe('AC-32: AutoSaveSystem calls save() every intervalTicks when no filePath', () => {
  it('calls persistence.save on the interval (fire-and-forget)', async () => {
    const { persistence } = makePersistence();
    const saveSpy = vi
      .spyOn(persistence, 'save')
      .mockResolvedValue({} as Awaited<ReturnType<typeof persistence.save>>);
    const saveToFileSpy = vi.spyOn(persistence, 'saveToFile');
    const sys = new AutoSaveSystem({
      persistence,
      config: { enabled: true, intervalTicks: 2 },
    });
    const tick: GameTick = { tickNumber: 0, simulationTime: 0, deltaSeconds: 0.016 };
    sys.update(tick);
    expect(saveSpy).not.toHaveBeenCalled();
    sys.update(tick);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveToFileSpy).not.toHaveBeenCalled();
  });
});

describe('AC-33: AutoSaveSystem.update() never awaits — fire-and-forget with .catch()', () => {
  it('does not throw when the save promise rejects (error is caught)', () => {
    const { persistence } = makePersistence();
    vi.spyOn(persistence, 'save').mockRejectedValue(new Error('boom'));
    const sys = new AutoSaveSystem({
      persistence,
      config: { enabled: true, intervalTicks: 1 },
    });
    const tick: GameTick = { tickNumber: 0, simulationTime: 0, deltaSeconds: 0.016 };
    // Should not throw synchronously even though save rejects.
    expect(() => sys.update(tick)).not.toThrow();
  });
});

// ─── AC-34 through AC-37: assembly integration ────────────────────────────────

describe('AC-34: EngineCore includes optional persistence and autoSaveConfig', () => {
  it('createEngineCore with a VectorStore sets persistence on the core', () => {
    const vs = new InMemoryVectorStore();
    const core = createEngineCore(makeConfig(), undefined, vs);
    expect(core.persistence).toBeDefined();
    expect(core.persistence).toBeInstanceOf(EnginePersistenceImpl);
  });

  it('createEngineCore without a VectorStore does not set persistence', () => {
    const core = createEngineCore(makeConfig());
    expect(core.persistence).toBeUndefined();
  });
});

describe('AC-36: assembleGameLoop registers AutoSaveSystem when enabled + persistence', () => {
  it('registers auto-save as the last system when enabled and persistence is set', () => {
    const vs = new InMemoryVectorStore();
    const core = createEngineCore(makeConfig(), undefined, vs);
    const orch = new FakeOrchestrator();
    const autoSaveConfig: AutoSaveConfig = { enabled: true, intervalTicks: 10 };
    assembleGameLoop(core, orch, undefined, { config: autoSaveConfig });
    const names = core.gameLoop.systemNames();
    expect(names[names.length - 1]).toBe('auto-save');
  });

  it('does not register auto-save when persistence is not set (logs warning)', () => {
    const core = createEngineCore(makeConfig());
    const orch = new FakeOrchestrator();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    assembleGameLoop(core, orch, undefined, { config: { enabled: true, intervalTicks: 10 } });
    const names = core.gameLoop.systemNames();
    expect(names).not.toContain('auto-save');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not register auto-save when disabled', () => {
    const vs = new InMemoryVectorStore();
    const core = createEngineCore(makeConfig(), undefined, vs);
    const orch = new FakeOrchestrator();
    assembleGameLoop(core, orch, undefined, { config: { enabled: false, intervalTicks: 10 } });
    const names = core.gameLoop.systemNames();
    expect(names).not.toContain('auto-save');
  });

  it('registers auto-save after MemoryMaintenanceSystem when both are present', () => {
    const vs = new InMemoryVectorStore();
    const core = createEngineCore(makeConfig(), undefined, vs);
    // Stub a minimal decay service so memory maintenance is registered.
    const decayService = {
      async applyDecay() {
        return { agentId: '', pruneCandidateIds: [], scores: [] };
      },
      async pruneMemories() {
        return 0;
      },
    };
    const orch = new FakeOrchestrator();
    assembleGameLoop(
      core,
      orch,
      { memoryDecayService: decayService },
      {
        config: { enabled: true, intervalTicks: 10 },
      },
    );
    const names = core.gameLoop.systemNames();
    expect(names[names.length - 1]).toBe('auto-save');
    expect(names).toContain('memory-maintenance');
  });
});

describe('AC-37: AssembledEngine includes optional persistence; createEngine returns it', () => {
  it('createEngine returns persistence when a VectorStore is provided', () => {
    const vs = new InMemoryVectorStore();
    const engine = createEngine(makeConfig(), new FakeOrchestrator(), undefined, vs);
    expect(engine.persistence).toBeDefined();
    expect(engine.persistence).toBeInstanceOf(EnginePersistenceImpl);
  });

  it('createEngine does not return persistence when no VectorStore', () => {
    const engine = createEngine(makeConfig(), new FakeOrchestrator());
    expect(engine.persistence).toBeUndefined();
  });
});

// ─── AC-38 through AC-45: round-trip state preservation ───────────────────────

describe('AC-38: round-trip preserves AgentInternalState', () => {
  it('drives, currentGoal, currentPlan, location, lastPerceptionTick survive', async () => {
    const ctx = makePersistence();
    ctx.agentManager.spawn(makeProfile('a1'));
    const plan = {
      id: 'plan1',
      description: 'get coffee',
      steps: [{ description: 'brew', completed: false, targetAffordance: 'brew_coffee' }],
      currentStepIndex: 0,
      createdAt: 5,
    };
    ctx.agentManager.updateState('a1', {
      drives: { energy: 20, hunger: 40, social: 70, comfort: 60, curiosity: 80 },
      currentGoal: 'get coffee',
      currentPlan: plan,
      location: 'kitchen',
      lastPerceptionTick: 12,
    });
    const saved = await ctx.persistence.save();

    const target = makePersistence();
    await target.persistence.load(saved);

    const st = target.agentManager.getState('a1');
    expect(st?.drives).toEqual({ energy: 20, hunger: 40, social: 70, comfort: 60, curiosity: 80 });
    expect(st?.currentGoal).toBe('get coffee');
    expect(st?.currentPlan).toEqual(plan);
    expect(st?.location).toBe('kitchen');
    expect(st?.lastPerceptionTick).toBe(12);
  });
});

describe('AC-39: round-trip preserves AgentProfile (including persona)', () => {
  it('persona fields survive', async () => {
    const ctx = makePersistence();
    const profile = makeProfile('a1');
    ctx.agentManager.spawn(profile);
    const saved = await ctx.persistence.save();

    const target = makePersistence();
    await target.persistence.load(saved);

    const p = target.agentManager.getProfile('a1');
    expect(p).toEqual(profile);
  });
});

describe('AC-40: round-trip preserves object state (not initial scene state)', () => {
  it('runtime object state survives', async () => {
    const ctx = makePersistence();
    ctx.sceneManager.restoreRooms(new Map([['kitchen', makeRoom('kitchen')]]));
    ctx.smartObjectRegistry.register(makeObject('coffee', 'kitchen', { water_level: 'full' }));
    // Mutate the runtime state after registration.
    ctx.smartObjectRegistry.updateState('coffee', { water_level: 'low', bean_count: 5 });
    const saved = await ctx.persistence.save();

    const target = makePersistence();
    await target.persistence.load(saved);
    expect(target.smartObjectRegistry.get('coffee')?.state).toEqual({
      water_level: 'low',
      bean_count: 5,
    });
  });
});

describe('AC-41: round-trip preserves rooms (connections + objectIds)', () => {
  it('room structure survives', async () => {
    const ctx = makePersistence();
    ctx.sceneManager.restoreRooms(
      new Map([
        ['kitchen', makeRoom('kitchen', ['bedroom', 'hall'], ['coffee', 'fridge'])],
        ['bedroom', makeRoom('bedroom', ['kitchen'], [])],
        ['hall', makeRoom('hall', ['kitchen'], [])],
      ]),
    );
    const saved = await ctx.persistence.save();

    const target = makePersistence();
    await target.persistence.load(saved);
    const kitchen = target.sceneManager.getRoom('kitchen');
    expect(kitchen?.connections).toEqual(['bedroom', 'hall']);
    expect(kitchen?.objectIds).toEqual(['coffee', 'fridge']);
  });
});

describe('AC-42: round-trip preserves memory nodes (embeddings, importance, lastAccessed, type)', () => {
  it('all memory fields survive', async () => {
    const ctx = makePersistence();
    await ctx.vectorStore.store(makeMemory('m1', 'a1', [0.1, 0.2], 7, 15, 'reflection'));
    await ctx.vectorStore.store(makeMemory('m2', 'a1', [0.3, 0.4], 2, 8, 'action'));
    const saved = await ctx.persistence.save();

    const target = makePersistence();
    await target.persistence.load(saved);
    const mems = (await target.vectorStore.exportAll()).sort((a, b) => a.id.localeCompare(b.id));
    expect(mems).toHaveLength(2);
    expect(mems[0]).toEqual({
      id: 'm1',
      agentId: 'a1',
      content: 'content-m1',
      embedding: [0.1, 0.2],
      timestamp: 10,
      importance: 7,
      type: 'reflection',
      lastAccessed: 15,
    });
    expect(mems[1]?.embedding).toEqual([0.3, 0.4]);
    expect(mems[1]?.type).toBe('action');
  });
});

describe('AC-43: round-trip preserves gameLoop tickNumber and simulationTime', () => {
  it('tick values match after load', async () => {
    const ctx = makePersistence();
    ctx.gameLoop.injectElapsed(3);
    const beforeTick = ctx.gameLoop.currentTick();
    const saved = await ctx.persistence.save();

    const target = makePersistence();
    target.gameLoop.injectElapsed(10); // different starting point
    await target.persistence.load(saved);
    expect(target.gameLoop.currentTick().tickNumber).toBe(beforeTick.tickNumber);
    expect(target.gameLoop.currentTick().simulationTime).toBeCloseTo(beforeTick.simulationTime, 5);
  });
});

describe('AC-44: round-trip sets isThinking: false regardless of saved value', () => {
  it('saved isThinking: true → loaded isThinking: false', async () => {
    const ctx = makePersistence();
    ctx.agentManager.spawn(makeProfile('a1'));
    ctx.agentManager.updateState('a1', { isThinking: true });
    const saved = await ctx.persistence.save();

    const target = makePersistence();
    await target.persistence.load(saved);
    expect(target.agentManager.getState('a1')?.isThinking).toBe(false);
  });

  it('saved isThinking: false → loaded isThinking: false', async () => {
    const ctx = makePersistence();
    ctx.agentManager.spawn(makeProfile('a1'));
    const saved = await ctx.persistence.save();

    const target = makePersistence();
    await target.persistence.load(saved);
    expect(target.agentManager.getState('a1')?.isThinking).toBe(false);
  });
});

describe('AC-45: consolidated memory nodes with reduced importance survive', () => {
  it('a reflection node with halved importance is preserved as-is', async () => {
    const ctx = makePersistence();
    // Simulate a consolidated node: original importance 8 halved to 4.
    await ctx.vectorStore.store(makeMemory('orig', 'a1', [1, 0], 4, 20, 'observation'));
    await ctx.vectorStore.store(makeMemory('reflect', 'a1', [0.9, 0.1], 9, 21, 'reflection'));
    const saved = await ctx.persistence.save();

    const target = makePersistence();
    await target.persistence.load(saved);
    const mems = await target.vectorStore.exportAll();
    const orig = mems.find((m) => m.id === 'orig');
    const reflect = mems.find((m) => m.id === 'reflect');
    expect(orig?.importance).toBe(4);
    expect(reflect?.importance).toBe(9);
    expect(reflect?.type).toBe('reflection');
  });
});

// ─── AC-46 / AC-47: edge cases ────────────────────────────────────────────────

describe('AC-46: load() with an empty SaveState clears existing state', () => {
  it('an empty save results in an empty simulation', async () => {
    const target = makePersistence();
    target.agentManager.spawn(makeProfile('old'));
    target.sceneManager.restoreRooms(new Map([['old', makeRoom('old')]]));
    target.smartObjectRegistry.register(makeObject('oldobj', 'old'));
    await target.vectorStore.store(makeMemory('oldmem', 'old', [1, 1]));

    const empty = {
      formatVersion: SAVE_FORMAT_VERSION,
      savedAt: 1,
      gameLoop: { tickNumber: 0, simulationTime: 0, deltaSeconds: 0.016 },
      agents: [],
      world: { rooms: [], objects: [] },
      memories: [],
    };
    await target.persistence.load(empty);

    expect(target.agentManager.getActiveAgents()).toHaveLength(0);
    expect(target.sceneManager.getAllRooms()).toHaveLength(0);
    expect(target.smartObjectRegistry.getAllObjects()).toHaveLength(0);
    expect(await target.vectorStore.exportAll()).toEqual([]);
  });
});

describe('AC-47: save() with no agents/objects/memories returns a valid empty SaveState', () => {
  it('returns empty arrays for agents, world, and memories', async () => {
    const { persistence } = makePersistence();
    const state = await persistence.save();
    expect(state.formatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(state.agents).toEqual([]);
    expect(state.world.rooms).toEqual([]);
    expect(state.world.objects).toEqual([]);
    expect(state.memories).toEqual([]);
  });
});

// ─── AC-48 / AC-49: package boundaries (static import analysis) ───────────────

/** Extract actual `import ... from '...'` specifiers from a source file. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /^\s*import\b[^'";]*?\s+from\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    specs.push(m[1]!);
  }
  return specs;
}

describe('AC-48: EnginePersistenceImpl imports only from shared + memory', () => {
  it('does not import from @evol-hive/cognition', () => {
    const source = readSrc('packages/engine/src/persistence/engine-persistence.ts');
    const specs = importSpecifiers(source);
    expect(specs).toContain('@evol-hive/shared');
    expect(specs).toContain('@evol-hive/memory');
    for (const spec of specs) {
      expect(spec).not.toContain('@evol-hive/cognition');
    }
  });
});

describe('AC-49: AutoSaveSystem imports only from shared (+ engine internal)', () => {
  it('does not import from cognition or memory', () => {
    const source = readSrc('packages/engine/src/systems/auto-save.ts');
    const specs = importSpecifiers(source);
    expect(specs).toContain('@evol-hive/shared');
    for (const spec of specs) {
      expect(spec).not.toContain('@evol-hive/cognition');
      expect(spec).not.toContain('@evol-hive/memory');
    }
  });
});

// ─── AC-51 / AC-52: error propagation ─────────────────────────────────────────

describe('AC-51: loadFromString("not valid json") throws SyntaxError', () => {
  it('propagates the JSON.parse SyntaxError', async () => {
    const { persistence } = makePersistence();
    await expect(persistence.loadFromString('not valid json')).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe('AC-52: loadFromFile("nonexistent.json") throws', () => {
  it('propagates the fs error', async () => {
    const { persistence } = makePersistence();
    await expect(
      persistence.loadFromFile(join(tmpdir(), 'definitely-nonexistent-12345.json')),
    ).rejects.toThrow();
  });
});

// ─── AC-55: full integration round-trip ───────────────────────────────────────

describe('AC-55: full simulation (2 agents, 3 rooms, 5 objects, 20 memories) round-trip', () => {
  it('preserves all state after a save → load round-trip', async () => {
    // Build a richer simulation using createEngineCore + loadScene-style seeding.
    const config = makeConfig();
    const gameLoop = new GameLoopImpl(config);
    const agentManager = new AgentManagerImpl();
    const sceneManager = new SceneManagerImpl(agentManager, new Map());
    const smartObjectRegistry = new SmartObjectRegistryImpl();
    const vectorStore = new InMemoryVectorStore();
    const persistence = new EnginePersistenceImpl({
      gameLoop,
      agentManager,
      smartObjectRegistry,
      sceneManager,
      vectorStore,
    });

    // 3 rooms.
    sceneManager.restoreRooms(
      new Map([
        ['kitchen', makeRoom('kitchen', ['bedroom', 'hall'], ['coffee', 'fridge', 'stove'])],
        ['bedroom', makeRoom('bedroom', ['kitchen'], ['bed'])],
        ['hall', makeRoom('hall', ['kitchen'], ['lamp'])],
      ]),
    );
    // 5 objects.
    const objs = [
      makeObject('coffee', 'kitchen', { water_level: 'low' }),
      makeObject('fridge', 'kitchen', { temp: 4 }),
      makeObject('stove', 'kitchen', { on: false }),
      makeObject('bed', 'bedroom', { made: true }),
      makeObject('lamp', 'hall', { brightness: 80 }),
    ];
    for (const o of objs) smartObjectRegistry.register(o);

    // 2 agents.
    agentManager.spawn(makeProfile('a1', 'kitchen'));
    agentManager.spawn(makeProfile('a2', 'bedroom'));
    agentManager.updateState('a1', {
      drives: { energy: 15, hunger: 30, social: 70, comfort: 60, curiosity: 90 },
      currentGoal: 'stay awake',
      location: 'kitchen',
      lastPerceptionTick: 5,
    });
    agentManager.updateState('a2', {
      drives: { energy: 80, hunger: 20, social: 40, comfort: 30, curiosity: 50 },
      currentGoal: 'eat',
      location: 'bedroom',
      lastPerceptionTick: 7,
    });

    // 20 memory nodes (10 per agent).
    for (let i = 0; i < 10; i++) {
      await vectorStore.store(
        makeMemory(
          `m-a1-${i}`,
          'a1',
          [i * 0.1, 0.5, 1 - i * 0.05],
          (i % 10) + 1,
          i,
          i % 2 === 0 ? 'observation' : 'action',
        ),
      );
      await vectorStore.store(
        makeMemory(
          `m-a2-${i}`,
          'a2',
          [1 - i * 0.05, i * 0.1, 0.5],
          (i % 10) + 1,
          i + 1,
          i % 2 === 0 ? 'interaction' : 'reflection',
        ),
      );
    }

    gameLoop.injectElapsed(2);

    const saved = await persistence.save();
    expect(saved.agents).toHaveLength(2);
    expect(saved.world.rooms).toHaveLength(3);
    expect(saved.world.objects).toHaveLength(5);
    expect(saved.memories).toHaveLength(20);

    // Load into a fresh target.
    const target = makePersistence();
    target.agentManager.spawn(makeProfile('stale'));
    await target.persistence.load(saved);

    expect(target.agentManager.getActiveAgents()).toHaveLength(2);
    expect(target.sceneManager.getAllRooms()).toHaveLength(3);
    expect(target.smartObjectRegistry.getAllObjects()).toHaveLength(5);
    expect(await target.vectorStore.exportAll()).toHaveLength(20);

    // Verify a sample of preserved state.
    expect(target.agentManager.getState('a1')?.currentGoal).toBe('stay awake');
    expect(target.agentManager.getState('a2')?.drives.hunger).toBe(20);
    expect(target.smartObjectRegistry.get('coffee')?.state['water_level']).toBe('low');
    expect(target.sceneManager.getRoom('kitchen')?.connections).toEqual(['bedroom', 'hall']);
    const mems = await target.vectorStore.exportAll();
    const sample = mems.find((m) => m.id === 'm-a1-3');
    // Compare with tolerance — the saved embedding is the result of JS float
    // arithmetic (3 * 0.1 = 0.30000000000000004) and must be preserved as-is.
    expect(sample?.embedding).toHaveLength(3);
    expect(sample?.embedding[0]).toBeCloseTo(0.3, 10);
    expect(sample?.embedding[1]).toBeCloseTo(0.5, 10);
    expect(sample?.embedding[2]).toBeCloseTo(0.85, 10);
    expect(sample?.importance).toBe(4);
    expect(target.gameLoop.currentTick().tickNumber).toBe(gameLoop.currentTick().tickNumber);
  });
});

// ─── defaultAutoSaveConfig sanity (used by assembly) ───────────────────────────

describe('defaultAutoSaveConfig sanity', () => {
  it('is disabled by default', () => {
    expect(defaultAutoSaveConfig.enabled).toBe(false);
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');

function readSrc(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
}
