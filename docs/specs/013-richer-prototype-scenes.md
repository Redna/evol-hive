# Feature: Richer Prototype Scenes — Multi-Room, Multi-Object, Multi-Agent

## Context
- Architecture: [§2 — System Overview](../architecture/02-system-overview.md) (package boundaries, hybrid engine), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (AgentDrives, AgentProfile, AgentInternalState), [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (SmartObject, Affordance, engineEffect, preconditions, effects), [§6 — PPER Loop](../architecture/06-pper-loop.md) (spatial debouncing, perceive → plan → execute → reflect), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (formulate_plan with targetAffordance steps)
- Related specs: [005 — Game Loop Integration & Minimal Scene](005-game-loop-integration.md) (SceneDefinition, loadScene, EngineBuilder, minimal scene entry point), [008 — Multi-Agent & Multi-Room Integration Tests](008-multi-agent-multi-room-integration-tests.md) (multi-room navigation, multi-agent concurrency, object contention), [012 — Agent Persona System](012-agent-persona-system.md) (AgentProfile persona fields, formatPersona)
- Package: `shared` (type extension), `engine` (loadScene enhancement), `examples` (scene definitions, entry points, affordance handlers)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#45](https://github.com/Redna/evol-hive/issues/45)

## Design Rationale

The current prototype (`examples/minimal-scene.ts`) is intentionally minimal: one room, one object, one agent. The engine already supports multiple rooms, objects, and agents — the minimal scene simply doesn't exercise them. This spec authors two richer scenes that demonstrate the engine's capabilities: multi-room navigation, multi-agent concurrency, object state depletion, drive prioritization, and LLM decision-making across multiple available affordances.

The work is primarily scene definition (declarative `SceneDefinition` data) and affordance handler authoring (deterministic engine-effect functions). No PPER loop logic, no game loop changes, no new engine systems. The only engine-level change is a small backward-compatible enhancement to `loadScene` to support per-agent starting rooms via an optional `startRoomId` field on `AgentProfile`.

Room-to-room navigation is implemented via "Doorway" smart objects: each room contains a Doorway with affordances named after each connected room (e.g., `go_to_kitchen`). The affordance handler captures the `SceneManager` and calls `moveAgent(agentId, targetRoomId)`. This works within the existing execute-phase flow: `resolveAffordance` finds the affordance on the Doorway object in the agent's current room, the handler executes, and the agent's `location` is updated.

Social interactions in the "Office Day" scene are simulated through social- affordance objects (Water Cooler, Meeting Table, Whiteboard) rather than direct agent-to-agent affordance targeting. This is pragmatic for the prototype — structured social dynamics and relationship graphs are a future concern (per ROADMAP "Multi-Agent Social").

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`startRoomId` on `AgentProfile`** — Add an optional field `startRoomId?: string` to the `AgentProfile` interface in `packages/shared/src/types/agent.ts`. When present, `loadScene` uses it as the agent's initial room. When absent, `loadScene` falls back to the first room in the scene (current behavior). This is backward-compatible — all existing `AgentProfile` objects without `startRoomId` continue to work.

### Engine Layer (`@evol-hive/engine`)

2. **`loadScene` respects `startRoomId`** — The `loadScene` function in `packages/engine/src/assembly.ts` must use `profile.startRoomId` when available, falling back to `scene.rooms[0]?.id ?? ''` when not. This allows scene authors to spawn agents in different rooms declaratively.

### Affordance Handler Library (`examples/scene-helpers.ts`)

3. **Shared affordance handler registration** — Create `examples/scene-helpers.ts` exporting a `registerAffordanceHandlers(core: EngineCore)` function that registers all affordance handlers used by both scenes. This avoids duplication between the two scene entry points. The function must register handlers for: `sleep`, `brew_coffee`, `observe`, `take_shower`, `watch_tv`, `read_book`, `go_outside`, `work`, `brainstorm`, `small_talk`, `hold_meeting`, `use_bathroom`, `wash_hands`, `print_document`, and all `go_to_*` movement affordances.

4. **`brew_coffee` handler** — Decrement `water_level` by 1 and `bean_count` by 1 in the object's new state. Return `driveChanges: { energy: 20 }`. If `water_level` is 0 or `bean_count` is 0, return `{ success: false, failureReason: "No water or beans left" }` (precondition checkers handle this before execution, but the handler is defensive).

5. **`sleep` handler** — Return `driveChanges: { energy: 30, comfort: -5 }`. No object state change (bed state is unchanged).

6. **`take_shower` handler** — Decrement `water_level` by 1 in the shower object's state. Return `driveChanges: { comfort: 25, energy: -5 }`.

7. **`watch_tv` handler** — Return `driveChanges: { comfort: 15, energy: -5, curiosity: 5 }`. Update object state `powered_on` to `false` (TV turns off after watching).

8. **`read_book` handler** — Decrement `book_count` by 1 in the bookshelf's state. Return `driveChanges: { curiosity: 20, energy: -10 }`. If `book_count` is 0, return `{ success: false, failureReason: "No books left" }`.

9. **`go_outside` handler** — Log a message: `"Agent <agentId> went outside (scene transition not yet implemented)"`. Return `{ success: true }` with no drive changes. Actual scene transitions are a future concern and out of scope.

10. **`work` handler (Computer)** — Return `driveChanges: { energy: -15 }`. No drive restoration — work drains energy. Update computer state `tasks_completed` by +1.

11. **`brainstorm` handler (Whiteboard)** — Return `driveChanges: { curiosity: 15, social: 5, energy: -10 }`. Update whiteboard state `ideas_generated` by +1.

12. **`small_talk` handler (Water Cooler)** — Return `driveChanges: { social: 15, energy: -2 }`. No object state change.

13. **`hold_meeting` handler (Meeting Table)** — Return `driveChanges: { social: 20, energy: -15, comfort: -5 }`. Update meeting table state `meetings_held` by +1.

14. **`use_bathroom` handler (Toilet)** — Return `driveChanges: { comfort: 10 }`. No object state change.

15. **`wash_hands` handler (Sink)** — Return `driveChanges: { comfort: 5 }`. No object state change.

16. **`print_document` handler (Printer)** — Decrement `paper_count` by 1. Return `driveChanges: { curiosity: 2 }`. If `paper_count` is 0, return `{ success: false, failureReason: "Printer out of paper" }`.

17. **`go_to_*` movement handlers** — For each `go_to_<roomId>` affordance, the handler must call `core.sceneManager.moveAgent(agentId, '<roomId>')` and return `{ success: true }` with no drive changes. The handler captures the `SceneManager` reference (after `loadScene` has been called, so the reference is the populated scene manager). Movement is a direct teleport — no pathfinding, no travel time.

18. **`observe` handler** — Return `{ success: true }` with no state or drive changes. (Already exists in the minimal scene; re-used here.)

### Precondition Checker Library (`examples/scene-helpers.ts`)

19. **Shared precondition checker registration** — The `registerAffordanceHandlers` function (or a companion `registerPreconditionCheckers`) must register precondition checkers for: `has_water` (state `water_level > 0`), `has_beans` (state `bean_count > 0`), `is_powered` (state `powered_on === true`), `has_books` (state `book_count > 0`), `has_paper` (state `paper_count > 0`).

### Scene 1: "Morning Routine" (`examples/morning-routine.ts`)

20. **Room definitions** — Define four connected rooms:
    - `bedroom`: name "Bedroom", connections `["bathroom", "living_room"]`
    - `bathroom`: name "Bathroom", connections `["bedroom", "living_room"]`
    - `living_room`: name "Living Room", connections `["bedroom", "bathroom", "kitchen"]`
    - `kitchen`: name "Kitchen", connections `["living_room"]`

21. **Object definitions** — Define smart objects with state and affordances:
    - **Bed** (`bed-1`, bedroom): state `{}`, affordances: `sleep` (effects: `{ energy: 30, comfort: -5 }`), `observe`
    - **Shower** (`shower-1`, bathroom): state `{ water_level: 10 }`, affordances: `take_shower` (preconditions: `["has_water"]`, effects: `{ comfort: 25, energy: -5 }`), `observe`
    - **TV** (`tv-1`, living_room): state `{ powered_on: true }`, affordances: `watch_tv` (preconditions: `["is_powered"]`, effects: `{ comfort: 15, energy: -5, curiosity: 5 }`), `observe`
    - **Bookshelf** (`bookshelf-1`, living_room): state `{ book_count: 8 }`, affordances: `read_book` (preconditions: `["has_books"]`, effects: `{ curiosity: 20, energy: -10 }`), `observe`
    - **Front Door** (`front-door-1`, living_room): state `{}`, affordances: `go_outside` (effects: `{}`), `observe`
    - **Coffee Machine** (`coffee-1`, kitchen): state `{ water_level: 5, bean_count: 12 }`, affordances: `brew_coffee` (preconditions: `["has_water", "has_beans"]`, effects: `{ energy: 20 }`), `observe`
    - **Doorway objects** — One per room, with `go_to_<roomId>` affordances for each connected room. Each doorway has type `"doorway"` and no meaningful state. Affordance effects are empty `{}`.

22. **Agent definitions** — Define two agents with distinct drives and starting rooms:
    - **Alice** (`agent-alice`): `startRoomId: "bedroom"`, `initialDrives: { energy: 15, hunger: 60, social: 40, comfort: 50, curiosity: 30 }`, traits `["diligent", "caffeine-dependent"]`, description "A caffeine-dependent researcher who needs coffee to start the day."
    - **Bob** (`agent-bob`): `startRoomId: "living_room"`, `initialDrives: { energy: 50, hunger: 40, social: 15, comfort: 60, curiosity: 50 }`, traits `["social", "easygoing"]`, description "A social morning person who wants to chat and relax."

23. **Scene assembly** — The `SceneDefinition` must be exported as `MORNING_ROUTINE_SCENE`. The entry point must call `createEngineCore`, `loadScene`, `registerAffordanceHandlers(core)`, construct the PPER orchestrator (with mock or real LLM), `assembleGameLoop`, and `gameLoop.start()`. Must follow the same pattern as `examples/minimal-scene.ts`.

24. **Drive-aware mock LLM** — The mock LLM for the Morning Routine scene must select actions based on the agent's primary drive label passed in the `LLMContextPayload`. It must return a `FormulatePlanResult` whose first step's `targetAffordance` targets an affordance available in the agent's current room that addresses the primary drive. For example, if the primary drive is "energy", it returns a plan targeting `brew_coffee` (if in kitchen) or `sleep` (if in bedroom) or a `go_to_kitchen` step (if in another room). This demonstrates drive prioritization with a mock.

### Scene 2: "Office Day" (`examples/office-day.ts`)

25. **Room definitions** — Define four connected rooms:
    - `office`: name "Office", connections `["break_room", "meeting_room"]`
    - `break_room`: name "Break Room", connections `["office", "bathroom"]`
    - `meeting_room`: name "Meeting Room", connections `["office"]`
    - `bathroom`: name "Bathroom", connections `["break_room"]`

26. **Object definitions** — Define smart objects:
    - **Computer** (`computer-1`, office): state `{ tasks_completed: 0 }`, affordances: `work` (effects: `{ energy: -15 }`), `observe`
    - **Whiteboard** (`whiteboard-1`, meeting_room): state `{ ideas_generated: 0 }`, affordances: `brainstorm` (effects: `{ curiosity: 15, social: 5, energy: -10 }`), `observe`
    - **Coffee Machine** (`coffee-2`, break_room): state `{ water_level: 8, bean_count: 20 }`, affordances: `brew_coffee` (preconditions: `["has_water", "has_beans"]`, effects: `{ energy: 20 }`), `observe`
    - **Water Cooler** (`cooler-1`, break_room): state `{}`, affordances: `small_talk` (effects: `{ social: 15, energy: -2 }`), `observe`
    - **Meeting Table** (`table-1`, meeting_room): state `{ meetings_held: 0 }`, affordances: `hold_meeting` (effects: `{ social: 20, energy: -15, comfort: -5 }`), `observe`
    - **Printer** (`printer-1`, office): state `{ paper_count: 50 }`, affordances: `print_document` (preconditions: `["has_paper"]`, effects: `{ curiosity: 2 }`), `observe`
    - **Toilet** (`toilet-1`, bathroom): state `{}`, affordances: `use_bathroom` (effects: `{ comfort: 10 }`), `observe`
    - **Sink** (`sink-1`, bathroom): state `{}`, affordances: `wash_hands` (effects: `{ comfort: 5 }`), `observe`
    - **Doorway objects** — One per room, with `go_to_<roomId>` affordances for each connected room.

27. **Agent definitions** — Define three agents:
    - **Alice** (`agent-alice`): `startRoomId: "office"`, `initialDrives: { energy: 40, hunger: 50, social: 30, comfort: 50, curiosity: 60 }`, traits `["diligent", "caffeine-dependent"]`, description "A researcher at work."
    - **Bob** (`agent-bob`): `startRoomId: "break_room"`, `initialDrives: { energy: 60, hunger: 40, social: 20, comfort: 50, curiosity: 40 }`, traits `["social", "easygoing"]`, description "A social coworker on break."
    - **Carol** (`agent-carol`): `startRoomId: "meeting_room"`, `initialDrives: { energy: 70, hunger: 30, social: 50, comfort: 40, curiosity: 50 }`, traits `["assertive", "organized"]`, description "The boss who runs meetings."

28. **Scene assembly** — The `SceneDefinition` must be exported as `OFFICE_DAY_SCENE`. The entry point must follow the same assembly pattern as the Morning Routine scene.

29. **Drive-aware mock LLM** — Same as Req 24, but with office-appropriate affordance mapping. If the primary drive is "social", return a plan targeting `small_talk` (if in break_room) or `hold_meeting` (if in meeting_room) or `go_to_break_room` (if elsewhere).

### Tests (`packages/engine/tests/richer-scenes.test.ts`)

30. **Scene definition validation test** — Test that `MORNING_ROUTINE_SCENE` has 4 rooms, 6 non-doorway objects + 4 doorway objects = 10 objects, and 2 agents. Test that `OFFICE_DAY_SCENE` has 4 rooms, 8 non-doorway objects + 4 doorway objects = 12 objects, and 3 agents. Verify room connections are bidirectional (if A connects to B, B connects to A).

31. **Multi-room navigation test** — Load the Morning Routine scene, place an agent in `bedroom`, and execute the `go_to_living_room` affordance via the registered handler. Assert that `sceneManager.getAgentRoom(agentId)` returns the Living Room. Then execute `go_to_kitchen` and assert the agent is in the Kitchen.

32. **Object state depletion test** — Load the Morning Routine scene, execute `brew_coffee` on the Coffee Machine 3 times. Assert that `water_level` has decreased by 3 (from 5 to 2) and `bean_count` has decreased by 3 (from 12 to 9). Execute `brew_coffee` again 2 more times and assert `water_level` is 0. Attempt to execute `brew_coffee` once more and assert the precondition `has_water` fails.

33. **Multi-agent concurrency test** — Load the Office Day scene with 3 agents. Run the game loop for N ticks with a `FakeOrchestrator` that records `runCycle` calls. Assert that all 3 agents have at least one `runCycle` call recorded when `maxConcurrentCycles >= 3`. Assert that with `maxConcurrentCycles: 2`, only 2 agents start cycles on the first tick.

34. **Drive prioritization test** — Load the Morning Routine scene. Place Alice (energy: 15) in the Kitchen and Bob (social: 15) in the Living Room. Run one PPER cycle for each with a mock that selects affordances based on primary drive. Assert that Alice's plan targets `brew_coffee` (energy restoration) and Bob's plan targets an affordance that restores a non-energy drive (e.g., `watch_tv` for comfort or `read_book` for curiosity, since no social affordance exists in the Living Room).

35. **Precondition enforcement test** — Load the Morning Routine scene. Set the Coffee Machine's `water_level` to 0. Attempt to execute `brew_coffee` and assert the precondition `has_water` fails, producing a `failureReason` containing "has_water". Set `water_level` back to 5, set `bean_count` to 0, and assert `has_beans` fails.

36. **Per-agent starting rooms test** — Load the Morning Routine scene. Assert Alice's `location` is `"bedroom"` and Bob's `location` is `"living_room"` immediately after `loadScene`. Load the Office Day scene and assert Alice is in `"office"`, Bob is in `"break_room"`, and Carol is in `"meeting_room"`.

## Acceptance Criteria

- [ ] **AC-1**: `AgentProfile` in `packages/shared/src/types/agent.ts` includes optional field `startRoomId?: string`. Existing `AgentProfile` objects without `startRoomId` compile without error. *(Req 1)*
- [ ] **AC-2**: `loadScene` uses `profile.startRoomId` when present. Given a `SceneDefinition` with two agents where agent A has `startRoomId: "bedroom"` and agent B has `startRoomId: "kitchen"`, after `loadScene`, agent A's `location` is `"bedroom"` and agent B's `location` is `"kitchen"`. When `startRoomId` is absent, the agent spawns in `scene.rooms[0].id`. *(Req 2)*
- [ ] **AC-3**: `examples/scene-helpers.ts` exports `registerAffordanceHandlers(core: EngineCore)` that registers handlers for all affordance IDs listed in Req 3. Calling `affordanceRegistry.getHandler('sleep')` (and each other ID) returns a non-null handler after registration. *(Req 3)*
- [ ] **AC-4**: The `brew_coffee` handler decrements `water_level` and `bean_count` by 1 each and returns `driveChanges: { energy: 20 }`. After 3 calls on a Coffee Machine with `water_level: 5, bean_count: 12`, the object state shows `water_level: 2, bean_count: 9`. *(Req 4)*
- [ ] **AC-5**: The `sleep` handler returns `driveChanges: { energy: 30, comfort: -5 }` with no object state change. *(Req 5)*
- [ ] **AC-6**: The `take_shower` handler decrements `water_level` by 1 and returns `driveChanges: { comfort: 25, energy: -5 }`. *(Req 6)*
- [ ] **AC-7**: The `watch_tv` handler returns `driveChanges: { comfort: 15, energy: -5, curiosity: 5 }` and sets `powered_on: false` in the new state. *(Req 7)*
- [ ] **AC-8**: The `read_book` handler decrements `book_count` by 1 and returns `driveChanges: { curiosity: 20, energy: -10 }`. When `book_count` is 0, it returns `{ success: false, failureReason: "No books left" }`. *(Req 8)*
- [ ] **AC-9**: The `go_outside` handler returns `{ success: true }` and logs a message containing the agent ID. No drive changes are applied. *(Req 9)*
- [ ] **AC-10**: The `work` handler returns `driveChanges: { energy: -15 }` and increments `tasks_completed` by 1 in the new state. *(Req 10)*
- [ ] **AC-11**: The `brainstorm` handler returns `driveChanges: { curiosity: 15, social: 5, energy: -10 }` and increments `ideas_generated` by 1. *(Req 11)*
- [ ] **AC-12**: The `small_talk` handler returns `driveChanges: { social: 15, energy: -2 }` with no object state change. *(Req 12)*
- [ ] **AC-13**: The `hold_meeting` handler returns `driveChanges: { social: 20, energy: -15, comfort: -5 }` and increments `meetings_held` by 1. *(Req 13)*
- [ ] **AC-14**: The `use_bathroom` handler returns `driveChanges: { comfort: 10 }` with no object state change. *(Req 14)*
- [ ] **AC-15**: The `wash_hands` handler returns `driveChanges: { comfort: 5 }` with no object state change. *(Req 15)*
- [ ] **AC-16**: The `print_document` handler decrements `paper_count` by 1 and returns `driveChanges: { curiosity: 2 }`. When `paper_count` is 0, it returns `{ success: false, failureReason: "Printer out of paper" }`. *(Req 16)*
- [ ] **AC-17**: A `go_to_kitchen` handler, when invoked with an agent in `living_room`, calls `sceneManager.moveAgent(agentId, 'kitchen')` and returns `{ success: true }`. After the call, `sceneManager.getAgentRoom(agentId)` returns the Kitchen room. *(Req 17)*
- [ ] **AC-18**: Precondition checkers `has_water`, `has_beans`, `is_powered`, `has_books`, `has_paper` are registered. `has_water` returns `true` when `state.water_level > 0` and `false` when `state.water_level === 0`. `is_powered` returns `true` when `state.powered_on === true`. *(Req 19)*
- [ ] **AC-19**: `MORNING_ROUTINE_SCENE` has 4 rooms (`bedroom`, `bathroom`, `living_room`, `kitchen`) with bidirectional connections. `bedroom.connections` includes `"bathroom"` and `"living_room"`; `living_room.connections` includes `"bedroom"`, `"bathroom"`, and `"kitchen"`; `kitchen.connections` includes `"living_room"`. *(Req 20)*
- [ ] **AC-20**: `MORNING_ROUTINE_SCENE` has a Bed in `bedroom`, a Shower in `bathroom`, a TV and Bookshelf and Front Door in `living_room`, a Coffee Machine in `kitchen`, and a Doorway object in each room with `go_to_*` affordances matching the room's `connections`. Each non-doorway object has the correct affordances and preconditions per Req 21. *(Req 21)*
- [ ] **AC-21**: `MORNING_ROUTINE_SCENE` has 2 agents: Alice with `startRoomId: "bedroom"` and `initialDrives.energy: 15`, Bob with `startRoomId: "living_room"` and `initialDrives.social: 15`. *(Req 22)*
- [ ] **AC-22**: `examples/morning-routine.ts` exports `MORNING_ROUTINE_SCENE` and `buildMorningRoutineEngine()`. Calling `buildMorningRoutineEngine()` returns an `AssembledEngine` with all affordance handlers registered. The simulation runs without errors when `gameLoop.start()` is called. *(Req 23)*
- [ ] **AC-23**: The Morning Routine mock LLM returns a `FormulatePlanResult` whose first step's `targetAffordance` is `"brew_coffee"` when the primary drive label contains "energy" and the agent is in the Kitchen. When the agent is in the Bedroom and the primary drive is "energy", it returns a plan with `targetAffordance: "go_to_kitchen"` (or `"sleep"`). *(Req 24)*
- [ ] **AC-24**: `OFFICE_DAY_SCENE` has 4 rooms (`office`, `break_room`, `meeting_room`, `bathroom`) with bidirectional connections. `office.connections` includes `"break_room"` and `"meeting_room"`; `break_room.connections` includes `"office"` and `"bathroom"`. *(Req 25)*
- [ ] **AC-25**: `OFFICE_DAY_SCENE` has a Computer in `office`, a Whiteboard in `meeting_room`, a Coffee Machine and Water Cooler in `break_room`, a Meeting Table in `meeting_room`, a Printer in `office`, a Toilet and Sink in `bathroom`, and a Doorway in each room. Each object has the correct affordances and preconditions per Req 26. *(Req 26)*
- [ ] **AC-26**: `OFFICE_DAY_SCENE` has 3 agents: Alice (`startRoomId: "office"`), Bob (`startRoomId: "break_room"`), Carol (`startRoomId: "meeting_room"`). Each has distinct `initialDrives` per Req 27. *(Req 27)*
- [ ] **AC-27**: `examples/office-day.ts` exports `OFFICE_DAY_SCENE` and `buildOfficeDayEngine()`. Calling `buildOfficeDayEngine()` returns an `AssembledEngine` with all affordance handlers registered. The simulation runs without errors when `gameLoop.start()` is called. *(Req 28)*
- [ ] **AC-28**: The Office Day mock LLM returns a plan targeting `small_talk` when the primary drive is "social" and the agent is in the Break Room. When the agent is in the Office and the primary drive is "social", it returns a plan with `targetAffordance: "go_to_break_room"`. *(Req 29)*
- [ ] **AC-29**: `MORNING_ROUTINE_SCENE` has 4 rooms, 10 objects (6 non-doorway + 4 doorway), and 2 agents. `OFFICE_DAY_SCENE` has 4 rooms, 12 objects (8 non-doorway + 4 doorway), and 3 agents. All room connections are bidirectional. *(Req 30)*
- [ ] **AC-30**: After loading the Morning Routine scene and executing `go_to_living_room` on an agent in `bedroom`, `sceneManager.getAgentRoom(agentId)` returns the Living Room. After then executing `go_to_kitchen`, the agent is in the Kitchen. *(Req 31)*
- [ ] **AC-31**: After executing `brew_coffee` 3 times on the Morning Routine Coffee Machine (`water_level: 5, bean_count: 12`), the object state shows `water_level: 2, bean_count: 9`. After 2 more executions, `water_level: 0`. A 6th execution attempt fails the `has_water` precondition. *(Req 32)*
- [ ] **AC-32**: Loading the Office Day scene with 3 agents and a `FakeOrchestrator`, running the game loop for 1 tick with `maxConcurrentCycles >= 3` results in 3 `runCycle` calls. With `maxConcurrentCycles: 2`, only 2 `runCycle` calls are recorded on the first tick. *(Req 33)*
- [ ] **AC-33**: Alice (energy: 15) in the Kitchen produces a plan targeting `brew_coffee`. Bob (social: 15) in the Living Room produces a plan targeting a non-energy affordance (e.g., `watch_tv`, `read_book`, or `go_to_*` to reach a social affordance). *(Req 34)*
- [ ] **AC-34**: When the Coffee Machine has `water_level: 0`, executing `brew_coffee` fails with a `failureReason` containing "has_water". When `bean_count: 0` (and `water_level > 0`), it fails with "has_beans". *(Req 35)*
- [ ] **AC-35**: After `loadScene` with the Morning Routine scene, Alice's `location` is `"bedroom"` and Bob's `location` is `"living_room"`. After `loadScene` with the Office Day scene, Alice is in `"office"`, Bob in `"break_room"`, Carol in `"meeting_room"`. *(Req 36)*

## Constraints

- **Package boundaries** (per ADR-0001): `engine` and `cognition` must not directly import from each other. Scene definitions and entry points live in `examples/` and may import from all packages. Affordance handlers are registered in the entry point (or `examples/scene-helpers.ts`) via closures — they capture engine subsystems (`SceneManager`, `SmartObjectRegistry`) without coupling `cognition` to `engine`.
- **No PPER loop changes**: This spec does not modify any PPER phase logic (perceive, plan, execute, reflect), the game loop, the PPERScheduler, or the orchestrator. All infrastructure from specs 001–005, 008, 011, 012 is reused as-is.
- **No new engine systems**: No new `EngineSystem` implementations. The `DriveDecaySystem`, `PPERScheduler`, and `SpatialSystem` from spec 005 are reused unchanged.
- **Movement is teleport**: `go_to_*` affordance handlers call `sceneManager.moveAgent` directly — no pathfinding, no travel time, no intermediate states. Pathfinding and room-graph traversal are future concerns.
- **Social interactions are object-based**: Social affordances (`small_talk`, `hold_meeting`, `brainstorm`) are on smart objects, not on agents. Direct agent-to-agent affordance targeting is not implemented. Structured social dynamics are a future concern (per ROADMAP "Multi-Agent Social").
- **Scene transitions are stubbed**: `go_outside` logs a message and returns success. Actual cross-scene transitions (loading a new `SceneDefinition` mid-simulation) are out of scope.
- **Mock LLM for prototype**: Both scene entry points must work with mock LLM implementations (as in `examples/minimal-scene.ts`). Real LLM integration is supported via `USE_REAL_LLM=true` but not required for tests.
- **Backward compatibility**: The `startRoomId` field on `AgentProfile` is optional. The existing `examples/minimal-scene.ts` and all existing tests must compile and pass without modification.
- **Doorway pattern**: Each room has a single Doorway smart object (type `"doorway"`) with one `go_to_<roomId>` affordance per connection. The affordance ID encodes the destination. This is the simplest approach that works with the existing `resolveAffordance(roomId, affordanceId)` flow — no changes to the execute service are needed.
- **Handler registration order**: Affordance handlers must be registered after `loadScene` (so the `SceneManager` is populated with rooms) and before `assembleGameLoop` (so the game loop can start immediately). The `scene-helpers.ts` function receives `core: EngineCore` and captures `core.sceneManager` after `loadScene` has run.
- **What NOT to do**:
  - Do not modify PPER phase logic, the game loop, the scheduler, or the orchestrator.
  - Do not implement pathfinding, A* search, or room-graph traversal algorithms.
  - Do not implement direct agent-to-agent affordance targeting or a relationship graph.
  - Do not implement cross-scene transitions or scene loading mid-simulation.
  - Do not add visual rendering, a UI, or a game server.
  - Do not add new npm dependencies.
  - Do not modify the `AffordanceHandler` signature or `PhysicsSystemImpl`.
  - Do not change the `resolveAffordance` method or the execute service flow.
  - Do not re-implement `brew_coffee` or `observe` handlers — reuse from the minimal scene pattern.
