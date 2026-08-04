# Feature: Perceive Phase of the PPER Loop

## Context
- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md) (§6.1 Perceive, Spatial Debouncing), [§5 — Fast-Path Classifier](../architecture/05-fast-path-classifier.md), [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (§11.1 Track 1), [§9 — Engine Routing](../architecture/09-engine-routing.md) (§9.2 Action Feedback Loop)
- Related specs: None (first spec)
- Package: `shared`, `engine`, `cognition`
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)

## Requirements

### Engine Layer (`@evol-hive/engine`)

1. **Room state retrieval** — The engine must expose a method to retrieve all `SmartObject` instances located in the agent's current room (`AgentInternalState.location`). The existing `SmartObjectRegistry.getByRoom(roomId)` returns full `SmartObject[]`; a new method `getObjectsInRoom(roomId)` must be added (or `getByRoom` wrapped) to return only `{ id, name, type }` — no deep `state`, no `affordances`. This aligns with the existing `SpatialSystem.getObjectsInRoom(roomId)` interface, which currently returns `SmartObject[]` and must be updated to return the projected shape.

2. **Affordance collection** — The engine must expose a method to aggregate all `Affordance[]` across every `SmartObject` in a given room, returning a flat list suitable for classifier input. The existing `SmartObjectRegistry.getAffordancesInRoom(roomId)` interface already defines this contract; it must be implemented.

3. **Primary drive determination** — The engine must compute the agent's primary drive as the drive with the **lowest** value (0 = most urgent, per §3), and produce a semantic label string in the format `"low {drive}, need to restore {drive}"` for the classifier query. The existing `DriveSystem.getPrimaryDrive(state)` interface returns `{ name, value }` — this must be extended (or a companion method added) to also produce the semantic label string.

4. **Spatial debounce — room threshold** — The engine must trigger a new perception tick when the agent crosses a room boundary (i.e., `AgentInternalState.location` changes since the last tick). This logic lives in `SpatialSystem.shouldTriggerPerception(agentId)`.

5. **Spatial debounce — idle timer** — The engine must trigger a new perception tick when the agent has been idle (no movement, no action execution) for longer than `EngineConfig.spatialDebounceSeconds` (default: 5s, per `.env.example` `ENGINE_SPATIAL_DEBOUNCE_SECONDS=5`).

6. **Perception tick recording** — After each perception tick fires, the engine must update `AgentInternalState.lastPerceptionTick` to the current simulation time. The existing `SpatialSystem.recordPerceptionTick(agentId, simulationTime)` interface already defines this contract; it must be implemented.

7. **Debounce skip** — If neither the room-threshold nor idle-timer condition is met, the engine must **not** trigger a perception tick. `SpatialSystem.shouldTriggerPerception(agentId)` must return `false` in this case.

### Cognition Layer (`@evol-hive/cognition`)

8. **Passive perception assembly** — The cognition layer must build a `PassivePerception` object containing: the agent's current `roomId`, an array of `{ objectId, name, type }` for each smart object in the room (projected from the engine's room state retrieval), a snapshot of the agent's current `drives`, any pending `systemFeedback` string from a failed action (per §9.2 Action Feedback Loop), and (optionally) `associativeMemories` from Track 1.

9. **System 0 classifier pruning** — The cognition layer must invoke `AffordanceClassifier.prune()` with the primary drive label (from Req 3) and the full room affordance list (from Req 2), returning only the top-K affordances whose cosine similarity meets or exceeds the configured threshold (default K=5, threshold=0.3, per `.env.example`).

10. **Structured perception result** — The cognition layer must return a `PerceptionResult` object bundling: the `PassivePerception`, the pruned `Affordance[]`, and the `primaryDriveLabel` string.

11. **LLM context payload construction** — `PerceptionBuilder.build()` must accept the `PerceptionResult` and produce an `LLMContextPayload` containing: a system prompt, a formatted perception context string (room name, object names, drive summary), the pruned affordances, available cognitive tools, and the structured output response schema. **Note:** The existing `PerceptionBuilder.build()` interface signature is `build(passive: PassivePerception, affordances: Affordance[]): LLMContextPayload`. This must be updated to `build(perceptionResult: PerceptionResult): LLMContextPayload` to accept the bundled result including `primaryDriveLabel`.

### Shared Layer (`@evol-hive/shared`)

12. **`PerceptionResult` type** — A new interface `PerceptionResult` must be defined in `packages/shared/src/types/cognition.ts` with fields: `passive: PassivePerception`, `prunedAffordances: Affordance[]`, `primaryDriveLabel: string`.

### Cross-Cutting

13. **No deep state leakage** — Passive perception must **never** include `SmartObject.state` (e.g., `water_level`, `bean_count`). Deep state is only accessible via the active `observe` action (§6.2), which is out of scope for this spec.

14. **No LLM call in perceive** — The Perceive phase is System 1 (passive). It must not invoke the heavy LLM (`LLMClient`). The LLM is only called in the Plan phase.

15. **Associative memory injection point** — The `PassivePerception.associativeMemories` field must be populated (or left `undefined`) as an integration point for Track 1 memory retrieval. The actual retrieval implementation is deferred to the memory package spec.

## Acceptance Criteria

- [ ] **AC-1**: `SmartObjectRegistry.getObjectsInRoom(roomId)` returns an array of `{ id, name, type }` for every `SmartObject` whose `roomId` matches, excluding the `state` and `affordances` fields. *(Req 1)*
- [ ] **AC-2**: `SmartObjectRegistry.getAffordancesInRoom(roomId)` returns a flat `Affordance[]` aggregating all affordances from all objects in the room. Returns an empty array if the room has no objects. *(Req 2)*
- [ ] **AC-3**: Given `AgentDrives = { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 }`, the primary drive is `energy` and the label is `"low energy, need to restore energy"`. *(Req 3)*
- [ ] **AC-4**: Given `AgentDrives = { energy: 90, hunger: 5, social: 70, comfort: 50, curiosity: 30 }`, the primary drive is `hunger` and the label is `"low hunger, need to restore hunger"`. *(Req 3)*
- [ ] **AC-5**: When `AgentInternalState.location` changes from `"kitchen"` to `"lounge"`, `SpatialSystem.shouldTriggerPerception(agentId)` returns `true`. *(Req 4)*
- [ ] **AC-6**: When `AgentInternalState.location` does **not** change between ticks, `SpatialSystem.shouldTriggerPerception(agentId)` returns `false` (assuming idle timer not expired). *(Req 4)*
- [ ] **AC-7**: When the agent has been idle for `spatialDebounceSeconds + 1` seconds (simulation time), `SpatialSystem.shouldTriggerPerception(agentId)` returns `true`. *(Req 5)*
- [ ] **AC-8**: When the agent has been idle for less than `spatialDebounceSeconds`, `SpatialSystem.shouldTriggerPerception(agentId)` returns `false` (assuming no room change). *(Req 5)*
- [ ] **AC-9**: After `SpatialSystem.recordPerceptionTick(agentId, simulationTime)` is called, `AgentInternalState.lastPerceptionTick` equals the passed `simulationTime`. *(Req 6)*
- [ ] **AC-10**: When neither debounce condition is met, `SpatialSystem.shouldTriggerPerception(agentId)` returns `false` and no perception tick fires. *(Req 7)*
- [ ] **AC-11**: `buildPassivePerception(agentId)` returns a `PassivePerception` with `roomId` matching the agent's location, `objectsPresent` containing `{ objectId, name, type }` for each object in the room, and `drives` matching the agent's current drive values. *(Req 8)*
- [ ] **AC-12**: The `PassivePerception.objectsPresent` array does **not** contain any `state` or `affordances` fields on any entry. *(Req 8, Req 13)*
- [ ] **AC-13**: `AffordanceClassifier.prune(driveLabel, affordances)` returns at most `CLASSIFIER_TOP_K` (default 5) affordances. *(Req 9)*
- [ ] **AC-14**: `AffordanceClassifier.prune(driveLabel, affordances)` excludes any affordance whose cosine similarity score is below `CLASSIFIER_SIMILARITY_THRESHOLD` (default 0.3). *(Req 9)*
- [ ] **AC-15**: When a room has 0 affordances, `prune()` returns an empty array without error. *(Req 9)*
- [ ] **AC-16**: The perception result includes `prunedAffordances` containing exactly the output of `AffordanceClassifier.prune()`. *(Req 10)*
- [ ] **AC-17**: `PerceptionResult` is defined in `packages/shared/src/types/cognition.ts` with fields `passive: PassivePerception`, `prunedAffordances: Affordance[]`, and `primaryDriveLabel: string`. *(Req 12)*
- [ ] **AC-18**: `PerceptionBuilder.build(perceptionResult)` returns an `LLMContextPayload` with `availableAffordances` set to the pruned list, `perceptionContext` containing the room name and object names, and `responseSchema` set to the structured output schema (`llmActionResponseSchema`). *(Req 11)*
- [ ] **AC-19**: No method in the Perceive phase calls `LLMClient.completeStructured()` or `LLMClient.completeReflection()`. *(Req 14)*
- [ ] **AC-20**: `PassivePerception.associativeMemories` is `undefined` when no memory subsystem is wired, and the type allows `MemorySnippet[]` when it is. *(Req 15)*
- [ ] **AC-21**: When `systemFeedback` is present (from a prior failed action per §9.2), it is included in the `PassivePerception.systemFeedback` field. *(Req 8)*

## Constraints

- **Package boundaries** (per ADR-0001): `engine` and `cognition` must **not** directly import from each other. All cross-package communication must go through interfaces defined in `@evol-hive/shared`. The engine owns spatial debouncing and world/agent state; cognition owns perception compilation and classifier invocation.
- **No deep state leakage**: `PassivePerception.objectsPresent` must only carry `{ objectId, name, type }`. Including `SmartObject.state` is a hard violation. *(§6.1)*
- **No LLM in perceive**: The perceive phase is passive (System 1). Calling the LLM client during perceive is a hard violation. *(§6.1)*
- **Configurable thresholds**: `CLASSIFIER_TOP_K`, `CLASSIFIER_SIMILARITY_THRESHOLD`, and `spatialDebounceSeconds` must be config/env-driven (see `.env.example`), not hardcoded constants. *(§5 Configuration table)*
- **Primary drive = lowest value**: Drive urgency is inversely proportional to value (0 = most urgent). This aligns with §3 and the existing YAAM design decision. Do not use "highest value = most urgent."
- **Token budget**: The perception context string should be compact — object names and drive summary only. Do not dump full affordance labels or descriptions into the perception context; those go into `availableAffordances` in the `LLMContextPayload`.
- **Interface changes required**: This spec proposes updates to two existing interfaces:
  - `PerceptionBuilder.build()` — signature changes from `(passive: PassivePerception, affordances: Affordance[])` to `(perceptionResult: PerceptionResult)`.
  - `SpatialSystem.getObjectsInRoom()` — return type changes from `SmartObject[]` to `{ id: string; name: string; type: string }[]` (projected shape, no deep state).
  - `SmartObjectRegistry` — new method `getObjectsInRoom(roomId)` returning `{ id, name, type }[]` (projected from existing `getByRoom`).
  - `DriveSystem.getPrimaryDrive()` — extended to also produce the semantic label string, or a companion method `getPrimaryDriveLabel(state)` added.
- **Patterns to follow**: Use the existing interface-first pattern — define interfaces in `shared`, implement in the appropriate package. Stub files already exist at `packages/engine/src/spatial/index.ts`, `packages/cognition/src/pper/index.ts`, `packages/cognition/src/classifier/embedding/index.ts`, and `packages/cognition/src/classifier/pruning/index.ts`.
- **What NOT to do**:
  - Do not implement the `observe(target)` active perception mechanism (§6.2) — that is a separate spec.
  - Do not implement the Plan, Execute, or Reflect phases of the PPER loop.
  - Do not implement the full memory retrieval subsystem — only wire the `associativeMemories` integration point.
  - Do not implement the game loop or async routing infrastructure (§9).
  - Do not add `PerceptionResult` to `packages/engine/` — it belongs in `shared` since both engine and cognition need to reference it.
