# §5 — The Fast-Path Classifier (System 0)

## Problem

Sending every possible affordance in a room to the heavy LLM (System 2) is too slow and wastes tokens. A room with 50 interactable objects would generate massive context windows.

## Solution

We inject a **System 0 Classifier** before the main LLM call — a blazing-fast, lightweight local embedding model.

## Mechanism

1. The engine takes the agent's **current primary drive** (e.g., `drives.energy = 20`)
2. Runs a **cosine similarity check** against the embeddings of all affordances in the room
3. **Prunes** the list down to the top-K most semantically relevant affordances
4. Only these top-K are passed to the heavy LLM

## Model Selection

- **Model2Vec** — sub-100M parameter, extremely fast
- **ONNX model** — running directly in Node/TypeScript via ONNX Runtime
- **Ollama embeddings** — `nomic-embed-text` or similar

## Example

```
Agent drives: { energy: 20 (primary), hunger: 80 }

Room contains 50 objects with ~120 affordances total.

System 0 Classifier:
  Query: "low energy, need to restore energy"
  Embeds query → cosine similarity vs all 120 affordance embeddings
  Top 5: [brew_coffee, sit_down, sleep_on_couch, drink_water, eat_snack]

Only these 5 affordances → sent to System 2 LLM
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_PROVIDER` | `ollama-embeddings` | Backend selection |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Model name |
| `CLASSIFIER_TOP_K` | `5` | Affordances to retain |
| `CLASSIFIER_SIMILARITY_THRESHOLD` | `0.3` | Minimum cosine similarity |

## Implementation Location

- **Type definitions**: `packages/classifier/src/index.ts`
- **Embedding providers**: `packages/classifier/src/embedding/`
- **Pruning logic**: `packages/classifier/src/pruning/`