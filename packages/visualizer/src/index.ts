/**
 * @evol-hive/visualizer — Browser-based 2D canvas renderer & WebSocket transport
 * ────────────────────────────────────────────────────────────────────────────
 * Spec 023. Contains a Canvas 2D renderer, a lightweight HTTP server, and a
 * hand-rolled WebSocket transport layer. Depends only on `@evol-hive/shared`
 * for types — no external runtime dependencies.
 */

export { CanvasRenderer } from './renderer/canvas-renderer.js';
export { VisualizerServer } from './server/visualizer-server.js';
export type { VisualizerServerOptions } from './server/visualizer-server.js';
