# Implementation Notes — Spec 030 (Dynamic Scenes / Living Worlds) — Issue #117

> Progress breadcrumbs for the developer agent session on
> `feature/030-dynamic-scenes-living-worlds`. (YAAM daemon/JSON-RPC API is not
> available in this environment — using the documented docs/notes fallback.)

## Status: IN PROGRESS — tests written first (TDD)

## Plan (maps to spec Reqs)
1. **shared** `src/types/mutations.ts`: `SceneMutationType`/payloads, `SceneMutationEvent`
   `{seq,tick,type,payload,source}`, `SceneMutationError` (rule + offendingIds),
   `SceneMutationProposal`/`Result`/`Port` (bridge, engine implements, cognition consumes),
   `DormantAgentSnapshot`, `DynamicWorldSnapshot`, `TopologyGuard`.
   Edit `persistence.ts`: `SaveState.dynamic?`, `SAVE_FORMAT_VERSION` 1→2 (load accepts 1+2).
   Edit `cognition.ts`: `CognitiveToolName`+`'modify_scene'`, `GuardrailConfig.maxSceneMutationsPerCycle?`,
   `CognitiveToolExecutor.executeModifyScene?`, `PlanValidationContext`.
2. **engine**: registry `remove`/`setRoom` + movement filter (cross-door affordances);
   SceneManager `setConnectionOpen`/`addConnection`/`hasConnection` + `TopologyGuard`
   (`go_to_<room>` parsing); `world/mutations/` = SceneMutationServiceImpl (validate→queue→
   apply at tick boundary, append-only log, getMutations(sinceSeq?)), DormantAgentStore,
   YaamEventLog (UPSERT_NODE/DELETE_NODE JSONL), SceneMutationSystem (applies pending each tick);
   persistence saves/restores `dynamic`; assembly wires all + loadScene deep-clones rooms/objects
   (SceneDefinition immutability constraint).
3. **cognition**: `modify_scene` tool schema; executor budget (default 1/cycle,
   `resetSceneMutationBudget`); orchestrator `onCycleStart` hook; execute-service passes
   `{agentId, fromRoom}` to validateAction; GuardrailEngineImpl optional TopologyGuard;
   openai-client dispatch + COGNITIVE_TOOL_NAMES.
4. **visualizer**: data-adapter optional mutationService → `getMutationDeltas(sinceSeq?)`
   (snapshot already reads live registries each frame).
5. **examples**: `examples/dynamic-world.ts` demo scene.

## Key decisions
- Scheduler registration = AgentManager registration (PPERScheduler iterates getActiveAgents).
- Closed connections: removed from Room.connections adjacency, pair remembered for reopen;
  doorway object kept with `state.open=false` (design note D2).
- Dormancy memories: sync `DormancyMemoryPort` adapter keeps mutation apply synchronous;
  cross-session persistence via YAAM JSONL replay (Req 12).
- Load = derived snapshot (live rooms/objects + dormant + log restored) — spec's
  "equivalent derived DynamicWorldSnapshot" alternative.

## Files touched
(see git log on branch feature/030-dynamic-scenes-living-worlds)

## Test files (written FIRST, before implementation)
- packages/shared/tests/spec-030-mutation-types.test.ts
- packages/engine/tests/spec-030-scene-mutations.test.ts (AC-1, AC-5, AC-8)
- packages/engine/tests/spec-030-agent-lifecycle.test.ts (AC-2, AC-3)
- packages/engine/tests/spec-030-topology.test.ts (AC-4, Req 9)
- packages/engine/tests/spec-030-persistence.test.ts (AC-7, AC-11)
- packages/engine/tests/spec-030-yaam-events.test.ts (AC-10)
- packages/engine/tests/spec-030-visualizer-deltas.test.ts (AC-6)
- packages/cognition/tests/spec-030-modify-scene-tool.test.ts (AC-5, AC-9)