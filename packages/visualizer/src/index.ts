/**
 * @evol-hive/visualizer — Browser-based 2D canvas renderer & WebSocket transport
 * ────────────────────────────────────────────────────────────────────────────
 * Spec 023 (renderer + transport), spec 042 (single renderer), spec 062 (pure
 * layout seam, skin seam, mobile world view). Depends only on
 * `@evol-hive/shared` for types — no external runtime dependencies.
 */

export { CanvasRenderer } from './renderer/canvas-renderer.js';
export type { RenderOptions } from './renderer/canvas-renderer.js';
export { FOG_CELL_FILL, THEME, PHASE_COLORS, DRIVES, AGENT_COLORS } from './renderer/theme.js';
export { formatStateLine, initials, truncate } from './renderer/format.js';
export {
  layoutWorld,
  placeRooms,
  adjacencyScore,
  resolveDoors,
  unexploredRects,
  cellCenter,
  legacySlot,
  legacyObjectSlot,
  objectChipWidth,
  smoothTowards,
  GRID_COLS,
  GRID_ROWS,
  ZERO_INSETS,
} from './renderer/layout.js';
export type {
  WorldLayout,
  RoomLayout,
  DoorLayout,
  EntityLayout,
  Rect,
  Point,
  Insets,
  Viewport,
} from './renderer/layout.js';
export { CanvasSkin } from './renderer/skin.js';
export type { Skin } from './renderer/skin.js';
export { cameraFor, transformLayout, worldBounds, FIT_ALL_CAMERA } from './renderer/camera.js';
export type { Camera } from './renderer/camera.js';
export { VisualizerServer } from './server/visualizer-server.js';
export type { VisualizerServerOptions } from './server/visualizer-server.js';
