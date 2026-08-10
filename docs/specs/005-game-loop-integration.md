# Feature: Integrate PPER Loop into the Game Loop with a Minimal Scene

## Context
- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md) (full cycle), [§9 — Engine Routing](../architecture/09-engine-routing.md) (is_thinking, async routing, accumulator pattern), [§2 — System Overview](../architecture/02-system-overview.md) (hybrid engine, package boundaries), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (AgentInternalState, isThinking), [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (scene composition), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (MemoryStore wiring)
- Related specs: [001 — Perceive Phase](001-perceive-phase.md), [002 — Plan Phase](002-plan-phase.md), [003 — Execute Phase](003-execute-phase.md), [004 — Reflect Phase](004-reflect-phase.md)
- Package: `shared`, `engine`, `cognition`, `memory`
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#10](https://github.com/Redna/evol-hive/issues/10)

## Requirements

### Engine Layer (`@evol-hive/engine`)

1. **Fixed-timestep game loop (accumulator pattern)** — Implement `GameLoopImpl` in `packages/engine/src/loop/index.ts` using the accumulator pattern with a target FPS of 60 (configurable via `EngineConfig.fps`, default 16.67ms per tick). The loop must accumulate real elapsed time between `requestAnimationFrame` (or equivalent timer) calls and consume it in fixed-size `deltaSeconds` steps. Any remainder is carried over to the next frame. The loop must call `update(tick)` on every registered `EngineSystem` in registration order on each consumed tick, and increment `tickNumber` and `simulationTime` accordingly.

2. **Game loop start/stop** — `GameLoopImpl.start()` must begin the accumulator loop and `GameLoopImpl.stop()` must halt it and release any timer handles. Starting an already-running loop is a no-op. Stopping an already-stopped loop is a no-op. `currentTick()` must return the latest `GameTick` (`{ tickNumber, simulationTime, deltaSeconds }`) even while stopped.

3. **PPER scheduler system** — Implement a new `PPERScheduler` engine system (`EngineSystem`) registered with the `GameLoopImpl`. On each tick, the scheduler iterates all active agents. For each agent where `isThinking === false`, the scheduler initiates a PPER cycle asynchronously via the `PPEROrchestrator.runCycle(agentId)` method (defined in `@evol-hive/cognition`). The async call must not block the game loop — it must be fired-and-forgotten with error handling that sets `isThinking = false` on any uncaught rejection. The scheduler must not start a new cycle for an agent that is already thinking.

4. **Drive decay system** — Implement a `DriveDecaySystem` (`EngineSystem`) registered with the `GameLoopImpl`. On each tick, it applies drive decay to every active agent using `DriveSystem.applyDecay(state, deltaSeconds)`. This runs on every tick regardless of `isThinking` status (drives decay while the agent thinks).

5. **Spatial system tick** — The existing `SpatialSystemImpl` already implements `EngineSystem.update(tick)` to advance its internal simulation clock. It must be registered with the `GameLoopImpl` so its `currentSimTime` stays synchronized with the loop's `simulationTime`.

6. **Scene manager implementation** — Implement `SceneManagerImpl` in `packages/engine/src/world/scenes/index.ts` backed by an in-memory `Map<string, Room>`. Must support: `getRoom(roomId)`, `getConnectedRooms(roomId)`, `moveAgent(agentId, toRoomId)` (updates `AgentInternalState.location`), and `getAgentRoom(agentId)` (delegates to `AgentManager.getState(agentId).location`). Moving an agent to a room triggers the spatial debouncing logic on the next tick (the `SpatialSystemImpl` detects the room boundary change).

7. **Engine assembly (factory)** — Implement an `EngineBuilder` or equivalent factory function that wires together all engine subsystems: `AgentManagerImpl`, `DriveSystemImpl`, `PlanManagerImpl`, `SmartObjectRegistryImpl`, `AffordanceRegistryImpl`, `PhysicsSystemImpl`, `SpatialSystemImpl`, `SceneManagerImpl`, `SystemFeedbackStore`, and the data-provider bridges (`PerceptionDataProviderImpl`, `PlanDataProviderImpl`, `ExecuteDataProviderImpl`, `ReflectDataProviderImpl`). The factory must register all `EngineSystem`s with the `GameLoopImpl` in the correct order: (1) `SpatialSystem`, (2) `DriveDecaySystem`, (3) `PPERScheduler`. The factory must accept an `EngineConfig` and an `LLMClient` (or `PPEROrchestrator`) as construction parameters.

8. **`GameTick` propagation** — Every `EngineSystem.update(tick)` call must receive the same `GameTick` object (same `tickNumber`, `simulationTime`, `deltaSeconds`) within a single tick. The `GameLoopImpl` must construct one `GameTick` per consumed accumulator step and pass it to all systems.

### Shared Layer (`@evol-hive/shared`)

9. **`PPERSchedulerConfig` type** — Define a new interface `PPERSchedulerConfig` in `packages/shared/src/types/engine.ts` with fields: `{ maxConcurrentCycles: number }` (default: 8, matching `ENGINE_MAX_CONCURRENT_LLM`). This limits how many agents can be in a PPER cycle simultaneously.

10. **`SceneDefinition` type** — Define a new interface `SceneDefinition` in `packages/shared/src/types/world.ts` representing a serializable scene blueprint: `{ id: string; name: string; rooms: Room[]; objects: SmartObject[]; agents: AgentProfile[] }`. This allows scenes to be defined declaratively and loaded into the engine.

### Cognition Layer (`@evol-hive/cognition`)

11. **PPER orchestrator implementation** — Implement `PPEROrchestratorImpl` (satisfying the existing `PPEROrchestrator` interface) in `packages/cognition/src/pper/index.ts`. The `runCycle(agentId)` method must execute the four phases in sequence: (1) `PerceptionServiceImpl.perceive(agentId)` → (2) `PlanServiceImpl.plan(agentId, perceptionResult)` → (3) `ExecuteServiceImpl.execute(agentId)` → (4) `ReflectServiceImpl.reflect(agentId, executeResult)`. If any phase returns `success: false`, the cycle must abort early (no subsequent phases run) and `isThinking` must be guaranteed `false` (each phase service already handles this in its `finally` block). The orchestrator must track the current phase per agent via `getPhase(agentId)`.

12. **Phase tracking** — `PPEROrchestratorImpl.getPhase(agentId)` must return the current `PPERPhase` for the agent: `'perceive'` while perceiving, `'plan'` while planning, `'execute'` while executing, `'reflect'` while reflecting, and `'perceive'` (idle / ready for next cycle) when no cycle is in progress.

13. **PPER orchestrator factory** — Implement a factory function or class that constructs `PPEROrchestratorImpl` from its dependencies: `PerceptionServiceOptions`, `PlanServiceOptions`, `ExecuteServiceOptions`, `ReflectServiceOptions`. The factory must accept the shared data-provider bridges and LLM client as parameters and internally wire the service implementations.

### Root-Level Entry Point

14. **Minimal scene definition** — Create a `examples/minimal-scene.ts` entry point that defines a minimal playable scene: one room (`"kitchen"`) with one smart object (a `CoffeeMachine` with `brew_coffee` and `observe` affordances) and one agent (with initial drives, e.g., `energy: 20`). The scene must use `SceneDefinition` and the engine factory to bootstrap the simulation.

15. **Simulation start** — The entry point must call `GameLoopImpl.start()` to begin the simulation. It must log a message when the agent completes a full PPER cycle (perceive → plan → execute → reflect) to demonstrate the prototype works. The entry point must be runnable via `npx tsx examples/minimal-scene.ts` or an equivalent npm script.

16. **Mock LLM client** — The entry point must include a mock `LLMClient` implementation that returns canned responses for `completePlan` (a valid `FormulatePlanResult` with steps targeting `brew_coffee`) and `completeReflect` (a valid `ReflectLLMResponse` with a memory entry). This allows the prototype to run without a real LLM backend. The mock must also implement `completeStructured` and `completeReflection` for interface completeness.

17. **Mock embedding provider** — The entry point must include a mock `EmbeddingProvider` (for the `MemoryStore`) that returns deterministic zero vectors or random-but-stable vectors. This allows memory storage to work without a real embedding model.

### Cross-Cutting

18. **Concurrency control** — The `PPERScheduler` must limit the number of concurrent PPER cycles to `PPERSchedulerConfig.maxConcurrentCycles` (default 8). When the limit is reached, agents that are not thinking and not already in a cycle must wait until a slot frees. This mirrors the `LLMConcurrencyManager` design from §9 but operates at the PPER-cycle level.

19. **Error resilience** — If a PPER cycle throws an uncaught exception (not handled by the phase services' internal try/catch), the scheduler must catch it, log the error, and ensure `isThinking` is set to `false` for that agent so the game loop can retry on the next tick. The game loop must never crash due to a PPER cycle failure.

20. **Drive decay continues during thinking** — Drive decay (`DriveDecaySystem`) must run for all agents on every tick, including those with `isThinking === true`. This ensures agent needs escalate while waiting for LLM responses, creating urgency for the next cycle.

21. **No blocking I/O in the game loop** — The game loop's `update()` calls must never `await` a promise. All LLM calls, memory stores, and other async operations happen in the fired-and-forgotten PPER cycle. The game loop tick must complete synchronously and return control to the accumulator.

## Acceptance Criteria

- [ ] **AC-1**: `GameLoopImpl` accumulates real elapsed time and consumes it in fixed `deltaSeconds` steps of `1/fps` seconds. When 33ms of real time elapses at 60 FPS, exactly 2 ticks are consumed (2 × 16.67ms ≈ 33.3ms), with the remainder carried over. *(Req 1)*
- [ ] **AC-2**: `GameLoopImpl.start()` begins the loop and `GameLoopImpl.stop()` halts it. Calling `start()` when already running does not create a second loop. `currentTick()` returns the last `GameTick` after stopping. *(Req 2)*
- [ ] **AC-3**: Every registered `EngineSystem` receives the same `GameTick` (same `tickNumber`, `simulationTime`, `deltaSeconds`) on a given tick. Systems are called in registration order. *(Req 1, Req 8)*
- [ ] **AC-4**: On each tick, the `PPERScheduler` iterates all active agents. For each agent where `isThinking === false`, it calls `PPEROrchestrator.runCycle(agentId)` asynchronously. The `update()` method returns synchronously without awaiting the cycle. *(Req 3, Req 21)*
- [ ] **AC-5**: The `PPERScheduler` does not start a new cycle for an agent that already has `isThinking === true`. *(Req 3)*
- [ ] **AC-6**: If a PPER cycle's promise rejects with an uncaught error, the scheduler catches it, logs the error, and sets `isThinking = false` for that agent. The game loop does not crash. *(Req 19)*
- [ ] **AC-7**: The `DriveDecaySystem` calls `DriveSystem.applyDecay(state, deltaSeconds)` for every active agent on every tick, including agents with `isThinking === true`. *(Req 4, Req 20)*
- [ ] **AC-8**: `SpatialSystemImpl` is registered with `GameLoopImpl` and its `currentSimTime` equals `simulationTime` from the latest `GameTick` after at least one tick. *(Req 5)*
- [ ] **AC-9**: `SceneManagerImpl.getRoom(roomId)` returns the registered `Room` or `null`. `getConnectedRooms(roomId)` returns all rooms whose IDs appear in `room.connections`. `moveAgent(agentId, toRoomId)` updates the agent's `AgentInternalState.location`. `getAgentRoom(agentId)` returns the `Room` matching the agent's current location. *(Req 6)*
- [ ] **AC-10**: `SceneManagerImpl.moveAgent(agentId, toRoomId)` updates `AgentInternalState.location`, causing `SpatialSystemImpl.shouldTriggerPerception(agentId)` to return `true` on the next tick (room boundary crossed). *(Req 6)*
- [ ] **AC-11**: The engine factory wires all subsystems and registers `EngineSystem`s with `GameLoopImpl` in order: `SpatialSystem` → `DriveDecaySystem` → `PPERScheduler`. Calling `GameLoopImpl.start()` on the assembled engine runs all systems. *(Req 7)*
- [ ] **AC-12**: `PPERSchedulerConfig` is defined in `packages/shared/src/types/engine.ts` with `{ maxConcurrentCycles: number }`. *(Req 9)*
- [ ] **AC-13**: `SceneDefinition` is defined in `packages/shared/src/types/world.ts` with `{ id: string; name: string; rooms: Room[]; objects: SmartObject[]; agents: AgentProfile[] }`. *(Req 10)*
- [ ] **AC-14**: `PPEROrchestratorImpl.runCycle(agentId)` calls `perceive()` → `plan()` → `execute()` → `reflect()` in sequence. When `plan()` returns `{ success: false }`, `execute()` and `reflect()` are not called. *(Req 11)*
- [ ] **AC-15**: `PPEROrchestratorImpl.getPhase(agentId)` returns `'perceive'` during the perceive step, `'plan'` during plan, `'execute'` during execute, `'reflect'` during reflect, and `'perceive'` when idle. *(Req 12)*
- [ ] **AC-16**: After a successful full PPER cycle (all 4 phases succeed), `isThinking` is `false` for the agent. After a failed cycle (any phase returns `success: false`), `isThinking` is also `false`. *(Req 11)*
- [ ] **AC-17**: The PPER orchestrator factory constructs `PPEROrchestratorImpl` from the data-provider bridges and LLM client. The resulting orchestrator can run a full cycle for an agent. *(Req 13)*
- [ ] **AC-18**: `examples/minimal-scene.ts` defines a `SceneDefinition` with one room (`"kitchen"`), one `SmartObject` (`CoffeeMachine` with `brew_coffee` affordance), and one `AgentProfile` (with `energy: 20`). *(Req 14)*
- [ ] **AC-19**: `examples/minimal-scene.ts` calls the engine factory with the `SceneDefinition`, a mock `LLMClient`, and a mock `EmbeddingProvider`, then calls `GameLoopImpl.start()`. The simulation runs without errors. *(Req 15, Req 16, Req 17)*
- [ ] **AC-20**: When the agent completes a full PPER cycle, the entry point logs a message containing the agent ID and the cycle result (e.g., `"Agent agent-1 completed PPER cycle: success=true"`). *(Req 15)*
- [ ] **AC-21**: The mock `LLMClient.completePlan()` returns a valid `FormulatePlanResult` with at least one step whose `targetAffordance` is `"brew_coffee"`. The mock `LLMClient.completeReflect()` returns a valid `ReflectLLMResponse` with a `memoryEntry` of type `"action"` and importance 5. *(Req 16)*
- [ ] **AC-22**: The mock `EmbeddingProvider.embed()` returns a `number[]` of the correct dimensionality (e.g., 384) without making any network calls. *(Req 17)*
- [ ] **AC-23**: When `maxConcurrentCycles` is set to 1 and two agents are both idle, only one PPER cycle starts on a given tick. The second agent's cycle starts only after the first completes (sets `isThinking = false`). *(Req 18)*
- [ ] **AC-24**: The `GameLoopImpl.update()` path (all `EngineSystem.update()` calls for a single tick) completes synchronously without any `await`. *(Req 21)*

## Constraints

- **Package boundaries** (per ADR-0001): `engine` and `cognition` must **not** directly import from each other. The `PPERScheduler` (in `engine`) calls `PPEROrchestrator.runCycle()` (in `cognition`) through an interface defined in `@evol-hive/shared` or through a callback/injection pattern. The engine factory receives the `PPEROrchestrator` as a construction parameter.
- **No blocking in the game loop**: The game loop tick (`update()`) must complete synchronously. All async work (LLM calls, memory stores) happens in fired-and-forgotten promises from the `PPERScheduler`. A `Promise<void>` is launched and not awaited; errors are caught in a `.catch()` handler. *(§9.1)*
- **isThinking is the gate**: The only check for starting a PPER cycle is `isThinking === false`. The scheduler does not check plan state, drive values, or spatial debounce — those are handled within the Perceive phase itself. The spatial debounce check (`SpatialSystem.shouldTriggerPerception`) gates whether the Perceive phase produces a new perception snapshot or returns early, not whether the cycle starts.
- **Phase services are already implemented**: Specs 001–004 have implemented `PerceptionServiceImpl`, `PlanServiceImpl`, `ExecuteServiceImpl`, and `ReflectServiceImpl`. This spec's job is to wire them into an orchestrator and run them in the game loop — not to re-implement any phase logic.
- **Scene manager is a stub**: `packages/engine/src/world/scenes/index.ts` currently `export {}`s. This spec implements the `SceneManagerImpl` concrete class.
- **Game loop is a stub**: `packages/engine/src/loop/index.ts` currently `export {}`s. This spec implements the `GameLoopImpl` concrete class.
- **Routing is a stub**: `packages/engine/src/routing/index.ts` currently `export {}`s. The routing of LLM action responses (§9.1 action routing) is handled by the phase services themselves in this design — the `ExecuteServiceImpl` routes affordance execution, the `PlanServiceImpl` routes plan formulation. A separate `ActionRouter` implementation is out of scope for this spec unless needed by the orchestrator.
- **Mock dependencies for prototype**: The entry point must use mock LLM/embedding implementations so the prototype runs without external services. Real LLM integration is a future concern.
- **Configurable FPS**: The target FPS must come from `EngineConfig.fps` (default 60), not a hardcoded constant. `EngineConfig.spatialDebounceSeconds` and `EngineConfig.maxConcurrentLLM` must be respected.
- **What NOT to do**:
  - Do not re-implement any PPER phase logic (perceive, plan, execute, reflect) — those are done.
  - Do not implement the `ActionRouter` or `LLMConcurrencyManager` as separate subsystems unless the orchestrator requires them. The phase services handle their own routing.
  - Do not implement a real LLM client or real embedding model — use mocks for the prototype.
  - Do not implement agent movement between rooms (pathfinding, room graph traversal) — `SceneManager.moveAgent` is a direct teleport for the prototype.
  - Do not implement the background reflection loop (§11.3) — only the synchronous Reflect phase within the PPER cycle.
  - Do not implement memory retrieval (Track 1 associative injection) — only memory storage from the Reflect phase.
  - Do not add visual rendering, a UI, or a game server — this is a headless simulation prototype.
