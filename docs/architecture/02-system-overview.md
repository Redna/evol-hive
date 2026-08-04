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

| Package | Responsibility |
|---------|---------------|
| `@evol-hive/engine` | Game loop, physics, spatial management, async routing |
| `@evol-hive/cognition` | PPER loop, cognitive tools, LLM client, guardrails |
| `@evol-hive/classifier` | System 0 embedding model, affordance pruning |
| `@evol-hive/memory` | Vector store, weighted retrieval, reflection loop |
| `@evol-hive/world` | Smart objects, affordances, scenes/rooms |
| `@evol-hive/agents` | Agent state, drives, plans |
| `@evol-hive/shared` | Shared types, schemas, interfaces |