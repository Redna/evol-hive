# Spec 039 — Spatial Phase 2: `targetArea` LLM Intents, Cell-Level Fog, Social Fog-Lifting, Determinism & QA

## Context

- Architecture: §2 (System Overview — engine/cognition split), §3 (Agent State — `position` + `spatialMemory`), §6 (PPER — Execute is navigation-aware), §7 (Structured Outputs — enum-bound tool schemas), §9 (Engine Routing — navigation service)
- Related specs: 038 (spatial navigation & fog of war — this is the **phase-2 remainder**; first slice R1/R2/R5 implemented in 8c38f9b, tracked by #143), 037 (enum-bound plan formulation — the schema pattern reused here), 030 (dynamic scenes / door topology), 031 (co-location guard — preserved when crossing doors), 017 (persistence save/load), 023 (Canvas 2D visualizer)
- Issue: [#144](https://github.com/Redna/evol-hive/issues/144) (tracks #143)
- Package: shared, engine, cognition, visualizer, examples
- Status: 📝 Drafted

## Problem

Spec 038's first slice delivered the grid spatial model, tick-integrated walking, engine-side pathfinding, room-level spatial memory, and the curiosity reward. What is still missing for the fog-of-war vision:

1. **The LLM cannot say *where* it wants to act.** Plan steps only carry `targetAffordance` (spec 037); the agent can only act on affordances available *in its current room*, so cross-room goals ("go to the workshop and craft") cannot be expressed as a plan.
2. **Perception is not fogged.** Passive perception still surfaces every object/affordance in the world regardless of whether the agent has ever seen that room or cell — unexplored areas leak into `prunedAffordances` and the object list, so exploration has no information value.
3. **Knowledge does not travel socially.** Agents that discovered something cannot lift another agent's fog via `talk_to`.
4. **Spatial memory is not persisted** in the save format round-trip (position + spatial memory).
5. **Determinism (038 AC-6) and fog shading (038 AC-5) are unverified/unimplemented**, and the whole 038 slice has not had a QA pass against AC-1..AC-7.

## Requirements

### R1 — Enum-bound `targetArea` on plan steps (cognition)

- Plan steps gain an optional **`targetArea`** field, enum-bound exactly like spec 037's `targetAffordance`: the per-cycle static `formulate_plan` schema is built (`formulatePlanSchemaFor` pattern) with valid values = the agent's **known** object anchors (grid-anchored object names in spatial memory / current perception) + known room/area names.
- The enum must only contain KNOWN areas — an unvisited room or unobserved object never appears in the value space (fog requirement, R3).
- The LLM reasons over areas/objects it knows — never cell coordinates (spec 038 constraint).

### R2 — Navigation-then-execution in Execute (engine)

- When a plan step carries `targetArea`, the engine first navigates: `NavigationSystem.requestWalk` routes through the WorldGrid doorway graph (spec 030 topology), then the affordance executes **on arrival**. Movement spans multiple ticks; execution fires only when the agent reaches the target area/anchor.
- Steps without `targetArea` (same-cell, spec 037 contract) are unchanged: the existing co-location guard (spec 031) and execution path apply verbatim.
- If no open route exists to `targetArea`, the step fails gracefully (system feedback per §9.2) — no teleport, no error leak.

### R3 — Cell-level fog in passive perception (engine + cognition)

- Passive perception covers only explored/visible cells: objects outside the agent's explored area do **not** enter `prunedAffordances` or the perceived object list.
- After exploration (personal visit or social transfer), the objects/affordances become perceivable — no code change needed to "unlock" them, only the fog set changes.

### R4 — Unknown markers in context (cognition)

- The perception context renders unknowns as explicit markers, e.g. "a door west — unexplored" — derived from spatial memory's known-but-unvisited doors/areas — so the LLM can plan exploration without seeing what lies beyond.

### R5 — Social fog-lifting via `talk_to` (engine + cognition)

- `talk_to` transfers sightings: what the speaker has observed (rooms, doors, object anchors, last-seen state) enters the **listener's** spatial memory as known areas — same representation as personal discovery, so perception fog and `targetArea` enums pick it up automatically.

### R6 — Persistence round-trip (engine)

- `spatialMemory` and agent `position` round-trip in save/load (verify the v3 serialization path): after load, fog state, known areas, and cell positions are identical to pre-save state.

### R7 — Determinism test (engine)

- A determinism test proves paths are pure functions of grid + door state: same initial state + same plan → identical cell paths (038 R7/AC-6). No RNG; BFS tie-break is deterministic (lowest index).

### R8 — Visualizer fog shading (visualizer)

- Unexplored cells render with fog shading in the Canvas 2D visualizer (spec 023), completing 038 AC-5. Explored cells render normally; agents/objects outside the viewed agent's fog do not render for that viewer.

### R9 — QA pass over the full 038 slice (protocol)

- QA verifies the whole 038 slice against AC-1..AC-7 (first-slice AC-1/AC-5/AC-7 + this spec's phase-2 items), including the updated system-order assertions (NavigationSystem ordering in the game loop) and the no-regression gate below.

## Acceptance Criteria

- [ ] **AC-1** (038 AC-2, full): a plan step with `targetArea: 'workshop'` walks the agent through the door graph over multiple ticks; the affordance execution fires on arrival; a same-cell step with only `targetAffordance` behaves exactly as in spec 037 *(maps to R1, R2)*
- [ ] **AC-2** (038 AC-3): a room never visited produces no affordances/objects in `prunedAffordances` or the object list; after the agent explores it (or receives a `talk_to` transfer), they do appear *(maps to R3)*
- [ ] **AC-3**: unexplored-but-known doors/areas appear in context as unknown markers ("a door west — unexplored"), never as full perception of the unknown side *(maps to R4)*
- [ ] **AC-4** (038 AC-4): `talk_to` about a discovery transfers it to the listener's spatial memory — the listener's `targetArea` enum and perception subsequently include the discovered area *(maps to R5)*
- [ ] **AC-5**: save → load round-trip restores `spatialMemory` and `position` exactly; fog-limited perception after load matches pre-save perception *(maps to R6)*
- [ ] **AC-6** (038 AC-6): same initial state + same plan → identical paths (determinism test green) *(maps to R7)*
- [ ] **AC-7** (038 AC-5 remainder): the visualizer renders fog shading over unexplored cells; `targetArea` enum values are limited to the agent's known areas at schema-build time *(maps to R1, R8)*
- [ ] **AC-8** (no regression): existing system-order assertions pass; engine/cognition suites have ≤ pre-existing failures; `targetAffordance`-only plans (spec 037) keep working; scenes without anchors auto-assign deterministically *(maps to R9)*

## Constraints

- Package boundaries: grid/pathfinding stay in `engine/spatial/`; cognition consumes `targetArea` enums and fog-filtered perception only; shared defines the types (`spatialMemory` extension lives in `packages/shared/src/types/agent.ts`)
- The `targetArea` schema is rebuilt **per cycle** as a static tool signature (spec 037 pattern) — no runtime JSON-schema mutation of a live tool loop
- KV-cache (spec 021): the known-map summary and fog markers live in the **dynamic** context section; the stable system prefix is untouched
- Determinism: no RNG in path resolution, enum construction, or anchor auto-assignment (seeded hash layout, spec 038 R1)
- Backward compatibility: plans with only `targetAffordance` (spec 037) must keep working; save v3 must accept records without `targetArea`-era spatial extensions (fields optional)
- What NOT to do: do not let the LLM see or emit cell coordinates; do not teleport on unreachable `targetArea`; do not move fog knowledge into the classifier/embedding layer — it is state on the agent, engine-owned
