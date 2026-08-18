# Feature: Persistence — Save/Load Game State and Agent Memory Across Sessions

## Context
- Architecture: [§2 — System Overview](../architecture/02-system-overview.md) (package boundaries, system structure), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (AgentInternalState, AgentProfile, AgentDrives, AgentPlan — all must be serializable), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (MemoryNode, VectorStore — memory persistence across sessions), [§6 — PPER Loop](../architecture/06-pper-loop.md) (Reflect stores memories, plans, goals — all must survive restarts)
- Related specs: [004 — Reflect Phase](004-reflect-phase.md) (MemoryStore, MemoryStoreImpl, MemoryEntryInput — memory nodes stored during Reflect), [005 — Game Loop Integration](005-game-loop-integration.md) (EngineCore, assembleGameLoop, loadScene, GameLoopImpl — engine assembly), [012 — Agent Persona System](012-agent-persona-system.md) (AgentProfile persona fields must persist), [014 — Memory Consolidation, Decay & Retrieval](014-memory-consolidation-decay-retrieval.md) (InMemoryVectorStore, MemoryNode.lastAccessed, consolidated memories must survive restarts), [013 — Richer Prototype Scenes](013-richer-prototype-scenes.md) (SceneDefinition, loadScene — scene loading pattern to follow)
- Package: `shared` (save/load format types), `memory` (VectorStore export/import), `engine` (EnginePersistence implementation, save/load API, auto-save system)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#61](https://github.com/Redna/evol-hive/issues/61)

## Design Rationale

When the simulation stops, all in-memory state is lost — agent memories, plans, drives, object states, and positions. The agent starts fresh every run with no memory of past experiences. This spec defines a serialization format and a save/load API that captures the full game state (agents, world, memory) as a single JSON object, restores it on load, and optionally auto-saves at a configurable tick interval.

The approach is straightforward: each subsystem (`AgentManagerImpl`, `SmartObjectRegistryImpl`, `SceneManagerImpl`, `GameLoopImpl`, `InMemoryVectorStore`) already holds its state in in-memory `Map`s. We add `exportState()`/`importState()` methods to each subsystem, compose them into a single `SaveState` object at the engine level, and provide `engine.save()` / `engine.load()` convenience methods. File I/O is a thin wrapper using Node.js `fs/promises`. No new packages, no new architectural concepts — just serialization of existing data.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`SaveState` interface** — A new interface `SaveState` must be defined in `packages/shared/src/types/persistence.ts` and exported from `packages/shared/src/index.ts`. This is the top-level serializable object representing the full game state at a point in time:
   ```typescript
   interface SaveState {
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
   ```
   This is a pure data interface — no methods, no class hierarchy. It must be serializable via `JSON.stringify` with no replacer function (all fields are plain JSON-compatible types: strings, numbers, booleans, arrays, and plain objects). The `embeddings` inside `MemoryNode[]` are `number[]` arrays — these are JSON-serializable.

2. **`GameLoopSnapshot` interface** — A new interface `GameLoopSnapshot` must be defined in `packages/shared/src/types/persistence.ts`:
   ```typescript
   interface GameLoopSnapshot {
     tickNumber: number;
     simulationTime: number;
     deltaSeconds: number;
   }
   ```
   This captures the `GameLoopImpl`'s deterministic state: the current tick counter, simulation time, and the fixed delta. On load, the `GameLoopImpl` restores `tickNumber` and `simulationTime` from this snapshot (the `deltaSeconds` is derived from `config.fps` and is stored for informational/debugging purposes only — it is not restored because it is a construction-time constant).

3. **`AgentSnapshot` interface** — A new interface `AgentSnapshot` must be defined in `packages/shared/src/types/persistence.ts`:
   ```typescript
   interface AgentSnapshot {
     /** The agent's immutable profile (identity, persona, initial drives). */
     profile: AgentProfile;
     /** The agent's mutable internal state (drives, goal, plan, location, etc.). */
     state: AgentInternalState;
   }
   ```
   This bundles the `AgentProfile` and `AgentInternalState` together for each agent. On load, `AgentManagerImpl.importState()` calls `spawn(profile)` (to register the profile) then `updateState(agentId, state)` (to overwrite the spawn-initialized state with the saved state). This ensures the profile is registered and the state is exactly as saved.

4. **`WorldSnapshot` interface** — A new interface `WorldSnapshot` must be defined in `packages/shared/src/types/persistence.ts`:
   ```typescript
   interface WorldSnapshot {
     rooms: Room[];
     objects: SmartObject[];
   }
   ```
   This captures the full world: rooms (with connections and objectIds) and smart objects (with their current `state`, affordances, and `roomId`). On load, `SceneManagerImpl` is reconstructed from `rooms`, and `SmartObjectRegistryImpl` is populated from `objects`. The objects include their current runtime state (e.g., `{ water_level: "low", bean_count: 5 }`) — not the initial scene definition state.

5. **`SAVE_FORMAT_VERSION` constant** — A new constant `SAVE_FORMAT_VERSION` must be defined in `packages/shared/src/types/persistence.ts`:
   ```typescript
   const SAVE_FORMAT_VERSION = 1;
   ```
   This is the current save format version. When the `SaveState` format changes in a breaking way, this is incremented and a migration function is added (future concern). For this spec, version 1 is the only version. The `save()` method writes this constant; `load()` checks it and throws `SaveFormatVersionError` if the version is not supported.

6. **`SaveFormatVersionError` error class** — A new error class `SaveFormatVersionError` must be defined in `packages/shared/src/types/persistence.ts`, extending `Error`:
   ```typescript
   class SaveFormatVersionError extends Error {
     readonly expected: number;
     readonly actual: number;
     constructor(expected: number, actual: number) {
       super(`Save format version mismatch: expected ${expected}, got ${actual}`);
       this.name = 'SaveFormatVersionError';
      this.expected = expected;
      this.actual = actual;
    }
   }
   ```
   This is thrown by `load()` when the `formatVersion` in the loaded JSON does not match `SAVE_FORMAT_VERSION`. It is a fatal error — no partial loading is attempted. The caller is expected to handle this (e.g., by starting a fresh simulation or prompting the user).

7. **`AutoSaveConfig` interface** — A new interface `AutoSaveConfig` must be defined in `packages/shared/src/types/persistence.ts`:
   ```typescript
   interface AutoSaveConfig {
     /** Enable periodic auto-save. Default: false. */
     enabled: boolean;
     /** Auto-save every N engine ticks. Default: 600 (10 seconds at 60 FPS). */
     intervalTicks: number;
     /** File path for auto-saves. If omitted, auto-save is in-memory only (no file write). */
     filePath?: string;
   }
   ```
   This configures the optional `AutoSaveSystem` (Req 16). The `intervalTicks` controls how often the auto-save fires — it is not every tick (that would be too frequent). The `filePath` is optional: if provided, auto-saves are written to disk; if omitted, the save state is only held in memory (useful for testing or crash-recovery within the same process).

8. **`defaultAutoSaveConfig` constant** — A new constant `defaultAutoSaveConfig` must be defined in `packages/shared/src/types/persistence.ts`:
   ```typescript
   const defaultAutoSaveConfig: AutoSaveConfig = {
     enabled: false,
     intervalTicks: 600,
   };
   ```
   Auto-save is disabled by default — the simulation does not auto-save unless the caller explicitly enables it.

### Memory Layer (`@evol-hive/memory`)

9. **`VectorStore.exportAll()` method** — The existing `VectorStore` interface in `packages/memory/src/index.ts` must be extended with a new method: `exportAll(): Promise<MemoryNode[]>`. This returns all `MemoryNode` objects stored in the vector store, regardless of `agentId`. The order of results is unspecified. This is the memory serialization entry point: the engine's `save()` method calls `vectorStore.exportAll()` to get all memory nodes for the `SaveState.memories` field. The returned nodes are copies (not references to internal storage) — mutating them does not affect the store.

10. **`VectorStore.importAll()` method** — The existing `VectorStore` interface must be extended with a new method: `importAll(nodes: MemoryNode[]): Promise<void>`. This clears all existing nodes from the store and replaces them with the provided `nodes`. Each node is stored via the existing `store()` method (which copies the node). If a node in the array has the same `id` as an existing node (after the clear, this is impossible — but if `importAll` is called without clearing in a subclass, the later node wins). The `importAll` method must: (a) call `delete([...currentIds])` or clear the internal map, then (b) call `store(node)` for each node in the array. The embeddings are preserved as-is from the saved nodes — no re-embedding is performed. This is the memory deserialization entry point: the engine's `load()` method calls `vectorStore.importAll(saveState.memories)` to restore all memory nodes.

11. **`InMemoryVectorStore.exportAll()` implementation** — The `InMemoryVectorStore` class in `packages/memory/src/store/in-memory-vector-store.ts` must implement `exportAll()` by returning copies of all values in its internal `Map<string, MemoryNode>`. The implementation must return `[...this.nodes.values()].map(n => ({ ...n }))` to ensure the caller receives copies, not references to internal storage.

12. **`InMemoryVectorStore.importAll()` implementation** — The `InMemoryVectorStore` class must implement `importAll(nodes: MemoryNode[])` by: (a) clearing the internal `this.nodes` map (`this.nodes.clear()`), then (b) calling `this.nodes.set(node.id, { ...node })` for each node in the array. This is equivalent to clearing and then storing each node, but optimized to avoid individual `store()` calls. The embeddings are stored as-is (they are `number[]` arrays, already JSON-deserialized).

### Engine Layer (`@evol-hive/engine`)

13. **`EnginePersistence` interface** — A new interface `EnginePersistence` must be defined in `packages/engine/src/index.ts`:
    ```typescript
    interface EnginePersistence {
      /** Serialize the full game state to a SaveState object. */
      save(): Promise<SaveState>;
      /** Restore the full game state from a SaveState object. */
      load(state: SaveState): Promise<void>;
      /** Serialize the full game state to a JSON string. */
      saveToString(): Promise<string>;
      /** Restore the full game state from a JSON string. */
      loadFromString(json: string): Promise<void>;
      /** Serialize the full game state to a file on disk. */
      saveToFile(path: string): Promise<void>;
      /** Restore the full game state from a file on disk. */
      loadFromFile(path: string): Promise<void>;
    }
    ```
    This is the public save/load API. The `save()` / `load()` methods work with `SaveState` objects (structured). The `saveToString()` / `loadFromString()` methods work with JSON strings (convenience for in-process usage). The `saveToFile()` / `loadFromFile()` methods work with files on disk (convenience for session persistence). All methods are `async` because the `VectorStore` methods are async.

14. **`EnginePersistenceImpl` concrete implementation** — A concrete `EnginePersistenceImpl` class must be implemented in `packages/engine/src/persistence/engine-persistence.ts`, exported from `packages/engine/src/persistence/index.ts` and `packages/engine/src/index.ts`. It accepts `EnginePersistenceOptions` via constructor injection:
    ```typescript
    interface EnginePersistenceOptions {
      gameLoop: GameLoopImpl;
      agentManager: AgentManagerImpl;
      smartObjectRegistry: SmartObjectRegistryImpl;
      sceneManager: SceneManagerImpl;
      vectorStore: VectorStore;
    }
    ```
    The `save()` method must:
    - Call `gameLoop.currentTick()` to get the `GameLoopSnapshot` (tickNumber, simulationTime, deltaSeconds).
    - For each agent from `agentManager.getActiveAgents()`:
      - Get the state via `agentManager.getState(agent.agentId)`.
      - Get the profile via `agentManager.getProfile(agent.agentId)`.
      - If the profile is `null` (should not happen for active agents, but defensive), skip this agent.
      - Create an `AgentSnapshot { profile, state }`.
    - Get all rooms from `sceneManager` — the `SceneManagerImpl` must expose a `getAllRooms(): Room[]` method (Req 15) for this purpose.
    - Get all objects from `smartObjectRegistry` — the `SmartObjectRegistryImpl` must expose a `getAllObjects(): SmartObject[]` method (Req 15) for this purpose.
    - Build `WorldSnapshot { rooms, objects }`.
    - Call `vectorStore.exportAll()` to get all memory nodes.
    - Build and return a `SaveState` with `formatVersion: SAVE_FORMAT_VERSION`, `savedAt: Date.now()`, `gameLoop`, `agents`, `world`, and `memories`.

    The `load(state: SaveState)` method must:
    - Check `state.formatVersion === SAVE_FORMAT_VERSION`. If not, throw `SaveFormatVersionError(SAVE_FORMAT_VERSION, state.formatVersion)`.
    - Stop the game loop if it is running (`gameLoop.stop()`).
    - Restore the game loop state: set `tickNumber` and `simulationTime` on the `GameLoopImpl`. The `GameLoopImpl` must expose a `restoreState(tickNumber: number, simulationTime: number): void` method (Req 15).
    - Clear and rebuild agent state: for each `AgentSnapshot` in `state.agents`:
      - Call `agentManager.spawn(snapshot.profile)` (registers the profile).
      - Call `agentManager.updateState(snapshot.profile.id, snapshot.state)` (overwrites spawn-initialized state with saved state).
    - Clear and rebuild the world:
      - Create a new `Map<string, Room>` from `state.world.rooms` and reconstruct the `SceneManagerImpl` via a `restoreRooms(rooms: Map<string, Room>): void` method (Req 15).
      - For each object in `state.world.objects`, call `smartObjectRegistry.register(object)` (which replaces any existing object with the same ID).
    - Clear and rebuild memory: call `vectorStore.importAll(state.memories)`.
    - The `load()` method does NOT restart the game loop — the caller decides whether to call `gameLoop.start()`.

    The `saveToString()` method must call `save()` and return `JSON.stringify(state, null, 2)` (pretty-printed for human readability — the file size overhead is negligible for the prototype scale).

    The `loadFromString(json: string)` method must `JSON.parse(json)` into a `SaveState` object and call `load(state)`. If the JSON is invalid, the `JSON.parse` error propagates (the caller handles it).

    The `saveToFile(path: string)` method must call `saveToString()` and write the result to `path` using `fs.promises.writeFile(path, json, 'utf8')`. This uses Node.js's built-in `fs/promises` module — no new dependencies.

    The `loadFromFile(path: string)` method must read the file at `path` using `fs.promises.readFile(path, 'utf8')` and call `loadFromString(content)`. If the file does not exist, the `fs` error propagates.

15. **Subsystem export/import methods** — The following internal methods must be added to existing engine subsystems to support serialization:
    - **`GameLoopImpl.restoreState(tickNumber: number, simulationTime: number): void`** — Sets the internal `tickNumber` and `simulationTime` fields and updates `currentGameTick`. The loop must not be running when this is called (the caller, `EnginePersistenceImpl.load()`, stops the loop first). If the loop is running, `restoreState` logs a warning and proceeds anyway (defensive — but the caller should stop the loop first).
    - **`SceneManagerImpl.getAllRooms(): Room[]`** — Returns all rooms as an array: `[...this.rooms.values()]`. This is a read-only method used by `save()`.
    - **`SceneManagerImpl.restoreRooms(rooms: Map<string, Room>): void`** — Replaces the internal `rooms` map with the provided map. This is used by `load()` to rebuild the world from the saved rooms. The existing `agentManager` reference is preserved (the `SceneManagerImpl` constructor binds to an `AgentManager`, and `restoreRooms` does not change that binding).
    - **`SmartObjectRegistryImpl.getAllObjects(): SmartObject[]`** — Returns all objects as an array: `[...this.objects.values()]`. This is a read-only method used by `save()`.
    - These methods are internal to the engine package — they are not part of the public `EnginePersistence` interface. They are exported from their respective modules but are primarily consumed by `EnginePersistenceImpl`.

16. **`AutoSaveSystem` engine system** — A new `AutoSaveSystem` class must be implemented in `packages/engine/src/systems/auto-save.ts`, exported from `packages/engine/src/index.ts`. It must implement the `EngineSystem` interface. It accepts `AutoSaveSystemOptions` via constructor injection:
    ```typescript
    interface AutoSaveSystemOptions {
      persistence: EnginePersistence;
      config: AutoSaveConfig;
    }
    ```
    The `name` property is `'auto-save'`. The `update(tick: GameTick)` method must:
    - If `!config.enabled`, return immediately (no-op).
    - Increment an internal tick counter.
    - If `tickCounter % config.intervalTicks === 0` and `tickCounter > 0`:
      - If `config.filePath` is provided, call `persistence.saveToFile(config.filePath)` (fire-and-forget — `.catch()` to log errors, matching the `PPERScheduler` pattern).
      - If `config.filePath` is not provided, call `persistence.save()` (fire-and-forget — the result is not stored; this is useful for testing that auto-save fires).
    - The `update` method is synchronous and never awaits — it fire-and-forgets the save operation. This ensures the game loop is never blocked by serialization. Multiple overlapping saves (if a save takes longer than `intervalTicks`) are acceptable — the later save overwrites the earlier one's file.

17. **Assembly integration** — The `createEngineCore` function in `packages/engine/src/assembly.ts` must be extended to accept an optional `persistence` configuration parameter. The `EngineCore` interface must be extended to include:
    ```typescript
    persistence?: EnginePersistenceImpl;
    autoSaveConfig?: AutoSaveConfig;
    ```
    If a `VectorStore` is provided to `createEngineCore` (it already accepts an optional `MemoryStore`), the `EnginePersistenceImpl` is constructed and stored on `EngineCore.persistence`. If no `VectorStore` is available (e.g., minimal test setups with `NullMemoryStore`), `persistence` is not set — save/load is not available (calling `save()` on a null persistence throws).

18. **`assembleGameLoop` auto-save registration** — The `assembleGameLoop` function must be extended to accept an optional `autoSave` parameter:
    ```typescript
    assembleGameLoop(
      core: EngineCore,
      orchestrator: PPEROrchestratorPort,
      memoryMaintenance?: { ... },
      autoSave?: { config: AutoSaveConfig },
    ): GameLoop
    ```
    If `autoSave?.config.enabled` is `true` AND `core.persistence` is set, the `AutoSaveSystem` is registered as the last engine system (after `MemoryMaintenanceSystem` if present, otherwise after `PPERScheduler`). If `core.persistence` is not set but auto-save is enabled, a warning is logged and auto-save is not registered. The `AutoSaveSystem` is the lowest-priority system — it runs after all gameplay and cognition systems.

19. **`EngineCore` persistence access** — The `EngineCore` interface must expose the `persistence` field so the application entry point can call `core.persistence.saveToFile('save.json')` or wire it into a CLI. The `createEngine` convenience function must also expose `persistence` on the returned `AssembledEngine` interface:
    ```typescript
    interface AssembledEngine {
      gameLoop: GameLoop;
      agentManager: AgentManagerImpl;
      sceneManager: SceneManagerImpl;
      smartObjectRegistry: SmartObjectRegistryImpl;
      affordanceRegistry: AffordanceRegistryImpl;
      bridges: EngineCore['bridges'];
      persistence?: EnginePersistenceImpl;
    }
    ```

### Cross-Cutting

20. **Package boundaries** (per ADR-0001) — The `SaveState`, `GameLoopSnapshot`, `AgentSnapshot`, `WorldSnapshot`, `AutoSaveConfig`, `SaveFormatVersionError`, and `SAVE_FORMAT_VERSION` are defined in `@evol-hive/shared` because both `engine` (implements save/load) and the application entry point (calls save/load) need them. The `VectorStore.exportAll` and `VectorStore.importAll` methods are defined in `@evol-hive/memory` (on the interface) and implemented in `InMemoryVectorStore`. The `EnginePersistence` interface and `EnginePersistenceImpl` are in `@evol-hive/engine`. The `AutoSaveSystem` is in `@evol-hive/engine`. No new cross-package dependencies are introduced — `engine` already imports from `shared` and `memory`.

21. **Save/load is a full snapshot, not incremental** — The `save()` method captures the entire game state at a single point in time. There is no incremental save, delta, or append-only log. The save is atomic from the caller's perspective: `save()` returns a `SaveState` that represents a consistent snapshot. The `load()` method restores the full state, replacing any existing state — it is a destructive operation that clears all current agents, world objects, rooms, and memories before restoring from the save. The caller must not call `load()` while the game loop is running (the implementation stops the loop, but the caller should also not be modifying state concurrently).

22. **Memory embeddings are preserved as-is** — The `MemoryNode.embedding` field (a `number[]` array) is serialized as-is in the JSON. On load, the embeddings are restored from the JSON — no re-embedding is performed. This is critical for session continuity: re-embedding would produce different vectors (due to model nondeterminism or different model versions), breaking cosine similarity comparisons. The embeddings are the ground truth, stored at creation time by the `EmbeddingProvider`, and preserved across save/load cycles.

23. **Consolidated memories survive restarts** — The `SaveState.memories` array includes ALL memory nodes: raw observations, actions, interactions, AND consolidated reflections (created by `ReflectionLoopImpl.runReflection`, spec 014). The `importance` and `lastAccessed` fields are preserved, so the decay computation (spec 014) continues correctly after load. Deprioritized original nodes (with halved importance) are also preserved — the save/load is a faithful copy of the vector store's contents.

24. **Agent plans and goals survive restarts** — The `AgentInternalState.currentPlan` (an `AgentPlan` with steps, current step index, and creation time) and `currentGoal` are part of `AgentSnapshot.state`. On load, `updateState()` restores them as-is. The agent continues executing its plan from the saved `currentStepIndex` — no plan reset or re-evaluation is performed. The `isThinking` flag is saved as-is, but the PPER scheduler will naturally re-trigger a PPER cycle for the agent on the next tick if `isThinking` is `true` (the saved LLM call's response is lost, but the scheduler will retry). This is acceptable — the agent re-enters the Perceive phase and re-plans.

25. **Agent persona survives restarts** — The `AgentProfile` (including persona fields from spec 012: backstory, longTermGoals, behavioralTendencies, speechStyle, relationships) is saved in `AgentSnapshot.profile`. On load, `spawn(profile)` re-registers the profile. The persona is preserved exactly — no persona drift or evolution (consistent with spec 012, Req 22: persona is immutable).

26. **Object state survives restarts** — The `SmartObject.state` field (e.g., `{ water_level: "low", bean_count: 5 }`) is saved in `WorldSnapshot.objects`. On load, `smartObjectRegistry.register(object)` restores the object with its saved state — not the initial scene state. This means if the coffee machine was used and its water level dropped, the saved state reflects that. The `affordances` array is also saved (it includes preconditions and effects, which are static — but saving them is simpler than separating static and dynamic state, and the JSON size is negligible for the prototype scale).

27. **Versioning and forward compatibility** — The `SAVE_FORMAT_VERSION` constant is `1` for this spec. The `load()` method checks `state.formatVersion === SAVE_FORMAT_VERSION` and throws `SaveFormatVersionError` if it doesn't match. Future format changes will increment this version and add migration functions (not in scope for this spec). The caller catches `SaveFormatVersionError` and decides what to do (start fresh, prompt the user, etc.). Unknown fields in the JSON (forward-compatibility from newer versions) are ignored by `load()` — `JSON.parse` preserves them, but the `load()` method only reads known fields.

28. **`isThinking` flag on load** — When the game state is loaded, any agent with `isThinking: true` in the saved state will have that flag restored. The `PPERScheduler` checks `isThinking` to skip agents already in a PPER cycle. Since the LLM call from the previous session is lost, the agent will be stuck in `isThinking: true` forever unless the scheduler clears it. The `load()` method must set `isThinking: false` for all agents after restoring their state — this is done by calling `agentManager.updateState(agentId, { isThinking: false })` for each loaded agent. This ensures the agent re-enters the PPER cycle fresh on the next tick.

29. **What NOT to do**:
    - Do not implement incremental saves, delta encoding, or append-only logs — the save is a full snapshot.
    - Do not implement compression — the JSON is stored as pretty-printed text. For the prototype scale (a handful of agents, objects, and thousands of memory nodes), the file size is manageable.
    - Do not re-embed memory content on load — embeddings are preserved as-is from the save.
    - Do not implement a persistent vector store backend (LanceDB, ChromaDB) — this spec serializes the `InMemoryVectorStore` to JSON. A persistent backend is a separate future concern.
    - Do not modify the `AgentProfile`, `AgentInternalState`, `SmartObject`, `Room`, or `MemoryNode` interfaces — they are already JSON-serializable (all fields are plain types). This spec adds serialization infrastructure, not new data fields.
    - Do not implement save encryption — the save file is plain JSON. Encryption is a future concern for multiplayer or shared environments.
    - Do not auto-restart the game loop after `load()` — the caller decides whether to call `gameLoop.start()`.
    - Do not implement cross-session agent learning or behavioral adaptation — the saved state is a faithful copy; any "learning" is in the memory nodes and drives, which are preserved. No new learning mechanism is added.
    - Do not implement save file management (rotating saves, timestamps in filenames, save slots) — the caller manages file paths. The `saveToFile(path)` method writes to whatever path is given.
    - Do not add new npm dependencies — `fs/promises` is a Node.js built-in.

## Acceptance Criteria

- [ ] **AC-1**: `SaveState` interface is defined in `packages/shared/src/types/persistence.ts` and exported from `packages/shared/src/index.ts`. It includes `formatVersion: number`, `savedAt: number`, `gameLoop: GameLoopSnapshot`, `agents: AgentSnapshot[]`, `world: WorldSnapshot`, and `memories: MemoryNode[]`. *(Req 1)*
- [ ] **AC-2**: `GameLoopSnapshot` interface is defined in `packages/shared/src/types/persistence.ts` with `tickNumber: number`, `simulationTime: number`, and `deltaSeconds: number`. *(Req 2)*
- [ ] **AC-3**: `AgentSnapshot` interface is defined in `packages/shared/src/types/persistence.ts` with `profile: AgentProfile` and `state: AgentInternalState`. *(Req 3)*
- [ ] **AC-4**: `WorldSnapshot` interface is defined in `packages/shared/src/types/persistence.ts` with `rooms: Room[]` and `objects: SmartObject[]`. *(Req 4)*
- [ ] **AC-5**: `SAVE_FORMAT_VERSION` constant is defined in `packages/shared/src/types/persistence.ts` with value `1`. *(Req 5)*
- [ ] **AC-6**: `SaveFormatVersionError` class is defined in `packages/shared/src/types/persistence.ts`, extends `Error`, and has `expected` and `actual` number properties. *(Req 6)*
- [ ] **AC-7**: `AutoSaveConfig` interface is defined in `packages/shared/src/types/persistence.ts` with `enabled: boolean`, `intervalTicks: number`, and optional `filePath?: string`. *(Req 7)*
- [ ] **AC-8**: `defaultAutoSaveConfig` constant is defined in `packages/shared/src/types/persistence.ts` with `enabled: false` and `intervalTicks: 600`. *(Req 8)*
- [ ] **AC-9**: `VectorStore` interface in `packages/memory/src/index.ts` includes `exportAll(): Promise<MemoryNode[]>`. *(Req 9)*
- [ ] **AC-10**: `VectorStore` interface in `packages/memory/src/index.ts` includes `importAll(nodes: MemoryNode[]): Promise<void>`. *(Req 10)*
- [ ] **AC-11**: `InMemoryVectorStore.exportAll()` returns copies of all stored `MemoryNode` objects. Mutating a returned node does not affect the store. *(Req 11)*
- [ ] **AC-12**: `InMemoryVectorStore.importAll(nodes)` clears all existing nodes and stores copies of the provided nodes. After `importAll`, `exportAll()` returns the same nodes (deep equality). *(Req 12)*
- [ ] **AC-13**: `EnginePersistence` interface is defined in `packages/engine/src/index.ts` with `save()`, `load()`, `saveToString()`, `loadFromString()`, `saveToFile()`, and `loadFromFile()` methods. *(Req 13)*
- [ ] **AC-14**: `EnginePersistenceImpl` is defined in `packages/engine/src/persistence/engine-persistence.ts` and exported from `packages/engine/src/index.ts`. *(Req 14)*
- [ ] **AC-15**: `EnginePersistenceImpl.save()` returns a `SaveState` with `formatVersion: SAVE_FORMAT_VERSION`, `savedAt` set to the current time, and the correct game loop tick, agents, world, and memories. *(Req 14)*
- [ ] **AC-16**: `EnginePersistenceImpl.save()` includes all active agents — each `AgentSnapshot` has the agent's `profile` (from `getProfile`) and `state` (from `getState`). *(Req 14)*
- [ ] **AC-17**: `EnginePersistenceImpl.save()` includes all rooms (from `SceneManagerImpl.getAllRooms()`) and all objects (from `SmartObjectRegistryImpl.getAllObjects()`) in the `WorldSnapshot`. *(Req 14, Req 15)*
- [ ] **AC-18**: `EnginePersistenceImpl.save()` includes all memory nodes (from `vectorStore.exportAll()`) in the `SaveState.memories` field, including their embeddings. *(Req 14, Req 9)*
- [ ] **AC-19**: `EnginePersistenceImpl.load(state)` stops the game loop, restores `tickNumber` and `simulationTime` via `GameLoopImpl.restoreState()`, restores all agents via `spawn()` + `updateState()`, restores the world via `SceneManagerImpl.restoreRooms()` and `SmartObjectRegistryImpl.register()`, and restores memories via `vectorStore.importAll()`. *(Req 14, Req 15)*
- [ ] **AC-20**: `EnginePersistenceImpl.load(state)` throws `SaveFormatVersionError` when `state.formatVersion` does not equal `SAVE_FORMAT_VERSION`. *(Req 14, Req 6)*
- [ ] **AC-21**: `EnginePersistenceImpl.load(state)` sets `isThinking: false` for every loaded agent (clearing stale thinking state from the previous session). *(Req 28)*
- [ ] **AC-22**: `EnginePersistenceImpl.load(state)` does NOT call `gameLoop.start()` — the loop remains stopped after load. *(Req 14)*
- [ ] **AC-23**: `EnginePersistenceImpl.saveToString()` returns a pretty-printed JSON string of the `SaveState`. `loadFromString(json)` parses it and calls `load()`. A round-trip `loadFromString(saveToString())` restores the exact same state. *(Req 14)*
- [ ] **AC-24**: `EnginePersistenceImpl.saveToFile(path)` writes the JSON to the file at `path`. `loadFromFile(path)` reads the file and calls `loadFromString()`. A round-trip `loadFromFile(saveToFile())` restores the exact same state. *(Req 14)*
- [ ] **AC-25**: `GameLoopImpl.restoreState(tickNumber, simulationTime)` sets the internal `tickNumber` and `simulationTime` and updates `currentGameTick`. After `restoreState(42, 123.45)`, `currentTick()` returns `{ tickNumber: 42, simulationTime: 123.45, deltaSeconds: <existing> }`. *(Req 15)*
- [ ] **AC-26**: `SceneManagerImpl.getAllRooms()` returns all rooms as an array. *(Req 15)*
- [ ] **AC-27**: `SceneManagerImpl.restoreRooms(rooms)` replaces the internal room map. After `restoreRooms(newMap)`, `getRoom()` returns rooms from the new map. *(Req 15)*
- [ ] **AC-28**: `SmartObjectRegistryImpl.getAllObjects()` returns all objects as an array, including their current runtime state. *(Req 15)*
- [ ] **AC-29**: `AutoSaveSystem` is defined in `packages/engine/src/systems/auto-save.ts` and exported from `packages/engine/src/index.ts`. Its `name` is `'auto-save'`. *(Req 16)*
- [ ] **AC-30**: `AutoSaveSystem.update()` is a no-op when `config.enabled` is `false`. *(Req 16)*
- [ ] **AC-31**: `AutoSaveSystem.update()` calls `persistence.saveToFile(config.filePath)` every `intervalTicks` ticks when `enabled` is `true` and `filePath` is set (fire-and-forget). *(Req 16)*
- [ ] **AC-32**: `AutoSaveSystem.update()` calls `persistence.save()` every `intervalTicks` ticks when `enabled` is `true` and `filePath` is not set (fire-and-forget). *(Req 16)*
- [ ] **AC-33**: `AutoSaveSystem.update()` never awaits — the save operation is fire-and-forget with `.catch()` error logging. *(Req 16)*
- [ ] **AC-34**: `EngineCore` interface includes optional `persistence?: EnginePersistenceImpl` and `autoSaveConfig?: AutoSaveConfig` fields. *(Req 17, Req 19)*
- [ ] **AC-35**: `createEngineCore` constructs `EnginePersistenceImpl` when a `VectorStore` is provided. When no `VectorStore` is available, `persistence` is not set on `EngineCore`. *(Req 17)*
- [ ] **AC-36**: `assembleGameLoop` registers `AutoSaveSystem` as the last engine system when `autoSave.config.enabled` is `true` and `core.persistence` is set. When `core.persistence` is not set but auto-save is enabled, a warning is logged and no auto-save system is registered. *(Req 18)*
- [ ] **AC-37**: `AssembledEngine` interface includes optional `persistence?: EnginePersistenceImpl`. `createEngine` returns the `persistence` field. *(Req 19)*
- [ ] **AC-38**: After a full save → load round-trip, `agentManager.getActiveAgents()` returns the same agents with the same `AgentInternalState` (drives, currentGoal, currentPlan, location, lastPerceptionTick) as before the save. *(Req 21, Req 24)*
- [ ] **AC-39**: After a full save → load round-trip, `agentManager.getProfile(agentId)` returns the same `AgentProfile` (including persona fields) as before the save. *(Req 25)*
- [ ] **AC-40**: After a full save → load round-trip, `smartObjectRegistry.get(objectId).state` returns the same object state as before the save (not the initial scene state). *(Req 26)*
- [ ] **AC-41**: After a full save → load round-trip, `sceneManager.getRoom(roomId)` returns the same room (with connections and objectIds) as before the save. *(Req 21)*
- [ ] **AC-42**: After a full save → load round-trip, `vectorStore.exportAll()` returns the same memory nodes (including embeddings, importance, lastAccessed, type, timestamp) as before the save. *(Req 22, Req 23)*
- [ ] **AC-43**: After a full save → load round-trip, `gameLoop.currentTick().tickNumber` and `.simulationTime` match the values from before the save. *(Req 21)*
- [ ] **AC-44**: After a full save → load round-trip, all loaded agents have `isThinking: false` regardless of the saved `isThinking` value. *(Req 28)*
- [ ] **AC-45**: After a full save → load round-trip, consolidated memory nodes (created by `ReflectionLoopImpl.runReflection`) with reduced `importance` are preserved with their reduced importance values. *(Req 23)*
- [ ] **AC-46**: `EnginePersistenceImpl.load()` with an empty `SaveState` (no agents, no objects, no memories) clears all existing state and results in an empty simulation. *(Req 21)*
- [ ] **AC-47**: `EnginePersistenceImpl.save()` with no agents, no objects, and no memories returns a valid `SaveState` with empty `agents`, `world.rooms`, `world.objects`, and `memories` arrays. *(Req 14)*
- [ ] **AC-48**: `EnginePersistenceImpl` imports from `@evol-hive/shared` (for types) and `@evol-hive/memory` (for `VectorStore`). It does NOT import from `@evol-hive/cognition`. *(Req 20)*
- [ ] **AC-49**: `AutoSaveSystem` imports from `@evol-hive/shared` (for `AutoSaveConfig`, `GameTick`) and `@evol-hive/engine` (for `EnginePersistence`, `EngineSystem`). It does NOT import from `@evol-hive/cognition` or `@evol-hive/memory`. *(Req 20)*
- [ ] **AC-50**: `JSON.stringify(saveState)` produces valid JSON with no replacer function. `JSON.parse(jsonString)` produces an object assignable to `SaveState`. *(Req 1)*
- [ ] **AC-51**: `EnginePersistenceImpl.loadFromString("not valid json")` throws a `SyntaxError` (from `JSON.parse`). The error is not swallowed. *(Req 14)*
- [ ] **AC-52**: `EnginePersistenceImpl.loadFromFile("nonexistent.json")` throws an `Error` (from `fs.readFile`). The error is not swallowed. *(Req 14)*
- [ ] **AC-53**: `SaveFormatVersionError` is thrown by `load()` when `formatVersion` is `0` (or any value other than `1`). The error's `expected` is `1` and `actual` is the received version. *(Req 6, Req 14)*
- [ ] **AC-54**: `EnginePersistenceImpl.saveToFile(path)` writes a file that contains `"formatVersion": 1` and `"savedAt":` followed by a number. *(Req 14, Req 5)*
- [ ] **AC-55**: A simulation with 2 agents, 3 rooms, 5 objects, and 20 memory nodes can be saved and loaded. After load, the simulation has 2 agents, 3 rooms, 5 objects, and 20 memory nodes with all state preserved. *(Req 21, Req 22, Req 23, Req 24, Req 25, Req 26)*

## Constraints

- **Package boundaries** (per ADR-0001): `shared` owns the save format types (`SaveState`, snapshots, `AutoSaveConfig`, `SAVE_FORMAT_VERSION`, `SaveFormatVersionError`). `memory` owns the `VectorStore.exportAll` / `importAll` interface methods and `InMemoryVectorStore` implementations. `engine` owns `EnginePersistence`, `EnginePersistenceImpl`, `AutoSaveSystem`, and subsystem export/import methods. No new cross-package dependencies: `engine` already imports from `shared` and `memory`.
- **Full snapshot, not incremental**: The save is a complete capture of the game state. No deltas, no append-only logs, no incremental updates. This is simpler and sufficient for the prototype scale. The save file is a single JSON object.
- **Embeddings are preserved, not re-embedded**: The `MemoryNode.embedding` field is serialized as-is. On load, embeddings are restored from JSON without calling `EmbeddingProvider.embed()`. Re-embedding would produce different vectors (model nondeterminism), breaking retrieval. The embeddings are the ground truth from creation time.
- **`load()` is destructive**: `load()` clears all existing state (agents, world, memories) before restoring from the save. The caller must not call `load()` while the game loop is running (the implementation stops the loop, but concurrent state modifications by other systems are not prevented). The caller should stop the loop, call `load()`, then decide whether to restart.
- **`isThinking` is cleared on load**: Any agent with `isThinking: true` in the saved state has it set to `false` during load. The lost LLM call from the previous session cannot be recovered — the agent re-enters the PPER cycle fresh on the next tick.
- **No new dependencies**: File I/O uses Node.js built-in `fs/promises`. No compression, encryption, or database libraries. The save file is plain pretty-printed JSON.
- **Versioning**: The `SAVE_FORMAT_VERSION` is `1`. The `load()` method checks the version and throws `SaveFormatVersionError` on mismatch. Future format changes will increment the version and add migrations (not in scope).
- **Auto-save is optional and fire-and-forget**: The `AutoSaveSystem` is only registered when explicitly enabled and when a `VectorStore` is available. The save operation is fire-and-forget — the game loop is never blocked by serialization. Overlapping saves (if serialization takes longer than `intervalTicks`) are acceptable.
- **What NOT to do**:
  - Do not implement incremental saves, delta encoding, or append-only logs.
  - Do not compress or encrypt the save file.
  - Do not re-embed memory content on load.
  - Do not implement a persistent vector store backend (LanceDB, ChromaDB).
  - Do not modify the `AgentProfile`, `AgentInternalState`, `SmartObject`, `Room`, or `MemoryNode` interfaces.
  - Do not auto-restart the game loop after `load()`.
  - Do not implement save file management (rotating saves, save slots, timestamps in filenames).
  - Do not add new npm dependencies.
  - Do not implement cross-session agent learning or behavioral adaptation beyond preserving existing state.
  - Do not save the `AffordanceRegistry`'s handler functions — these are code (functions), not data. They are registered at startup by the application entry point, not serialized. The `SmartObject.affordances` array (which contains the affordance metadata: id, label, engineEffect, preconditions, effects) IS saved, but the actual handler functions are not — they are re-registered at startup.
