# Feature: Multi-Agent & Multi-Room Integration Tests

## Context
- Architecture: [§2 System Overview](../architecture/02-system-overview.md), [§3 Agent State Schema](../architecture/03-agent-state-schema.md), [§4 Smart Objects & Affordances](../architecture/04-smart-objects.md), [§6 PPER Loop](../architecture/06-pper-loop.md), [§9 Engine Routing](../architecture/09-engine-routing.md)
- Related specs: [005 Game Loop Integration](005-game-loop-integration.md), [003 Execute Phase](003-execute-phase.md), [004 Reflect Phase](004-reflect-phase.md)
- Issue: [#22](https://github.com/Redna/evol-hive/issues/22)
- Package: `@evol-hive/engine` (primary), `@evol-hive/shared` (types only)

## Requirements

### Multi-Agent

- **Req 1:** Two or more agents must be able to run PPER cycles concurrently within a single engine instance, each with independent `isThinking` state.
- **Req 2:** The `PPERScheduler` must enforce `maxConcurrentCycles` — when the number of in-flight cycles equals the limit, no additional cycles are started until a slot frees.
- **Req 3:** When two agents target the same affordance on the same `SmartObject` in the same tick, the engine must execute for at most one agent and return a failure result to the other, with a `failureReason` explaining the contention (e.g., `"object in use"` or `"precondition not satisfied"`).
- **Req 4:** A failed affordance execution due to contention must inject system feedback into the agent's next perception tick, preventing infinite retry loops (per §9 feedback mechanism).
- **Req 5:** Agents must not interfere with each other's internal state — `AgentInternalState` updates (drives, plans, location) for one agent must not leak to another.
- **Req 6:** Drive decay must apply independently per agent — each agent's drives decay based on simulation time, not based on what other agents do.

### Multi-Room

- **Req 7:** An agent must be able to move from one room to a connected room via `SceneManager.moveAgent`, and `SceneManager.getAgentRoom` must reflect the new location immediately.
- **Req 8:** After moving to a new room, the agent's perception must include only objects in the new room — objects from the previous room must not appear in `SmartObjectRegistry.getObjectsInRoom(newRoomId)` or `getAffordancesInRoom(newRoomId)`.
- **Req 9:** Moving between rooms must trigger the spatial debouncing mechanism — `SpatialSystem.shouldTriggerPerception` must return `true` on the tick following a room change (per §6.1 spatial debouncing).
- **Req 10:** The `SceneManager` must support loading a multi-room scene via `loadScene` / `SceneDefinition` with connected rooms, objects scoped to specific rooms, and multiple agents spawned at designated rooms.
- **Req 11:** Objects registered in one room must not be discoverable from another room — `SmartObjectRegistry.getByRoom(roomId)` must return only objects whose `roomId` matches the query.

## Acceptance Criteria

### Multi-Agent

- [x] **AC-1:** Given two idle agents (`isThinking: false`) and `maxConcurrentCycles >= 2`, calling `PPERScheduler.update(tick)` starts a PPER cycle for both agents (verified via fake orchestrator recording both `agentId` calls).
- [x] **AC-2:** Given three idle agents and `maxConcurrentCycles: 2`, calling `PPERScheduler.update(tick)` starts cycles for exactly 2 agents; the third agent's `isThinking` remains `false` and no `runCycle` call is recorded for it.
- [x] **AC-3:** After one in-flight cycle resolves (promise settles), the next `update(tick)` call starts a cycle for the previously-waiting third agent.
- [x] **AC-4:** Given two agents and a single `SmartObject` with an affordance whose preconditions fail when the object is "in use", simulating concurrent execution on the same object yields one `AffordanceResult` with `success: true` and one with `success: false` and a `failureReason` indicating contention.
- [x] **AC-5:** After an agent receives a failed affordance result due to contention, the `SystemFeedbackStore` contains a feedback entry for that agent that will be surfaced in the next perception tick.
- [x] **AC-6:** Running two agents through independent PPER cycles does not cause cross-contamination — after cycles complete, each agent's `drives`, `currentPlan`, and `location` reflect only its own actions.
- [x] **AC-7:** After N simulation ticks with two agents, each agent's drive values have decayed independently (no agent's drives match the other's unless their initial drives and actions were identical).

### Multi-Room

- [x] **AC-8:** Given two connected rooms (kitchen ↔ lounge) and an agent in kitchen, calling `sceneManager.moveAgent(agentId, 'lounge')` causes `sceneManager.getAgentRoom(agentId)` to return the lounge `Room` object.
- [x] **AC-9:** After moving an agent from kitchen to lounge, `SmartObjectRegistry.getObjectsInRoom('lounge')` returns only objects registered with `roomId: 'lounge'`, and objects from kitchen do not appear.
- [x] **AC-10:** After moving an agent from kitchen to lounge, `SmartObjectRegistry.getAffordancesInRoom('lounge')` returns only affordances from objects in lounge — no affordances from kitchen objects.
- [x] **AC-11:** Moving an agent between rooms triggers spatial debouncing: after `sceneManager.moveAgent`, the next `SpatialSystem.update(tick)` causes `shouldTriggerPerception(agentId)` to return `true`.
- [x] **AC-12:** Loading a `SceneDefinition` with 3 connected rooms, 5 objects (scoped to different rooms), and 2 agents (in different starting rooms) results in correct initial state: each agent's `location` matches its designated room, each room's `objectIds` match registered objects, and `sceneManager.getConnectedRooms` returns the expected graph.
- [x] **AC-13:** An agent in room A cannot access affordances from room B — `SmartObjectRegistry.getAffordancesInRoom('room-a')` excludes all affordances from objects in room B.

### Cross-Cutting Integration

- [x] **AC-14:** Running a full game loop with 2 agents in 2 connected rooms for N ticks produces per-agent perception data scoped to each agent's current room, with no cross-room leakage.
- [x] **AC-15:** When one agent moves to a new room while the other stays, only the moving agent's perception is debounced/triggered — the stationary agent's perception is not affected by the other agent's movement.

## Constraints

- **No new production code:** This spec is purely for integration test files. All infrastructure (PPERScheduler, SceneManagerImpl, SmartObjectRegistryImpl, SpatialSystemImpl, AgentManagerImpl, GameLoopImpl) already exists from specs 005, 003, 004. Tests must exercise existing code, not create new modules.
- **Package boundaries:** Tests live in `packages/engine/tests/`. They may import from `@evol-hive/shared` (types) and `@evol-hive/engine` (implementations). They must NOT import from `@evol-hive/cognition` or `@evol-hive/memory` — use fake/mock implementations of `PPEROrchestratorPort` instead.
- **No real LLM calls:** All tests must use `FakeOrchestrator` or equivalent mock implementations. No network calls, no real model inference.
- **Deterministic timing:** Use `vi.useFakeTimers()` and `loop.injectElapsed()` for time control. Never rely on real wall-clock time.
- **Test naming:** Files should be named `multi-agent.test.ts` and `multi-room.test.ts` in `packages/engine/tests/`.
- **Pattern:** Follow the existing test patterns in `pper-scheduler.test.ts` and `scene-manager.test.ts` — use `vitest`, inline helper functions (`makeAgent`, `makeObject`, etc.), and `FakeOrchestrator` classes.
- **What NOT to do:** Do not modify existing source files. Do not add new interfaces to `shared`. Do not create new engine systems. Do not test with real async I/O — all async should be mockable/promise-controllable.
