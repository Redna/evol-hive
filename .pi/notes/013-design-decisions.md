# Design Decisions — Spec 013 (Richer Prototype Scenes, Issue #45)

## Decision 1: Doorway Pattern for Room Navigation
**Context:** The execute phase's `resolveAffordance(roomId, affordanceId)` searches for affordances on objects in the agent's current room. There is no mechanism for "global" affordances not tied to a specific object.

**Decision:** Each room gets a "Doorway" smart object (type `"doorway"`) with one `go_to_<roomId>` affordance per connected room. The affordance ID encodes the destination (e.g., `go_to_kitchen`). The handler captures `SceneManager` and calls `moveAgent(agentId, targetRoomId)`.

**Rationale:** This works within the existing execute-phase flow without any code changes. The LLM sees `go_to_kitchen` as an available affordance in the perception data and can plan to use it. No changes to `resolveAffordance`, `ExecuteServiceImpl`, or `PhysicsSystemImpl` are needed.

**Alternative considered:** A generic `move_to_room` affordance with a `targetRoom` argument via `actionArgs`. Rejected because the execute service doesn't pass `actionArgs` to handlers, and adding this would require changes to the execute service and `AffordanceHandler` signature.

## Decision 2: Per-Agent Starting Rooms via `startRoomId` on `AgentProfile`
**Context:** `loadScene` currently spawns all agents in `scene.rooms[0]`. The richer scenes need agents in different rooms (e.g., Alice in Bedroom, Bob in Living Room).

**Decision:** Add optional `startRoomId?: string` to `AgentProfile`. `loadScene` uses it when present, falls back to the first room when absent.

**Rationale:** This is a small, backward-compatible change that makes scene definitions more declarative. The alternative (manually setting locations after `loadScene` in each entry point) is more error-prone and less clean.

## Decision 3: Social Interactions via Objects, Not Agent-to-Agent Targeting
**Context:** The issue mentions "agents can talk, collaborate, conflict" for the Office Day scene. The current architecture has no mechanism for agent-to-agent affordance targeting.

**Decision:** Social interactions are affordances on smart objects (Water Cooler → `small_talk`, Meeting Table → `hold_meeting`, Whiteboard → `brainstorm`). These restore the `social` drive when used.

**Rationale:** This works within the existing smart object + affordance model. Direct agent-to-agent affordance targeting would require significant engine changes (registering agents as smart objects, resolving affordances on agents, handling two-agent interactions). Structured social dynamics are a future concern per the ROADMAP.

## Decision 4: `go_outside` as a Stub
**Context:** The issue mentions "Front Door → go_outside (transitions to another scene)". Cross-scene transitions are not supported by the current engine.

**Decision:** `go_outside` is an affordance on the Front Door that logs a message and returns `{ success: true }`. No actual scene transition occurs.

**Rationale:** Implementing cross-scene transitions (loading a new `SceneDefinition` mid-simulation, preserving agent state across scenes) is a significant feature beyond the scope of this spec. The stub demonstrates the affordance pattern and leaves a clear extension point.

## Decision 5: Shared Affordance Handler Library in `examples/scene-helpers.ts`
**Context:** Both scenes share affordances (e.g., `brew_coffee`, `observe`, `go_to_*`). Duplicating handler registration in each entry point is error-prone.

**Decision:** Create `examples/scene-helpers.ts` with a `registerAffordanceHandlers(core: EngineCore)` function that registers all handlers. Both entry points call this function after `loadScene`.

**Rationale:** DRY principle. The function receives `EngineCore` and captures `core.sceneManager` (already populated by `loadScene`) for movement handlers.

## Decision 6: Drive-Aware Mock LLM
**Context:** The minimal scene's mock LLM always returns `brew_coffee`. The richer scenes need to demonstrate drive prioritization — different agents choosing different actions based on their drives.

**Decision:** The mock LLM inspects the `LLMContextPayload` (which includes the primary drive label and available affordances) and returns a plan targeting an affordance that addresses the primary drive. This is a simple heuristic, not real intelligence.

**Rationale:** This allows the prototype to demonstrate drive prioritization without a real LLM. The real LLM integration is already supported via `USE_REAL_LLM=true`.
