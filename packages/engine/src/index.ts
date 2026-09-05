/**
 * @evol-hive/engine — Deterministic Game Engine
 * ──────────────────────────────────────────────
 * Sections 2, 6, 9: Game loop, physics simulation, spatial management,
 * asynchronous state management, and action routing.
 *
 * The engine runs at a deterministic FPS while LLM calls happen
 * asynchronously. Agents in "is_thinking" state don't block the loop.
 */

// ── Game Loop ────────────────────────────────────────────────────────────────

/** The core game loop. Manages ticks, physics updates, and agent queries. */
export interface GameLoop {
  /** Start the simulation. */
  start(): void;
  /** Stop the simulation. */
  stop(): void;
  /** Register a system to be updated each tick. */
  registerSystem(system: EngineSystem): void;
  /** Current simulation tick info. */
  currentTick(): import('@evol-hive/shared').GameTick;
}

/** A pluggable engine system (physics, cognition scheduler, memory, etc.). */
export interface EngineSystem {
  name: string;
  /** Called every tick at engine FPS. */
  update(tick: import('@evol-hive/shared').GameTick): void;
}

// ── Physics ──────────────────────────────────────────────────────────────────

/** The deterministic physics subsystem. */
export interface PhysicsSystem extends EngineSystem {
  /** Execute an affordance's engine effect on the world. */
  executeAffordance(
    objectId: string,
    affordanceId: string,
    agentId: string,
  ): Promise<import('@evol-hive/shared').AffordanceResult>;
}

// ── Spatial ──────────────────────────────────────────────────────────────────

/** Spatial management with debouncing (Section 6.1). */
export interface SpatialSystem extends EngineSystem {
  /** Get objects visible in the agent's current room — projected to { id, name, type } (passive perception). */
  getObjectsInRoom(roomId: string): import('@evol-hive/shared').SmartObjectSummary[];
  /** Check if a perception tick should fire (spatial debouncing). */
  shouldTriggerPerception(agentId: string): boolean;
  /** Record that a perception tick fired for an agent. */
  recordPerceptionTick(agentId: string, simulationTime: number): void;
}

// ── Routing (Section 9) ───────────────────────────────────────────────────────

/** Routes LLM responses to the appropriate engine subsystem. */
export interface ActionRouter {
  /** Route an LLM action response to physics, cognitive tools, or observation. */
  route(agentId: string, response: import('@evol-hive/shared').LLMActionResponse): Promise<void>;
}

/** Manages the asynchronous execution of LLM calls (Section 9.1). */
export interface LLMConcurrencyManager {
  /** Maximum concurrent LLM calls allowed. */
  maxConcurrent: number;
  /** Queue an LLM call. Returns when a slot is available. */
  acquireSlot(): Promise<void>;
  /** Release a slot after the LLM call completes. */
  releaseSlot(): void;
  /** Current number of active LLM calls. */
  activeCount: number;
}

// ── Re-exports ────────────────────────────────────────────────────────────────

// Engine core
export * from './loop/index.js';
export * from './physics/index.js';
export * from './spatial/index.js';
export * from './routing/index.js';

// World (smart objects, affordances, scenes) — Section 4
export * from './world/index.js';

// Agents (state, drives, plans) — Section 3
export * from './agents/index.js';

// Engine systems (drive decay, PPER scheduler, memory maintenance, object state) — spec 005 / 014 / 018
export * from './systems/index.js';

// Social (agent-to-agent perception, communication, relationships) — spec 018
export * from './social/message-queue.js';
export * from './social/social-manager.js';
export * from './social/conversation-manager.js';
export * from './systems/conversation-lifecycle.js';

// Dynamic scene mutations — spec 030 (examples need the service type)
export * from './world/mutations/index.js';

// Visualizer adapter — spec 023
export * from './visualizer/data-adapter.js';

// ── Persistence (spec 017) ───────────────────────────────────────────────
export interface EnginePersistence {
  /** Serialize the full game state to a SaveState object. */
  save(): Promise<import('@evol-hive/shared').SaveState>;
  /** Restore the full game state from a SaveState object. */
  load(state: import('@evol-hive/shared').SaveState): Promise<void>;
  /** Serialize the full game state to a JSON string. */
  saveToString(): Promise<string>;
  /** Restore the full game state from a JSON string. */
  loadFromString(json: string): Promise<void>;
  /** Serialize the full game state to a file on disk. */
  saveToFile(path: string): Promise<void>;
  /** Restore the full game state from a file on disk. */
  loadFromFile(path: string): Promise<void>;
}

// Persistence implementation (spec 017)
export * from './persistence/index.js';

// Engine assembly factory — spec 005
export * from './assembly.js';

// Scene loader (declarative scene authoring) — spec 022
export * from './scene-loader/index.js';
