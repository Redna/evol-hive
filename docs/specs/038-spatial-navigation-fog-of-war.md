# Spec 038 — Spatial Navigation & Fog of War: Grid-Based Agents, Engine-Side Pathfinding, High-Level LLM Intents

## Context

- Architecture: §2 (System Overview — adds a spatial layer), §3 (Agent State — position + spatial memory), §4 (Smart Objects — grid anchors, visibility), §6 (PPER — Execute becomes navigation-aware), §9 (Engine Routing — pathfinding service)
- Related specs: 030 (dynamic scenes/topology), 031 (co-location guard), 037 (enum-bound plans)
- Package: shared, engine, cognition, visualizer, examples
- Status: 📝 Drafted (user-directed design, 2026-09-07)
- Supersedes: the earlier "spatial presentation" sketch — this is not a presentation layer; movement is an engine mechanic.

## Problem

The engine has **no spatial model**. Agents are "in a room"; they teleport between rooms via `moveAgent`. The visualizer pins agents to fixed slots and lays objects in a schematic chip grid — nothing ever moves. The food chain lives in one planter, so agents cluster and compete for one cell of the world. The user-directed architecture refinement:

> Agents live on a **grid** and move **object to object / into areas** based on their **spatial understanding** (per-agent explored knowledge — fog of war). The **LLM formulates high-level area/action intents**; the **engine finds the path** and moves the agents.

This matches the established division of labor: LLM = high-level planner (areas, goals, affordance intent); engine = deterministic executor (paths, timing, collisions).

## Requirements

### R1 — Grid spatial model (engine)

- Each room is a grid of cells (e.g. 12×8; configurable per scene). Objects occupy **anchor cells** (declared in scene authoring or auto-assigned deterministically). Agents occupy one cell at a time.
- Movement is **cell-by-cell, tick-integrated** — fully deterministic, no real-time physics; one cell per tick or configurable speed. Rooms connect through doorway cells.
- `moveAgent(roomId)` is replaced by navigation: the engine computes a **cell path** and walks it over ticks.

### R2 — Engine-side pathfinding

- Pathfinding is engine-owned (ADR-0001: LLM never computes paths). BFS over the room's grid for intra-room targets; **multi-room routes compose** room-level hops through open doorway connections (spec 030 topology) — e.g. garden → gate → workshop.
- A navigation request carries a **target anchor** (object cell) or an **area label** (a region of the room). The engine walks the agent to the anchor cell of the requested object/area.
- Blocked cells (objects), closed doors, and other agents (soft constraint) shape the path. Path re-computation on world mutation (spec 030 event-sourced changes).

### R3 — High-level LLM intents

- Plan steps gain an optional **`targetArea`** field (enum-bound like spec 037: valid values = known object anchors + known area names + compass directions). The LLM says _what and where at area level_ ("harvest at the planter", "go to the workshop, find water"); the engine resolves it to a path + affordance execution.
- The plan's existing `targetAffordance` flow is unchanged for **same-cell interactions**; `targetArea` triggers navigation first, then execution on arrival. Enum for `targetArea` = the agent's **known** areas only (see R4).

### R4 — Fog of war / per-agent spatial understanding

- Each agent keeps a **spatial memory**: cells/areas explored, objects observed (with last-seen state), doors seen but not opened.
- **Passive perception covers only explored/visible area.** Unexplored rooms and out-of-view objects do NOT appear in `prunedAffordances`, the object list, or the context — the LLM context renders known areas plus explicit unknown markers ("a door west — unexplored").
- World mutations (spec 030) only enter an agent's knowledge when observed (or via social learning — `talk_to` shares sightings: agents tell each other what they've seen).
- Persistence: spatial memory round-trips in save v3.

### R5 — Exploration drive integration

- `curiosity` (already a drive) gains a real remedy: visiting unknown areas/doors reduces curiosity and expands the fog. The drive→affordance matcher (spec 034) can hint _known-but-unexplored_ areas ("the west door you found earlier").

### R6 — Visualizer

- Render the room grid, agents at true positions with **walking animation** (interpolated cell movement), fog shading over unexplored cells, object anchors instead of the fixed chip grid (objects render at their anchor cells).

### R7 — Determinism

- Paths are pure functions of grid state + door state. No RNG required (BFS tie-break: lowest index). Tick-integrated movement replays identically in save/load (persistence saves position + spatial memory).

## Acceptance Criteria

- [ ] AC-1: Agents occupy grid cells; walking is cell-by-cell per tick (deterministic, verifiable)
- [ ] AC-2: A plan step with `targetArea: 'workshop'` walks the agent through the door graph to the workshop; movement spans multiple ticks; execution fires on arrival
- [ ] AC-3: A room never visited produces no affordances/objects in perception (fog); after exploration it does
- [ ] AC-4: `talk_to` about a discovery transfers it to the listener's spatial memory (social fog-lifting)
- [ ] AC-5: Visualizer shows grid, walking agents, fog shading, anchor-positioned objects
- [ ] AC-6: Same initial state + same plan → identical paths (determinism test)
- [ ] AC-7: Closed door blocks the path; opening it re-routes live (spec 030 integration)

## Constraints

- Pathfinding is engine-side and synchronous-cheap (BFS on ≤ 12×8 grids; multi-room via precomputed doorway graph)
- Cognition stays spatially **abstract**: the LLM reasons over areas/objects it knows, never over cell coordinates (context cost + reliability — this is the division of labor: LLM = where/what intent, engine = how/when path)
- KV-cache (spec 021): dynamic context may include known-map summary; the stable system prefix is untouched
- Package boundaries: pathfinding + grid live in `engine/spatial/`; cognition consumes `targetArea` enums and fog-filtered perception; shared defines the types
- Backward compatibility: scenes without anchors auto-assign grid positions deterministically (seeded layout); `targetAffordance`-only plans keep working (spec 037 contract preserved)

## Non-goals

- Continuous real-time physics, collision resolution beyond cell occupancy
- Line-of-sight/visibility simulation beyond explored-cell tracking (could be a follow-up)
- Weighted A* (all cells cost 1 for now)
