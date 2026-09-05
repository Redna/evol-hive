/**
 * Persistence Types — Save/Load Game State (spec 017, Reqs 1–8)
 * ───────────────────────────────────────────────────────────────
 * Pure data interfaces and constants representing the full serializable game
 * state. All fields are plain JSON-compatible types (strings, numbers,
 * booleans, arrays, plain objects) so `JSON.stringify` works with no replacer.
 *
 * Owned by `@evol-hive/shared` because both `@evol-hive/engine` (implements
 * save/load) and the application entry point (calls save/load) need them.
 */

import type { AgentInternalState, AgentProfile } from './agent.js';
import type { SmartObject } from './affordance.js';
import type { MemoryNode } from './memory.js';
import type { Room } from './world.js';
import type { DynamicWorldSnapshot } from './mutations.js';
import type { SelfModel } from './identity.js';

/** A snapshot of the deterministic game loop state (spec 017, Req 2). */
export interface GameLoopSnapshot {
  tickNumber: number;
  simulationTime: number;
  deltaSeconds: number;
}

/** A single agent's serializable profile + internal state (spec 017, Req 3). */
export interface AgentSnapshot {
  /** The agent's immutable profile (identity, persona, initial drives). */
  profile: AgentProfile;
  /** The agent's mutable internal state (drives, goal, plan, location, etc.). */
  state: AgentInternalState;
  /**
   * The evolved identity self-model (spec 033, R10/R11). Optional — absent
   * when the agent never evolved (backward compat with v1/v2 saves).
   */
  selfModel?: SelfModel;
}

/** The full world state: rooms and smart objects (spec 017, Req 4). */
export interface WorldSnapshot {
  rooms: Room[];
  objects: SmartObject[];
}

/**
 * The top-level serializable object representing the full game state at a
 * point in time (spec 017, Req 1). Serializable via `JSON.stringify` with no
 * replacer function.
 */
export interface SaveState {
  /** Format version for forward compatibility. Increment on breaking format changes. */
  formatVersion: number;
  /** Timestamp when the save was created (Unix epoch ms). */
  savedAt: number;
  /** Game loop state. */
  gameLoop: GameLoopSnapshot;
  /** All agent states and profiles. */
  agents: AgentSnapshot[];
  /** World state: rooms and objects. */
  world: WorldSnapshot;
  /** All memory nodes across all agents. */
  memories: MemoryNode[];
  /**
   * Dynamic-world extension (spec 030, Req 11): the applied mutation log and
   * dormant agent snapshots. Absent for scenes that never mutated, so static
   * scenes produce byte-identical saves (spec 030, AC-11).
   */
  dynamic?: DynamicWorldSnapshot;
}

/**
 * The current save format version (spec 017, Req 5). Increment on breaking
 * format changes and add a migration function (future concern).
 *
 * Spec 030 bumps 1 → 2: the optional `dynamic` field was added to
 * `SaveState`. Old (v1) saves still load — absence of dynamic data is
 * equivalent to zero mutations replayed (spec 030, Req 11).
 *
 * Spec 033 bumps 2 → 3: conversations ride in `DynamicWorldSnapshot.conversations`
 * and the evolved identity self-model rides in `AgentSnapshot.selfModel` /
 * `DormantAgentSnapshot.selfModel`. All new fields are optional, and
 * `MIN_SUPPORTED_SAVE_FORMAT_VERSION` stays at 1 so v1/v2 saves still load
 * (spec 033, R10/R16).
 */
export const SAVE_FORMAT_VERSION = 3;

/** The last save format version that `load()` still accepts (spec 030, Req 11). */
export const MIN_SUPPORTED_SAVE_FORMAT_VERSION = 1;

/**
 * Thrown by `load()` when the loaded `formatVersion` does not match
 * {@link SAVE_FORMAT_VERSION} (spec 017, Req 6). Fatal — no partial loading is
 * attempted.
 */
export class SaveFormatVersionError extends Error {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`Save format version mismatch: expected ${expected}, got ${actual}`);
    this.name = 'SaveFormatVersionError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** Configuration for the optional `AutoSaveSystem` (spec 017, Req 7). */
export interface AutoSaveConfig {
  /** Enable periodic auto-save. Default: false. */
  enabled: boolean;
  /** Auto-save every N engine ticks. Default: 600 (10 seconds at 60 FPS). */
  intervalTicks: number;
  /** File path for auto-saves. If omitted, auto-save is in-memory only (no file write). */
  filePath?: string;
}

/** Default auto-save config — disabled (spec 017, Req 8). */
export const defaultAutoSaveConfig: AutoSaveConfig = {
  enabled: false,
  intervalTicks: 600,
};
