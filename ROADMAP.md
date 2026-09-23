# Roadmap

> LLM-driven game engine: autonomous NPCs with embodied cognition in a deterministic TypeScript physics simulation.

## Current State

**Full PPER loop + cognitive tools + memory + persistence + social + object interactions — all implemented and tested with real LLM (Ollama + tool calling).**

| Phase                | Spec                                                          | Status    | PRs      |
| -------------------- | ------------------------------------------------------------- | --------- | -------- |
| Perceive             | [001](docs/specs/001-perceive-phase.md)                       | ✅ Merged | #3, #7   |
| Plan                 | [002](docs/specs/002-plan-phase.md)                           | ✅ Merged | #7       |
| Execute              | [003](docs/specs/003-execute-phase.md)                        | ✅ Merged | #17      |
| Reflect              | [004](docs/specs/004-reflect-phase.md)                        | ✅ Merged | #17      |
| Game Loop            | [005](docs/specs/005-game-loop-integration.md)                | ✅ Merged | #19      |
| Ollama LLM Client    | [006](docs/specs/006-openai-compatible-llm-client.md)         | ✅ Merged | #25      |
| ONNX Embeddings      | [007](docs/specs/007-onnx-embedding-provider.md)              | ✅ Merged | #31      |
| Multi-Agent Tests    | [008](docs/specs/008-multi-agent-multi-room-tests.md)         | ✅ Merged | #32      |
| Error Recovery       | [008](docs/specs/008-pper-error-recovery.md)                  | ✅ Merged | #33      |
| Tool Calling         | [011](docs/specs/011-structured-output-to-tool-calling.md)    | ✅ Merged | #42      |
| Agent Persona        | [012](docs/specs/012-agent-persona-system.md)                 | ✅ Merged | #48, #52 |
| Richer Scenes        | [013](docs/specs/013-richer-prototype-scenes.md)              | ✅ Merged | #49      |
| Memory Consolidation | [014](docs/specs/014-memory-consolidation-decay-retrieval.md) | ✅ Merged | #53      |
| Full Cognitive Tools | [015](docs/specs/015-full-cognitive-tools.md)                 | ✅ Merged | #60      |
| Cognitive Guardrails | [016](docs/specs/016-cognitive-guardrails.md)                 | ✅ Merged | #59      |
| Persistence          | [017](docs/specs/017-persistence-save-load-game-state.md)     | ✅ Merged | #67      |
| Object Interactions  | [018](docs/specs/018-object-interactions.md)                  | ✅ Merged | #69      |
| Multi-Agent Social   | [018](docs/specs/018-multi-agent-social.md)                   | ✅ Merged | #70      |

**69 specs, 147 merged PRs (166 opened). ~3,182 tests passing across 8 packages.**

### Phase 4-5 Progress (specs 019-044)

> These are the original arcs. Specs **045-063** (conversations, plan robustness,
drive economy, visualizer) are not repeated here —
[`docs/specs/INDEX.md`](docs/specs/INDEX.md) is the authoritative ledger for all 69.

| Spec                                                         | Feature                                                           | Status         | PRs            |
| ------------------------------------------------------------ | ----------------------------------------------------------------- | -------------- | -------------- |
| [021](docs/specs/021-kv-cache-prompt-optimization.md)        | KV-Cache Prompt Optimization                                      | ✅ Merged      | #97            |
| [022](docs/specs/022-scene-authoring-declarative.md)         | Scene Authoring (YAML + CLI)                                      | ✅ Merged      | #96            |
| [023](docs/specs/023-visual-output-canvas-renderer.md)       | Visual Output (canvas renderer)                                   | ✅ Merged      | #95            |
| [024](docs/specs/024-social-tool-invocation-fix.md)          | Social Tool Invocation Fix                                        | ✅ Merged      | #102           |
| [026](docs/specs/026-memory-entry-fix.md)                    | Memory Entry Fix (flatten + fallback)                             | ✅ Merged      | #104           |
| [027](docs/specs/027-real-llm-visualizer-demo.md)            | Real-LLM Visualizer Demo                                          | ✅ Merged      | #113           |
| [028](docs/specs/028-compound-action-execution.md)           | Compound Action Execution                                         | ✅ Merged      | #114           |
| [029](docs/specs/029-visualizer-state-text-overflow.md)      | Visualizer State Text Overflow Fix                                | ✅ Merged      | (direct)       |
| [030](docs/specs/030-dynamic-scenes-living-worlds.md)        | Dynamic Scenes — Living Worlds (runtime mutation, event-sourced)  | ✅ Merged      | #120           |
| [031](docs/specs/031-execute-colocation-guard.md)            | Execute-Time Co-Location Guard                                    | ✅ Merged      | #123           |
| [032](docs/specs/032-dynamic-world-drive-restoration.md)     | Drive Restoration Affordances (bench/stool)                       | ✅ Merged      | #127           |
| [033](docs/specs/033-conversations-identity-evolution.md)    | Conversations as Perceivable Objects + Identity Evolution         | ✅ Merged      | #131           |
| [034](docs/specs/034-drive-affordance-hints-hunger-chain.md) | Drive→Affordance Hints + Hunger Chain                             | ✅ Merged      | #133           |
| [035](docs/specs/035-system1-trainable-heads.md)             | System 1 — Trainable React/Ignore Gate + Importance Head          | ✅ Merged      | #136           |
| [036](docs/specs/036-exploration-factor.md)                  | Curiosity-Modulated Exploration Factor                            | ✅ Implemented | (direct, #138) |
| [037](docs/specs/037-enum-bound-plan-formulation.md)         | Enum-Bound Plan Formulation (+ livelock guard, empty-args repair) | ✅ Implemented | #141           |
| [038](docs/specs/038-spatial-navigation-fog-of-war.md)       | Spatial Navigation — Grid, Pathfinding, Fog of War (slice 1)      | ✅ Merged      | 8c38f9b        |
| [040](docs/specs/040-idle-tick-memory-suppression.md)        | Idle-Tick Memory Suppression (label pipeline domino 3)            | ✅ Merged      | #151           |
| [041](docs/specs/041-applied-drive-changes-label.md)         | Applied-DriveChanges Outcome Labeling (domino 4 — causal labels)  | ✅ Merged      | #154           |
| [042](docs/specs/042-visualizer-single-renderer.md)          | Visualizer Single Renderer (inline template → bundled module)     | ✅ Merged      | #157           |
| [043](docs/specs/043-conversation-perception-bridge.md)      | Conversation Perception Bridge (threads reach the LLM)            | ✅ Merged      | #159           |
| [044](docs/specs/044-social-urge-model.md)                   | Social Urge Model — persona-seeded talk inclination, reciprocity  | ✅ Merged      | #164           |

## Completed Phases

### ✅ Phase 1: Core PPER Loop

> Perceive → Plan → Execute → Reflect with real LLM

- All 4 PPER phases implemented and tested
- Game loop integration with deterministic physics
- Real Ollama LLM client (tool calling, not structured output)
- Real ONNX embedding provider
- Multi-agent, multi-room integration tests
- Error recovery and edge case handling

### ✅ Phase 2: Cognition Deep Dive

> Sophisticated agent minds — emergent behavior

- Agent Persona System — personality, backstory, goals influence LLM prompts
- Richer Prototype Scene — multiple rooms, objects, agents
- Memory Consolidation — background reflection, importance scoring, memory decay, weighted retrieval
- Cognitive Guardrails — affordance masking, contextual forcing, plan validation (§10)
- Full Cognitive Tools — `query_memory` and `update_internal_state` as real tool calls (§8)

### ✅ Phase 3: Agent State & Persistence

> Agents that remember across sessions and interact with each other

- Persistence — save/load game state, agent memory across sessions
- Multi-Agent Social — agents perceive each other, communicate, form relationships, social drives
- Object Interactions — multi-step affordances, object state changes, dependencies, conditional affordances

## What's Next

> **All 11 architecture sections (§1-§11) are fully implemented, and every planned
> phase below is complete.** No roadmap-planned work remains; what is left is
> issue-driven:
>
> - [#225](https://github.com/Redna/evol-hive/issues/225) — context-correctness audit: instructions the phase rejects, offers that cannot be executed (`conversation_contribute`), entities that no longer exist
> - [#191](https://github.com/Redna/evol-hive/issues/191) — plan stickiness: Iris repeating `go_to_greenhouse`/`water_plants` under a persistent urgency directive
>
> Closed arcs: spatial layer verified (spec 039), label pipeline causally complete
> (specs 040/041), drive-economy equilibrium (spec 048, #139), first conversations
> observed live (2026-09-08 — `talk_to` exchanges, herb offers, trust deltas).

### ✅ Phase 4: Validation & Polish

> Prove emergent behavior works with real LLM runs. **Complete (2026-09-04).**

- [x] **Prototype Validation Run** — 91 PPER cycles/60s with 3 agents active; navigation between rooms observed (kitchen ↔ living room)
- [x] **Social Behavior Emergence Test** — Bob↔Carol relationship formed organically (trust=52, familiarity=5); `talk_to` used without prompting
- [x] **Memory Persistence Test** — 28-80 memories stored per run; the in-engine memory round-trips across sessions via save/load. (The *CI* YAAM branch this once also used was retired by [ADR-003](docs/adr/0003-memory-is-local-ci-runs-none.md); the engine's dormant-agent store is untouched.)
- [x] **Token Cost Measurement** — 91,993 tokens per 2-min 3-agent run (83.6K prompt / 8.3K completion — 10:1 ratio confirms KV-cacheability)

### ✅ Phase 5: Presentation & Scale

> Visual layer and authoring tools. Shipped items:

- [x] **Visual Output** — canvas renderer: rooms, objects with state chips, agents with drive bars, PPER phase rings, relationship lines, WebSocket live updates, speed controls, save/load (spec 023, #95; label-overflow fix spec 029)
- [x] **Scene Authoring** — YAML scene schema + `validate-scene` / `create-scene` / `run-scene` CLI (spec 024, #96)
- [x] **Performance Tuning** — KV-cache-optimized prompts (371-char stable system prompt, 1 variant), round-robin PPER scheduling at maxConcurrent=1 (spec 025, #97)
- [x] **Real-LLM Visualizer Demo** — coffee-shop example wired to the visualizer server with TokenUsageReporter (spec 027, #113)
- [x] **Compound Action Execution** — LLM-planned compound actions execute via the Execute service (spec 028, #114)
- [x] **Dynamic Scenes** — SceneMutationService (validated mutation funnel, tick-boundary apply, event-sourced), object/agent lifecycle with dormant-agent store + YAAM persistence, dynamic topology (open/close doors), `modify_scene` cognitive tool with §10 guardrails, live visualizer deltas (spec 030, #120)
- [x] **Conversations as Perceivable Temporal Objects + Identity Evolution** — ConversationManager (rolling turn window, sentiment-gated trust), SelfModelManager, `update_self_model` tool, identity consolidation, save v3 (spec 033, #131)
- [x] **Drive→Affordance Hints + Hunger Chain** — data-driven matcher, plant→harvest→eat closes the hunger loop (spec 034, #133)
- [x] **System 1 Trainable Heads** — React/Ignore linear-probe gate (fail-open, hard triggers), composite importance head, self-supervised outcome labeling, dream-time weight updates with holdout revert (spec 035, #136; ADR-0002 accepted)
- [x] **Curiosity-Modulated Exploration** — seeded epsilon for the React/Ignore gate, default-off (spec 036, #138)
- [x] **Enum-Bound Plan Formulation** — `targetAffordance` constrained via a dynamic tool-signature enum; first affordance executions and **drive oscillation** observed live (hunger 39→97, energy 44→100); step-skip livelock guard + empty-args repair (spec 037, #141)
- [x] **Visualizer World View** — pure `layoutWorld` seam (topology-scored placement, real wall openings + gutter corridors, fog rects), theme/skin/format seams, DPR-correct backing store sized from the CSS-pixel viewport, DOM-measured HUD insets (spec 062, #234)
- [x] **Visualizer Mobile Shell** — same-origin `wss://` behind the environment's existing TLS proxy, follow-camera with tap-to-select, installable PWA (manifest + service worker), documented phone path (spec 063, #236)

## Architecture Coverage Map

```
§1  Vision              ████████████✅  Documented
§2  System Overview     ████████████✅  Documented
§3  Agent State         ████████████✅  Implemented (specs 001-005, 012, 017)
§4  Smart Objects       ████████████✅  Implemented (specs 001, 003, 013, 018)
§5  Fast-Path Classifier████████████✅  Implemented (specs 001, 007, 018)
§6  PPER Loop           ████████████✅  All 4 phases + tool calling + guardrails
§7  Structured Outputs  ████████████✅  Tool calling (spec 011)
§8  Cognitive Tools     ████████████✅  All 3 tools as real tool calls (spec 015)
§9  Engine Routing      ████████████✅  Implemented (spec 005)
§10 Guardrails          ████████████✅  Implemented (spec 016)
§11 Memory              ████████████✅  Full: store, consolidation, decay, retrieval (spec 014)
```

**All 11 architecture sections fully implemented.**

## Infrastructure

| Component             | Status                                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| Pipeline Orchestrator | ✅ Single workflow (Architect → Developer → CI+QA → Merge); since 2026-09-18 the intellectual work is done by local legs |
| Agent Team            | ✅ 5 agents: Architect, Developer, QA, Doctor, Responder                        |
| GitHub App (bot)      | ✅ evol-hive-agent[bot] for spec PR creation and approval                       |
| Bot Approval / Gate   | ✅ Cross-identity review so branch protection is satisfied without `--admin` ([BOT_APPROVAL.md](docs/BOT_APPROVAL.md)) |
| Agent Handoff         | ✅ Committed notes — `docs/specs/notes/NNN-*-{design,implementation,qa}-notes.md` |
| Memory Pipeline       | ⛔ Retired by [ADR-003](docs/adr/0003-memory-is-local-ci-runs-none.md) — memory is local-only; CI runs none |
| Memory Compaction     | ⛔ Removed by [ADR-003](docs/adr/0003-memory-is-local-ci-runs-none.md) — no CI memory, so nothing to compact |
| CI                    | ✅ Build, typecheck, lint, ~3,182 tests + QA coverage gate + GitGuardian        |
| Agent Run Resilience  | ✅ Concurrency serialization + heartbeat monitor + 4GB runner swap + auto-retry |

## Decision Log

| Date       | Decision                                        | Rationale                                                                                                                                                                                                       |
| ---------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-04 | 4-package monorepo structure                    | [ADR-0001](docs/adr/0001-lean-monorepo-structure.md)                                                                                                                                                            |
| 2026-08-04 | GitHub-hosted runners for agent CI              | Free for public repos, no security risk                                                                                                                                                                         |
| 2026-08-04 | Ollama Cloud direct API for LLM                 | No local daemon needed in CI                                                                                                                                                                                    |
| 2026-08-04 | YAAM memory via git memory branch               | ⛔ Superseded by [ADR-003](docs/adr/0003-memory-is-local-ci-runs-none.md) — durable and versioned, but ~99.96% of what it stored was a code graph CI already had in its checkout                                                                                                                                                                           |
| 2026-08-04 | pi -p (print mode) for agents                   | Multi-turn tool use without interactive mode                                                                                                                                                                    |
| 2026-08-06 | GitHub App for bot identity                     | `evol-hive-agent[bot]` distinct from human                                                                                                                                                                      |
| 2026-08-06 | PAT for PR creation, App for everything else    | Triggers pull_request events automatically                                                                                                                                                                      |
| 2026-08-07 | Controller → Pipeline Orchestrator              | Single workflow, no event storms                                                                                                                                                                                |
| 2026-08-17 | Tool calling replaces structured output         | 3x faster, reliable field names, simpler code                                                                                                                                                                   |
| 2026-08-17 | Configurable decay rate (0.1/sec)               | Real LLM too slow for 1.0/sec decay                                                                                                                                                                             |
| 2026-08-17 | Core cognition before visuals                   | Emergent behavior is the priority, not presentation                                                                                                                                                             |
| 2026-08-24 | Compaction lock for distributed agents          | ⛔ Superseded by [ADR-003](docs/adr/0003-memory-is-local-ci-runs-none.md) — the lock existed only to referee multiple writers; CI no longer writes                                                                                                                                              |
| 2026-08-24 | JS compactor for CI, daemon compactor for local | ⛔ Superseded by [ADR-003](docs/adr/0003-memory-is-local-ci-runs-none.md) — no CI compaction at all                                                                                                                                              |
| 2026-09-04 | Streaming compactor for scheduled compaction    | ⛔ Superseded by [ADR-003](docs/adr/0003-memory-is-local-ci-runs-none.md) — the 3.7M-event count was itself a symptom of unbounded churn                                                                                                                    |
| 2026-09-04 | 4GB swap + heartbeat on hosted runners          | Agent stack sits at 93-95% of 16GB runner RAM; spikes OOM-killed ~50% of agent jobs                                                                                                                             |
| 2026-09-04 | Strict spec lookup in Developer workflow        | "Latest spec" fallback made the agent implement the wrong issue (PR #116)                                                                                                                                       |
| 2026-09-18 | Local relay legs + GitHub ledger (hybrid)       | Actions ~40% no-op runs and spec drift (every agent-authored spec needed correction); local legs do the intellectual work, GitHub keeps CI/QA/identity. See [DELIVERY_PROCEDURE.md](docs/DELIVERY_PROCEDURE.md) |
| 2026-09-22 | Memory is local-only; CI runs none              | [ADR-003](docs/adr/0003-memory-is-local-ci-runs-none.md) — CI memory was 0.04% payload (50 of 124,558 links) and 95.4% link churn re-indexing code CI already had; the agent handoff is committed notes, the sync scripts are deleted, and the `memory` branch was deleted |
