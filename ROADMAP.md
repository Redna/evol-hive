# Roadmap

> LLM-driven game engine: autonomous NPCs with embodied cognition in a deterministic TypeScript physics simulation.

## Phases

### Phase 1: PPER Loop Foundation
> Build the core cognitive cycle: Perceive → Plan → Execute → Reflect

- [x] Architecture specification (§1–§11)
- [x] Package structure (ADR-0001)
- [x] Shared types & JSON schemas
- [x] CI pipeline (typecheck, lint, test, build)
- [ ] **Perceive Phase** — passive awareness, spatial debouncing, System 0 classifier pruning → [spec 001](docs/specs/001-perceive-phase.md) 🔨
- [ ] **Plan Phase** — LLM formulates plan via `formulate_plan` cognitive tool, structured output → needs spec
- [ ] **Execute Phase** — engine runs affordance, preconditions, action feedback → needs spec
- [ ] **Reflect Phase** — LLM updates agent state & memory, self-correction → needs spec

### Phase 2: Smart Objects & World
> Populate the simulation with interactive objects and spatial structure

- [ ] Smart Object Registry — objects expose affordances, LLM sees semantics → needs spec (§4)
- [ ] Affordance System — discrete actions with preconditions and effects → needs spec (§4)
- [ ] Scene Management — rooms, transitions, spatial queries → needs spec
- [ ] Agent State — drives, plans, goals, memory references → needs spec (§3)

### Phase 3: Cognition Deep Dive
> Full cognitive toolset and guardrails

- [ ] Cognitive Tools — `formulate_plan`, `query_memory`, `update_state` → needs spec (§8)
- [ ] Structured Outputs — JSON schema enforcement for all LLM responses → needs spec (§7)
- [ ] Engine Routing — `is_thinking` state, async LLM concurrency → needs spec (§9)
- [ ] Cognitive Guardrails — affordance masking, contextual forcing, plan validation → needs spec (§10)

### Phase 4: Memory & Reflection
> Dual-track memory with background consolidation

- [ ] Vector Store — in-memory, LanceDB, or ChromaDB backend → needs spec (§11)
- [ ] Weighted Retrieval — recency × importance × relevance scoring → needs spec (§11)
- [ ] Background Reflection — consolidation, memory updates → needs spec (§11)

### Phase 5: Integration & Polish
> End-to-end simulation with multiple agents

- [ ] Game Loop Integration — PPER loop wired into the fixed-timestep loop
- [ ] Multi-Agent Simulation — multiple NPCs with independent cognition
- [ ] Scene Authoring — tools for defining rooms, objects, agents
- [ ] Performance Tuning — latency profiling, LLM call optimization

## Architecture Coverage Map

```
§1  Vision              ████████████✅  Documented
§2  System Overview     ████████████✅  Documented
§3  Agent State         ████░░░░░░░░📝  Partial (spec 001)
§4  Smart Objects       ████░░░░░░░░📝  Partial (spec 001)
§5  Fast-Path Classifier████░░░░░░░░📝  Partial (spec 001)
§6  PPER Loop           ████░░░░░░░░🔨  Perceive in development
§7  Structured Outputs  ░░░░░░░░░░░░📝  Needs spec
§8  Cognitive Tools     ░░░░░░░░░░░░📝  Needs spec
§9  Engine Routing      ░░░░░░░░░░░░📝  Needs spec
§10 Guardrails          ░░░░░░░░░░░░📝  Needs spec
§11 Memory              ████░░░░░░░░📝  Partial (spec 001)
```

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-04 | 4-package monorepo structure | [ADR-0001](docs/adr/0001-lean-monorepo-structure.md) |
| 2026-08-04 | GitHub-hosted runners for agent CI | Free for public repos, no security risk |
| 2026-08-04 | Ollama Cloud direct API for LLM | No local daemon needed in CI |
| 2026-08-04 | YAAM memory via git memory branch | Durable, versioned, no cache eviction |
| 2026-08-04 | pi -p (print mode) for agents | Multi-turn tool use without interactive mode |