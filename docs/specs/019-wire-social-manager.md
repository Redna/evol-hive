# Feature: Wire SocialManager in Assembly & Example Scenes

## Context
- Architecture: [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (relationships), [§6 — PPER Loop](../architecture/06-pper-loop.md) (social perception in Perceive phase), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (talk_to as a cognitive tool), [§9 — Engine Routing](../architecture/09-engine-routing.md) (assembly wiring)
- Related specs: [018 — Multi-Agent Social](018-multi-agent-social.md) (all social types, SocialManager, MessageQueue, SocialActionBridge, CognitiveToolExecutorImpl social methods, perception/builder social context), [005 — Game Loop Integration](005-game-loop-integration.md) (createEngineCore, assembleGameLoop, EngineCore), [013 — Richer Prototype Scenes](013-richer-prototype-scenes.md) (example scene structure), [015 — Full Cognitive Tools](015-full-cognitive-tools.md) (CognitiveToolExecutorImpl, OpenAICompatibleLLMClient tool call loop)
- Package: `engine` (assembly.ts — create SocialManager, wire to PerceptionDataProviderImpl, expose on EngineCore/AssembledEngine), `examples` (morning-routine.ts, office-day.ts, minimal-scene.ts — wire socialBridge to CognitiveToolExecutorImpl, use real LLM for social demonstration)
- Issue: [#73](https://github.com/Redna/evol-hive/issues/73)

## Design Rationale

Spec 018 fully implemented the social infrastructure: `SocialManager`, `MessageQueue`, `SocialActionBridge` interface, `PerceptionDataProviderImpl.setSocialManager()`, `CognitiveToolExecutorImpl` social methods with `socialBridge` option, social tool definitions (`talk_to`, `observe_agent`, `help`, `ignore`), perception/plan builder social context injection, and `COGNITIVE_TOOL_NAMES` updates in `OpenAICompatibleLLMClient`. All 60 acceptance criteria of spec 018 passed.

**However, none of these pieces are wired together in the actual application.** The gap is purely integration:

1. **`createEngineCore()` does not create a `SocialManager`.** The `EngineCore` interface has no `socialManager` field. The `PerceptionDataProviderImpl` is constructed without calling `setSocialManager()`, so `getAgentsInRoom()`, `dequeueSocialMessages()`, and `getRelationships()` all return empty results. Agents cannot perceive each other.

2. **`CognitiveToolExecutorImpl` is never constructed with `socialBridge`.** In `examples/minimal-scene.ts` (the only scene using `OpenAICompatibleLLMClient`), the `CognitiveToolExecutorImpl` is created with only `stateDataProvider` — no `socialBridge`. All social tool calls return `{ success: false, message: 'Social actions not available.' }`. `talk_to` cannot queue messages.

3. **Example scenes use mock LLMs that bypass the tool-call loop.** `MorningRoutineMockLLMClient` and `OfficeDayMockLLMClient` implement `LLMClient` directly (using `completePlan`, `completeStructured`, etc.) and never invoke cognitive tools. Even if `socialBridge` were wired, the mock LLMs would never call `talk_to`. The mock LLM has a hardcoded fallback `if (drive === social) return watch_tv` because no social affordances work.

4. **`AssembledEngine` does not expose `socialManager`.** Even if `createEngineCore()` created it, example scenes that use `createEngine()` (which returns `AssembledEngine`) would not have access to the `SocialManager` to pass it as `socialBridge` to `CognitiveToolExecutorImpl`.

This spec is intentionally narrow — it does **not** introduce any new types, classes, or interfaces. All infrastructure from spec 018 is reused as-is. The work is:
- Adding `SocialManager` construction and wiring to `createEngineCore()` (engine layer)
- Exposing `socialManager` on `EngineCore` and `AssembledEngine` (engine layer)
- Updating `examples/minimal-scene.ts` to wire `socialBridge` when using a real LLM (examples layer)
- Updating at least one prototype scene (`morning-routine` or `office-day`) to support real LLM mode with social wiring (examples layer)

### Key Design Decisions

**Decision 1: `createEngineCore()` always creates `SocialManager`.** Unlike `MemoryStore` or `VectorStore` (which are optional construction parameters), `SocialManager` is always created because it only depends on `AgentManager`, which is always available. The cost is negligible (one object with an empty `MessageQueue`). This ensures that any scene loaded into the engine automatically has social perception wired — no caller needs to remember to call `setSocialManager()`.

**Decision 2: `SocialManager` is exposed on `EngineCore` and `AssembledEngine`.** The example scenes need access to `socialManager` to pass it as `socialBridge` to `CognitiveToolExecutorImpl`. Without exposing it, scenes would have no way to wire the social bridge. This follows the same pattern as `agentManager`, `sceneManager`, and other subsystems already exposed on `EngineCore`.

**Decision 3: `CognitiveToolExecutorImpl` wiring stays in the example scenes, not in the engine.** Per ADR-0001, `cognition` and `engine` must not import from each other. `CognitiveToolExecutorImpl` is in `cognition`; `SocialManager` is in `engine`. The wiring (passing `socialManager` as `socialBridge`) must happen at the application entry point (example scenes), which can import from both packages. This is the same pattern used for wiring `stateDataProvider` (the engine's `ReflectDataProviderImpl`) to `CognitiveToolExecutorImpl`.

**Decision 4: Prototype scenes get real-LLM mode with social wiring.** The `morning-routine` and `office-day` scenes currently only use mock LLMs. This spec adds a `USE_REAL_LLM` environment variable check (same pattern as `minimal-scene.ts`) to at least one scene. When `USE_REAL_LLM=true`, the scene constructs `OpenAICompatibleLLMClient` with `CognitiveToolExecutorImpl` (wired with `socialBridge: socialManager` and `stateDataProvider: core.bridges.reflect`), enabling full social interaction. When `USE_REAL_LLM` is not set, the existing mock LLM is used (backward compatible). The morning-routine scene is the primary target because it has 2 agents (Alice and Bob) who can meet in the living room.

**Decision 5: The mock LLMs in prototype scenes are updated to parse social context.** When `agentsPresent` is populated (because `SocialManager` is now wired), the mock LLM's `completePlan` method should be able to parse "Agents present:" from the perception context and, when the social drive is primary and another agent is present, select a `talk_to` affordance. This makes the mock LLM socially aware even without a real LLM, enabling integration testing of the social pipeline without API costs. The mock LLM calls `talk_to` via the `completeStructured` method (which returns `{ action: 'talk_to', actionArgs: { targetAgentId, message } }`) — this requires the `OpenAICompatibleLLMClient`'s tool-call loop. Since mock LLMs bypass the tool-call loop, the mock LLM's social behavior is limited to drive-based navigation (moving toward other agents' rooms). Full `talk_to` execution requires a real LLM.

Actually, re-examining the mock LLM interface: the mock LLMs implement `LLMClient` which has `completeStructured(payload)` returning `LLMActionResponse` with `action` and `actionArgs`. The action `talk_to` is not an affordance — it's a cognitive tool. The mock LLM's `completeStructured` returns an action, but `talk_to` is not processed as a physical affordance by the `ExecuteServiceImpl`. So the mock LLM cannot trigger `talk_to` — only the `OpenAICompatibleLLMClient` tool-call loop can. Therefore, the mock LLM update is limited to acknowledging social context in its heuristic (e.g., not falling back to `watch_tv` when agents are present and social is the primary drive). Full social interaction demonstration requires `USE_REAL_LLM=true`.

## Requirements

### Engine Layer — Assembly (`@evol-hive/engine`)

1. **`createEngineCore()` creates `SocialManager`** — The `createEngineCore()` function in `packages/engine/src/assembly.ts` must construct a `SocialManager` instance after creating `AgentManagerImpl`. The `SocialManager` is constructed with `agentManager` as its sole constructor argument (matching the existing `SocialManager` constructor signature in spec 018, Req 17).

2. **`createEngineCore()` wires `SocialManager` to `PerceptionDataProviderImpl`** — After constructing the `PerceptionDataProviderImpl`, `createEngineCore()` must call `perceptionProvider.setSocialManager(socialManager)`. This ensures that `getAgentsInRoom()`, `dequeueSocialMessages()`, and `getRelationships()` on the perception provider delegate to the `SocialManager`. This call must happen before the `EngineCore` is returned.

3. **`EngineCore` interface includes `socialManager`** — The `EngineCore` interface in `packages/engine/src/assembly.ts` must include a `socialManager: SocialManager` field. This allows callers (example scenes) to access the `SocialManager` and pass it as `socialBridge` to `CognitiveToolExecutorImpl`. The field is non-optional because `createEngineCore()` always creates it.

4. **`createEngineCore()` returns `socialManager`** — The return object from `createEngineCore()` must include the `socialManager` instance.

5. **`AssembledEngine` interface includes `socialManager`** — The `AssembledEngine` interface in `packages/engine/src/assembly.ts` must include a `socialManager: SocialManager` field. This allows callers using `createEngine()` (the one-call factory) to access the `SocialManager`.

6. **`createEngine()` returns `socialManager`** — The `createEngine()` function must include `socialManager: core.socialManager` in its return object.

7. **Import `SocialManager` in `assembly.ts`** — The `SocialManager` class must be imported from `./social/social-manager.js` in `assembly.ts`. This import is within the `engine` package (no cross-package dependency).

### Examples Layer — Minimal Scene (`examples/minimal-scene.ts`)

8. **Wire `socialBridge` in `minimal-scene.ts` when using real LLM** — When `USE_REAL_LLM=true`, the `CognitiveToolExecutorImpl` construction in `minimal-scene.ts` must include `socialBridge: core.socialManager` alongside the existing `stateDataProvider: core.bridges.reflect`. This enables `talk_to`, `observe_agent`, `help`, and `ignore` to execute via the `SocialManager`.

### Examples Layer — Morning Routine Scene (`examples/morning-routine.ts`)

9. **Real-LLM mode in `morning-routine.ts`** — The `buildEngine()` function in `morning-routine.ts` must check `process.env['USE_REAL_LLM'] === 'true'` and, when true, construct an `OpenAICompatibleLLMClient` (same pattern as `minimal-scene.ts`) with:
   - `baseUrl`, `model`, `apiKey` from environment variables (same env vars as `minimal-scene.ts`)
   - `cognitiveToolExecutor: new CognitiveToolExecutorImpl({ stateDataProvider: core.bridges.reflect, socialBridge: core.socialManager })`
   - Optional `reasoningEffort` and `maxToolCallIterations` from environment variables
   When `USE_REAL_LLM` is not set, the existing `MorningRoutineMockLLMClient` is used (backward compatible).

10. **Import `OpenAICompatibleLLMClient` and `CognitiveToolExecutorImpl` in `morning-routine.ts`** — The `morning-routine.ts` file must import `OpenAICompatibleLLMClient` and `CognitiveToolExecutorImpl` from `@evol-hive/cognition`. These imports are used only when `USE_REAL_LLM=true`.

11. **Import `SocialManager` type in `morning-routine.ts`** — The `morning-routine.ts` file must import `SocialManager` from `@evol-hive/engine` (type only) for the `AssembledEngine.socialManager` field. Alternatively, since `AssembledEngine` already includes `socialManager`, the type is available without an explicit import if the scene uses `AssembledEngine` as its return type.

12. **`buildMorningRoutineEngine()` exposes `socialManager`** — The `buildMorningRoutineEngine()` function (and the internal `buildEngine()` helper) must include `socialManager: core.socialManager` in the returned `AssembledEngine` object. This is automatic if `AssembledEngine` includes the field and the return object is updated.

13. **Morning Routine mock LLM social awareness** — The `MorningRoutineMockLLMClient.selectAffordance()` method must be updated: when `drive === 'social'` and the agent is in the `living_room` (where Bob starts), the mock LLM should NOT fall back to `watch_tv`. Instead, it should attempt to navigate toward the other agent's location. Since the mock LLM cannot call `talk_to` (it bypasses the tool-call loop), this is a best-effort heuristic that at least moves agents into the same room. The existing fallback `return 'watch_tv'` in the `living_room` case is replaced with `return 'observe'` (acknowledging the presence of another agent without social action capability). This makes the mock LLM's behavior less misleading (it no longer pretends to satisfy social drive by watching TV when another agent is present).

### Examples Layer — Office Day Scene (`examples/office-day.ts`)

14. **Real-LLM mode in `office-day.ts`** — The `buildOfficeDayEngine()` function in `office-day.ts` must check `process.env['USE_REAL_LLM'] === 'true'` and, when true, construct an `OpenAICompatibleLLMClient` with `CognitiveToolExecutorImpl` (wired with `socialBridge: core.socialManager` and `stateDataProvider: core.bridges.reflect`), following the same pattern as `morning-routine.ts` (Req 9). When `USE_REAL_LLM` is not set, the existing `OfficeDayMockLLMClient` is used (backward compatible).

15. **Import `OpenAICompatibleLLMClient` and `CognitiveToolExecutorImpl` in `office-day.ts`** — Same as Req 10 but for `office-day.ts`.

16. **`buildOfficeDayEngine()` exposes `socialManager`** — The `buildOfficeDayEngine()` function must include `socialManager: core.socialManager` in the returned `AssembledEngine` object.

17. **Office Day mock LLM social awareness** — The `OfficeDayMockLLMClient.selectAffordance()` method already handles social drive by navigating to `break_room` (for `small_talk`) or `meeting_room` (for `hold_meeting`). This behavior is adequate and does not need changes. The `small_talk` and `hold_meeting` affordances are physical affordances on objects, not cognitive tools, so the mock LLM can use them without the tool-call loop. No changes needed.

### Tests

18. **Assembly test: `createEngineCore()` creates `SocialManager`** — A test in `packages/engine/tests/assembly.test.ts` must verify that `createEngineCore(config)` returns an `EngineCore` with a non-undefined `socialManager` field. The `socialManager` must be an instance of `SocialManager`.

19. **Assembly test: `PerceptionDataProviderImpl` has `SocialManager` wired** — A test must verify that after `createEngineCore()`, the `bridges.perception` provider returns non-empty `getAgentsInRoom()` results when agents are in the same room. Specifically: create an engine core, spawn two agents in the same room, and assert `bridges.perception.getAgentsInRoom(roomId, agentA)` returns a summary for agent B.

20. **Assembly test: `createEngine()` returns `socialManager`** — A test must verify that `createEngine(config, orchestrator)` returns an `AssembledEngine` with a non-undefined `socialManager` field.

21. **Integration test: agents perceive each other after wiring** — A test must verify that after `createEngineCore()` + `loadScene()` with a multi-agent scene (e.g., morning-routine scene with Alice in bedroom and Bob in living_room), when both agents are moved to the same room, the perception provider's `getAgentsInRoom()` returns the other agent's summary. This test does NOT require an LLM — it tests the wiring, not the full PPER cycle.

22. **Integration test: `talk_to` end-to-end with real LLM wiring** — A test (or manual verification documented in the spec) must demonstrate that when `USE_REAL_LLM=true` with the morning-routine scene, agents can:
    - Perceive each other in the same room (`agentsPresent` is populated)
    - The LLM context includes "Agents present: ..." and social tool definitions
    - The LLM calls `talk_to` with a target agent and message
    - The message appears in the target agent's next perception (`socialContext`)
    - Relationships update (familiarity +5, trust +2 for both agents)
    This test requires a running LLM server and is tagged as a manual/integration test. It is not expected to run in CI without an LLM endpoint.

### Documentation

23. **Update `docs/specs/INDEX.md`** — The INDEX.md must be updated with spec 019 added with status 📝 Drafted.

## Acceptance Criteria

- [ ] **AC-1**: `createEngineCore(config)` returns an `EngineCore` object with a `socialManager` field that is an instance of `SocialManager` (not `undefined`). *(Req 1, 3, 4)*
- [ ] **AC-2**: After `createEngineCore(config)`, `core.bridges.perception.getAgentsInRoom(roomId, agentId)` returns non-empty results when other agents are in the same room. Specifically: spawn agents A and B in room "kitchen", then `getAgentsInRoom("kitchen", "agent-a")` returns a summary containing B's `agentId`. *(Req 2)*
- [ ] **AC-3**: The `EngineCore` interface in `assembly.ts` includes `socialManager: SocialManager` as a non-optional field. *(Req 3)*
- [ ] **AC-4**: The `AssembledEngine` interface in `assembly.ts` includes `socialManager: SocialManager` as a non-optional field. *(Req 5)*
- [ ] **AC-5**: `createEngine(config, orchestrator)` returns an `AssembledEngine` with a non-undefined `socialManager` field. *(Req 6)*
- [ ] **AC-6**: `assembly.ts` imports `SocialManager` from `./social/social-manager.js`. *(Req 7)*
- [ ] **AC-7**: When `USE_REAL_LLM=true`, `examples/minimal-scene.ts` constructs `CognitiveToolExecutorImpl` with `socialBridge: core.socialManager` (in addition to the existing `stateDataProvider`). *(Req 8)*
- [ ] **AC-8**: When `USE_REAL_LLM=true`, `examples/morning-routine.ts` constructs an `OpenAICompatibleLLMClient` with a `CognitiveToolExecutorImpl` wired with `socialBridge: core.socialManager` and `stateDataProvider: core.bridges.reflect`. *(Req 9, 10)*
- [ ] **AC-9**: When `USE_REAL_LLM` is not set, `examples/morning-routine.ts` uses the existing `MorningRoutineMockLLMClient` (no behavior change). *(Req 9)*
- [ ] **AC-10**: `buildMorningRoutineEngine()` returns an `AssembledEngine` with a non-undefined `socialManager` field. *(Req 12)*
- [ ] **AC-11**: The `MorningRoutineMockLLMClient.selectAffordance()` method, when `drive === 'social'` and `room === 'living_room'`, returns `'observe'` instead of `'watch_tv'`. *(Req 13)*
- [ ] **AC-12**: When `USE_REAL_LLM=true`, `examples/office-day.ts` constructs an `OpenAICompatibleLLMClient` with a `CognitiveToolExecutorImpl` wired with `socialBridge: core.socialManager` and `stateDataProvider: core.bridges.reflect`. *(Req 14, 15)*
- [ ] **AC-13**: When `USE_REAL_LLM` is not set, `examples/office-day.ts` uses the existing `OfficeDayMockLLMClient` (no behavior change). *(Req 14)*
- [ ] **AC-14**: `buildOfficeDayEngine()` returns an `AssembledEngine` with a non-undefined `socialManager` field. *(Req 16)*
- [ ] **AC-15**: A test in `packages/engine/tests/assembly.test.ts` verifies that `createEngineCore(config).socialManager` is an instance of `SocialManager`. *(Req 18)*
- [ ] **AC-16**: A test verifies that after `createEngineCore(config)` + spawning two agents in the same room, `core.bridges.perception.getAgentsInRoom(roomId, agentA)` returns a non-empty array containing agent B's summary. *(Req 19)*
- [ ] **AC-17**: A test verifies that `createEngine(config, orchestrator).socialManager` is not `undefined`. *(Req 20)*
- [ ] **AC-18**: A test verifies that after `createEngineCore()` + `loadScene()` with a multi-agent scene, moving two agents to the same room results in `getAgentsInRoom()` returning the other agent. *(Req 21)*
- [ ] **AC-19**: `docs/specs/INDEX.md` includes spec 019 with status 📝 Drafted. *(Req 23)*
- [ ] **AC-20**: Existing tests in `packages/engine/tests/assembly.test.ts` that do not reference `socialManager` continue to compile and pass without modification. *(Backward compatibility)*
- [ ] **AC-21**: Existing tests that call `createEngineCore()` without accessing `socialManager` continue to compile and pass. The `socialManager` field is additive. *(Backward compatibility)*
- [ ] **AC-22**: When `USE_REAL_LLM=true` with the morning-routine scene, the LLM context includes "Agents present: Bob (...)" when Alice and Bob are in the same room, and the `tools` array includes `talk_to`, `observe_agent`, `help`, and `ignore` tool definitions. *(Req 9, Issue AC-4)*
- [ ] **AC-23**: When `USE_REAL_LLM=true` with the morning-routine scene, and the LLM calls `talk_to` with `{ targetAgentId: "agent-bob", message: "Hi Bob!" }`, the message is queued via `SocialManager.queueMessage()` and appears in Bob's next perception `socialContext`. *(Req 9, Issue AC-5)*
- [ ] **AC-24**: After a `talk_to` interaction between Alice and Bob, `AgentInternalState.relationships` for Alice includes `{ "agent-bob": { trust: 52, familiarity: 5, lastInteraction: <timestamp> } }` and for Bob includes `{ "agent-alice": { trust: 52, familiarity: 5, lastInteraction: <timestamp> } }`. *(Req 9, Issue AC-6)*

## Constraints

- **No new types, classes, or interfaces**: All social infrastructure (SocialManager, MessageQueue, SocialActionBridge, social tool definitions, perception/builder social context) was implemented in spec 018. This spec only wires existing pieces together.
- **Package boundaries** (per ADR-0001): `assembly.ts` is in `engine` and imports `SocialManager` from `./social/social-manager.js` (within-package import). Example scenes import from both `engine` and `cognition` — this is allowed because examples are the application entry point. No `cognition` → `engine` or `engine` → `cognition` imports are introduced.
- **Backward compatibility**: The `socialManager` field on `EngineCore` and `AssembledEngine` is additive. Existing code that destructures `EngineCore` or `AssembledEngine` without referencing `socialManager` continues to work. Existing tests that call `createEngineCore()` or `createEngine()` without accessing `socialManager` compile and pass without modification. The `USE_REAL_LLM` env var check in prototype scenes is additive — when not set, existing mock LLM behavior is preserved.
- **No changes to `packages/shared/` or `packages/cognition/`**: All wiring changes are in `packages/engine/src/assembly.ts` and `examples/`. The `shared` and `cognition` packages already have the necessary infrastructure from spec 018.
- **No changes to `packages/memory/`**: Social features do not interact with the memory subsystem.
- **No new npm dependencies**: All imports are from existing packages.
- **`SocialManager` is always created in `createEngineCore()`**: Unlike optional subsystems (persistence, memory decay), `SocialManager` is always constructed because it only depends on `AgentManager` (always available) and has negligible overhead. This ensures social perception is always wired when using the engine.
- **Real-LLM social tests are manual/integration**: AC-22 through AC-24 require a running LLM server and are not expected to run in CI. They are documented as manual verification steps. The wiring tests (AC-15 through AC-18) run in CI without an LLM.
- **What NOT to do**:
  - Do not modify `SocialManager`, `MessageQueue`, `PerceptionDataProviderImpl`, `CognitiveToolExecutorImpl`, or `OpenAICompatibleLLMClient` — these are already implemented per spec 018.
  - Do not introduce a new `SocialSystem` `EngineSystem` — `SocialManager` is a passive data structure, not ticked.
  - Do not modify the `PPEROrchestratorOptions` or `createPPEROrchestrator` — the orchestrator receives the LLM client (already wired with `cognitiveToolExecutor` by the caller).
  - Do not change the `LLMClient` interface or mock LLM signatures.
  - Do not add social features to the Reflect phase.
  - Do not modify `loadScene()` — scene loading does not need social wiring (the `SocialManager` is already created by `createEngineCore()` before `loadScene()` is called).
  - Do not auto-wire `socialBridge` inside `createEngineCore()` — `CognitiveToolExecutorImpl` is in `cognition`, and the engine must not import from `cognition`. The wiring happens in example scenes.
