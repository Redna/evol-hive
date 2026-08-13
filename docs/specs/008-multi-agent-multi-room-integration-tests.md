# Feature: Multi-Agent & Multi-Room Integration Tests

## Context
- Architecture: [§2 System Overview](../architecture/02-system-overview.md), [§4 Smart Objects & Affordances](../architecture/04-smart-objects.md), [§6 PPER Loop](../architecture/06-pper-loop.md), [§9 Engine Routing & Async Execution](../architecture/09-engine-routing.md), [§11 Memory Architecture](../architecture/11-memory-architecture.md)
- Related specs: [005 Game Loop Integration & Minimal Scene](005-game-loop-integration.md), [001 Perceive Phase](001-perceive-phase.md), [002 Plan Phase](002-plan-phase.md), [003 Execute Phase](003-execute-phase.md), [004 Reflect Phase](004-reflect-phase.md)
- Issue: [#22 — Add multi-agent and multi-room integration tests](https://github.com/Redna/evol-hive/issues/22)
- Package: `engine`, `cognition`, `shared`, `memory`

## Problem Statement

All existing tests are unit-level, covering single-agent, single-room scenarios. The codebase has the infrastructure for multi-agent concurrency (`PPERScheduler`, `AgentManager.getActiveAgents()`) and multi-room spatial graphs (`SceneManagerImpl`, `Room.connections`, `SmartObject.roomId`), but no integration tests exercise these paths end-to-end. This leaves critical concurrency, scoping, and navigation behaviors unverified.

## Requirements

### Multi-Agent

- **R1**: A test must run 2+ agents through concurrent PPER cycles (Perceive → Plan → Execute → Reflect) using a shared engine assembly with mock LLM/embedding providers, verifying that each agent completes at least one full cycle independently.
- **R2**: A test must verify that when two agents target the same affordance on the same SmartObject, the first execution mutates object state and the second agent receives feedback reflecting the post-first-execution state (e.g., resource depleted → failure with reason).
- **R3**: A test must verify that `maxConcurrentCycles` is enforced: with `maxConcurrentCycles = 1` and 3 idle agents, only 1 `runCycle` call fires per tick; the remaining agents start only after the first cycle settles and the slot frees.
- **R4**: A test must verify that `isThinking` is correctly toggled per-agent during concurrent cycles — an agent in a thinking state is not rescheduled, while idle agents in the same tick are.
- **R5**: A test must verify that a PPER cycle rejection for one agent does not prevent other agents from starting or completing their cycles (error isolation).

### Multi-Room

- **R6**: A test must verify that an agent can navigate from one room to a connected room via `SceneManagerImpl.moveAgent`, and that the agent's `AgentInternalState.location` updates accordingly.
- **R7**: A test must verify that after an agent moves to a new room, the perception data for that agent reflects objects in the new room only (not objects in the previous room), confirming room-scoped object visibility.
- **R8**: A test must verify that affordances returned by `getAffordancesInRoom(roomId)` are scoped to the objects in that room — an affordance available in room A is not returned when querying room B.
- **R9**: A test must verify that loading a `SceneDefinition` with multiple rooms, objects, and agents via `loadScene()` correctly populates the `SceneManagerImpl`, `SmartObjectRegistry`, and `AgentManager` with all entities.
- **R10**: A test must verify that room boundary crossing triggers spatial debouncing — after `moveAgent`, `SpatialSystemImpl.shouldTriggerPerception(agentId)` returns `true` on the next tick (already partially covered by unit test; integration test must exercise it through the full game-loop tick).

### Multi-Agent + Multi-Room (Combined)

- **R11**: A test must verify that 2+ agents in different rooms run concurrent PPER cycles, each perceiving only their own room's objects and affordances, without cross-room interference in perception context.
- **R12**: A test must verify that an agent moving between rooms mid-simulation (between ticks) correctly receives perception updates scoped to the new room on subsequent PPER cycles.

## Acceptance Criteria

### Multi-Agent

- [ ] **AC-1** (maps to R1): Given an engine assembled with 2 agents and mock LLM/embedding providers, when the game loop is ticked enough times for all agents to complete a PPER cycle, then each agent's `runCycle` was called at least once and each agent's `isThinking` returns to `false`.
- [ ] **AC-2** (maps to R2): Given 2 agents in the same room with a single CoffeeMachine (water_level: 1), when both agents execute `brew_coffee`, then the first agent's `AffordanceResult.success` is `true` and the second agent's `AffordanceResult.success` is `false` with a failure reason indicating the resource is depleted.
- [ ] **AC-3** (maps to R3): Given `maxConcurrentCycles = 1` and 3 idle agents with a non-resolving fake orchestrator, when `PPERScheduler.update(tick)` is called once, then exactly 1 `runCycle` call is recorded; after the slot frees (cycle resolves), a second `update(tick)` starts the next agent.
- [ ] **AC-4** (maps to R4): Given 2 agents where agent A has `isThinking = true` and agent B has `isThinking = false`, when `PPERScheduler.update(tick)` runs, then only agent B's `runCycle` is called; agent A is skipped.
- [ ] **AC-5** (maps to R5): Given 2 agents where the orchestrator throws for agent A but resolves for agent B, when both cycles are flushed, then agent A's `isThinking` is `false` (reset on error) and agent B's `isThinking` is `false` (completed normally), and the game loop did not crash.

### Multi-Room

- [ ] **AC-6** (maps to R6): Given a scene with kitchen (connected to lounge) and an agent in kitchen, when `sceneManager.moveAgent(agentId, 'lounge')` is called, then `agentManager.getState(agentId).location` equals `'lounge'` and `sceneManager.getAgentRoom(agentId)` returns the lounge `Room`.
- [ ] **AC-7** (maps to R7): Given a scene where kitchen has a CoffeeMachine and lounge has a Sofa, when the agent moves from kitchen to lounge, then `perceptionDataProvider.getObjectsInRoom('lounge')` returns only the Sofa and does not include the CoffeeMachine.
- [ ] **AC-8** (maps to R8): Given a scene where kitchen has a CoffeeMachine with `brew_coffee` and lounge has a Sofa with `sit`, then `getAffordancesInRoom('kitchen')` returns only `brew_coffee` (plus `observe`) and `getAffordancesInRoom('lounge')` returns only `sit` (plus `observe`).
- [ ] **AC-9** (maps to R9): Given a `SceneDefinition` with 2 rooms, 3 SmartObjects (2 in room A, 1 in room B), and 2 agents, when `loadScene(core, scene)` is called, then `sceneManager.getRoom('A')` and `sceneManager.getRoom('B')` return the correct rooms, `smartObjectRegistry` contains all 3 objects, and `agentManager.getActiveAgents()` returns 2 agents with correct starting locations.
- [ ] **AC-10** (maps to R10): Given an agent in kitchen (connected to lounge) with spatial debouncing configured, when the agent moves to lounge and the game loop ticks once, then `spatialSystem.shouldTriggerPerception(agentId)` returns `true`.

### Multi-Agent + Multi-Room (Combined)

- [ ] **AC-11** (maps to R11): Given 2 agents — agent A in kitchen (CoffeeMachine) and agent B in lounge (Sofa) — when both run a PPER cycle concurrently, then agent A's perception context includes the CoffeeMachine and agent B's includes the Sofa, and neither agent's perception includes objects from the other's room.
- [ ] **AC-12** (maps to R12): Given an agent in kitchen that completes one PPER cycle, when the agent moves to lounge and runs another PPER cycle, then the second cycle's perception context includes lounge objects only, confirming the location change is reflected in subsequent PPER cycles.

## Test File Structure

Integration tests should live alongside the existing test files in `packages/engine/tests/`:

| File | Coverage |
|------|----------|
| `multi-agent.test.ts` | AC-1 through AC-5 — multi-agent concurrency, affordance competition, `maxConcurrentCycles` enforcement, `isThinking` gating, error isolation |
| `multi-room.test.ts` | AC-6 through AC-10 — room navigation, room-scoped objects/affordances, scene loading, spatial debounce |
| `multi-agent-multi-room.test.ts` | AC-11, AC-12 — combined multi-agent + multi-room scenarios |

## Test Harness

All integration tests should use:

- **Mock LLM client**: A reusable fake `LLMClient` (similar to `MockLLMClient` in `examples/minimal-scene.ts`) that returns deterministic structured outputs without network calls.
- **Mock embedding provider**: A fake `EmbeddingProvider` returning fixed vectors.
- **Fake/null vector store**: An in-memory `VectorStore` stub for memory integration.
- **`createEngineCore` + `assembleGameLoop` + `loadScene`**: The real engine assembly pipeline to exercise actual wiring, not just mocks.

## Constraints

- **Package boundaries**: Tests may import from `engine`, `cognition`, `shared`, and `memory` — the same packages the existing `reflect-integration.test.ts` already crosses. No new cross-package dependencies are introduced.
- **No network calls**: All LLM and embedding interactions must use mock/fake implementations. No real OpenAI or ONNX calls.
- **No new production code required**: The tests exercise existing APIs (`PPERScheduler`, `SceneManagerImpl`, `AgentManagerImpl`, `SmartObjectRegistryImpl`, `SpatialSystemImpl`, `loadScene`). If a gap is discovered (e.g., `SceneManagerImpl` lacks `loadRoom`/`unloadRoom`), it should be noted as a follow-up issue rather than implemented in this spec.
- **Performance**: Each integration test should complete in < 5 seconds (no real LLM latency; mock orchestrators resolve synchronously or with microtask delay).
- **Follow existing patterns**: Use `vitest` (`describe`/`it`/`expect`), import from source via `.js` extensions (per existing tests), and follow the naming conventions in existing test files.
- **What NOT to do**: Do not add concurrency primitives (locks, mutexes) to the engine — the existing fire-and-forget design is intentional. Do not test timing-sensitive behavior with real `setTimeout`; use deterministic fake clocks and controlled promise flushing.
