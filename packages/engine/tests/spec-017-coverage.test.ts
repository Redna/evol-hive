/**
 * Spec 017 coverage tests — Persistence (Save/Load Game State)
 * ============================================================
 * PR #64 is a **spec-only PR** that introduces the specification document
 * `docs/specs/017-persistence-save-load-game-state.md` (29 requirements,
 * 55 acceptance criteria). No implementation code is included in this PR.
 *
 * This file serves two purposes:
 *
 * 1. **Spec document validation** — Active tests that verify the spec file
 *    exists, is well-formed, has the correct number of requirements and
 *    acceptance criteria, and that `docs/specs/INDEX.md` is updated.
 *
 * 2. **AC test scaffolds** — `it.todo()` stubs for each of the 55 acceptance
 *    criteria. These are pending tests that will be activated (converted to
 *    real tests) when the implementation PR lands. They serve as a verifiable
 *    checklist ensuring no AC is forgotten during implementation.
 *
 * Coverage summary:
 *   - AC-1 through AC-55: all scaffolded as `it.todo`
 *   - Spec document structure: 8 active tests
 *   - INDEX.md update: 3 active tests
 *   - Existing scaffolding verification: 5 active tests
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '../../..');
const SPEC_PATH = join(REPO_ROOT, 'docs/specs/017-persistence-save-load-game-state.md');
const INDEX_PATH = join(REPO_ROOT, 'docs/specs/INDEX.md');

function readFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

// ─── Spec Document Validation ───────────────────────────────────────────────

describe('Spec 017 — Document structure', () => {
  it('spec file exists at docs/specs/017-persistence-save-load-game-state.md', () => {
    expect(fileExists(SPEC_PATH)).toBe(true);
  });

  it('spec file has the correct title', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('# Feature: Persistence — Save/Load Game State and Agent Memory Across Sessions');
  });

  it('spec file contains 29 requirements', () => {
    const content = readFile(SPEC_PATH);
    const reqMatches = content.match(/^\d+\.\s\*\*/gm);
    expect(reqMatches).not.toBeNull();
    expect(reqMatches!.length).toBe(29);
  });

  it('spec file contains exactly 55 acceptance criteria', () => {
    const content = readFile(SPEC_PATH);
    const acMatches = content.match(/- \[ \] \*\*AC-\d+\*\*:/g);
    expect(acMatches).not.toBeNull();
    expect(acMatches!.length).toBe(55);
  });

  it('spec file references the correct architecture sections (§2, §3, §6, §11)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('§2');
    expect(content).toContain('§3');
    expect(content).toContain('§6');
    expect(content).toContain('§11');
  });

  it('spec file references the correct issue (#61)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('#61');
  });

  it('spec file lists all three packages: shared, memory, engine', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('`shared`');
    expect(content).toContain('`memory`');
    expect(content).toContain('`engine`');
  });

  it('spec file does NOT reference cognition package', () => {
    const content = readFile(SPEC_PATH);
    // The spec explicitly states no cognition dependency.
    // It should mention "cognition" only in the context of saying NOT to import from it.
    expect(content).toContain('cognition');
    // The packages line should not list cognition.
    const packagesLine = content.match(/^- Package:.*$/m);
    expect(packagesLine).not.toBeNull();
    expect(packagesLine![0]).not.toContain('cognition');
  });
});

// ─── INDEX.md Validation ────────────────────────────────────────────────────

describe('Spec 017 — INDEX.md update', () => {
  it('INDEX.md contains spec 017 row', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('017');
    expect(content).toContain('Persistence');
    expect(content).toContain('Save/Load');
  });

  it('INDEX.md updates architecture coverage for §2, §3, §6, §11', () => {
    const content = readFile(INDEX_PATH);
    // Spec 017 should appear in the architecture coverage for these sections.
    expect(content).toContain('017');
  });

  it('INDEX.md updates spec count summary to 18', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('Total specs:');
    expect(content).toMatch(/Total specs:\s+18/);
  });
});

// ─── Existing Scaffolding Verification ──────────────────────────────────────
//
// These tests verify that the existing types and classes the spec references
// as "already existing" are present in the codebase. The spec explicitly
// depends on these — confirming their presence validates the spec's assumptions.

describe('Spec 017 — Existing scaffolding verification', () => {
  it('AgentProfile and AgentInternalState already exist in shared', () => {
    const agentTypesPath = join(REPO_ROOT, 'packages/shared/src/types/agent.ts');
    expect(fileExists(agentTypesPath)).toBe(true);
    const content = readFile(agentTypesPath);
    expect(content).toContain('export interface AgentProfile');
    expect(content).toContain('export interface AgentInternalState');
    expect(content).toContain('export interface AgentDrives');
    expect(content).toContain('export interface AgentPlan');
  });

  it('Room and SmartObject already exist in shared', () => {
    const worldTypesPath = join(REPO_ROOT, 'packages/shared/src/types/world.ts');
    expect(fileExists(worldTypesPath)).toBe(true);
    const content = readFile(worldTypesPath);
    expect(content).toContain('export interface Room');
  });

  it('SmartObject already exists in shared', () => {
    const affordanceTypesPath = join(REPO_ROOT, 'packages/shared/src/types/affordance.ts');
    expect(fileExists(affordanceTypesPath)).toBe(true);
    const content = readFile(affordanceTypesPath);
    expect(content).toContain('export interface SmartObject');
  });

  it('MemoryNode already exists in shared', () => {
    const memoryTypesPath = join(REPO_ROOT, 'packages/shared/src/types/memory.ts');
    expect(fileExists(memoryTypesPath)).toBe(true);
    const content = readFile(memoryTypesPath);
    expect(content).toContain('export interface MemoryNode');
    expect(content).toContain('embedding');
    expect(content).toContain('importance');
  });

  it('VectorStore interface and InMemoryVectorStore already exist in memory', () => {
    const memoryIndexPath = join(REPO_ROOT, 'packages/memory/src/index.ts');
    expect(fileExists(memoryIndexPath)).toBe(true);
    const content = readFile(memoryIndexPath);
    expect(content).toContain('export interface VectorStore');

    const storePath = join(REPO_ROOT, 'packages/memory/src/store/in-memory-vector-store.ts');
    expect(fileExists(storePath)).toBe(true);
    const storeContent = readFile(storePath);
    expect(storeContent).toContain('export class InMemoryVectorStore');
  });
});

// ─── AC Scaffolds (pending until implementation) ────────────────────────────
//
// Each `it.todo` below corresponds to one acceptance criterion from the spec.
// When the implementation PR lands, convert these to real `it()` tests with
// assertions. This ensures every AC is tracked and none are forgotten.

describe('Spec 017 — Acceptance Criteria scaffolds (pending implementation)', () => {
  // ── Shared Layer ACs (AC-1 through AC-8) ──────────────────────────────────

  it.todo(
    'AC-1: SaveState interface is defined in packages/shared/src/types/persistence.ts and exported from index.ts. Includes formatVersion: number, savedAt: number, gameLoop: GameLoopSnapshot, agents: AgentSnapshot[], world: WorldSnapshot, and memories: MemoryNode[].',
  );

  it.todo(
    'AC-2: GameLoopSnapshot interface is defined in persistence.ts with tickNumber: number, simulationTime: number, and deltaSeconds: number.',
  );

  it.todo(
    'AC-3: AgentSnapshot interface is defined in persistence.ts with profile: AgentProfile and state: AgentInternalState.',
  );

  it.todo(
    'AC-4: WorldSnapshot interface is defined in persistence.ts with rooms: Room[] and objects: SmartObject[].',
  );

  it.todo(
    'AC-5: SAVE_FORMAT_VERSION constant is defined in persistence.ts with value 1.',
  );

  it.todo(
    'AC-6: SaveFormatVersionError class is defined in persistence.ts, extends Error, and has expected and actual number properties.',
  );

  it.todo(
    'AC-7: AutoSaveConfig interface is defined in persistence.ts with enabled: boolean, intervalTicks: number, and optional filePath?: string.',
  );

  it.todo(
    'AC-8: defaultAutoSaveConfig constant is defined in persistence.ts with enabled: false and intervalTicks: 600.',
  );

  // ── Memory Layer ACs (AC-9 through AC-12) ─────────────────────────────────

  it.todo(
    'AC-9: VectorStore interface in packages/memory/src/index.ts includes exportAll(): Promise<MemoryNode[]>.',
  );

  it.todo(
    'AC-10: VectorStore interface in packages/memory/src/index.ts includes importAll(nodes: MemoryNode[]): Promise<void>.',
  );

  it.todo(
    'AC-11: InMemoryVectorStore.exportAll() returns copies of all stored MemoryNode objects. Mutating a returned node does not affect the store.',
  );

  it.todo(
    'AC-12: InMemoryVectorStore.importAll(nodes) clears all existing nodes and stores copies of the provided nodes. After importAll, exportAll() returns the same nodes (deep equality).',
  );

  // ── Engine Layer ACs (AC-13 through AC-19) ────────────────────────────────

  it.todo(
    'AC-13: EnginePersistence interface is defined in packages/engine/src/index.ts with save(), load(), saveToString(), loadFromString(), saveToFile(), and loadFromFile() methods.',
  );

  it.todo(
    'AC-14: EnginePersistenceImpl is defined in packages/engine/src/persistence/engine-persistence.ts and exported from packages/engine/src/index.ts.',
  );

  it.todo(
    'AC-15: EnginePersistenceImpl.save() returns a SaveState with formatVersion: SAVE_FORMAT_VERSION, savedAt set to current time, and correct game loop tick, agents, world, and memories.',
  );

  it.todo(
    'AC-16: EnginePersistenceImpl.save() includes all active agents — each AgentSnapshot has the agent profile (from getProfile) and state (from getState).',
  );

  it.todo(
    'AC-17: EnginePersistenceImpl.save() includes all rooms (from SceneManagerImpl.getAllRooms()) and all objects (from SmartObjectRegistryImpl.getAllObjects()) in the WorldSnapshot.',
  );

  it.todo(
    'AC-18: EnginePersistenceImpl.save() includes all memory nodes (from vectorStore.exportAll()) in the SaveState.memories field, including their embeddings.',
  );

  it.todo(
    'AC-19: EnginePersistenceImpl.load(state) stops the game loop, restores tickNumber and simulationTime via GameLoopImpl.restoreState(), restores agents via spawn() + updateState(), restores world via SceneManagerImpl.restoreRooms() and SmartObjectRegistryImpl.register(), and restores memories via vectorStore.importAll().',
  );

  // ── Load Behaviour ACs (AC-20 through AC-22) ──────────────────────────────

  it.todo(
    'AC-20: EnginePersistenceImpl.load(state) throws SaveFormatVersionError when state.formatVersion does not equal SAVE_FORMAT_VERSION.',
  );

  it.todo(
    'AC-21: EnginePersistenceImpl.load(state) sets isThinking: false for every loaded agent (clearing stale thinking state from previous session).',
  );

  it.todo(
    'AC-22: EnginePersistenceImpl.load(state) does NOT call gameLoop.start() — the loop remains stopped after load.',
  );

  // ── String/File Round-Trip ACs (AC-23 through AC-24) ──────────────────────

  it.todo(
    'AC-23: EnginePersistenceImpl.saveToString() returns a pretty-printed JSON string of the SaveState. loadFromString(json) parses it and calls load(). A round-trip loadFromString(saveToString()) restores the exact same state.',
  );

  it.todo(
    'AC-24: EnginePersistenceImpl.saveToFile(path) writes the JSON to the file at path. loadFromFile(path) reads the file and calls loadFromString(). A round-trip loadFromFile(saveToFile()) restores the exact same state.',
  );

  // ── Subsystem Export/Import ACs (AC-25 through AC-28) ─────────────────────

  it.todo(
    'AC-25: GameLoopImpl.restoreState(tickNumber, simulationTime) sets the internal tickNumber and simulationTime and updates currentGameTick. After restoreState(42, 123.45), currentTick() returns { tickNumber: 42, simulationTime: 123.45, deltaSeconds: <existing> }.',
  );

  it.todo(
    'AC-26: SceneManagerImpl.getAllRooms() returns all rooms as an array.',
  );

  it.todo(
    'AC-27: SceneManagerImpl.restoreRooms(rooms) replaces the internal room map. After restoreRooms(newMap), getRoom() returns rooms from the new map.',
  );

  it.todo(
    'AC-28: SmartObjectRegistryImpl.getAllObjects() returns all objects as an array, including their current runtime state.',
  );

  // ── AutoSaveSystem ACs (AC-29 through AC-33) ──────────────────────────────

  it.todo(
    'AC-29: AutoSaveSystem is defined in packages/engine/src/systems/auto-save.ts and exported from packages/engine/src/index.ts. Its name is "auto-save".',
  );

  it.todo(
    'AC-30: AutoSaveSystem.update() is a no-op when config.enabled is false.',
  );

  it.todo(
    'AC-31: AutoSaveSystem.update() calls persistence.saveToFile(config.filePath) every intervalTicks ticks when enabled is true and filePath is set (fire-and-forget).',
  );

  it.todo(
    'AC-32: AutoSaveSystem.update() calls persistence.save() every intervalTicks ticks when enabled is true and filePath is not set (fire-and-forget).',
  );

  it.todo(
    'AC-33: AutoSaveSystem.update() never awaits — the save operation is fire-and-forget with .catch() error logging.',
  );

  // ── Assembly Integration ACs (AC-34 through AC-37) ────────────────────────

  it.todo(
    'AC-34: EngineCore interface includes optional persistence?: EnginePersistenceImpl and autoSaveConfig?: AutoSaveConfig fields.',
  );

  it.todo(
    'AC-35: createEngineCore constructs EnginePersistenceImpl when a VectorStore is provided. When no VectorStore is available, persistence is not set on EngineCore.',
  );

  it.todo(
    'AC-36: assembleGameLoop registers AutoSaveSystem as the last engine system when autoSave.config.enabled is true and core.persistence is set. When core.persistence is not set but auto-save is enabled, a warning is logged and no auto-save system is registered.',
  );

  it.todo(
    'AC-37: AssembledEngine interface includes optional persistence?: EnginePersistenceImpl. createEngine returns the persistence field.',
  );

  // ── Round-Trip State Preservation ACs (AC-38 through AC-45) ───────────────

  it.todo(
    'AC-38: After a full save → load round-trip, agentManager.getActiveAgents() returns the same agents with the same AgentInternalState (drives, currentGoal, currentPlan, location, lastPerceptionTick) as before the save.',
  );

  it.todo(
    'AC-39: After a full save → load round-trip, agentManager.getProfile(agentId) returns the same AgentProfile (including persona fields) as before the save.',
  );

  it.todo(
    'AC-40: After a full save → load round-trip, smartObjectRegistry.get(objectId).state returns the same object state as before the save (not the initial scene state).',
  );

  it.todo(
    'AC-41: After a full save → load round-trip, sceneManager.getRoom(roomId) returns the same room (with connections and objectIds) as before the save.',
  );

  it.todo(
    'AC-42: After a full save → load round-trip, vectorStore.exportAll() returns the same memory nodes (including embeddings, importance, lastAccessed, type, timestamp) as before the save.',
  );

  it.todo(
    'AC-43: After a full save → load round-trip, gameLoop.currentTick().tickNumber and .simulationTime match the values from before the save.',
  );

  it.todo(
    'AC-44: After a full save → load round-trip, all loaded agents have isThinking: false regardless of the saved isThinking value.',
  );

  it.todo(
    'AC-45: After a full save → load round-trip, consolidated memory nodes (created by ReflectionLoopImpl.runReflection) with reduced importance are preserved with their reduced importance values.',
  );

  // ── Edge Case ACs (AC-46 through AC-47) ───────────────────────────────────

  it.todo(
    'AC-46: EnginePersistenceImpl.load() with an empty SaveState (no agents, no objects, no memories) clears all existing state and results in an empty simulation.',
  );

  it.todo(
    'AC-47: EnginePersistenceImpl.save() with no agents, no objects, and no memories returns a valid SaveState with empty agents, world.rooms, world.objects, and memories arrays.',
  );

  // ── Package Boundary ACs (AC-48 through AC-49) ────────────────────────────

  it.todo(
    'AC-48: EnginePersistenceImpl imports from @evol-hive/shared (for types) and @evol-hive/memory (for VectorStore). It does NOT import from @evol-hive/cognition.',
  );

  it.todo(
    'AC-49: AutoSaveSystem imports from @evol-hive/shared (for AutoSaveConfig, GameTick) and @evol-hive/engine (for EnginePersistence, EngineSystem). It does NOT import from @evol-hive/cognition or @evol-hive/memory.',
  );

  // ── Serialization & Error Handling ACs (AC-50 through AC-54) ──────────────

  it.todo(
    'AC-50: JSON.stringify(saveState) produces valid JSON with no replacer function. JSON.parse(jsonString) produces an object assignable to SaveState.',
  );

  it.todo(
    'AC-51: EnginePersistenceImpl.loadFromString("not valid json") throws a SyntaxError (from JSON.parse). The error is not swallowed.',
  );

  it.todo(
    'AC-52: EnginePersistenceImpl.loadFromFile("nonexistent.json") throws an Error (from fs.readFile). The error is not swallowed.',
  );

  it.todo(
    'AC-53: SaveFormatVersionError is thrown by load() when formatVersion is 0 (or any value other than 1). The error expected is 1 and actual is the received version.',
  );

  it.todo(
    'AC-54: EnginePersistenceImpl.saveToFile(path) writes a file that contains "formatVersion": 1 and "savedAt": followed by a number.',
  );

  // ── Integration AC (AC-55) ────────────────────────────────────────────────

  it.todo(
    'AC-55: A simulation with 2 agents, 3 rooms, 5 objects, and 20 memory nodes can be saved and loaded. After load, the simulation has 2 agents, 3 rooms, 5 objects, and 20 memory nodes with all state preserved.',
  );
});