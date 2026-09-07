# Spec 039 — Spatial Navigation Phase 2: `targetArea` LLM Intents, Cell-Level Fog, Social Fog-Lifting, Determinism + QA Pass

## Context

- Architecture: [§2 System Overview](../architecture/02-system-overview.md), [§3 Agent State Schema](../architecture/03-agent-state-schema.md), [§4 Smart Objects](../architecture/04-smart-objects.md), [§6 PPER Loop](../architecture/06-pper-loop.md), [§7 Structured Outputs](../architecture/07-structured-outputs.md), [§9 Engine Routing](../architecture/09-engine-routing.md)
- Related specs: [038 — Spatial Navigation & Fog of War](038-spatial-navigation-fog-of-war.md) (phase 2 of its R3/R4 + determinism AC-6 + visualizer remainder; first slice R1/R2/R5 implemented in `8c38f9b`, tracked in [#143](https://github.com/Redna/evol-hive/issues/143)), [037 — Enum-Bound Plan Formulation](037-enum-bound-plan-formulation.md) (`formulatePlanSchemaFor` pattern, validator + one-retry), [030 — Dynamic Scenes](030-dynamic-scenes-living-worlds.md) (event-sourced topology/mutations), [031 — Co-Location Guard](031-execute-colocation-guard.md), [017 — Persistence](017-persistence-save-load-game-state.md)
- Package: shared, engine, cognition, visualizer
- Issue: [#144](https://github.com/Redna/evol-hive/issues/144)

## Problem

Spec 038's first slice delivered the grid model, tick-integrated walking, engine-side BFS pathfinding, room-level spatial memory and the curiosity reward (R1/R2/R5). What is still missing for the user-directed vision ("the LLM says _what and where_ at area level; the engine finds the path"):

1. **No `targetArea` intent (R3)** — plan steps can only bind `targetAffordance` (spec 037). The LLM cannot say "go to the workshop"; agents only act on affordances resolvable in their *current* room, so multi-room chains (garden → gate → workshop) are unreachable from the planner.
2. **No cell-level fog (R4)** — `spatialMemory` tracks visited rooms only; passive perception still exposes every object in the world regardless of exploration. Unexplored areas leak into `prunedAffordances` and the object list, so the LLM "knows" things it never observed.
3. **No social fog-lifting** — `talk_to` (spec 033 conversations) does not transfer sightings between spatial memories.
4. **Spatial memory + position do not round-trip** in the save format.
5. **AC-6 (determinism) and the visualizer fog shading (AC-5) remain unverified/unimplemented**, and the whole 038 slice has not had a QA pass against AC-1..AC-7.

## Requirements

### R1 — `targetArea` plan-step field (shared + cognition)

- Plan steps gain an optional `targetArea` field. The per-cycle `formulatePlanSchemaFor`/`formulatePlanToolFor` builders (spec 037 pattern) build a **static enum per cycle** whose valid values are: the agent's **KNOWN object anchors** + **known room/area names** (from `spatialMemory`) — plus an escape value (`stay`/omit) so the model is never trapped.
- The enum must **only** contain KNOWN areas (fog requirement): unvisited rooms and never-seen objects never appear as legal values.
- `targetArea` stays out of `required` (spec 037 lesson: required fields broke the backend, `2267354`); the validator enforces membership with exactly one CORRECTION-feedback retry.

### R2 — Navigate-then-execute (cognition + engine)

- When an execute step carries `targetArea`, the engine first navigates (`NavigationSystem.requestWalk` through `WorldGrid`) and executes the bound affordance **on arrival**; the step does not complete while the walk is in progress.
- Same-cell steps (no `targetArea`) keep the spec-037 contract unchanged: co-location guard (spec 031), guardrails (spec 016), step-skip livelock guard (spec 037) all behave as before.
- A `targetArea` with no open route fails the step through the existing failed-step path (reflection tick, livelock guard) — no silent advance.

### R3 — Fog-filtered passive perception (engine + cognition)

- Passive perception covers only explored/visible cells: objects outside the agent's explored area do **not** enter `prunedAffordances` or the object list.
- Unknowns are rendered in the context as explicit markers ("a door west — unexplored"), never as interactable objects or affordances.
- World mutations (spec 030) only enter an agent's knowledge when observed.

### R4 — Social fog-lifting via `talk_to` (engine + cognition)

- `talk_to` (spec 033 conversation bridge) transfers the speaker's sightings (rooms visited, doors known, objects observed) to the listener's spatial memory, marked as secondhand (distinguishing "seen" from "told" where cheap to do so).

### R5 — Persistence round-trip (engine)

- `spatialMemory` and agent `position` serialize/deserialize in the save format (verify/bump the format version to v3); old saves still load; save/load replay does not alter paths (ties into R7 determinism).

### R6 — Determinism (engine)

- Paths are pure functions of grid state + door state: same initial state + same plan → identical paths. BFS tie-break is deterministic (lowest index); no RNG anywhere in `engine/spatial/`.

### R7 — Visualizer fog shading (visualizer)

- Unexplored cells render with fog shading; explored cells render normally; agents render at true cell positions (walking animation from the first slice is retained).

### R8 — QA pass (protocol)

- QA verifies the whole spec-038 slice against AC-1..AC-7 of spec 038 (first-slice AC-1/AC-5/AC-7 already partially demonstrated + this phase's ACs), including the updated system-order assertions in `assembly.test.ts` (SceneMutations → Navigation → SpatialSystem → DriveDecay → ObjectState → PPERScheduler).

## Acceptance Criteria

Each requirement maps to at least one criterion below.

- [ ] **AC-1** (spec 038 AC-2, full): a plan step with `targetArea: 'workshop'` walks the agent through the door graph to the workshop over multiple ticks; execution fires **on arrival** — engine/cognition test (R1, R2)
- [ ] **AC-2**: the `targetArea` enum in `formulatePlanSchemaFor` contains only the agent's known areas/anchors for that cycle; an unvisited room is never a legal enum value — unit-tested (R1)
- [ ] **AC-3** (spec 038 AC-3): a never-visited room produces no affordances/objects in passive perception; after exploration (arrival or `talk_to` transfer) it does — test (R3, R4)
- [ ] **AC-4**: the LLM context renders unexplored directions as unknown markers ("a door west — unexplored") and does not list their objects — perception-builder test (R3)
- [ ] **AC-5** (spec 038 AC-4): `talk_to` about a discovery transfers it to the listener's spatial memory (social fog-lifting) — conversation-manager/social test (R4)
- [ ] **AC-6**: save → load round-trips `spatialMemory` + `position`; old-format saves still load — persistence test (R5)
- [ ] **AC-7** (spec 038 AC-6): determinism test green — same initial state + same plan → identical paths, across two fresh engine instances and across a save/load cycle — test (R6)
- [ ] **AC-8** (spec 038 AC-5 remainder): visualizer renders fog shading over unexplored cells and explored cells unshaded — visualizer adapter test (R7)
- [ ] **AC-9** (QA, R8): the full spec-038 AC-1..AC-7 checklist passes in a QA session, including updated system-order assertions
- [ ] **AC-10** (regression): all system-order assertions pass; engine/cognition suites show ≤ pre-existing failures; spec-037 `targetAffordance`-only plans keep working unchanged

## Constraints

- **Cognition stays spatially abstract** (ADR-0001 division of labor): the LLM reasons over areas/objects it KNOWS — never over cell coordinates. No coordinates in schemas, enums, or context.
- **Package boundaries**: grid + pathfinding live in `engine/spatial/`; cognition consumes `targetArea` enums and fog-filtered perception; shared defines the types. No new cross-package imports (shared ← engine, shared ← cognition, memory ← cognition only).
- **KV-cache (spec 021)**: the `targetArea` enum lives inside the per-cycle tool-definition block (spec 037 placement), never in the stable system prompt prefix; a known-map summary, if added to context, goes in the dynamic per-cycle block only.
- **Backward compatibility**: scenes without anchors auto-assign grid positions deterministically (FNV-1a seeded layout, already in `grid.ts`); `targetAffordance`-only plans keep working (spec 037 contract preserved); `targetAffordance` remains out of `required`.
- **No nested per-step typed arguments** — enum constrains values only; handlers resolve concrete targets at execute time (spec 037 Req 4 boundary).
- **What NOT to do**: do not teach the LLM about cells or paths; do not implement line-of-sight simulation (spec 038 non-goal); do not make the plan validator fail when `availableAffordances` is empty (guardrail masking, spec 016/037 rule); do not block the synchronous game loop on LLM calls.

## Non-goals

- Line-of-sight/visibility simulation beyond explored-cell tracking
- Weighted A* or real-time physics (all cells cost 1; BFS stays)
- Per-cell object memory with staleness modeling (last-seen *state* of known objects is enough for this phase)
