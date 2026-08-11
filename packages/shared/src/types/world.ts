/**
 * World Types — Rooms, Scenes, Spatial Management
 * ───────────────────────────────────────────────
 */

/** A room/scene in the game world. */
export interface Room {
  id: string;
  name: string;
  description: string;
  /** Connected room IDs (for spatial traversal). */
  connections: string[];
  /** IDs of smart objects currently in this room. */
  objectIds: string[];
}

/** The full game world. */
export interface World {
  id: string;
  name: string;
  rooms: Map<string, Room>;
  objects: Map<string, import('./affordance.js').SmartObject>;
}

/**
 * A serializable scene blueprint (spec 005, Req 10) that can be declaratively
 * defined and loaded into the engine via the engine factory.
 */
export interface SceneDefinition {
  id: string;
  name: string;
  rooms: Room[];
  objects: import('./affordance.js').SmartObject[];
  agents: import('./agent.js').AgentProfile[];
}
