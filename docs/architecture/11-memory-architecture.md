# §11 — Advanced Memory Architecture

## Overview

Memory relies on **parallel systems** and **weighted retrieval** to mimic biological cognition efficiently.

## 11.1 Dual-Track Injection

### Track 1: Associative Memory (Passive — System 1)

During the Perceive step, the engine **automatically injects** highly relevant contextual memories based on the agent's immediate **spatial surroundings**.

- No LLM call required
- Embeddings of the current context → cosine similarity → top relevant memories
- Injected silently into the perception context window

### Track 2: Active Recall (Tool-Driven — System 2)

The agent **explicitly uses** the `query_memory` tool to fetch specific data.

- Agent-driven — the LLM decides what to recall
- Uses the retrieval engine with weighted scoring
- Results fed back in the next tick

## 11.2 Weighted Retrieval Scoring

When retrieving memories, the engine calculates a composite `retrievalScore` for every node:

```
retrievalScore = (recency × recencyWeight) + (importance × importanceWeight) + (relevance × relevanceWeight)
```

### Components

| Factor | Description | Formula |
|--------|-------------|---------|
| **Recency** | Time since memory creation | Exponential decay: `e^(-decayRate × timeElapsed)` |
| **Importance** | Static score assigned at encoding | Integer 1-10, set by LLM |
| **Relevance** | Semantic similarity | Cosine similarity between query & memory embeddings |

### Default Weights

| Parameter | Default |
|-----------|---------|
| `recencyWeight` | 1.0 |
| `importanceWeight` | 1.0 |
| `relevanceWeight` | 1.0 |
| `recencyDecayRate` | 0.01 |

## 11.3 Reflection & Consolidation (Background Asynchronous Loop)

### Problem

Without consolidation, the agent drowns in low-level memory nodes ("I walked into the kitchen", "I saw a coffee machine", etc.)

### Solution

A **background LLM call** is made, **detached from the real-time game loop**.

### Triggers

1. **Node threshold**: When the agent's short-term memory buffer reaches N new nodes (e.g., 50)
2. **Physical inactivity**: During periods of physical inactivity (e.g., sleeping)

### Execution

```
Short-term buffer → [50 nodes] → threshold reached
    │
    ▼
Background LLM call (async, not blocking game loop)
    │
    ├─ Input: 50 low-level memory nodes
    ├─ LLM consolidates into higher-level insights
    │
    ▼
Result:
    ├─ New higher-level MemoryNodes (e.g., "I've been trying to get coffee but the machine keeps breaking")
    └─ Original nodes deprioritized (not deleted, but lower retrieval weight)
```

### Configuration

| Config | Default | Description |
|--------|---------|-------------|
| `MEMORY_REFLECTION_THRESHOLD` | 50 | New nodes before reflection triggers |

## Implementation Location

- **Type definitions**: `packages/shared/src/types/memory.ts`
- **Vector store**: `packages/memory/src/store/`
- **Retrieval engine**: `packages/memory/src/retrieval/`
- **Reflection loop**: `packages/memory/src/reflection/`