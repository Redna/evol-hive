/**
 * Visualizer Types — Canvas/WebGL Renderer State & Commands (spec 023)
 * ───────────────────────────────────────────────────────────────────
 * Serializable snapshot types and the command union used by the browser-based
 * 2D canvas renderer. All types are plain JSON-compatible so they can be
 * serialized over WebSocket. Defined in `shared` so both the engine-side
 * adapter (`@evol-hive/engine`) and the visualizer package
 * (`@evol-hive/visualizer`) can depend on them without an import cycle (per
 * ADR-0001).
 */

import type { AgentDrives } from './agent.js';
import type { PPERPhase } from './cognition.js';

/**
 * A serializable snapshot of the full simulation state at a point in time
 * (spec 023, Req 1). Suitable for JSON serialization and WebSocket
 * transmission. Read-only — the visualizer never writes back through this
 * interface.
 */
export interface VisualizerState {
  tickNumber: number;
  simulationTime: number;
  isRunning: boolean;
  timeScale: number;
  rooms: VisualizerRoom[];
  agents: VisualizerAgent[];
}

/**
 * A room flattened with its full object list (spec 023, Req 2). Instead of
 * `objectIds`, each room carries its complete object array so the renderer
 * does not need to cross-reference a separate object map.
 */
export interface VisualizerRoom {
  id: string;
  name: string;
  description: string;
  connections: string[];
  objects: VisualizerObject[];
}

/**
 * A smart object projection for the renderer (spec 023, Req 3). Carries the
 * display name, type (for icon selection), deep state, available affordances
 * (as id+label pairs to keep the snapshot small), and compound action
 * summaries (step count for progress display).
 */
export interface VisualizerObject {
  id: string;
  name: string;
  type: string;
  state: Record<string, unknown>;
  affordances: { id: string; label: string }[];
  compoundActions?: { id: string; label: string; stepCount: number }[];
}

/**
 * All agent data the renderer needs (spec 023, Req 4): identity, position
 * (room ID), drives (five bars), goal (text), plan (description + progress),
 * PPER phase (for the phase indicator), thinking status, and relationships
 * (for drawing lines between agents).
 */
export interface VisualizerAgent {
  agentId: string;
  name: string;
  location: string;
  drives: AgentDrives;
  currentGoal: string;
  currentPlan: { description: string; currentStepIndex: number; totalSteps: number } | null;
  pperPhase: PPERPhase;
  isThinking: boolean;
  relationships: { agentId: string; trust: number; familiarity: number }[];
}

/**
 * The command sent from the browser to the server over WebSocket (spec 023,
 * Req 5). Each variant maps to a simulation control. `timeScale` is validated
 * server-side to be one of `1`, `2`, or `5`.
 */
export type VisualizerCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'setSpeed'; timeScale: number }
  | { type: 'save' }
  | { type: 'load'; stateJson: string }
  | { type: 'selectScene'; sceneId: string };

/**
 * The port interface the engine-side adapter implements (spec 023, Req 6).
 * The visualizer server holds a reference to this interface and calls
 * `getSnapshot()` on each push frame and `handleCommand()` when a command
 * arrives. Defined in `shared` to break the import cycle
 * (`visualizer → shared ← engine adapter`).
 */
export interface VisualizerInterface {
  getSnapshot(): VisualizerState;
  handleCommand(command: VisualizerCommand): Promise<void>;
}
