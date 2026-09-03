# Design Decisions — Feature 106: Real-LLM Visualizer Demo (Spec 027)

## Decision 1: Extract shared assembly helper, do not duplicate wiring
**Why**: `buildCoffeeShopEngine()` in `examples/coffee-shop.ts` already contains the exact
real-LLM wiring the issue asks for (OpenAICompatibleLLMClient + guardrails +
CognitiveToolExecutorImpl → createPPEROrchestrator). Copying it into the visualizer demo
would create two wiring paths that drift. The cognition/memory assembly is extracted into
`examples/assembly.ts` (`assembleCognitionStack()`); both entry points call it, giving
demo and validation scene one wiring source of truth.

**Alternative considered**: Have the visualizer demo call `buildCoffeeShopEngine()` directly
and just swap the scene. Rejected — `buildCoffeeShopEngine()` hardcodes `COFFEE_SHOP_SCENE`,
handler registration, and auto-save config; the demo needs scene-agnostic assembly to serve
its three-scene selector.

## Decision 2: Load the coffee-shop scene from `coffee-shop.scene.yaml` via `loadSceneFile`
**Why**: Spec 022 made the YAML file the declarative source of truth consumed by the CLI
(`run-scene`, `validate-scene`). The demo importing `COFFEE_SHOP_SCENE` from TypeScript
keeps two representations alive. Loading the YAML through the same loader path
(`loadSceneFile` + handler plugins/`autoRegisterHandlers`) guarantees what is rendered on
canvas is identical to what headless validation runs execute.

**Scope note**: `MINIMAL_SCENE` / `MORNING_ROUTINE_SCENE` stay as inline TypeScript — they
are demo-only scenes with no validation counterpart. Converting them is out of scope.

## Decision 3: Env-var convention unchanged (`USE_REAL_LLM`, `USE_REAL_EMBEDDINGS`, `LLM_*`)
**Why**: Same convention as `coffee-shop.ts` (spec 019) — `USE_REAL_LLM === 'true'` builds
the real orchestrator; default remains the no-op `MockOrchestrator` with zero network calls.
All env vars are read in one place (the shared helper) so both entry points behave
identically (AC-9 env parity test).

## Decision 4: Startup LLM health check in real mode only
**Why**: The issue's core complaint is a *silent* failure mode — a static scene where
agents never act. With a real backend that is unreachable, the demo would look identical
to the old bug. A cheap startup probe that exits non-zero with the backend URL in the
error message converts silent failure into loud failure. No probe in mock mode.

## Decision 5: No renderer/visualizer-package changes
**Why**: The renderer (spec 023) already draws agent location, drive bars, object state,
PPER phase, and relationship lines from `VisualizerState` snapshots. Agent movement,
water_level changes, and drive changes all flow through existing engine state the adapter
already reads — the only missing piece was that PPER cycles never ran. This keeps the
change confined to `examples/` (verified by AC-8).

## Decision 6: Mock-mode demo stays fully deterministic
**Why**: Existing visualizer smoke tests rely on the no-op `MockOrchestrator` and static
scene. Simulated cycles in mock mode would break determinism and blur the line between
"rendering demo" and "behavior demo". The no-op default remains exactly as before.

## Requirement → AC mapping
- Req 1 (extract helper) → AC-1
- Req 2 (refactor buildCoffeeShopEngine) → AC-1
- Req 3 (real orchestrator in demo) → AC-2
- Req 4 (demo handler parity) → AC-5
- Req 5 (YAML scene loading) → AC-3
- Req 6 (scene map integrity) → AC-4
- Req 7 (PPER cycles, movement, relationships) → AC-5, AC-6
- Req 8 (live state in snapshots) → AC-5, AC-6
- Req 9 (LLM health check) → AC-7
- Req 10 (concurrency safety) → AC-8
