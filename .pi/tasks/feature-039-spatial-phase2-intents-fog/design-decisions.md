# Design Decisions — Feature 039: Spatial Navigation Phase 2 (issue #144)

## Decision 1: Draft spec 039 as a phase-2 addendum instead of amending spec 038 in place
**Why**: Spec 038's first slice (R1/R2/R5) is already implemented and committed (`8c38f9b`) with a live tracking trail (#143). One spec per issue is the repo convention (see INDEX.md); issue #144 needs its own reviewable requirements/AC set. The new spec references 038's requirement/AC numbering explicitly (R3/R4, AC-2/AC-3/AC-4/AC-5/AC-6) so traceability is preserved, and 038 remains the parent design doc.
**Alternative considered**: Appending phase-2 sections to 038 — rejected: it would blur what first-slice QA verified vs. what is still open, and break the spec↔issue mapping convention.

## Decision 2: `targetArea` enum extends the spec-037 `formulatePlanSchemaFor` pattern, never a static schema
**Why**: The enum's legal values depend on the agent's KNOWN areas/anchors, which change per cycle (exploration, social transfer). A static schema cannot express this. `formulatePlanSchemaFor(ids)` is already rebuilt per cycle for `targetAffordance`; adding a sibling `targetArea` enum built from `spatialMemory` (visited rooms + discovered anchors) is the minimal, proven extension. `targetArea` stays OUT of `required` — making required fields broke gemma4 tool-calling entirely (spec 037, revert `2267354`); membership is enforced by the validator with exactly one CORRECTION-feedback retry.
**Constraint honored**: the enum contains only KNOWN areas — this is the fog requirement surfacing in the schema layer, not just perception.

## Decision 3: Navigate-then-execute is cognition-orchestrated, engine-executed
**Why**: The plan validator/execute-service (cognition) sees a step with `targetArea`; the actual walking is `NavigationSystem.requestWalk` (engine/spatial) — the LLM never computes paths (ADR-0001 division of labor: LLM = what/where intent, engine = how/when). The step does not complete while the walk is in progress; the engine ticks the walk, and the affordance executes on arrival.
**Failure path**: a `targetArea` with no open route fails through the existing failed-step path (reflection tick + spec-037 step-skip livelock guard). Silent advance is explicitly forbidden — that failure mode (108 unreachable re-executions) was already paid for once.
**Backward compat**: steps without `targetArea` keep the exact spec-037/031/016 contract (co-location guard, guardrails, skip guard).

## Decision 4: Fog filtering happens at the engine perception provider (single choke point)
**Why**: If cognition filtered fog itself, every consumer (perception-builder, plan-builder, drive-affordance-matcher) would need its own filter and any missed path leaks unexplored objects to the LLM. Filtering at the engine's passive-perception provider means `prunedAffordances` and the object list are fog-correct by construction for all downstream consumers.
**Markers**: unknowns ("a door west — unexplored") are context strings rendered by the perception builder — they are never affordances and never appear in any tool enum.

## Decision 5: Social fog-lifting rides the existing spec-033 conversation bridge
**Why**: `talk_to` already maps to open-or-contribute with a conversation manager on the engine side. Transferring the speaker's sightings (rooms, doors, observed objects) to the listener's spatial memory at that bridge point reuses an audited path (R13 sentiment audits every delta) instead of inventing a second social channel. Transferred knowledge is marked secondhand where cheap, so "seen" and "told" stay distinguishable for QA.

## Decision 6: Persistence — bump the save format version to v3, round-trip spatialMemory + position
**Why**: Save v2 (spec 033) predates cell-level fog and grid positions. A version bump keeps the loader explicit about the new fields; old saves still load with defaults (room-level memory, no position → legacy slot rendering, matching the `position?:` comment in shared/types/agent.ts). Round-trip integrity also feeds the determinism AC: save → load → same plan must replay identical paths.

## Decision 7: Determinism AC-6 as a property test, not a snapshot
**Why**: Paths being pure functions of grid+door state is the load-bearing property for replayability and future save/load verification. The test asserts identical paths across (a) two fresh engine instances from the same scene, and (b) a save/load cycle — stronger and less brittle than snapshotting one run. BFS tie-break (lowest index, already in grid.ts) and zero RNG in engine/spatial/ make this cheap to guarantee.

## Decision 8: Visualizer fog follows the per-agent explored set
**Why**: Fog is per-agent, but the canvas shows one scene. The renderer shades unexplored cells relative to the focused/primary agent's explored cells (consistent with how the visualizer already renders per-agent state); the data comes through the existing visualizer data adapter — no direct engine-state reach-in.

## Decision 9: QA verifies the WHOLE spec-038 slice, not just phase 2
**Why**: The issue scopes the QA pass to AC-1..AC-7 of spec 038, because the first slice (8c38f9b) was implemented without a full QA session. System-order assertions (assembly.test.ts: SceneMutations → Navigation → SpatialSystem → DriveDecay → ObjectState → PPERScheduler) are part of the checklist — navigation was inserted into the loop and the order is a contract, not an implementation detail.
