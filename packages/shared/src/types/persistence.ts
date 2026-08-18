/**
 * Persistence Types — Save/Load Game State (spec 017)
 * ──────────────────────────────────────────────────
 * Defines the serializable save format and configuration for persisting the
 * full game state (agents, world, memory) across sessions. All types are plain
 * JSON-serializable data — no methods, no class hierarchies.
 *
 * Architecture: §2 (System Overview), §3 (Agent State Schema), §6 (PPER Loop),
 * §11 (Memory Architecture). Issue #61.
 */

import type { AgentProfile, AgentInternalState } from './agent.js';
import type { Room } from './world.js';
import type { SmartObject } from './affordance.js';
import type { MemoryNode } from './memory.js';

// ── Snapshot interfaces ─────────────────────────────────────────────────────

/** Captures the `GameLoopImpl`'s deterministic state at save time. */
export interface GameLoopSnapshot {
  tickNumber: number;
  simulationTime: number;
  deltaSeconds: number;
}

/** Bundles an agent's immutable profile and mutable internal state for save/load. */
export interface AgentSnapshot {
  /** The agent's immutable profile (identity, persona, initial drives). */
  profile: AgentProfile;
  /** The agent's mutable internal state (drives, goal, plan, location, etc.). */
  state: AgentInternalState;
}

/** Captures the full world: rooms and smart objects with their current runtime state. */
export interface WorldSnapshot {
  rooms: Room[];
  objects: SmartObject[];
}

/**
 * The top-level serializable object representing the full game state at a
 * point in time. Must be serializable via `JSON.stringify` with no replacer.
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
}

// ── Versioning ──────────────────────────────────────────────────────────────

/** The current save format version. Increment on breaking format changes. */
export const SAVE_FORMAT_VERSION = 1;

/**
 * Thrown by `load()` when the `formatVersion` in the loaded JSON does not match
 * `SAVE_FORMAT_VERSION`. A fatal error — no partial loading is attempted.
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

// ── Auto-save configuration ─────────────────────────────────────────────────

/** Configuration for the optional `AutoSaveSystem` (spec 017, Req 16). */
export interface AutoSaveConfig {
  /** Enable periodic auto-save. Default: false. */
  enabled: boolean;
  /** Auto-save every N engine ticks. Default: 600 (10 seconds at 60 FPS). */
  intervalTicks: number;
  /** File path for auto-saves. If omitted, auto-save is in-memory only (no file write). */
  filePath?: string;
}

/** Default auto-save config — disabled by default (spec 017, Req 8). */
export const defaultAutoSaveConfig: AutoSaveConfig = {
  enabled: false,
  intervalTicks: 600,
};
