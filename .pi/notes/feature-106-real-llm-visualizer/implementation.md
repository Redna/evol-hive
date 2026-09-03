# Implementation Notes — Spec 027 (Real-LLM Visualizer Demo, Issue #106)

**Branch**: `feature/106-real-llm-visualizer-demo` · **PR**: #113
**Scope**: `examples/` only — no package sources under `packages/` modified (AC-8).
**Tests first**: `examples/tests/real-llm-visualizer.test.ts` (18 tests) written
before implementation; all spec-019/023 existing tests pass unchanged.

## What was built

### 1. `examples/assembly.ts` (new) — shared cognition assembly (Req 1)

- `buildMemorySubsystem(): MemorySubsystem` — embedding provider
  (`USE_REAL_EMBEDDINGS` → `OnnxEmbeddingProvider`, else in-memory
  `MockEmbeddingProvider`), `InMemoryVectorStore`, `MemoryStoreImpl`. Must be
  called BEFORE `createEngineCore(config, memoryStore, vectorStore)` because the
  engine's reflect bridge captures the memory store at core construction.
- `assembleCognitionStack(core, socialManager?, options?): CognitionStack` —
  SocialManager construction + perception wiring, `USE_REAL_LLM` client
  selection (`OpenAICompatibleLLMClient` vs injected `mockLLMClient`),
  `CognitiveToolExecutorImpl` (real mode only), classifier
  (`USE_REAL_EMBEDDINGS` → `AffordanceClassifierImpl`), `GuardrailEngineImpl`
  (all three guardrails), `createPPEROrchestrator(...)`, and (per
  `wireMemoryMaintenance`, default on) `MemoryDecayServiceImpl` +
  `ReflectionLoopImpl` + core introspection assignments
  (`core.memoryDecayService` / `core.reflectionLoop` /
  `core.memoryMaintenanceConfig`).
- **All `USE_REAL_LLM`/`USE_REAL_EMBEDDINGS`/`LLM_*`/`EMBEDDING_*`/
  `MEMORY_*` env vars are read here — one place, both entry points** (AC-9).
  Returns every field `CoffeeShopAssembledEngine` adds beyond
  `AssembledEngine` plus `decayConfig` and the orchestrator itself.
- Also hosts `MockEmbeddingProvider` + mock classifier (moved out of
  coffee-shop.ts — not referenced by any spec-019 test import).

### 2. `examples/coffee-shop.ts` — refactored onto the helper (Req 2)

`buildCoffeeShopEngine()` now: `buildMemorySubsystem()` → `createEngineCore` →
`loadScene(COFFEE_SHOP_SCENE)` → handlers → `assembleCognitionStack(core,
undefined, { memory, mockLLMClient: new CoffeeShopMockLLMClient() })` →
autoSave → `assembleGameLoop`. Pure refactor: `CoffeeShopAssembledEngine`
shape unchanged, spec-019 suite green unchanged.

### 3. `examples/visualizer-demo.ts` — real PPER cycles + YAML scene (Req 3–6, 9)

- `USE_REAL_LLM=true` → real `PPEROrchestratorImpl` via the helper, wired to
  `core.bridges.*`, passed to `assembleGameLoop()` AND `VisualizerDataAdapter`
  (live `getPhase()` per snapshot). Mock mode keeps the no-op `MockOrchestrator`
  (now exported) — zero cycles, zero network, deterministic smoke tests.
- Scene loading: `coffee-shop` entry comes from
  `loadSceneFile(COFFEE_SHOP_YAML_FILE)` (path resolved via `import.meta.url`
  so it works from any cwd — same file the CLI runs). No `COFFEE_SHOP_SCENE`
  import remains. Handler parity via the spec-022 plugin path
  (`clearHandlerPlugins` + `createBuiltinPlugins` + `registerHandlerPlugin` +
  `autoRegisterHandlers(core, scene)`). Default scene: `coffee-shop` in real
  mode (needed for movement/brewing on canvas), `minimal` otherwise (mock
  behavior unchanged); `opts.scene` overrides.
- Startup LLM health check (`checkLLMHealth`, exported): TCP probe of
  `LLM_BASE_URL` host/port (default Ollama `http://localhost:11434/v1`,
  model `llama3.1`), 3s timeout. Real mode only. Unreachable → throws error
  naming URL + model; `main()` catches → `process.exit(1)` (verified: exit
  code 1, message includes URL+model). `startVisualizerDemo` opts gained
  `scene` + `healthCheckTimeoutMs` (signature preserved, fields added only:
  handle gains `orchestrator`, `llmClient?`, `guardrail?`, `scenes`).

### 4. Test infrastructure pattern (reusable)

`startScriptedLLMServer()` in the test file speaks the OpenAI tool-call
protocol the real client uses: parses `Room:` / `Primary drive: low <drive>,`
from request text, returns `formulate_plan` tool-call for plan requests
(tools containing `formulate_plan`), `reflect` tool-call otherwise. Drive→
affordance selection mirrors `CoffeeShopMockLLMClient`. **Gotcha found the
hard way**: the orchestrator sets phase `plan` BEFORE the fetch hits the wire,
so a "hold the response" gate must be disabled *before* flushing — a poll can
observe the phase while the request is still in flight; releasing an empty
queue then deadlocks the cycle (request arrives later, gets held, nobody
releases). Always set `hold=false` before `release()`.

## AC status

- AC-1 ✅ helper exists; no direct LLM/guardrail/orchestrator construction in
  coffee-shop.ts (source-checked in test); spec-019 suite unchanged.
- AC-2 ✅ orchestrator type per env var; live `pperPhase === 'plan'` observed
  through `adapter.getSnapshot()` with a gated stub (deterministic).
- AC-3 ✅ YAML load via demo's `buildSceneMap()`; id/rooms/objects/agents
  asserted; deep-equal to direct `loadSceneFile`.
- AC-4 ✅ 3-scene map; inline scenes unchanged.
- AC-5 ✅ game-loop integration (`injectElapsed` + sampling): kitchen↔
  living_room movement, `water_level` < 5 (state rules approach back toward 5
  at 0.5/tick, so the test tracks the observed minimum), drive increases.
- AC-6 ◐ end-to-end run against a scripted backend: Alice kitchen→living_room,
  water 5→~3 over multiple brews, drive bars respond. Relationship lines need
  a real Ollama run (scripted server never issues social tool calls) — manual
  issue verification pending.
- AC-7 ✅ unreachable backend → exit 1 + URL/model in message (unit + CLI);
  mock mode: zero fetches/socket connects (spied).
- AC-8 ✅ full suite 7/7 packages; diff touches `examples/` only.
- AC-9 ✅ identical env → identical `baseUrl`/`model` on both llmClients.

## Verification

`pnpm test` (7/7 packages, incl. 97 example tests) · `pnpm typecheck` ·
`pnpm lint` · `pnpm build` · prettier clean. Real-mode CLI smoke:
`USE_REAL_LLM=true` + unreachable URL exits 1 with URL+model.