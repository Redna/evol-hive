# YAAM Workspace Note — feature-013-richer-prototype-scenes

## Task
Implement spec 013 (Richer Prototype Scenes — Multi-Room, Multi-Object, Multi-Agent) for GitHub issue #45.

## What was built (PR #49, branch feature/013-richer-prototype-scenes)

### Shared layer
- Added optional `startRoomId?: string` field to `AgentProfile` in `packages/shared/src/types/agent.ts` (backward compatible — existing profiles without it still compile).

### Engine layer
- Modified `loadScene` in `packages/engine/src/assembly.ts` to use `profile.startRoomId` when present, falling back to `scene.rooms[0].id` when absent.

### Examples
- `examples/scene-helpers.ts` — Shared `registerAffordanceHandlers(core: EngineCore)` registering 15 affordance handlers (sleep, brew_coffee, observe, take_shower, watch_tv, read_book, go_outside, work, brainstorm, small_talk, hold_meeting, use_bathroom, wash_hands, print_document, go_to_*) and 5 precondition checkers (has_water, has_beans, is_powered, has_books, has_paper). Movement handlers capture `core.sceneManager` and call `moveAgent` (teleport).
- `examples/morning-routine.ts` — "Morning Routine" scene: 4 rooms (bedroom, bathroom, living_room, kitchen), 6 non-doorway objects + 4 doorway objects, 2 agents (Alice in bedroom energy=15, Bob in living_room social=15). Drive-aware mock LLM parses primary drive label + room from perceptionContext and selects an affordance addressing the drive. Exports `MORNING_ROUTINE_SCENE`, `buildMorningRoutineEngine()`, `MorningRoutineMockLLMClient`.
- `examples/office-day.ts` — "Office Day" scene: 4 rooms (office, break_room, meeting_room, bathroom), 8 non-doorway objects + 4 doorway objects, 3 agents (Alice/office, Bob/break_room, Carol/meeting_room). Social affordances via objects (Water Cooler→small_talk, Meeting Table→hold_meeting, Whiteboard→brainstorm). Exports `OFFICE_DAY_SCENE`, `buildOfficeDayEngine()`, `OfficeDayMockLLMClient`.

### Tests
- `packages/engine/tests/richer-scenes.test.ts` — 56 tests covering AC-1..AC-35: startRoomId on AgentProfile, loadScene per-agent starting rooms, registerAffordanceHandlers, all 15 handlers, precondition checkers, scene definition validation (room counts, bidirectional connections, object placement, agent drives), multi-room navigation via doorway go_to_* handlers, object state depletion (Coffee Machine water/beans), multi-agent concurrency with FakeOrchestrator (maxConcurrentCycles enforcement), drive prioritization (mock LLM selects affordance by primary drive + room), precondition enforcement (has_water/has_beans failures).

## Key design decisions (from .pi/notes/013-design-decisions.md)
1. Doorway pattern: each room has a "doorway" smart object with go_to_<roomId> affordances per connection — works within existing resolveAffordance flow, no engine changes.
2. Per-agent starting rooms via optional startRoomId on AgentProfile — backward compatible.
3. Social interactions via objects (Water Cooler, Meeting Table, Whiteboard), not agent-to-agent targeting.
4. go_outside is a stub that logs and returns success — cross-scene transitions out of scope.
5. Shared handler library in examples/scene-helpers.ts — DRY across both scenes.
6. Drive-aware mock LLM parses perceptionContext string for room + primary drive label.

## Test results
- 239 tests pass (56 new), typecheck clean, lint clean, format clean, build succeeds.
- Both example scenes run without errors via `npx tsx`.