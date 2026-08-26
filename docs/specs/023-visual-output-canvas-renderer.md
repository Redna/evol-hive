# Feature: Visual Output — Canvas/WebGL Renderer for the Simulation

## Context
- Architecture: [§2 — System Overview](../architecture/02-system-overview.md) (package boundaries, hybrid engine, system diagram), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (AgentDrives, AgentInternalState, AgentPlan — all state the renderer must display), [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (SmartObject, Affordance, CompoundAction — object visualization), [§6 — PPER Loop](../architecture/06-pper-loop.md) (PPER phases — phase indicator), [§9 — Engine Routing](../architecture/09-engine-routing.md) (asynchronous state management, GameLoop start/stop — play/pause controls)
- Related specs: [005 — Game Loop Integration](005-game-loop-integration.md) (EngineCore, GameLoopImpl, start/stop — play/pause/speed controls build on this), [013 — Richer Prototype Scenes](013-richer-prototype-scenes.md) (SceneDefinition, room layouts, object definitions — scene selector), [017 — Persistence — Save/Load Game State](017-persistence-save-load-game-state.md) (EnginePersistence, SaveState, save/load API — save/load UI controls), [018 — Multi-Agent Social](018-multi-agent-social.md) (Relationship, SocialManager — relationship lines between agents), [018 — Object Interactions](018-object-interactions.md) (CompoundAction, ObjectStateRule, AffordanceCondition — compound action progress, object state indicators)
- Package: `shared` (VisualizerState types, VisualizerInterface), `engine` (VisualizerDataAdapter, speed control, phase query plumbing), `@evol-hive/visualizer` (new package — canvas renderer, HTTP server, WebSocket transport)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#89](https://github.com/Redna/evol-hive/issues/89)

## Design Rationale

The simulation runs headless — all validation requires reading console logs. This spec introduces a browser-based 2D canvas renderer that provides real-time visual output of rooms, objects, agents, and simulation controls.

The architecture follows the issue's guidance with three deliberate design decisions:

**1. New package `@evol-hive/visualizer` (canvas-based, no external deps).** Per ADR-0001, the existing 4-package structure separates concerns by runtime profile. The visualizer is a fundamentally different runtime concern: it runs in a browser, not Node.js. It uses the Canvas 2D API (not WebGL — the top-down 2D view does not benefit from GPU shaders, and Canvas 2D has universal browser support with zero dependencies). The package contains: (a) a TypeScript renderer that draws to a `<canvas>` element, (b) a lightweight HTTP server that serves the renderer HTML/JS to a browser, and (c) a WebSocket transport layer that streams state snapshots from the engine to the browser. The package depends on `@evol-hive/shared` for types and receives engine state via an interface — it never imports `@evol-hive/engine` directly, preserving the acyclic dependency graph.

**2. WebSocket for real-time updates (not SSE).** The issue allows "WebSocket or SSE." WebSocket is chosen because the visualizer needs bidirectional communication: the browser sends control commands (play, pause, speed, save, load, scene select) to the server, and the server pushes state snapshots to the browser. SSE is server-to-client only, which would require a separate HTTP endpoint for commands. A single WebSocket connection handles both directions with lower framing overhead.

**3. Engine exposes a `VisualizerInterface` for state queries.** The engine already has all the data the visualizer needs — `AgentManagerImpl.getActiveAgents()` returns agent states with drives, `SmartObjectRegistryImpl` holds object states, `SceneManagerImpl.getAllRooms()` returns room layouts, and `PPEROrchestratorPort.getPhase()` returns the current PPER phase. Rather than adding a new system, we add a `VisualizerDataAdapter` class in the engine package that composes these existing query surfaces into a single `VisualizerState` snapshot. This adapter is constructed in the example entry point and passed to the visualizer's HTTP/WebSocket server. The engine package itself is not modified to depend on the visualizer — the adapter is a thin read-only composition layer.

**Speed control** is implemented by modifying the `GameLoopImpl`'s effective delta time multiplier. Currently the loop uses a fixed `deltaSeconds = 1/fps`. Speed control introduces a `timeScale` multiplier (1×, 2×, 5×) that scales the elapsed real time before it enters the accumulator: `effectiveElapsed = realElapsed * timeScale`. At 1×, the simulation runs at normal speed; at 2×, each real second produces 2 seconds of simulation time; at 5×, each real second produces 5 seconds. This is a minimal change to `GameLoopImpl` — one line in the `frame()` method — and does not affect the fixed-timestep determinism (the accumulator still consumes fixed `deltaSeconds` steps; only the rate at which real time feeds the accumulator changes).

**Phase tracking** uses the existing `PPEROrchestratorPort.getPhase(agentId)` method, which is already defined in `shared` and implemented by `PPEROrchestratorImpl`. The `VisualizerDataAdapter` calls `getPhase()` for each active agent when building a snapshot. No new phase tracking infrastructure is needed.

**Save/load from the UI** reuses the existing `EnginePersistence` interface (spec 017). The visualizer server receives a "save" command from the browser, calls `enginePersistence.saveToString()`, and returns the JSON string to the browser (which can display it or trigger a download). For "load," the browser sends a JSON string, and the server calls `enginePersistence.loadFromString()`. No new persistence logic is needed.

**Scene selector** reuses the existing `SceneDefinition` type and `loadScene()` function. The visualizer server holds a map of scene IDs to `SceneDefinition` objects (the three built-in scenes: minimal, morning-routine, coffee-shop). When the browser sends a "selectScene" command, the server stops the game loop, creates a fresh `EngineCore` via `createEngineCore()`, calls `loadScene()` with the selected scene, and restarts the loop. This is the same flow the existing example entry points use.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`VisualizerState` interface** — A new interface `VisualizerState` must be defined in `packages/shared/src/types/visualizer.ts` and exported from `packages/shared/src/index.ts`. This is the serializable snapshot of the full simulation state at a point in time, suitable for JSON serialization and WebSocket transmission:
   ```typescript
   interface VisualizerState {
     tickNumber: number;
     simulationTime: number;
     isRunning: boolean;
     timeScale: number;
     rooms: VisualizerRoom[];
     agents: VisualizerAgent[];
   }
   ```
   All fields are plain JSON-compatible types. This is a read-only snapshot — the visualizer never writes back to the engine through this interface.

2. **`VisualizerRoom` interface** — A new interface `VisualizerRoom` in `packages/shared/src/types/visualizer.ts`:
   ```typescript
   interface VisualizerRoom {
     id: string;
     name: string;
     description: string;
     connections: string[];
     objects: VisualizerObject[];
   }
   ```
   This flattens the room-to-object relationship: instead of `objectIds`, each room carries its full object list. This avoids the visualizer needing to cross-reference a separate object map.

3. **`VisualizerObject` interface** — A new interface `VisualizerObject` in `packages/shared/src/types/visualizer.ts`:
   ```typescript
   interface VisualizerObject {
     id: string;
     name: string;
     type: string;
     state: Record<string, unknown>;
     affordances: { id: string; label: string }[];
     compoundActions?: { id: string; label: string; stepCount: number }[];
   }
   ```
   This carries the object's display name, type (for icon selection), deep state (e.g., `{ water_level: 5, bean_count: 12 }`), available affordances (as id+label pairs — not full `Affordance` objects, to keep the snapshot small), and compound action summaries (step count for progress display).

4. **`VisualizerAgent` interface** — A new interface `VisualizerAgent` in `packages/shared/src/types/visualizer.ts`:
   ```typescript
   interface VisualizerAgent {
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
   ```
   This bundles all agent data the renderer needs: identity, position (room ID), drives (five bars), goal (text), plan (description + progress), PPER phase (for the phase indicator), thinking status, and relationships (for drawing lines between agents). The `PPERPhase` type already exists in `shared/src/types/cognition.ts`.

5. **`VisualizerCommand` type** — A new discriminated union type in `packages/shared/src/types/visualizer.ts`:
   ```typescript
   type VisualizerCommand =
     | { type: 'play' }
     | { type: 'pause' }
     | { type: 'setSpeed'; timeScale: number }
     | { type: 'save' }
     | { type: 'load'; stateJson: string }
     | { type: 'selectScene'; sceneId: string };
   ```
   This is the command sent from the browser to the server over WebSocket. Each variant maps to a scene control. `timeScale` is validated server-side to be one of `1`, `2`, or `5`.

6. **`VisualizerInterface` interface** — A new interface `VisualizerInterface` in `packages/shared/src/types/visualizer.ts`:
   ```typescript
   interface VisualizerInterface {
     getSnapshot(): VisualizerState;
     handleCommand(command: VisualizerCommand): Promise<void>;
   }
   ```
   This is the port interface that the engine-side adapter implements. The visualizer package's server holds a reference to this interface and calls `getSnapshot()` on each WebSocket frame and `handleCommand()` when a command arrives. Defined in `shared` to break the import cycle (visualizer → shared ← engine adapter), per ADR-0001.

### Engine Layer (`@evol-hive/engine`)

7. **`timeScale` on `GameLoopImpl`** — Add a `timeScale` property to `GameLoopImpl` (default: `1`). In the `frame()` method, multiply `elapsed` by `this.timeScale` before adding to the accumulator: `const effectiveElapsed = elapsed * this.timeScale;`. Add a `setTimeScale(scale: number): void` method that sets `this.timeScale` and validates it is a positive finite number. Add a `getTimeScale(): number` getter. The `timeScale` is not part of `GameLoopSnapshot` or `SaveState` — it is a runtime control, not simulation state. At `timeScale = 1`, behavior is identical to current (backward compatible).

8. **`VisualizerDataAdapter` class** — Create `packages/engine/src/visualizer/data-adapter.ts` exporting a `VisualizerDataAdapter` class that implements `VisualizerInterface`. Constructor takes `{ gameLoop: GameLoopImpl; agentManager: AgentManagerImpl; smartObjectRegistry: SmartObjectRegistryImpl; sceneManager: SceneManagerImpl; orchestrator: PPEROrchestratorPort; persistence?: EnginePersistence; agentProfiles: Map<string, AgentProfile> }`. The `getSnapshot()` method composes a `VisualizerState` by: reading `gameLoop.currentTick()` for tick/simulation time, `gameLoop.isRunning()` (add an `isRunning(): boolean` getter to `GameLoopImpl`) and `gameLoop.getTimeScale()` for running state and speed, `sceneManager.getAllRooms()` for rooms, and for each room calling `smartObjectRegistry.getObjectsInRoom(roomId)` to get full objects (not just summaries). For agents, it calls `agentManager.getActiveAgents()`, maps each to a `VisualizerAgent` using the agent's `AgentInternalState` + the profile's `name` from `agentProfiles` + `orchestrator.getPhase(agentId)` for the PPER phase + the agent's `relationships` map for relationship data. The `handleCommand()` method dispatches to the appropriate engine method: `play` → `gameLoop.start()`, `pause` → `gameLoop.stop()`, `setSpeed` → `gameLoop.setTimeScale()`, `save` → `persistence?.saveToString()`, `load` → `persistence?.loadFromString()`, `selectScene` → stops loop, creates new engine core, loads scene, restarts loop.

9. **`isRunning()` getter on `GameLoopImpl`** — Add a public `isRunning(): boolean` method to `GameLoopImpl` that returns the current `this.running` value. This is needed by `VisualizerDataAdapter.getSnapshot()` to report the running state. This is a one-line method — the `running` field already exists.

10. **Export visualizer adapter from engine** — Add `export * from './visualizer/data-adapter.js';` to `packages/engine/src/index.ts`. This makes `VisualizerDataAdapter` available to example entry points that wire the visualizer server.

### Visualizer Package (`@evol-hive/visualizer`)

11. **Package structure** — Create `packages/visualizer/` with `package.json` (name: `@evol-hive/visualizer`, dependencies: `@evol-hive/shared` only), `tsconfig.json` (extends root), and `src/` directory. The package contains three modules: `renderer/` (canvas drawing), `server/` (HTTP + WebSocket), and `index.ts` (public exports). Add `@evol-hive/visualizer` to `pnpm-workspace.yaml`.

12. **`CanvasRenderer` class** — Create `packages/visualizer/src/renderer/canvas-renderer.ts` exporting a `CanvasRenderer` class. Constructor takes a `HTMLCanvasElement` (or a canvas-like context for testing). The class has a `render(state: VisualizerState): void` method that draws the full scene. Drawing is organized into layers: (1) rooms — rectangles with names, positioned in a grid or auto-layout based on connections, with connection lines for doors; (2) objects — icons within rooms, positioned by type-based layout, with state text below (e.g., "Water: 5"); (3) agents — avatars (circles with initials) positioned within their current room, with name labels, drive bars (five horizontal bars below the avatar, colored by urgency), PPER phase indicator (colored ring around avatar: blue=perceive, yellow=plan, orange=execute, purple=reflect), thought bubble showing `currentPlan.description` if present; (4) relationship lines — thin lines between agent avatars with trust-based opacity. No external dependencies — uses only the Canvas 2D API (`getContext('2d')`, `fillRect`, `fillText`, `arc`, `moveTo`, `lineTo`, etc.).

13. **`VisualizerServer` class** — Create `packages/visualizer/src/server/visualizer-server.ts` exporting a `VisualizerServer` class. Constructor takes `{ adapter: VisualizerInterface; port: number; scenes: Map<string, SceneDefinition> }`. The server uses Node.js `http` module to serve a single HTML page (with inline CSS and JS that imports the `CanvasRenderer`) at `GET /`. It upgrades WebSocket connections at the same port using the `ws` protocol handshake implemented manually (parse the `Sec-WebSocket-Key` header, compute `Sec-WebSocket-Accept` using `crypto.createHash('sha1')`, send the handshake response). Once connected, the server pushes `VisualizerState` snapshots at a configurable rate (default: 10 FPS via `setInterval`) by calling `adapter.getSnapshot()` and sending the JSON-serialized state as a WebSocket text frame. Incoming WebSocket messages are parsed as `VisualizerCommand` JSON and passed to `adapter.handleCommand()`. The `selectScene` command requires the `scenes` map to look up the `SceneDefinition` by ID — the adapter's `handleCommand` receives the scene definition alongside the command (the server resolves the scene ID to a `SceneDefinition` before calling the adapter).

14. **WebSocket frame encoding** — The `VisualizerServer` must implement basic WebSocket frame encoding/decoding (text frames only, no binary, no fragmentation, no compression). This is ~50 lines of code using Node.js `Buffer` operations. No external `ws` library — the issue specifies "no external deps." The server handles: opcode 0x1 (text), masking/unmasking client frames, and constructing server-to-client text frames (unmasked, per RFC 6455). Ping/pong frames (opcode 0x9/0xA) are handled for keepalive. Close frames (opcode 0x8) trigger connection cleanup.

15. **HTML page** — The server serves a single HTML page at `GET /` containing: a `<canvas>` element (full viewport), CSS for layout (dark background, centered canvas), and a `<script>` tag that: (a) opens a WebSocket to `ws://<host>:<port>/`, (b) on message, parses the `VisualizerState` JSON and calls `CanvasRenderer.render(state)`, (c) renders control buttons (play, pause, speed 1×/2×/5×, save, load, scene selector dropdown) in an overlay div, (d) on button click, sends the appropriate `VisualizerCommand` JSON over the WebSocket. The `CanvasRenderer` code is bundled inline in the script (no separate JS file to serve, no build step required). The scene selector dropdown is populated from the initial `VisualizerState` or a separate `scenes` list sent on connection.

16. **`start()` and `stop()` methods on `VisualizerServer`** — The server has a `start(): Promise<void>` method that begins listening on the configured port and a `stop(): Promise<void>` method that closes the HTTP server and all WebSocket connections. The snapshot push interval is cleared on stop.

17. **Public exports** — `packages/visualizer/src/index.ts` exports `CanvasRenderer` and `VisualizerServer`. This is the public API of the package.

### Example Integration (`examples/`)

18. **`visualizer-demo.ts` entry point** — Create `examples/visualizer-demo.ts` that: (a) builds an engine core + PPER orchestrator using the same pattern as `examples/minimal-scene.ts` (mock LLM or real LLM based on `USE_REAL_LLM` env var), (b) creates a `VisualizerDataAdapter` with the engine core + orchestrator + persistence, (c) creates a `VisualizerServer` with the adapter and a map of the three built-in scenes (minimal, morning-routine, coffee-shop — imported from their respective example files or defined inline), (d) calls `server.start()` and logs the URL, (e) keeps the process alive until `Ctrl+C`. This is the runnable demo: `npx tsx examples/visualizer-demo.ts` starts the server, and the user opens `http://localhost:<port>/` in a browser to see the visualization.

## Acceptance Criteria

- [ ] AC-1: `VisualizerState` and all sub-types (`VisualizerRoom`, `VisualizerObject`, `VisualizerAgent`, `VisualizerCommand`, `VisualizerInterface`) are defined in `packages/shared/src/types/visualizer.ts` and exported from `packages/shared/src/index.ts`. A type test confirms `VisualizerState` is JSON-serializable (all fields are `string | number | boolean | null | array | plain object`).
- [ ] AC-2: `GameLoopImpl.setTimeScale(2)` causes the simulation to advance simulation time at 2× the real-time rate. A test calls `setTimeScale(2)`, injects 1 second of elapsed time via `injectElapsed(1.0)`, and asserts `simulationTime` increased by `2.0` seconds (within tolerance). `setTimeScale(1)` produces 1:1 behavior (existing tests still pass).
- [ ] AC-3: `GameLoopImpl.isRunning()` returns `true` after `start()` and `false` after `stop()`. A test calls `start()`, asserts `isRunning() === true`, calls `stop()`, asserts `isRunning() === false`.
- [ ] AC-4: `VisualizerDataAdapter.getSnapshot()` returns a `VisualizerState` containing all rooms from `SceneManagerImpl.getAllRooms()`, all active agents from `AgentManagerImpl.getActiveAgents()`, the correct PPER phase from `orchestrator.getPhase()` for each agent, the correct `timeScale` from `gameLoop.getTimeScale()`, and the correct `isRunning` from `gameLoop.isRunning()`. A test with a mock engine core + mock orchestrator verifies each field.
- [ ] AC-5: `VisualizerDataAdapter.handleCommand({ type: 'play' })` calls `gameLoop.start()`. `handleCommand({ type: 'pause' })` calls `gameLoop.stop()`. `handleCommand({ type: 'setSpeed', timeScale: 5 })` calls `gameLoop.setTimeScale(5)`. Each is verified in a unit test with a spy/mock `GameLoopImpl`.
- [ ] AC-6: `VisualizerDataAdapter.handleCommand({ type: 'save' })` calls `persistence.saveToString()` and returns the JSON string. `handleCommand({ type: 'load', stateJson: '...' })` calls `persistence.loadFromString('...')`. Each is verified with a mock `EnginePersistence`.
- [ ] AC-7: `CanvasRenderer.render(state)` draws rooms as labeled rectangles, objects as icons within rooms with state text, agents as avatars with name labels within their room, drive bars (five bars per agent), and PPER phase indicator (colored ring). A test with a mock canvas context (recording all draw calls) verifies that `render()` produces draw calls for: at least one `fillRect` per room, at least one `arc` per agent, at least one `fillText` per agent name, and drive bar fill calls.
- [ ] AC-8: `CanvasRenderer.render(state)` draws relationship lines between agents that have relationships. A test with two agents in the same room with a relationship entry verifies that `moveTo`/`lineTo`/`stroke` calls are made connecting the two agent positions.
- [ ] AC-9: `VisualizerServer` starts an HTTP server on the configured port, responds to `GET /` with an HTML page containing a `<canvas>` element, and upgrades WebSocket connections. A test connects to the server, performs the WebSocket handshake, and verifies the response includes `Sec-WebSocket-Accept` header.
- [ ] AC-10: `VisualizerServer` pushes `VisualizerState` snapshots over WebSocket at the configured rate. A test connects, receives a text frame, parses it as JSON, and verifies it contains `tickNumber`, `rooms`, `agents`, `isRunning`, and `timeScale` fields.
- [ ] AC-11: `VisualizerServer` receives `VisualizerCommand` JSON over WebSocket and passes it to `adapter.handleCommand()`. A test sends `{"type":"pause"}` over the WebSocket, and verifies the adapter's `handleCommand` was called with `{ type: 'pause' }`.
- [ ] AC-12: `VisualizerServer` handles `selectScene` commands by looking up the scene ID in the `scenes` map. A test sends `{"type":"selectScene","sceneId":"minimal"}` and verifies the adapter receives the resolved `SceneDefinition`.
- [ ] AC-13: `examples/visualizer-demo.ts` starts without errors, creates an engine core, visualizer adapter, and server, and logs a URL. A smoke test (or manual verification) confirms the server is listening and `GET /` returns HTML.
- [ ] AC-14: All existing tests pass (`pnpm test`). The visualizer is purely additive — no existing engine, cognition, or memory behavior changes. The only engine modification is the `timeScale` field and `isRunning()` method on `GameLoopImpl`, both backward-compatible (defaults preserve existing behavior).
- [ ] AC-15: The `@evol-hive/visualizer` package has zero runtime dependencies (only `@evol-hive/shared` as a workspace dependency). `package.json` `dependencies` contains only `@evol-hive/shared`. No `ws`, `express`, or any third-party packages.
- [ ] AC-16: `VisualizerServer.stop()` closes the HTTP server and all WebSocket connections and clears the snapshot interval. A test starts the server, connects a WebSocket, calls `stop()`, and verifies the connection is closed and the port is released.

## Constraints
- **Package boundaries (ADR-0001):** The `@evol-hive/visualizer` package may import from `@evol-hive/shared` only. It must NOT import from `@evol-hive/engine`, `@evol-hive/cognition`, or `@evol-hive/memory`. The engine-side `VisualizerDataAdapter` lives in `@evol-hive/engine` and imports from `@evol-hive/shared` (for types) and its own internal subsystems. This preserves the acyclic dependency graph: `shared ← visualizer`, `shared ← engine`.
- **No external dependencies in the visualizer package:** The canvas renderer uses the browser's Canvas 2D API. The HTTP server uses Node.js built-in `http` module. The WebSocket implementation is hand-rolled (RFC 6455 frame encoding/decoding using `Buffer` and `crypto`). No `ws`, `socket.io`, `express`, `pixi.js`, `three.js`, or any third-party packages.
- **No engine behavior changes:** The `timeScale` addition to `GameLoopImpl` is backward-compatible (default `1`). The `isRunning()` method is a read-only getter. No existing engine system, game loop behavior, PPER cycle, or persistence logic is modified. Existing tests must pass unchanged.
- **Snapshot is read-only:** The `VisualizerState` snapshot is a one-way data flow: engine → adapter → server → browser. The browser sends commands via `VisualizerCommand`, which are handled by the adapter. The visualizer never directly mutates engine state objects.
- **Snapshot rate:** The default snapshot push rate is 10 FPS (every 100ms). This is configurable via the `VisualizerServer` constructor. The rate must not exceed the engine's tick rate (60 FPS) — there is no benefit to pushing snapshots faster than the simulation advances.
- **Canvas 2D, not WebGL:** The issue title mentions "canvas/WebGL" but the 2D top-down view does not benefit from GPU shaders. Canvas 2D has universal browser support, simpler API, and zero dependencies. WebGL would add complexity without visual benefit for a 2D top-down renderer.
- **Scene auto-layout:** Room positioning uses a simple grid or force-directed layout computed in the renderer. No external layout library. The layout algorithm can be naive for the prototype (grid placement with connection lines) — sophisticated auto-layout is a future concern.
- **What NOT to do:**
  - Do NOT add the visualizer as an `EngineSystem` that runs inside the game loop. The visualizer runs in a separate process (browser) and communicates via WebSocket. Adding it as an engine system would couple the engine to the visualizer and block the game loop on network I/O.
  - Do NOT modify `SaveState` or `GameLoopSnapshot` to include `timeScale`. Speed is a runtime control, not simulation state. It should not persist across save/load.
  - Do NOT implement pathfinding or animation for agent movement between rooms. Agents teleport between rooms (existing behavior). The visualizer shows the current state, not transitions.
  - Do NOT add a build step or bundler to the visualizer package. The HTML page served by the server contains inline JS — no webpack, no vite, no esbuild. The `CanvasRenderer` class is serialized as a string template in the server code (or served as a separate `.js` file from the package source).
