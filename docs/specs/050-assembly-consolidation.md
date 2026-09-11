# Feature: Assembly Consolidation — Promote the Cognition-Stack Assembler Out of `examples/`, Delete `examples/assembly.ts` (Single Wiring Source of Truth)

> Issue: [#166](https://github.com/Redna/evol-hive/issues/166) — "The repo has two assembly paths."
> `packages/engine/src/assembly.ts` (`createEngineCore`) owns all engine-side wiring; `examples/assembly.ts`
> (567 lines) assembles the cognition stack **and** re-wires social/perception pieces itself. This second
> path has already diverged twice: #155 (stale inline visualizer renderer) and #165 (`conversationBridge`
> + `social.setConversationManager` unwired — spec 033/043/044 conversation machinery dormant in every
> live sim). Spec 045 patched the symptom in `examples/`; this spec removes the second path.

## Context
- Architecture: [§2 System Overview](../architecture/02-system-overview.md) (Package Map, Dependency Graph: `shared ← engine/cognition/memory`, `memory ← cognition`; *engine and cognition do not directly depend on each other*), [§6 PPER Loop](../architecture/06-pper-loop.md) (orchestrator construction), [§8 Cognitive Tools](../architecture/08-cognitive-tools.md) (`CognitiveToolExecutor` bridge ports), [§11 Memory Architecture](../architecture/11-memory-architecture.md) (decay/reflection wiring)
- Related specs: [019 — Wire SocialManager in Assembly](019-wire-social-manager.md) (prior assembly-wiring spec, same drift family), [027 — Real-LLM Visualizer Demo](027-real-llm-visualizer-demo.md) (created `examples/assembly.ts`), [033 — Conversations](033-conversations-identity-evolution.md) / [043 — Conversation Perception Bridge](043-conversation-perception-bridge.md) / [044 — Social Urge Model](044-social-urge-model.md) (machinery that went dormant), [045 — Assembly Conversation Wiring](045-assembly-conversation-wiring.md) (issue #165's two-line fix — merge first; this spec supersedes it structurally, AC-5), [042 — Visualizer Single Renderer](042-visualizer-single-renderer.md) / issue [#155](https://github.com/Redna/evol-hive/issues/155) (drift family, opposite direction), [022 — Performance Tuning](022-performance-tuning.md) (`ENGINE_MAX_CONCURRENT_LLM` env → `defaultPPERSchedulerConfig`)
- Package: **new `@evol-hive/assembly` package** (composition root); consumers touched: `examples` (all sims), `cli` (`run-scene`). No behavior change inside `engine`, `cognition`, `memory`, or `shared` — their exported machinery is only relocated up one layer.

## Problem

Two assembly paths coexist:

1. `packages/engine/src/assembly.ts` — `createEngineCore`: agent/drive/plan managers, physics + spatial + scene manager, SocialManager ↔ ConversationManagerImpl ↔ self-model ↔ consolidation sink (spec 033/047), mutation funnel + dormancy + YAAM log (spec 030), the four bridges (perception wired with social/conversation/self-model/tick-source, spec 019/033/044), persistence (spec 017), scheduler config via `defaultPPERSchedulerConfig`.
2. `examples/assembly.ts` — `buildMemorySubsystem` (YAAM/ONNX memory wiring), `assembleCognitionStack` (LLM client + guardrails + classifier + PPER orchestrator + memory decay/reflection), `assembleSystem1` (gate/heads/salience/outcome recorder, spec 035/036/041) — **plus** its own social/perception re-wiring (`new SocialManager`, `setConversationManager`, `conversationBridge`), a second copy of logic `createEngineCore` already owns.

Every entry point re-wires by hand (`dynamic-world-sim.ts:287–372`, `coffee-shop.ts:527–556`, `visualizer-demo.ts:331–368`, `run-scene.ts` builds its own orchestrator from scratch) — any wire a caller forgets is silently dormant (exactly #165).

## Requirements

- **R1 — One promoted assembler at the layer above engine and cognition.** A single `assembleWorld` (or equivalent) lives in a **new `@evol-hive/assembly` package** whose dependency set is `{ shared, engine, cognition, memory }`. The package is the composition root: it is the only place allowed to depend on both `@evol-hive/engine` and `@evol-hive/cognition`. Dependency justification against §2's rules: (a) a package *above* both preserves the acyclic graph — `engine` and `cognition` still never import each other; (b) engine-with-cognition-peer is rejected outright (it would make `engine` depend on `cognition`, inverting ADR-0001 and coupling the deterministic loop to LLM code); (c) hosting in `packages/cli` is rejected (an app layer importing it from `examples/` and `visualizer` inverts app/library direction and couples the visualizer to CLI code). See Decision 1 in the workspace notes. (AC-1, AC-3)

- **R2 — The assembler wires everything, jointly.** The promoted assembler internally calls `createEngineCore` (all engine wiring as today) **and** builds the cognition stack (LLM client incl. `USE_REAL_LLM` selection, guardrail engine + topology/affordance guards, System-0 classifier incl. `USE_REAL_EMBEDDINGS`, PPER orchestrator, token usage reporter), memory maintenance (decay service, reflection loop, configs), System 1 (gate, importance head, feature service, outcome recorder, salience-weighted identity hook, session sample log), and calls `assembleGameLoop` with all of it — no optional wires left to the caller. `loadScene`/handler registration stay caller-side (they are scene data, not wiring). (AC-1, AC-2, AC-4)

- **R3 — Consumers become thin.** `examples/dynamic-world-sim.ts`, `coffee-shop.ts`, `visualizer-demo.ts`, `dynamic-world.ts`, and the CLI `run-scene` pass **config + env only**: they construct `EngineConfig` (or accept the assembler's env-driven default), optionally hand a mock LLM client, and call the assembler. Zero `createEngineCore`/`new SocialManager`/`new GuardrailEngineImpl`/`createPPEROrchestrator` calls remain in consumers. (AC-1, AC-3)

- **R4 — Default-path completeness invariant.** The conversation bridge (`conversationBridge: core.conversationManager`, spec 033/043) and the urge surfaces (spec 044 tick source, reciprocity via conversations) are wired **by default** inside the assembler. Rule: a component existing in core but unwired by the default path is a bug by definition — the assembler's own integration test asserts this. (AC-2)

- **R5 — `buildMemorySubsystem` moves with the assembler.** YAAM/ONNX memory wiring (`OnnxEmbeddingProvider` vs mock, `InMemoryVectorStore`, `MemoryStoreImpl`) is exported from `@evol-hive/assembly` and is constructed before `createEngineCore` internally (the reflect bridge captures the store at construction). Consumers never construct memory stores directly. (AC-1, AC-3)

- **R6 — `EngineConfig.maxConcurrentLLM` dead field resolved.** The scheduler reads `ENGINE_MAX_CONCURRENT_LLM` via `defaultPPERSchedulerConfig` (spec 022) and never reads `config.maxConcurrentLLM`. In the same pass: either the assembler forwards a scheduler config derived from the caller's `EngineConfig.maxConcurrentLLM` (env still overrides), or the field is removed from `EngineConfig` — chosen: **forward it** (`overrideSchedulerConfig`), because dozens of tests and scenes set the field meaningfully and removal would be a churn-only breaking change. The field must never again be declared-but-unread: a shared-types test asserts the scheduler consumes it. (AC-6)

## Acceptance Criteria

- [x] **AC-1** (R1, R2, R3, R5): `examples/assembly.ts` is deleted; `pnpm typecheck && pnpm build && pnpm test` green with all examples/cli importing the promoted assembler. Grep assertion: no file outside `packages/assembly`/`packages/engine` contains `createPPEROrchestrator|new GuardrailEngineImpl|buildMemorySubsystem|new SocialManager`. *(Implemented — `packages/assembly/tests/wiring-audit.test.ts` scans every consumer entry point; suite green.)*
- [x] **AC-2** (R4): In a live sim run (real LLM), `talk_to` creates conversation objects — `core.conversationManager` count > 0, spec 043 pending-address lines render on the target's perception. Encoded as an assembler-level integration test that constructs the stack via the default path and asserts `conversationBridge` identity (`===` `core.conversationManager`) and `getConversationsAwaitingAgentReply` non-emptiness after a `talk_to`. *(Implemented — `packages/assembly/tests/assembly.test.ts` AC-2 suite: identity via the production executor + thread in the core's manager + pending-address render + spec 044 reciprocity; the optional live-LLM render evidence remains a manual live-run item recorded in the implementation notes.)*
- [x] **AC-3** (R1, R3, R5): Grep-audit — engine-side wiring (`ConversationManagerImpl`, bridges, `setTickSource`, persistence) appears **only** in `packages/engine`; cognition-side wiring (orchestrator, guardrails, classifier, System 1 heads) **only** in `packages/assembly`; consumers (`examples/`, `packages/cli`) contain zero wiring calls — only `assembleWorld(...)` (or equivalent) + scene data. *(Implemented — `packages/assembly/tests/wiring-audit.test.ts`, incl. the ADR-0001 import-graph audit.)*
- [x] **AC-4** (R2): Full suite green; every example E2E (`coffee-shop.test.ts`, `spec-031/032/034/046/047/048` e2e tests) passes against the promoted path **unmodified except for imports**, proving behavioral equivalence (mock-LLM determinism unchanged). *(2,528 passed / 0 failed across 8 workspaces; the five listed suites pass with only import-path changes.)*
- [x] **AC-6** (R6): After the pass, `maxConcurrentLLM` set on `EngineConfig` demonstrably bounds concurrent PPER cycles in a unit test (scheduler receives the derived config; `ENGINE_MAX_CONCURRENT_LLM` env still overrides) — the field is consumed or absent, never dead. *(Implemented — shared `overrideSchedulerConfig` tests + `packages/assembly/tests/scheduler-forwarding.test.ts`: scheduler receives the derived config, env overrides, scene config keeps precedence, and a behavioral bound test counts concurrent cycles.)*

*(AC-5 of the issue — "supersedes #165's two-line fix" — is a sequencing condition, not a test: merge #165 first for the immediate unblock, then this spec deletes the file that fix patched.)*

## Requirement → AC mapping

| Requirement | ACs |
|---|---|
| R1 promoted assembler, new `@evol-hive/assembly` layer | AC-1, AC-3 |
| R2 wires everything jointly, no optional wires | AC-1, AC-2, AC-4 |
| R3 thin consumers (config + env only) | AC-1, AC-3 |
| R4 default-path completeness (bridge + urge surfaces) | AC-2 |
| R5 `buildMemorySubsystem` moves with the assembler | AC-1, AC-3 |
| R6 `maxConcurrentLLM` wired or removed | AC-6 |

## Constraints
- **Package boundaries:** new `@evol-hive/assembly` depends on `shared`, `engine`, `cognition`, `memory` (never the reverse); `examples/` and `cli` depend on it. `shared` imports nothing; `engine` and `cognition` remain mutually independent (§2 Dependency Graph).
- **Behavior safety:** this is a structural refactor, not a behavior change — mock-LLM scene outputs and engine telemetry must be byte-identical pre/post except where #165's fix already changed them (conversation path live). All existing tests pass unmodified except import paths.
- **Patterns to follow:** mirror `packages/engine/src/assembly.ts` JSDoc conventions (spec citations inline); export everything from `src/index.ts` (repo convention); strict TS flags per AGENTS.md.
- **What NOT to do:** do not move scene/handler registration (`loadScene`, `autoRegisterHandlers`) into the assembler — those are scene data, and `run-scene`/tests need them caller-side; do not create a second `ConversationManagerImpl` or a second `SocialManager` (spec 045 R2/R3 invariant); do not read env vars anywhere except the assembler (spec 027 AC-9 principle, now enforced structurally); do not edit `dist/`.
