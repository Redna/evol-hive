/**
 * @evol-hive/cli — Command-line interface for evol-hive (spec 022)
 * ────────────────────────────────────────────────────────────────────────────
 * Provides three commands:
 *   - `create-scene`  — interactive wizard that produces a valid .scene.yaml
 *   - `validate-scene` — loads and validates a scene file against the JSON Schema
 *   - `run-scene`     — loads a scene, builds the engine, and runs the simulation
 *
 * Usage: `npx evol-hive <command> [args]`
 */

export { validateSceneCommand } from './validate-scene.js';
export { createSceneCommand } from './create-scene.js';
export { runSceneCommand } from './run-scene.js';
