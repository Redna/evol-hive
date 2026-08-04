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
