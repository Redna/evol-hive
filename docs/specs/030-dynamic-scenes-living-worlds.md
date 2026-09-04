# Feature: Dynamic Scenes — Living Worlds (Runtime Scene Mutation)

## Context
- Architecture: [§2 — System Overview](../architecture/02-system-overview.md) (package boundaries, engine assembly), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (AgentProfile/AgentInternalState must remain serializable), [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (objects, affordances, precondition checking), [§6 — PPER Loop](../architecture/06-pper-loop.md) (spawned agents must enter the scheduler), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (`modify_scene` as a cognitive tool), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (guardrail coverage for `modify_scene`), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (agent memory bootstrap/flush via YAAM)
- Related specs: [017 — Persistence](017-persistence-save-load-game-state.md) (SaveState/WorldSnapshot/AgentSnapshot, `SAVE_FORMAT_VERSION`), [019 — Affordance-as-Tools](019-affordance-as-tools.md) (per-affordance tool registration), [022 — Scene Authoring](022-scene-authoring-declarative.md) (SceneDefinition JSON Schema — the authoring format that stays fixed), [023 — Visual Output](023-visual-output-canvas-renderer.md) (VisualizerDataAdapter, WebSocket live updates), [028 — Compound Action Execution](028-compound-action-execution.md) (Execute service pattern)
- Package: `@evol-hive/shared` (mutation types), `@evol-hive/engine` (mutation service, registry/scene/agent extensions, persistence), `@evol-hive/cognition` (tool schema), `@evol-hive/visualizer` (live structural rendering), `examples` (demo scene)
- Issue: [#117 — Dynamic Scenes: procedural scene generation (living worlds)](https://github.com/Redna/evol-hive/issues/117)

## Requirements

### Scene Mutation Pipeline

- **Req 1 — SceneMutationService**: Provide a single engine-internal service (`packages/engine/src/world/mutations/`) that is the ONLY entry point for runtime structural changes. Supported operations: `AddObject`, `RemoveObject`, `MoveObject`, `SpawnAgent`, `DespawnAgent`, `SetConnectionState` (open/close/insert/remove a room connection). Operations are queued and applied at tick boundaries (deterministic), never mid-phase.
- **Req 2 — Append-only mutation log**: Every applied mutation is recorded as a `SceneMutationEvent` (`{ seq, tick, type, payload, source }`) in an in-memory append-only log exposed via `getMutations(sinceSeq?)`. Persistence (Req 11) and the visualizer (Req 15) consume this log; replaying the log over the base scene reproduces the live scene exactly.
- **Req 3 — Mutation validation**: `SceneMutationService` validates every operation before applying it and rejects invalid ones with a `SceneMutationError` containing an actionable, human-readable message (offending IDs + reason). Validation rules: no orphaned object references (a `RemoveObject`/`MoveObject`/`AddObject` must leave every `roomId`/`objectIds` reference consistent), no room left with zero connections after connection removal, no duplicate object/agent/room IDs, `SpawnAgent` drive values within 0–100, target rooms must exist.

### Object Lifecycle

- **Req 4 — Registry mutation methods**: Extend `SmartObjectRegistry` with `remove(objectId)` and `setRoom(objectId, roomId)` (relocation). `register(object)` already exists (spec 022). Removal also unregisters the object's affordances from tool availability and clears any state patches (spec 018).
- **Req 5 — Affordance cache invalidation**: Any object mutation invalidates the per-room affordance caches (`packages/engine/src/world/affordances/cache.js`) so the next Perception tick reflects the new object distribution immediately.

### Agent Lifecycle

- **Req 6 — Mid-run spawn**: `SpawnAgent(profile)` registers the profile via the existing `AgentManagerImpl.spawn(profile)`, seeds the agent's location (profile `startRoomId`, default: a valid connected room), bootstraps memory from the vector store (any prior memories scoped to that `agentId`, e.g. from a previous session via Req 12), and registers the agent with the PPER scheduler so it participates in Perceive→Plan→Execute→Reflect from the next tick.
- **Req 7 — Despawn with state export**: `DespawnAgent(agentId)` exports the agent's full state (profile, `AgentInternalState`, plan, and memory nodes) into a `DormantAgentStore` (in-memory Map + serializable snapshot, keyed by `agentId`), then removes the agent from the agent manager, PPER scheduler, and scene. Despawned agents are excluded from perception and social systems.
- **Req 8 — Re-spawn from dormancy**: `SpawnAgent` accepts either a fresh `AgentProfile` or a dormant `agentId`; when dormant state exists it restores drives, goal/plan, location, and memory bootstrap from the `DormantAgentStore` instead of defaults. Dormant state survives save/load (Req 11).

### Dynamic Topology

- **Req 9 — Connection state management**: Extend `SceneManager` with `setConnectionOpen(roomA, roomB, open: boolean)` and `addConnection(roomA, roomB)`. A closed connection removes the room pair from adjacency while preserving the doorway smart object (spec 022 Req 12) with `state.open = false`. Doorway objects expose `open_door`/`close_door` affordances whose engine effects call `SceneMutationService.setConnectionState`.
- **Req 10 — Topology-aware traversal & perception**: `getConnectedRooms`, spatial debouncing/navigation, and room-affordance queries respect connection state: affordances belonging to objects in rooms unreachable through closed connections are not offered to agents in the current room. Closing a door while an agent's plan targets the far room causes plan validation to reject the blocked step (spec §10 mechanism 3) and triggers a reflection tick.

### Event Sourcing & Persistence

- **Req 11 — Save/restore of mutated scenes**: `SaveState` (spec 017) is extended with the mutation log (or an equivalent derived `DynamicWorldSnapshot`): live object placement, connection states, and dormant agent snapshots. On `load()`, the engine rebuilds the base scene from the original `SceneDefinition` then applies mutations, restoring the exact live state. `SAVE_FORMAT_VERSION` is bumped and load of old formats still works (no dynamic data = no mutations).
- **Req 12 — YAAM persistence for dormant agents**: On despawn, the agent's state summary and key memories are written to the YAAM event store (append-only JSONL: `UPSERT_NODE` with agent-scoped labels; `DELETE_NODE` on re-spawn claim) so a later session can re-spawn the agent with its prior state via the existing memory pipeline ([MEMORY_PIPELINE.md](../../docs/MEMORY_PIPELINE.md)).

### LLM Integration (`modify_scene` Cognitive Tool)

- **Req 13 — `modify_scene` tool**: Register a `modify_scene` cognitive tool (§8) in `@evol-hive/cognition` with a strict JSON-schema tool definition. Parameters: `{ op: 'add_object'|'remove_object'|'move_object'|'spawn_agent'|'despawn_agent'|'set_connection_state', ...payload }`. The tool enqueues a proposal to `SceneMutationService`; on rejection, the actionable validation error (Req 3) is returned to the LLM as tool feedback so it can self-correct.
- **Req 14 — Guardrails per §10**: `modify_scene` is subject to the guardrail framework: (a) rate limit — at most N mutation proposals per agent per PPER cycle (configurable, default 1); (b) proposals never bypass validation — the LLM cannot mutate state directly, only propose; (c) `modify_scene` is masked by affordance masking exactly like other cognitive tools; (d) guardrail config extended in `GuardrailConfig` with `maxSceneMutationsPerCycle`.

### Visualizer

- **Req 15 — Live structural rendering**: The `VisualizerDataAdapter` reflects mutations without engine changes depending on the visualizer: rooms/objects/agents that appear or disappear between snapshots are picked up from the registries each snapshot, and mutation log deltas (`getMutations(sinceSeq?)`) are pushed over the existing WebSocket channel. The canvas renderer adds/removes entities on the next frame — no page reload, no snapshot-reset flicker.

### Compatibility

- **Req 16 — Static scenes unchanged**: Scenes that never mutate behave identically to today. All existing example scenes and tests pass unmodified; the `SceneDefinition` interface and YAML format (spec 022) are unchanged — dynamic changes are runtime deltas only.

## Acceptance Criteria

- [ ] **AC-1**: An agent executes a carry/move affordance that calls `MoveObject`; the object's `roomId` changes, `getObjectsInRoom` reflects old and new rooms on the next tick, and the per-room affordance lists update (cache invalidated) — the object's affordances are available in the new room and absent from the old one. (maps to Req 1, Req 4, Req 5)
- [ ] **AC-2**: A `SpawnAgent` with a valid profile mid-run results in the agent receiving a perception tick and successfully completing at least one PPER cycle (plan formed, affordance executed) within N ticks (N=20). (maps to Req 6, Req 8)
- [ ] **AC-3**: After `DespawnAgent`, the agent is absent from `getAllAgents()`/perception/social surfaces, its full state is in the `DormantAgentStore`; a subsequent `SpawnAgent(agentId)` restores drives, goal, plan, and memories to their pre-despawn values. (maps to Req 7, Req 8)
- [ ] **AC-4**: After `setConnectionOpen(A, B, false)`, `getConnectedRooms(A)` excludes B, navigation to B is rejected by plan validation, and cross-door affordances are no longer offered; after re-opening, all three are restored. (maps to Req 9, Req 10)
- [ ] **AC-5**: `modify_scene` proposals are validated: attempting to remove an object referenced by a room's `objectIds` leaves no orphan, attempting to remove a room's last connection is rejected, spawning an agent with `energy: 150` is rejected, and a duplicate object ID is rejected — each rejection returns a `SceneMutationError` whose message names the offending ID(s) and the rule violated. (maps to Req 3, Req 13, Req 14)
- [ ] **AC-6**: With the visualizer connected via WebSocket, an `AddObject`/`RemoveObject`/`SpawnAgent`/`DespawnAgent` mutation appears/disappears on the canvas within one frame of the next snapshot, without a page reload and without a full snapshot reset. (maps to Req 15)
- [ ] **AC-7**: Save after a sequence of mutations (object moved, door closed, agent despawned) and restore: object placement, connection states, live agent states, and dormant agent states are all identical to pre-save; the original base scene is unchanged. (maps to Req 11, Req 8)
- [ ] **AC-8**: Replaying `getMutations(0)` over the base scene reproduces the exact live scene state (event-sourcing determinism test). (maps to Req 2)
- [ ] **AC-9**: `modify_scene` respects §10 guardrails: it is masked when affordance masking is active, exceeds-per-cycle proposals are rejected with a rate-limit error, and `GuardrailConfig.maxSceneMutationsPerCycle` is honored. (maps to Req 14)
- [ ] **AC-10**: Despawn writes an agent-scoped `UPSERT_NODE` event to the YAAM event log containing the state summary; the memory pipeline can replay it in a fresh session and the agent's memories are retrievable. (maps to Req 12)
- [ ] **AC-11**: `pnpm -r run test` passes with zero modifications to existing test files; scenes without mutations produce byte-identical `SaveState` output fields as before (minus the new version constant). (maps to Req 16)

## Constraints
- Package boundaries (per ADR-0001): `engine` imports only `shared` + `memory`; the mutation service must NOT import from `cognition` — the tool layer in `cognition` calls the engine through the existing ports pattern (as `VisualizerDataAdapter` does).
- Deterministic core unchanged: mutations are explicit, validated, queued engine operations applied at tick boundaries — no ambient mutation, no async mutation inside physics or the PPER phases.
- Scene YAML (spec 022) remains the authoring format; the mutation log is a runtime-only delta on top of the parsed `SceneDefinition`.
- No new npm dependencies.
- Performance: applying a mutation must be < 5 ms (map operations + cache invalidation only); visualizer delta push must not exceed the existing WebSocket update cadence (spec 023).
- Patterns to follow: Execute-service invocation pattern (spec 028) for agent-initiated mutations; `exportState()`/`importState()` composition pattern (spec 017) for persistence; `HandlerPlugin` registration (spec 022) for doorway affordances.
- What NOT to do: do not mutate `SceneDefinition` objects in place (they are treated as immutable authoring artifacts); do not let the LLM construct engine objects directly (proposal → validate → apply only); do not persist YAAM events on every object move (only despawn/spawn and session boundaries, to keep the JSONL log small).
