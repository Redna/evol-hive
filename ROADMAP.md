# Roadmap

> LLM-driven game engine: autonomous NPCs with embodied cognition in a deterministic TypeScript physics simulation.

## Current State

**Full PPER loop + cognitive tools + memory + persistence + social + object interactions — all implemented and tested with real LLM (Ollama + tool calling).**

| Phase | Spec | Status | PRs |
|---|---|---|---|
| Perceive | [001](docs/specs/001-perceive-phase.md) | ✅ Merged | #3, #7 |
| Plan | [002](docs/specs/002-plan-phase.md) | ✅ Merged | #7 |
| Execute | [003](docs/specs/003-execute-phase.md) | ✅ Merged | #17 |
| Reflect | [004](docs/specs/004-reflect-phase.md) | ✅ Merged | #17 |
| Game Loop | [005](docs/specs/005-game-loop-integration.md) | ✅ Merged | #19 |
| Ollama LLM Client | [006](docs/specs/006-openai-compatible-llm-client.md) | ✅ Merged | #25 |
| ONNX Embeddings | [007](docs/specs/007-onnx-embedding-provider.md) | ✅ Merged | #31 |
| Multi-Agent Tests | [008](docs/specs/008-multi-agent-multi-room-tests.md) | ✅ Merged | #32 |
| Error Recovery | [008](docs/specs/008-pper-error-recovery.md) | ✅ Merged | #33 |
| Tool Calling | [011](docs/specs/011-structured-output-to-tool-calling.md) | ✅ Merged | #42 |
| Agent Persona | [012](docs/specs/012-agent-persona-system.md) | ✅ Merged | #48, #52 |
| Richer Scenes | [013](docs/specs/013-richer-prototype-scenes.md) | ✅ Merged | #49 |
| Memory Consolidation | [014](docs/specs/014-memory-consolidation-decay-retrieval.md) | ✅ Merged | #53 |
| Full Cognitive Tools | [015](docs/specs/015-full-cognitive-tools.md) | ✅ Merged | #60 |
| Cognitive Guardrails | [016](docs/specs/016-cognitive-guardrails.md) | ✅ Merged | #59 |
| Persistence | [017](docs/specs/017-persistence-save-load-game-state.md) | ✅ Merged | #67 |
| Object Interactions | [018](docs/specs/018-object-interactions.md) | ✅ Merged | #69 |
| Multi-Agent Social | [018](docs/specs/018-multi-agent-social.md) | ✅ Merged | #70 |

**21 specs, 88+ PRs — all merged. 1,140 tests passing.**

### Phase 4-5 Progress (specs 019-029)

| Spec | Feature | Status | PRs |
|---|---|---|---|
| [021](docs/specs/021-kv-cache-prompt-optimization.md) | KV-Cache Prompt Optimization | ✅ Merged | #97 |
| [022](docs/specs/022-scene-authoring-declarative.md) | Scene Authoring (YAML + CLI) | ✅ Merged | #96 |
| [023](docs/specs/023-visual-output-canvas-renderer.md) | Visual Output (canvas renderer) | ✅ Merged | #95 |
| [024](docs/specs/024-social-tool-invocation-fix.md) | Social Tool Invocation Fix | ✅ Merged | #102 |
| [026](docs/specs/026-memory-entry-fix.md) | Memory Entry Fix (flatten + fallback) | ✅ Merged | #104 |
| [027](docs/specs/027-real-llm-visualizer-demo.md) | Real-LLM Visualizer Demo | ✅ Merged | #113 |
| [028](docs/specs/028-compound-action-execution.md) | Compound Action Execution | ✅ Merged | #114 |
| [029](docs/specs/029-visualizer-state-text-overflow.md) | Visualizer State Text Overflow Fix | ✅ Merged | (direct) |

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

> **All 11 architecture sections (§1-§11) are fully implemented.**
> The cognitive core is complete. Next focus: validation, presentation, and scale.

### ✅ Phase 4: Validation & Polish
> Prove emergent behavior works with real LLM runs. **Complete (2026-09-04).**

- [x] **Prototype Validation Run** — 91 PPER cycles/60s with 3 agents active; navigation between rooms observed (kitchen ↔ living room)
- [x] **Social Behavior Emergence Test** — Bob↔Carol relationship formed organically (trust=52, familiarity=5); `talk_to` used without prompting
- [x] **Memory Persistence Test** — 28-80 memories stored per run; YAAM persistence round-trips across sessions
- [x] **Token Cost Measurement** — 91,993 tokens per 2-min 3-agent run (83.6K prompt / 8.3K completion — 10:1 ratio confirms KV-cacheability)

### ✅ Phase 5: Presentation & Scale (in progress)
> Visual layer and authoring tools. Shipped items:

- [x] **Visual Output** — canvas renderer: rooms, objects with state chips, agents with drive bars, PPER phase rings, relationship lines, WebSocket live updates, speed controls, save/load (spec 023, #95; label-overflow fix spec 029)
- [x] **Scene Authoring** — YAML scene schema + `validate-scene` / `create-scene` / `run-scene` CLI (spec 024, #96)
- [x] **Performance Tuning** — KV-cache-optimized prompts (371-char stable system prompt, 1 variant), round-robin PPER scheduling at maxConcurrent=1 (spec 025, #97)
- [x] **Real-LLM Visualizer Demo** — coffee-shop example wired to the visualizer server with TokenUsageReporter (spec 027, #113)
- [x] **Compound Action Execution** — LLM-planned compound actions execute via the Execute service (spec 028, #114)
- [x] **Dynamic Scenes** — SceneMutationService (validated mutation funnel, tick-boundary apply, event-sourced), object/agent lifecycle with dormant-agent store + YAAM persistence, dynamic topology (open/close doors), `modify_scene` cognitive tool with §10 guardrails, live visualizer deltas (spec 030, #120)

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

| Component | Status |
|---|---|
| Pipeline Orchestrator | ✅ Single workflow (Architect → Developer → CI+QA → Merge → Compaction) |
| Agent Team | ✅ 5 agents: Architect, Developer, QA, Doctor, Responder |
| GitHub App (bot) | ✅ evol-hive-agent[bot] for spec PR creation and approval |
| YAAM Memory Pipeline | ✅ Git-based event sourcing with distributed locking + compaction |
| Memory Compaction | ✅ Pipeline Phase 6 + scheduled cron + manual trigger |
| CI | ✅ Build, typecheck, lint, 1,397 tests |
| Agent Run Resilience | ✅ Concurrency serialization + heartbeat monitor + 4GB runner swap + auto-retry |

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-04 | 4-package monorepo structure | [ADR-0001](docs/adr/0001-lean-monorepo-structure.md) |
| 2026-08-04 | GitHub-hosted runners for agent CI | Free for public repos, no security risk |
| 2026-08-04 | Ollama Cloud direct API for LLM | No local daemon needed in CI |
| 2026-08-04 | YAAM memory via git memory branch | Durable, versioned, no cache eviction |
| 2026-08-04 | pi -p (print mode) for agents | Multi-turn tool use without interactive mode |
| 2026-08-06 | GitHub App for bot identity | `evol-hive-agent[bot]` distinct from human |
| 2026-08-06 | PAT for PR creation, App for everything else | Triggers pull_request events automatically |
| 2026-08-07 | Controller → Pipeline Orchestrator | Single workflow, no event storms |
| 2026-08-17 | Tool calling replaces structured output | 3x faster, reliable field names, simpler code |
| 2026-08-17 | Configurable decay rate (0.1/sec) | Real LLM too slow for 1.0/sec decay |
| 2026-08-17 | Core cognition before visuals | Emergent behavior is the priority, not presentation |
| 2026-08-24 | Compaction lock for distributed agents | `yaam-compaction.lock` prevents race between agents and compaction |
| 2026-08-24 | JS compactor for CI, daemon compactor for local | Daemon compact breaks delta math; JS compactor runs without daemon |
| 2026-09-04 | Streaming compactor for scheduled compaction | In-memory compactor OOM'd at 3.7M events; streaming (readline + Maps) handles multi-GB files |
| 2026-09-04 | 4GB swap + heartbeat on hosted runners | Agent stack sits at 93-95% of 16GB runner RAM; spikes OOM-killed ~50% of agent jobs |
| 2026-09-04 | Strict spec lookup in Developer workflow | "Latest spec" fallback made the agent implement the wrong issue (PR #116) |