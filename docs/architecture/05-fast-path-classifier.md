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

- **Type definitions**: `packages/cognition/src/classifier/index.ts`
- **Embedding providers**: `packages/cognition/src/classifier/embedding/`
- **Pruning logic**: `packages/cognition/src/classifier/pruning/`

## Trainable System 1 Heads (spec 035, issue #132)

The same frozen embedding layer feeds **trainable classification heads**
(ADR-0002 — Accepted), layered on top of the System 0 pruning path:

- **React/Ignore gate** — a linear probe `p(react) = σ(W·x + b)` over the
  feature vector (384-dim snapshot embedding ⊕ ordered scalar features:
  drives, drive deltas, novelty, hard-trigger flags, ticks-since-cycle).
  The PPER scheduler consults it synchronously before `startCycle`:
  `p(react) >= threshold` OR a hard trigger → cycle; otherwise the agent
  idles the tick (no LLM calls, no associative injection). Hard triggers
  (incoming message, conversation invite/activity, nearby object mutation,
  drive threshold crossing) always force a cycle — System 1 gates, it never
  suppresses alarms.
- **Importance head** — the same frozen feature base feeds a second probe
  whose predicted prior is one input of the write-time composite importance
  (prior ⊕ drive-delta magnitude ⊕ downstream utility ⊕ LLM 1–10 as one
  feature among several). The spec 014 retrieval formula is untouched.

Weights are versioned artifacts (`headVersion` + `featureSchemaVersion`),
trained offline in `training/` (closed-form ridge) or updated in-runtime at
dream boundaries via the audited one-line update `W += lr · (p − y) · x`
with holdout-revert guardrails. Missing/corrupt/mismatched artifacts fail
OPEN (every-tick cycles — today's behavior), never closed.

### Amended Golden Rule (ADR-0002)

> **TS never *trains* models — it only runs exported ONNX inference over
> deterministic feature vectors. All gradient updates happen in Python
> offline, or as one-line sleep-time updates in-runtime.**
>
> (spec 035 refinement: for a linear probe, runtime "inference" is a plain
> TS dot-product + sigmoid over a versioned JSON weight snapshot; the ONNX
> artifact remains the Python↔TS interface for offline-trained baselines.)

- **Feature schema contract**: `packages/shared/src/types/system1.ts`
  (`FEATURE_SCHEMA_VERSION`, `SCALAR_FEATURE_FIELDS`, normalization rules)
- **Heads + extractor + inference**: `packages/cognition/src/system1/`
- **Scheduler gating + outcome labeling + trigger source**: `packages/engine/src/systems/system1-*.ts`
- **Write-time importance composition**: `packages/memory/src/store/` (`importanceComposer`)
- **Offline trainer**: `training/` (stdlib-only Python, build-time batch)