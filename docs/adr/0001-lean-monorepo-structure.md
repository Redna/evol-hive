# ADR-001: Lean Monorepo Package Structure

## Status
Accepted

## Context

The initial scaffold created 7 packages by mapping each spec section to a separate
package: `shared`, `engine`, `cognition`, `classifier`, `memory`, `world`, `agents`.

This was mechanically clean but created several problems:

1. **Premature granularity.** `classifier` contains only an embedding provider and
   a cosine-similarity pruner. `world` is object/affordance data definitions. `agents`
   is state + drives + plans. Splitting these into top-level packages adds build,
   link, and type-resolution overhead for what will likely be small modules.

2. **Circular dependency risk.** The engine triggers PPER cycles in cognition, and
   cognition writes agent state back through the engine. With them in separate
   packages, this creates a package-level cycle that requires a composition root
   (`runtime` package) or inversion-of-control indirection to break — ceremony that
   isn't justified at this stage.

3. **Weak boundaries.** Agent state (`isThinking`, drives, plans) is tightly coupled
   to the game loop. Smart objects and affordances are the engine's world data.
   Separating them from the engine doesn't reflect a real runtime boundary — it
   reflects the spec's section numbering.

4. **The classifier is not a separate runtime concern.** System 0 (embedding-based
   affordance pruning) runs synchronously inside the perception step of the PPER
   loop. It uses a different model type (embedding vs generative) but it is invoked
   by and serves cognition. Making it a sub-module of `cognition` keeps the call
   chain visible in one place.

## Decision

Collapse to **4 packages**:

```
packages/
├── shared/      — Shared types, JSON schemas, interfaces (no dependencies)
├── engine/      — Deterministic game engine
│                   ├── loop/        — Game loop, engine systems
│                   ├── physics/     — Affordance execution, preconditions
│                   ├── spatial/     — Room management, spatial debouncing
│                   ├── routing/     — Async LLM concurrency, action routing
│                   ├── world/       — Smart objects, affordances, scenes
│                   └── agents/      — Agent state, drives, plans
├── cognition/   — LLM cognitive layer
│                   ├── pper/        — PPER loop orchestration
│                   ├── llm/         — LLM client abstraction (Ollama, vLLM, llama.cpp)
│                   ├── tools/       — Cognitive tools (formulate_plan, query_memory, update_state)
│                   ├── guardrails/  — Affordance masking, contextual forcing, plan validation
│                   ├── classifier/  — System 0: embedding model, cosine similarity pruning
│                   └── schemas/     — Prompt templates, structured output config
└── memory/      — Memory architecture
                    ├── store/       — Vector store backend (in-memory, LanceDB, ChromaDB)
                    ├── retrieval/   — Weighted scoring (recency × importance × relevance)
                    └── reflection/  — Background reflection & consolidation loop
```

### Rationale per merge

| Merged into | What was folded in | Why |
|---|---|---|
| `engine` | `world`, `agents` | Smart objects, affordances, scenes, and agent state are all deterministic engine data. The engine reads/writes agent state every tick. World objects are the engine's domain model. Separating them reflected the spec's section layout, not a runtime boundary. |
| `cognition` | `classifier` | System 0 is invoked synchronously within cognition's perception step. It uses a different model type (embedding vs generative LLM) but the call chain lives inside cognition. Keeping it as a sub-module makes the PPER→prune→LLM flow visible in one package. |

### What stays separate

| Package | Why it stays independent |
|---|---|
| `shared` | Breaks import cycles. All packages depend on it; it depends on nothing. |
| `memory` | Distinct infrastructure (vector DB), swappable backend (in-memory → LanceDB → ChromaDB), and has its own background process (reflection loop). Different change velocity and deployment concerns. |
| `engine` | Deterministic, 60 FPS, synchronous. Different runtime profile from everything else. |
| `cognition` | Asynchronous, LLM-dependent, non-deterministic. The central orchestration layer. |

### Dependency graph (acyclic)

```
shared ←── engine
shared ←── cognition
shared ←── memory
memory  ←── cognition (cognition injects memories, runs active recall)
```

`engine` and `cognition` do **not** directly depend on each other at the package
level. The engine triggers cognition and cognition writes back agent state through
**interfaces defined in `shared`**. This inversion keeps the package graph acyclic.

If a composition root is needed later (wiring concrete implementations together),
a `runtime` package can be added that depends on both — but that's deferred until
implementation reveals whether it's necessary.

## Consequences

**Positive:**
- Fewer packages to build, link, and maintain
- Related code lives together (agent state next to game loop, classifier next to PPER)
- No package-level circular dependencies
- Faster incremental builds (fewer package boundaries to cross)
- Clearer mental model: 4 packages = 4 runtime concerns (types, deterministic, non-deterministic, storage)

**Negative:**
- `engine` and `cognition` are larger packages — changes touch a broader scope
- `classifier` loses its own package boundary — if it grows complex (caching, batch strategies, model warmup) it may warrant extraction
- No `runtime` composition root yet — wiring concrete implementations will need a decision when implementation begins

**Reversibility:**
All merges are reversible. If a sub-module grows large enough to warrant its own
package, extracting it is a mechanical change (move directory, add package.json,
update imports). The interfaces in `shared` already define the contracts.