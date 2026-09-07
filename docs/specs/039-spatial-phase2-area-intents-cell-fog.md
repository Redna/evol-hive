# Spec 039 — Spatial Navigation Phase 2: `targetArea` Intents, Cell-Level Fog, Social Fog-Lifting, Determinism

## Context

- Architecture: [§2 System Overview](../architecture/02-system-overview.md) (spatial layer), [§3 Agent State Schema](../architecture/03-agent-state-schema.md) (position + spatial memory), [§6 PPER Loop](../architecture/06-pper-loop.md) (Execute becomes navigation-aware), [§9 Engine Routing](../architecture/09-engine-routing.md) (pathfinding service)
- Related specs: [038 — Spatial Navigation & Fog of War](038-spatial-navigation-fog-of-war.md) (**parent** — this spec implements the R3/R4 remainder + AC-2/3/4/5/6), [037 — Enum-Bound Plan Formulation](037-enum-bound-plan-formulation.md) (enum pattern to reuse), [030 — Dynamic Scenes](030-dynamic-scenes-living-worlds.md) (topology/doors), [031 — Execute Co-location Guard](031-execute-colocation-guard.md), [017/033 — Persistence](017-persistence-save-load-game-state.md) (save v3), [022/023 — Visual Output](023-visual-output-canvas-renderer.md) (fog rendering)
- Package: shared, engine, cognition, visualizer
- Issue: [#144](https://github.com/Redna/evol-hive/issues/144) · tracks the spec 038 progress issue [#143](https://github.com/Redna/evol-hive/issues/143) (first slice R1/R2/R5 implemented in `8c38f9b`)
- Status: 📝 Drafted

## Problem

Spec 038's first slice delivered the grid model (R1), BFS pathfinding + tick-integrated walking (R2), and room-level spatial memory with a curiosity reward (R4/R5 partial). The remainder of the 038 contract is still open, and each gap is visible in behavior:

1. **The LLM cannot say WHERE a step happens.** Plans carry only `targetAffordance` (spec 037), so an agent executes affordances wherever it happens to stand. Nobody walks to the workshop to use the workbench — AC-2 stays unchecked.
2. **Fog is room-granular only.** `spatialMemory` records visited rooms and seen doors, but passive perception still surfaces every object of a *visited* room regardless of where the agent has actually been, and the context renders no unknown markers — the LLM has no vocabulary for "I know there is a door west, I have not been there" (AC-3 partial).
3. **Talk teaches nothing spatial.** `talk_to` (spec 024/033) updates relationships and conversations but transfers no sightings — AC-4 unchecked.
4. **Persistence is unverified.** `position` and `spatialMemory` ride on `AgentInternalState`, but no test proves they round-trip through save v3.
5. **No determinism regression net (R7/AC-6) and no fog shading (AC-5 remainder).** Nothing fails if a future change makes paths RNG-dependent or the canvas renders unexplored rooms as if explored.

## Requirements

1. **`targetArea` on plan steps, enum-bound (spec 038 R3, cognition + shared)**: `formulatePlanSchemaFor` / `formulatePlanToolFor` gain an optional per-step `targetArea` built per cycle exactly like the spec 037 `targetAffordance` enum. Valid values = the agent's **known** object anchors (objects in `spatialMemory`-visible areas) + known room/area names. `targetArea` stays out of `required` (spec 037 lesson: required fields break the backend); the validator is the backstop because Ollama does not hard-enforce enums.
2. **Fog-bound enum (spec 038 constraint)**: the `targetArea` enum contains ONLY areas the agent knows from spatial memory — never cell coordinates, never areas the agent has not discovered. An agent with no known areas collapses the enum to its current room (the LLM is never trapped).
3. **Navigation-first execution (spec 038 R3, engine + cognition)**: when a plan step carries `targetArea`, the engine first navigates (`NavigationSystem.requestWalk` through the WorldGrid/door graph), then executes the step's affordance **on arrival**. Same-cell steps keep the spec 037 contract unchanged; the spec 031 co-location guard still validates colocation at execution time.
4. **Cell-level fog in perception (spec 038 R4, engine + cognition)**: passive perception covers only explored/visible cells. Objects outside the agent's explored area do NOT enter `prunedAffordances` or the perception object list. `spatialMemory` extends from room-level to cell-level tracking (explored cells / observed objects with last-seen state), keeping the existing `visitedRooms`/`knownDoors` shape backward compatible.
5. **Unknown markers in context (spec 038 R4)**: the context renders known-but-unexplored areas as explicit markers ("a door west — unexplored") so the LLM can reason about exploration without seeing coordinates.
6. **Social fog-lifting (spec 038 R4)**: `talk_to` transfers the speaker's sightings (known areas/doors/objects) into the listener's spatial memory — bounded by what the speaker actually knows.
7. **Persistence round-trip (spec 038 R4)**: `spatialMemory` + `position` survive save/load in save format v3 (all fields optional, `MIN_SUPPORTED_SAVE_FORMAT_VERSION` unchanged) — covered by a serialization test.
8. **Determinism test (spec 038 R7 / AC-6)**: same initial state + same plan → identical cell paths. Paths remain pure functions of grid state + door state (BFS tie-break: lowest index; no RNG, no `Date.now()`-dependent path decisions).
9. **Visualizer fog shading (spec 038 R6 / AC-5 remainder)**: the canvas renderer shades unexplored cells (fog overlay) on top of the existing grid/agent rendering.
10. **QA pass over the whole 038 slice**: QA verifies the first-slice ACs (038 AC-1/AC-5 partial/AC-7) plus phase-2 ACs below, including updated system-order assertions.

## Acceptance Criteria

- [ ] AC-1 (Req 1–2): `formulatePlanSchemaFor` emits a per-step `targetArea` enum containing exactly the agent's known areas/anchors — no coordinates, no undiscovered areas; an agent with no spatial knowledge gets a non-empty fallback enum (current room).
- [ ] AC-2 (Req 3, 038 AC-2 full): a plan step `targetArea: 'workshop'` routes the agent through the door graph (multi-room), movement spans multiple ticks, `location` changes on door crossing, and the affordance executes on arrival.
- [ ] AC-3 (Req 3, backward compat): `targetAffordance`-only plan steps (spec 037 contract) execute unchanged in the same cell — no navigation triggered.
- [ ] AC-4 (Req 4, 038 AC-3): objects in unexplored areas produce NO affordances/object entries in perception; after the agent explores the area they do appear.
- [ ] AC-5 (Req 5): context output contains explicit unknown markers for known-but-unexplored doors/areas and contains no cell coordinates.
- [ ] AC-6 (Req 6, 038 AC-4): after `talk_to` about a discovery, the listener's spatial memory contains the transferred sighting and the listener's subsequent perception exposes the area.
- [ ] AC-7 (Req 7): save → load → save round-trip preserves `spatialMemory` and `position` byte-identically at format v3; v1/v2 saves still load.
- [ ] AC-8 (Req 8, 038 AC-6): determinism test — two runs from the same initial state with the same plan produce identical cell paths (and paths are stable across a save/load cycle).
- [ ] AC-9 (Req 9, 038 AC-5 remainder): renderer output distinguishes unexplored cells (fog shading) from explored cells — unit-testable against the render state.
- [ ] AC-10 (Req 10, no regression): engine + cognition suites ≤ pre-existing failures; system-order assertions updated and green; `pnpm typecheck`, `pnpm lint`, `pnpm format:check` pass.
- [ ] AC-11 (Req 10, QA protocol): full 038 slice verified against spec 038 AC-1..AC-7 in a QA pass (first-slice + phase-2 items).

## Constraints

- **Division of labor**: the LLM reasons over areas/objects it KNOWS — never cell coordinates. The engine owns paths, timing, occupancy (`packages/engine/src/spatial/`); cognition consumes `targetArea` enums + fog-filtered perception; shared defines types.
- **Package boundaries**: grid/pathfinding stay in `engine/spatial/`; no import cycles; `shared` gains only types/schemas.
- **Spec 037 pattern reuse**: `targetArea` enum is built per cycle in the dynamic tool-definition block (never the KV-cache-stable system prefix, spec 021); enum constrains values only — no nested per-step args (known backend failure surface, `2267354`).
- **Backward compat**: scenes without anchors auto-assign grid positions deterministically (seeded layout, `hash32` + linear probing — already in `grid.ts`); `targetAffordance`-only plans keep working; v1/v2 saves still load (spec 030/033 pattern).
- **Determinism**: movement and paths are tick-integrated, one cell per tick, no RNG; `spatialMemory.discoveredAt` should record simulation time where feasible (`Date.now()` is wall-clock and weakens replay fidelity of the audit trail — not path-affecting).
- **What NOT to do**: do not add line-of-sight/visibility simulation (038 non-goal), do not add weighted A* (all cells cost 1), do not block the synchronous game loop on LLM calls.

## Non-goals

- Continuous real-time physics or collision beyond cell occupancy.
- Line-of-sight/visibility simulation beyond explored-cell tracking (follow-up candidate).
- Social fog-lifting via overheard third-party conversation (only direct `talk_to` transfer).
