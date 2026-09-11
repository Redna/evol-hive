# Implementation Notes — Spec 050 (Assembly Consolidation) — Issue #166

> YAAM breadcrumb: the daemon (TCP JSON-RPC on the port recorded in
> `.yaam/daemon.port`) exposes `search`/`query`/`upsert_node`; notes written to
> `docs/specs/notes/*.md` are reconciler-indexed and surface in `yaam_search`
> (spec-045 session-1 convention, verified again this session).

## What was built

Spec 050 / issue #166 — ONE assembler, the composition root:

- **New package `packages/assembly` (`@evol-hive/assembly`)** — deps exactly
  `{ shared, engine, cognition, memory }`; the ONLY package allowed to depend
  on both engine and cognition (Decision 1 of the spec-050 workspace notes /
  `.pi/tasks/feature-050-assembly-consolidation/design-decisions.md`).
- **`assembleWorld()`** (`src/assembly.ts`) — one call, fully wired (R2):
  1. `buildMemorySubsystem()` from env (R5 — BEFORE `createEngineCore`, so the
     reflect bridge + persistence capture the store);
  2. `createEngineCore(config, memoryStore, vectorStore)` — all engine wiring;
  3. `options.sceneSetup?.(core)` — scene DATA hook, caller-side by design
     (`loadScene` + handler registration; spec constraint);
  4. R6 forwarding: `overrideSchedulerConfig(config)` →
     `assembleGameLoop(..., schedulerConfig, ...)` unless a scene-level config
     (`core.sceneSchedulerConfig`) or the env var exists — precedence is
     scene > env > `config.maxConcurrentLLM` > default 1;
  5. `assembleCognitionStack(core, undefined, { memory, mockLLMClient?, wireMemoryMaintenance? })`
     — LLM client (`USE_REAL_LLM`), CognitiveToolExecutor (with
     `conversationBridge: core.conversationManager`, spec 045 R1), guardrail +
     topology/affordance guards, classifier (`USE_REAL_EMBEDDINGS`), PPER
     orchestrator, token usage reporter, memory decay + reflection;
  6. `assembleSystem1(core, memory, options.system1?)` when requested (R2);
  7. `assembleGameLoop` with maintenance + autoSave + schedulerConfig +
     system1 ports.
- **SocialManager: zero new instances.** The promoted
  `assembleCognitionStack` uses `core.socialManager` as the social bridge
  (spec 045's R2/R3 invariant taken to its root — the #165 drift shape was a
  second SocialManager overwriting the perception bridge's social manager).
  The two wiring lines (`setSocialManager`, `setConversationManager`) remain
  for the injected-manager compat path (idempotent for the core's own).
- **`MockOrchestrator`** — the shared no-op orchestrator (no cycles, spec 041
  `appliedDriveChanges: false`), replacing visualizer-demo's and
  dynamic-world-sim's per-file classes. Mock mode (no `USE_REAL_LLM`, no
  `mockLLMClient`) wires it — no cognition stack, no memory subsystem, no
  maintenance (exact former mock parity).
- **`shared`: `overrideSchedulerConfig(config)`** (`types/engine.ts`) —
  R6/AC-6: returns `{ maxConcurrentCycles: config.maxConcurrentLLM }` when the
  env var is unset, `undefined` when it is set (env keeps override semantics
  via `defaultPPERSchedulerConfig`). The previously dead
  `EngineConfig.maxConcurrentLLM` field is now consumed.
- **`examples/assembly.ts` DELETED (AC-1, 567 lines).** Consumers now thin
  (R3): `coffee-shop.ts`, `dynamic-world-sim.ts`, `visualizer-demo.ts`,
  `minimal-scene.ts`, `morning-routine.ts`, `office-day.ts`, CLI `run-scene`
  all pass config + env + a scene-aware `mockLLMClient` + `sceneSetup`
  (scene data) only. `visualizer-demo` re-exports the assembler's
  `MockOrchestrator` (the spec-027 `toBeInstanceOf(MockOrchestrator)` contract
  preserved against the same class object).

## TDD flow (tests written BEFORE implementation)

Branch `feature/050-assembly-consolidation` (from main after #184's spec PR).

1. Commit `b88f3e2` — RED: package scaffolding with a placeholder
   `src/index.ts` + three suites (`assembly.test.ts` 11 tests,
   `scheduler-forwarding.test.ts` 6, `wiring-audit.test.ts` 38) + shared
   `overrideSchedulerConfig` tests. Confirmed failing for the right reasons
   (missing exports; consumers still containing wiring).
2. Commit `b8c2365` — implementation (shared helper + full assembler). AC-2
   suite green (11), AC-6 green (6); the 25 remaining failures were exactly
   the consumer-wiring audits.
3. Commits `4cac034`→`8549585` — consumer rewrites (coffee-shop, sim,
   visualizer, three legacy demos, run-scene), `examples/assembly.ts`
   deletion, examples/engine test import-path + spec-019 source-inspection
   updates, wiring-audit scope fixes.

## Notable call-site discoveries (for reviewers)

- `real-llm-visualizer.test.ts` imports `MockOrchestrator` and asserts
  `handle.orchestrator` is an instance of it in mock mode → the class moved to
  the assembly package; visualizer-demo re-exports it.
- `packages/engine/tests/minimal-scene.test.ts` + `persona.test.ts` asserted
  the demo LoggingOrchestrator's `completed PPER cycle` log line. Spec 050
  removes the demo-side orchestrator wrapper (the assembler owns the
  orchestrator); both tests now assert the STRONGER memory-store evidence
  (the Reflect phase stores a node in the assembler's store — exposed as
  `vectorStore` on the minimal/morning/office builders) + isThinking reset.
- `spec-019-wire-social.test.ts` source-inspection assertions (scenes must
  contain `OpenAICompatibleLLMClient` etc.) updated to the promoted
  invariants: scenes contain `assembleWorld` and expose
  `core.socialManager`; the wiring they referenced lives in the assembler.
- The visualizer real-mode regression I hit mid-flight: my first sceneSetup
  dropped the `loadScene(core, scene)` call (agents: [] in the probe run) —
  restored; the two scripted-LLM suites went green again. Probing script
  pattern (held plan responses + phase dump) lives in /tmp, re-creatable.

## Verification (fresh runs, post-8549585)

- `pnpm test`: **2,528 passed / 0 failed** (shared 350, memory 101 +24 todo,
  visualizer 48, cognition 939 +1 skipped +26 todo, engine 829 +141 todo,
  assembly 53, examples 193 +3 todo, cli 15).
- `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm build`: clean
  (assembly included in all four).
- AC-1 grep: zero wiring calls in every consumer entry point; engine-side
  wiring only in `packages/engine/src`; cognition-side only in
  `packages/assembly/src` (+ cognition's own definitions); ADR-0001 import
  graph asserted (engine↛cognition, cognition↛engine, shared imports nothing,
  only assembly knows both sides).

## AC-2 live-run evidence (the one manual item)

The deterministic clauses of AC-2 are covered by
`packages/assembly/tests/assembly.test.ts` (production executor → thread in
the core's `ConversationManagerImpl`, pending-address query + rendered line,
spec 044 reciprocity). The *live-LLM* run clause (real backend, full sim)
remains manual evidence for QA/merge — same pattern spec 045 followed
(live-run clauses tracked as todos/evidence notes).

## Remaining for full done

- CI on the PR + merge; QA coverage pass.
- After merge: flip INDEX row 050 → ✅ Done.

## Environment notes

- YAAM daemon: `search`/`query` work over TCP JSON-RPC (`.yaam/daemon.port`);
  `query` uses the query DSL with `"match"` (NOT `"match_clause"`) as the key.
- `pnpm test` in a fresh checkout needs `pnpm build` first (examples/engine
  tests resolve workspace packages to built `dist/`; the new
  `@evol-hive/assembly` is aliased to source in the examples + cli vitest
  configs and to dist everywhere else).
- CI's `format:check` scope covers `packages/*/src` + `packages/*/tests` —
  the new package is inside that scope (kept prettier-clean); the
  pre-existing `examples/dynamic-world.ts` prettier violation on main is
  untouched (out of scope, as in spec-045).