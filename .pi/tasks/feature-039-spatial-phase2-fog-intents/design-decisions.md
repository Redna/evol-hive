# Design Decisions — Feature 039: Spatial Phase 2 (Spec 038 remainder, Issue #144)

## Decision 1: `targetArea` rides the spec-037 enum-bound schema, not a new tool
**Why**: `formulatePlanSchemaFor` already rebuilds the `formulate_plan` tool per cycle with
an enum constrained to the agent's affordance IDs (spec 037). Extending the same per-cycle
static schema with an optional `targetArea` enum (known anchors + known rooms) reuses the
proven value-space constraint, keeps structured-output guarantees, and needs no new tool
loop. The enum is built from spatial memory + current-room perception ONLY — an unvisited
room cannot appear in the value space, which makes the fog requirement structurally
enforced (the LLM physically cannot emit an unknown area).

**Alternative considered**: free-text `targetArea` validated post-hoc. Rejected — silent
hallucination risk, and the failure surfaces only at Execute time (spec 037's lesson:
constrain at schema time, not guardrail time).

## Decision 2: Navigation-then-execution owned by the engine, same-cell contract frozen
**Why**: Execute checks the step for `targetArea`; if present it calls
`NavigationSystem.requestWalk` (existing, deterministic, spec 030 topology-aware) and only
invokes the affordance when arrival is observed. Same-cell steps take the existing path
verbatim — spec 037's contract and the spec 031 co-location guard stay untouched, so the
no-regression gate is structural, not hopeful. Unreachable `targetArea` → graceful step
failure + system feedback (§9.2 pattern); never teleport.

## Decision 3: Fog is a filter over perception output, not a new perception pass
**Why**: Passive perception already produces `prunedAffordances` and the object list from
world state. Phase-2 fog = intersect that output with the agent's explored set
(visited rooms + observed anchors from `spatialMemory`) before it reaches cognition.
One choke point, both consumers (affordances, object list) fixed at once, and social
transfer (R5) automatically "unlocks" perception because it writes the same
spatial-memory representation personal discovery writes.

**Alternative considered**: fog-aware pruning inside the System-0 classifier. Rejected —
the classifier is an embedding relevance filter, not a knowledge boundary; mixing the two
would make fog untestable and leak engine state into cognition.

## Decision 4: Unknown markers derived from knownDoors, rendered in the dynamic context only
**Why**: `spatialMemory.knownDoors` already records "roomA|roomB" pairs for doors seen but
not crossed. Rendering these as "a door west — unexplored" lines gives the LLM an
exploration target without exposing what lies beyond (no cell coordinates ever — spec 038
division of labor). These lines go in the dynamic context section so the spec 021 KV-cache
stable prefix stays byte-identical.

## Decision 5: Determinism as a pure-function property test, not a replay harness
**Why**: 038 AC-6 states paths are pure functions of grid + door state. The test builds
two identical WorldGrid/NavigationSystem fixtures from the same seed, runs the same
requestWalk sequence, and asserts identical cell paths — no RNG, BFS tie-break lowest
index (already the implementation's contract). Cheap, no save/load machinery required,
and it directly encodes the architectural guarantee.

## Decision 6: Persistence = extend the existing v3 serializer, fields optional
**Why**: `spatialMemory` and `position` already exist on agent state (first slice) but
must round-trip. The v3 save format gains these fields as OPTIONAL so pre-phase-2 saves
load unchanged (backward-compat constraint); round-trip test asserts fog-limited
perception is identical before save and after load.

## Decision 7: QA verifies the WHOLE 038 slice, not just phase 2
**Why**: The issue's QA requirement says AC-1..AC-7 across both slices, including the
updated system-order assertions (NavigationSystem sits between scene-mutations and
spatial in the game loop — asserted since 8c38f9b). Regression gate: engine/cognition
suites ≤ pre-existing failures.
