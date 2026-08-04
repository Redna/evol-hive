# §2 — System Overview

## Hybrid Engine

The system combines:
- **Deterministic game mechanics** — TypeScript engine (physics, game loop, spatial management)
- **Non-deterministic agent cognition** — Local LLMs via llama.cpp, vLLM, or Ollama

## PPER Loop

Built around a fluid **PPER** (Perceive, Plan, Execute, Reflect) loop, utilizing Structured Outputs to guarantee stable execution.

## System Boundaries

```
┌─────────────────────────────────────────────────────────┐
│                    evol-hive engine                      │
│                                                          │
│  ┌──────────────┐   ┌──────────────┐  ┌──────────────┐ │
│  │   Engine     │   │  Cognition   │  │  Classifier   │ │
│  │  (Physics,   │◄─►│  (PPER Loop, │  │  (System 0,   │ │
│  │   Game Loop) │   │   Tools)     │  │   Embeddings)  │ │
│  └──────┬───────┘   └──────┬───────┘  └──────────────┘ │
│         │                  │                             │
│  ┌──────┴───────┐   ┌──────┴───────┐                     │
│  │    World     │   │   Memory     │                     │
│  │  (Objects,   │   │  (Vector DB, │                     │
│  │  Affordances)│   │   Retrieval) │                     │
│  └──────────────┘   └──────────────┘                     │
│         │                  │                              │
│  ┌──────┴───────┐                                          │
│  │   Agents     │◄─────────┘                              │
│  │  (State,     │                                          │
│  │   Drives)    │                                          │
│  └──────────────┘                                          │
└─────────────────────────────────────────────────────────┘
         │
         ▼
   ┌───────────┐
   │  Local    │
   │   LLM     │  (Ollama / vLLM / llama.cpp)
   └───────────┘
```

## Package Map

See [ADR-0001](../adr/0001-lean-monorepo-structure.md) for the rationale behind this structure.

| Package | Responsibility |
|---------|---------------|
| `@evol-hive/shared` | Shared types, JSON schemas, interfaces |
| `@evol-hive/engine` | Game loop, physics, spatial management, async routing, **world** (smart objects, affordances, scenes), **agents** (state, drives, plans) |
| `@evol-hive/cognition` | PPER loop, cognitive tools, LLM client, guardrails, **System 0 classifier** (embedding-based affordance pruning) |
| `@evol-hive/memory` | Vector store, weighted retrieval, reflection loop |

### Dependency Graph

```
shared ←── engine
shared ←── cognition
shared ←── memory
memory  ←── cognition
```

`engine` and `cognition` do not directly depend on each other. The engine triggers
cognition and cognition writes back agent state through **interfaces in `shared`**.
This keeps the package graph acyclic.