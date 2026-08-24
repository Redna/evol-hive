# Feature: Phase 4 Validation Scene — "Coffee Shop" Comprehensive Integration Example

## Context
- Architecture: [§1 — Vision & Philosophy](../architecture/01-vision.md) (emergent behavior as the system goal), [§2 — System Overview](../architecture/02-system-overview.md) (package boundaries, PPER loop, hybrid engine), [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (SmartObject, Affordance, compound actions, state rules, conditional affordances, object dependencies), [§6 — PPER Loop](../architecture/06-pper-loop.md) (Perceive → Plan → Execute → Reflect), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (intrinsic tools, social tools, tool call loop), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (memory store, consolidation, decay, retrieval, embeddings)
- Related specs: [005 — Game Loop Integration & Minimal Scene](005-game-loop-integration.md) (createEngineCore, assembleGameLoop, loadScene, EngineConfig, DriveDecaySystem), [006 — OpenAI-Compatible LLM Client](006-openai-compatible-llm-client.md) (real LLM via Ollama/OpenAI-compatible endpoints, USE_REAL_LLM), [007 — ONNX Embedding Provider](007-onnx-embedding-provider.md) (real embeddings, USE_REAL_EMBEDDINGS), [012 — Agent Persona System](012-agent-persona-system.md) (AgentProfile, traits, formatPersona), [013 — Richer Prototype Scenes](013-richer-prototype-scenes.md) (scene definitions, room/object/agent structure, scene-helpers pattern, existing example scenes), [014 — Memory Consolidation, Decay & Retrieval](014-memory-consolidation-decay-retrieval.md) (MemoryStore, MemoryDecayService, ReflectionLoop, memory decay config), [015 — Full Cognitive Tools](015-full-cognitive-tools.md) (CognitiveToolExecutorImpl, tool call loop, social bridge), [016 — Cognitive Guardrails](016-cognitive-guardrails.md) (affordance masking, contextual forcing, plan validation), [017 — Persistence — Save/Load Game State](017-persistence-save-load-game-state.md) (EnginePersistence, AutoSaveSystem, AutoSaveConfig, save/load), [018 — Object Interactions](018-object-interactions.md) (compound actions, ObjectStateSystem, conditional affordances, cross-object state changes, object dependencies), [018 — Multi-Agent Social](018-multi-agent-social.md) (SocialManager, SocialActionBridge, talk_to, observe_agent, relationships, agent-to-agent perception)
- Package: `examples` (new scene file `coffee-shop.ts`, extended `scene-helpers.ts`), `shared` (no new types — all types already exist from specs 014–018), `engine` (no new code — all systems already implemented), `cognition` (no new code — all tool infrastructure already implemented), `memory` (no new code — memory store and decay service already implemented)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#74](https://github.com/Redna/evol-hive/issues/74)

## Design Rationale

Phase 4 validation revealed that no single example scene wires all features simultaneously. The existing three scenes (minimal, morning-routine, office-day) each exercise a subset:

- **Minimal scene** uses real LLM + real embeddings + cognitive tools, but has 1 room, 1 agent, 1 object, no social manager, no persistence, no object state system, no compound actions, no conditional affordances, no memory consolidation.
- **Morning Routine** has 4 rooms, 2 agents, object state depletion (via handler logic), but uses a mock LLM, no social manager, no cognitive tool executor, no persistence, no ObjectStateSystem, no compound actions, no conditional affordances, no real embeddings, no memory consolidation.
- **Office Day** has 4 rooms, 3 agents, social affordance objects (Water Cooler, Meeting Table), but uses a mock LLM, no SocialManager, no cognitive tool executor, no persistence, no ObjectStateSystem, no compound actions, no conditional affordances, no real embeddings, no memory consolidation.

The proposed "Coffee Shop" scene is an **integration-only** spec: every subsystem it wires already has a complete implementation and passing tests from specs 005–018. This spec defines a new example file (`examples/coffee-shop.ts`) and the necessary extensions to `examples/scene-helpers.ts` to register the new affordance handlers, precondition checkers, and movement destinations. No new types, no new engine systems, no new cognition logic — purely assembly and configuration.

The scene is designed around a coherent narrative (a shared living space with a coffee machine) that naturally exercises every feature:

1. **Compound actions** — The Coffee Machine exposes a 3-step sequence: `add_water` → `brew_coffee` → `pour_cup`, linked via `stepGroup`/`stepOrder` and declared as a `CompoundAction` on the object.

2. **Object state rules** — The Coffee Machine's `water_level` decays over time (simulating evaporation/usage) and replenishes toward a target (simulating automatic refill). The Sink's `water_supply` decays slowly. These are declared as `ObjectStateRule[]` on the objects and applied by the existing `ObjectStateSystem`.

3. **Conditional affordances** — `brew_coffee` has structured `conditions` requiring `water_level > 0` AND `bean_count > 0`. When water is depleted, `brew_coffee` is filtered out at perception time (not just failing at execute time). The `add_water` affordance has a condition requiring the Sink's `water_supply > 0` (cross-object dependency surfaced to the LLM).

4. **Object dependencies** — The Coffee Machine declares an `ObjectDependency`: `add_water` requires interacting with the Sink first (`refill_pitcher` on the Sink). This is surfaced in the LLM context via the plan builder.

5. **Cross-object state changes** — `refill_pitcher` on the Sink returns `crossObjectStateChanges` that update the Coffee Machine's `water_level`. This demonstrates the cross-object replenishment flow from spec 018.

6. **Social manager** — The `SocialManager` is wired as the `SocialActionBridge` and passed to the `CognitiveToolExecutorImpl` as `socialBridge`. Agents perceive each other via `PassivePerception.agentsPresent`. The `talk_to` and `observe_agent` cognitive tools are available when other agents are present.

7. **Cognitive tool executor** — Wired with `stateDataProvider` (the engine's reflect bridge) and `socialBridge` (the SocialManager), enabling `update_internal_state`, `query_memory`, `talk_to`, `observe_agent`, `help`, and `ignore` tools during the LLM tool call loop.

8. **Real LLM** — Uses `OpenAICompatibleLLMClient` when `USE_REAL_LLM=true`, configurable via `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_REASONING_EFFORT`, and `LLM_MAX_TOOL_CALL_ITERATIONS` environment variables. Falls back to a mock LLM when not set.

9. **Real embeddings** — Uses `OnnxEmbeddingProvider` when `USE_REAL_EMBEDDINGS=true`, configurable via `EMBEDDING_MODEL_PATH` and `EMBEDDING_TOKENIZER_PATH`. Falls back to `MockEmbeddingProvider` when not set.

10. **Memory consolidation** — The `MemoryDecayService` and `ReflectionLoop` are wired from the engine core (when a `VectorStore` is provided to `createEngineCore`). The `MemoryMaintenanceSystem` is registered as an engine system. Memory decay config is configurable via `MEMORY_DECAY_RATE` and `MEMORY_PRUNE_THRESHOLD` environment variables.

11. **Persistence** — The `EnginePersistenceImpl` is available when a `VectorStore` is provided. The `AutoSaveSystem` is registered with a configurable interval (default 30 seconds) and file path. Save/load can be triggered programmatically and via the auto-save system.

12. **Configurable drive decay** — The `DriveDecaySystem` is already registered by `assembleGameLoop`. The decay rate is configurable via `DRIVE_DECAY_RATE` environment variable, passed to the `DriveSystemImpl` via the `EngineConfig`.

The scene runs for a configurable duration (default 5 minutes with real LLM, 10 seconds with mock LLM) and logs periodic state snapshots to demonstrate emergent behavior.

## Requirements

### Scene Definition (examples/coffee-shop.ts)

1. **Four connected rooms** — The scene must define exactly four rooms: `kitchen`, `living_room`, `bathroom`, and `garden`. Room connections must form a connected graph: kitchen ↔ living_room, living_room ↔ bathroom, living_room ↔ garden, kitchen ↔ garden. Each room must have a `Doorway` smart object with `go_to_<connection>` affordances for navigation.

2. **Three agents with distinct drive profiles** — The scene must define three agents:
   - **Alice** — Traits: `['diligent', 'caffeine-dependent']`. Initial drives: `energy: 15, hunger: 60, social: 40, comfort: 50, curiosity: 30`. Start room: `kitchen`. Low energy drives coffee-seeking behavior.
   - **Bob** — Traits: `['social', 'easygoing']`. Initial drives: `energy: 50, hunger: 40, social: 15, comfort: 60, curiosity: 50`. Start room: `living_room`. Low social drives social-seeking behavior.
   - **Carol** — Traits: `['curious', 'analytical']`. Initial drives: `energy: 60, hunger: 30, social: 50, comfort: 40, curiosity: 15`. Start room: `garden`. Low curiosity drives knowledge-seeking behavior.

3. **At least six objects including compound actions** — The scene must define at least six smart objects (excluding doorways):
   - **Coffee Machine** (kitchen) — Compound action: `add_water` → `brew_coffee` → `pour_cup`. State: `{ water_level: 5, bean_count: 10, cup_count: 3 }`. State rules: `water_level` decays at 0.1/sec (evaporation), replenishes toward 5 at 0.5/sec after depletion. Conditional affordances: `brew_coffee` requires `water_level > 0 AND bean_count > 0`. Object dependency: `add_water` requires Sink's `refill_pitcher`. Compound action declared as `{ id: 'brew_coffee_sequence', label: 'Brew a cup of coffee', steps: [...] }`.
   - **Sink** (kitchen) — State: `{ water_supply: 20 }`. State rule: `water_supply` decays at 0.05/sec. Affordances: `refill_pitcher` (returns `crossObjectStateChanges` updating Coffee Machine `water_level` to 5), `wash_hands` (comfort +5). `refill_pitcher` has condition `water_supply > 0`.
   - **Bookshelf** (living_room) — State: `{ book_count: 8 }`. Affordances: `read_book` (curiosity +20, energy -10). Condition: `book_count > 0`.
   - **Sofa** (living_room) — State: `{}`. Affordances: `relax` (comfort +20, energy +5, social +5 when another agent is present — handled via social context, not the affordance itself).
   - **Toilet** (bathroom) — State: `{}`. Affordances: `use_bathroom` (comfort +10).
   - **Garden Bench** (garden) — State: `{}`. Affordances: `sit_outside` (comfort +15, curiosity +5, energy +3).
   - **Flower Bed** (garden) — State: `{ bloom_count: 5 }`. Affordances: `observe_flowers` (curiosity +10, comfort +5). Condition: `bloom_count > 0`. State rule: `bloom_count` decays at 0.02/sec, replenishes toward 5 at 0.1/sec.

4. **Doorway smart objects** — Each room must have a `Doorway` smart object with `go_to_<connection>` affordances matching the room's `connections` array, plus an `observe` affordance. This follows the existing `makeDoorway` helper pattern from the morning-routine and office-day scenes.

### Engine Assembly (examples/coffee-shop.ts)

5. **Real LLM support** — The engine builder must construct an `OpenAICompatibleLLMClient` when `process.env['USE_REAL_LLM'] === 'true'`, reading configuration from `LLM_BASE_URL` (default `http://localhost:11434/v1`), `LLM_MODEL` (default `llama3.1`), `LLM_API_KEY` (optional), `LLM_REASONING_EFFORT` (optional), and `LLM_MAX_TOOL_CALL_ITERATIONS` (optional). When `USE_REAL_LLM` is not set, a `CoffeeShopMockLLMClient` (drive-aware heuristic, same pattern as morning-routine and office-day mock LLMs) must be used.

6. **Real ONNX embeddings** — The engine builder must construct an `OnnxEmbeddingProvider` when `process.env['USE_REAL_EMBEDDINGS'] === 'true'`, reading `EMBEDDING_MODEL_PATH` (required when enabled) and `EMBEDDING_TOKENIZER_PATH` (optional). When not enabled, a `MockEmbeddingProvider` must be used. The embedding provider is passed to `MemoryStoreImpl`.

7. **Real AffordanceClassifier** — When `USE_REAL_EMBEDDINGS === 'true'`, the engine builder must construct an `AffordanceClassifierImpl` with the real embedding provider and `defaultClassifierConfig()`. When not enabled, a mock classifier (returns all affordances) must be used.

8. **SocialManager wired** — The engine builder must construct a `SocialManager` wrapping the `AgentManagerImpl` from the engine core and pass it as `socialBridge` to the `CognitiveToolExecutorImpl`. This enables agent-to-agent perception (`agentsPresent` in `PassivePerception`), `talk_to`, `observe_agent`, `help`, and `ignore` cognitive tools, and structured relationship tracking.

9. **CognitiveToolExecutor wired** — The engine builder must construct a `CognitiveToolExecutorImpl` with `stateDataProvider` set to `core.bridges.reflect` and `socialBridge` set to the `SocialManager`. This must be passed to the `OpenAICompatibleLLMClient` constructor (when using real LLM). When using mock LLM, the cognitive tool executor is not needed (the mock bypasses the tool call loop).

10. **Guardrails wired** — The engine builder must construct a `GuardrailEngineImpl` with `{ affordanceMasking: true, contextualForcing: true, planValidation: true }` and pass it to `createPPEROrchestrator`. This follows the existing pattern from all three example scenes.

11. **EnginePersistence wired with auto-save** — The engine builder must provide a `VectorStore` to `createEngineCore` so that `EnginePersistenceImpl` is available on `core.persistence`. The `assembleGameLoop` function must be called with auto-save configuration: `{ intervalSeconds: 30, filePath: process.env['SAVE_FILE_PATH'] ?? './coffee-shop-save.json' }` when `process.env['USE_AUTOSAVE'] !== 'false'`. Auto-save is enabled by default.

12. **ObjectStateSystem registered** — The `ObjectStateSystem` is registered by `assembleGameLoop` when any objects in the scene have `stateRules`. The Coffee Machine, Sink, and Flower Bed objects must declare `stateRules` so the system has work to do. The system must be active and applying rules every tick.

13. **Memory consolidation wired** — The engine builder must provide a real `VectorStore` (not a mock) so that `MemoryDecayService` and `ReflectionLoop` are available on the engine core. The `MemoryMaintenanceSystem` is registered by `assembleGameLoop` when the memory decay service is present. Memory decay config must be configurable via `MEMORY_DECAY_RATE` (default from `defaultMemoryDecayConfig()`) and `MEMORY_PRUNE_THRESHOLD` environment variables.

14. **Configurable drive decay rate** — The `DriveSystemImpl` decay rate must be configurable via `process.env['DRIVE_DECAY_RATE']` (a number, default: the existing default from `DriveSystemImpl`). When set, the engine builder must pass it to `createEngineCore` via the `EngineConfig` or directly to the `DriveSystemImpl`. The `DriveDecaySystem` is already registered by `assembleGameLoop`.

15. **InMemoryVectorStore with export/import** — The engine builder must use an `InMemoryVectorStore` (same pattern as existing scenes) that supports `exportAll`, `importAll`, `queryByAgent`, and `update` methods, enabling persistence and memory decay. This is required for both auto-save and memory consolidation to work.

### Affordance Handlers (examples/scene-helpers.ts)

16. **New affordance handlers** — The `registerAffordanceHandlers` function (or a new `registerCoffeeShopHandlers` function) must register handlers for all new affordance IDs used by the Coffee Shop scene: `add_water`, `pour_cup`, `refill_pitcher`, `relax`, `sit_outside`, `observe_flowers`. Each handler must be deterministic (no LLM calls, no randomness) and return an `AffordanceResult` with appropriate `driveChanges` and `newState`.

17. **Cross-object state change in refill_pitcher** — The `refill_pitcher` handler on the Sink must return `crossObjectStateChanges: [{ objectId: 'coffee-1', statePatch: { water_level: 5 } }]` to refill the Coffee Machine's water. This demonstrates the cross-object replenishment flow from spec 018.

18. **New precondition checkers** — Precondition checkers must be registered for any new preconditions used by the scene: `has_cups` (checks `cup_count > 0`), `has_water_supply` (checks `water_supply > 0`), `has_blooms` (checks `bloom_count > 0`).

19. **New movement destinations** — The movement handler registration must include `garden` as a new destination, alongside the existing destinations from morning-routine and office-day scenes.

### Entry Point and Observability (examples/coffee-shop.ts)

20. **Configurable run duration** — The entry point (`main`) must run the simulation for a configurable duration: `SCENE_DURATION_MS` environment variable (default: 300000 / 5 minutes when `USE_REAL_LLM=true`, 10000 / 10 seconds when mock LLM). The game loop must be started, the duration awaited, then stopped.

21. **Periodic state logging** — The entry point must log agent state (drives, location, isThinking, relationships) every `LOG_INTERVAL_MS` milliseconds (default: 10000 / 10 seconds) to demonstrate observable emergent behavior. This includes agent locations, current drives, and relationship states between agents.

22. **Save/load demonstration** — The entry point must demonstrate save/load: after the simulation runs, if `USE_REAL_LLM=true`, save the state to the save file, then log the save state summary (number of agents, objects, memory nodes). Optionally, if `DEMO_LOAD=true`, load the saved state into a fresh engine and verify agent memories are preserved.

23. **Mock LLM with social awareness** — The `CoffeeShopMockLLMClient` must be a drive-aware heuristic (same pattern as `MorningRoutineMockLLMClient` and `OfficeDayMockLLMClient`) that selects affordances based on the agent's primary drive and current room. It must handle the `social` drive by navigating toward the living room (where social interactions are likely) and using `talk_to` when other agents are present. It must handle the `curiosity` drive by navigating toward the living room (bookshelf) or garden (flower bed).

24. **Scene export** — The scene definition must be exported as `COFFEE_SHOP_SCENE: SceneDefinition` and the engine builder as `buildCoffeeShopEngine(): AssembledEngine`, following the same export pattern as the existing scenes.

## Acceptance Criteria

- [ ] AC-1: The scene defines ≥4 rooms (`kitchen`, `living_room`, `bathroom`, `garden`) forming a connected graph (every room reachable from every other room) — maps to Req 1
- [ ] AC-2: The scene defines ≥3 agents (Alice, Bob, Carol) with distinct drive profiles where each agent's lowest drive is different (energy, social, curiosity respectively) — maps to Req 2
- [ ] AC-3: The scene defines ≥6 non-doorway smart objects (Coffee Machine, Sink, Bookshelf, Sofa, Toilet, Garden Bench, Flower Bed = 7 objects) — maps to Req 3
- [ ] AC-4: The Coffee Machine declares a `CompoundAction` with ≥3 steps (`add_water` → `brew_coffee` → `pour_cup`) and the affordances have matching `stepGroup`/`stepOrder` fields — maps to Req 3
- [ ] AC-5: At least 3 objects declare `stateRules` (Coffee Machine `water_level`, Sink `water_supply`, Flower Bed `bloom_count`) and the `ObjectStateSystem` is registered and active — maps to Req 3, Req 12
- [ ] AC-6: The `brew_coffee` affordance has structured `conditions: [{ field: 'water_level', operator: '>', value: 0 }, { field: 'bean_count', operator: '>', value: 0 }]` that are evaluated at perception time — maps to Req 3
- [ ] AC-7: The Coffee Machine declares an `ObjectDependency` linking `add_water` to the Sink's `refill_pitcher` — maps to Req 3
- [ ] AC-8: The `refill_pitcher` handler returns `crossObjectStateChanges` that update the Coffee Machine's `water_level` — maps to Req 17
- [ ] AC-9: When `USE_REAL_LLM=true`, the engine uses `OpenAICompatibleLLMClient` configured from environment variables (`LLM_BASE_URL`, `LLM_MODEL`) — maps to Req 5
- [ ] AC-10: When `USE_REAL_EMBEDDINGS=true`, the engine uses `OnnxEmbeddingProvider` for the memory store and `AffordanceClassifierImpl` for affordance pruning — maps to Req 6, Req 7
- [ ] AC-11: A `SocialManager` is constructed and passed as `socialBridge` to the `CognitiveToolExecutorImpl` — maps to Req 8, Req 9
- [ ] AC-12: The `CognitiveToolExecutorImpl` is wired with `stateDataProvider` (reflect bridge) and `socialBridge` (SocialManager) and passed to the LLM client — maps to Req 9
- [ ] AC-13: `GuardrailEngineImpl` is constructed with all three guardrails enabled and passed to the PPER orchestrator — maps to Req 10
- [ ] AC-14: `EnginePersistenceImpl` is available on `core.persistence` and `AutoSaveSystem` is registered with a 30-second interval (default) — maps to Req 11
- [ ] AC-15: `MemoryDecayService` and `ReflectionLoop` are wired and `MemoryMaintenanceSystem` is registered as an engine system — maps to Req 13
- [ ] AC-16: Drive decay rate is configurable via `DRIVE_DECAY_RATE` environment variable — maps to Req 14
- [ ] AC-17: All new affordance handlers (`add_water`, `pour_cup`, `refill_pitcher`, `relax`, `sit_outside`, `observe_flowers`) are registered and return deterministic `AffordanceResult` values — maps to Req 16
- [ ] AC-18: New precondition checkers (`has_cups`, `has_water_supply`, `has_blooms`) are registered — maps to Req 18
- [ ] AC-19: Movement handler for `garden` is registered — maps to Req 19
- [ ] AC-20: The entry point runs for `SCENE_DURATION_MS` (default 300000ms with real LLM) and logs agent state every `LOG_INTERVAL_MS` (default 10000ms) — maps to Req 20, Req 21
- [ ] AC-21: After simulation, the state is saved to a file and the save summary is logged (agent count, object count, memory node count) — maps to Req 22
- [ ] AC-22: The `CoffeeShopMockLLMClient` selects drive-appropriate affordances including social-aware navigation — maps to Req 23
- [ ] AC-23: `COFFEE_SHOP_SCENE` and `buildCoffeeShopEngine` are exported from the module — maps to Req 24
- [ ] AC-24: The scene runs with `USE_REAL_LLM=true` for ≥5 minutes without crashing and produces observable state changes (agent locations change, drives fluctuate, relationships develop) — maps to Req 20, Req 21
- [ ] AC-25: Save/load round-trip works — after saving, loading the state into a fresh engine restores agent drives, locations, object states, and memory nodes — maps to Req 22

## Constraints

- **No new packages** — This spec only touches the `examples` package (new file + extended helpers). No new types, interfaces, or implementations in `shared`, `engine`, `cognition`, or `memory`. All subsystems are already implemented by specs 005–018.
- **No new EngineSystem implementations** — The `ObjectStateSystem`, `DriveDecaySystem`, `AutoSaveSystem`, `MemoryMaintenanceSystem`, and `PPERScheduler` are all already implemented and registered by `assembleGameLoop`. This spec only configures them via scene data and engine config.
- **Package boundaries** — The `examples` package may import from `@evol-hive/shared`, `@evol-hive/engine`, `@evol-hive/cognition`, and `@evol-hive/memory`. It must not import from internal package paths (only from the package entry points).
- **Deterministic handlers** — All affordance handlers must be deterministic (no randomness, no LLM calls, no system clock). State changes are functions of the object's current state only.
- **Mock LLM as fallback** — The mock LLM must not call any external service. It must be a pure heuristic based on parsing `perceptionContext` (same pattern as existing mock LLMs). This ensures the scene runs in CI without external dependencies.
- **Performance** — The scene must run with 3 agents and 7+ objects without excessive memory growth. The `InMemoryVectorStore` stores all memory nodes in memory; for a 5-minute run with real LLM, the memory node count should stay under 1000 (agents produce ~1 memory per PPER cycle, ~1 cycle per 5-10 seconds).
- **What NOT to do** — Do not add new fields to `SmartObject`, `Affordance`, `AgentProfile`, `SceneDefinition`, or any other shared type. Do not modify engine system registration order. Do not create a new `EngineSystem`. Do not add new cognitive tools. Do not modify the PPER orchestrator. Do not add new LLM client methods.
