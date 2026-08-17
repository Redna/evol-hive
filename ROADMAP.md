# Roadmap

> LLM-driven game engine: autonomous NPCs with embodied cognition in a deterministic TypeScript physics simulation.

## Current State

**Full PPER loop implemented and tested with real LLM (Ollama + tool calling).**

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

**Prototype works end-to-end:** one room, one Coffee Machine, one agent (Alice) that perceives, plans, brews coffee, and reflects — with a real LLM.

## What's Next (Prioritized)

> **Focus: core agent mechanics and emergent behavior.**
> Scenes, objects, and agents stay static and manageable for now.
> Visual output and scene authoring are deferred until the cognitive core is solid.

### Phase 2: Cognition Deep Dive
> Make the agent's mind more sophisticated — this is where emergent behavior comes from.

- [ ] **Agent Persona System** (#44) — personality, backstory, goals that influence LLM prompts → *Architect running*
- [ ] **Richer Prototype Scene** (#45) — multiple rooms, objects, agents (static, for testing) → *Architect running*
- [ ] **Memory Consolidation** — background reflection, importance scoring, memory decay (§11)
- [ ] **Cognitive Guardrails** — affordance masking, contextual forcing, plan validation (§10)
- [ ] **Full Cognitive Tools** — `query_memory` and `update_internal_state` as real tool calls (§8)

### Phase 3: Agent State & Persistence
> Agents that remember across sessions and maintain coherent internal state.

- [ ] **Persistence** — save/load game state, agent memory across sessions
- [ ] **Multi-Agent Social** — agents that perceive each other, communicate, form relationships
- [ ] **Object Interactions** — multi-step affordances, object state changes, dependencies

### Phase 4: Presentation & Scale (Deferred)
> Visual layer and authoring tools — only after the cognitive core is solid.

- [ ] **Visual Output** — canvas/WebGL renderer for the simulation
- [ ] **Scene Authoring** — tools for defining rooms, objects, agents
- [ ] **Performance Tuning** — LLM batching, context window optimization

## Architecture Coverage Map

```
§1  Vision              ████████████✅  Documented
§2  System Overview     ████████████✅  Documented
§3  Agent State         ████████████✅  Implemented (specs 001-005)
§4  Smart Objects       ████████████✅  Implemented (specs 001, 003)
§5  Fast-Path Classifier████████████✅  Implemented (specs 001, 007)
§6  PPER Loop           ████████████✅  All 4 phases implemented
§7  Structured Outputs  ████████████✅  Tool calling (spec 011)
§8  Cognitive Tools     █████████░░░📝  Partial (formulate_plan ✅, query_memory/update_state ❌)
§9  Engine Routing      ████████████✅  Implemented (spec 005)
§10 Guardrails          ████░░░░░░░░📝  Needs spec
§11 Memory              ████████░░░░📝  Partial (store ✅, consolidation ❌)
```

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
