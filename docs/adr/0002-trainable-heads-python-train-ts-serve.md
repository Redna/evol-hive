# ADR-002: Trainable Cognitive Heads — Python Trains Offline, TypeScript Serves ONNX

## Status
Proposed (referenced by issue #132 — System 1 trainable heads)

## Context

The original architecture vision (recalled 2026-09-05, user-confirmed as source-of-intent)
specified a **TypeScript/Python microservice split**: a deterministic TS engine plus a
Python "Cognitive Backend" running local LLMs (vLLM/llama.cpp), embeddings (Model2Vec),
a vector database (Qdrant/Chroma), and **PyTorch-based trainable classification heads**
(System 1: React/Ignore gating; trainable importance rating). The two services would
communicate via REST/gRPC; the "Golden Rule" stated that TypeScript never touches
neural networks, embeddings, or unstructured text.

Since that vision was written, two things changed:

1. **Spec 007 proved ONNX-in-Node.** The embedding model runs directly in TypeScript via
   `onnxruntime-node` — fast, no service boundary, CI-safe. The strict "TS never touches
   embeddings" rule was already superseded by working, shipped code.
2. **Operational surface matters.** The project runs agent sessions on memory-constrained
   GitHub Actions runners and already operates one external daemon (YAAM). A second
   always-on Python service (plus possibly a vector DB) duplicates the class of
   operational failure we just spent days eliminating — while the cognition it would
   host is *microseconds* of MLP inference.

At the same time, the trainable heads themselves are a confirmed requirement (#132):
a React/Ignore gate and an importance head over embeddings + engine state features,
with self-supervised labels derived from session outcomes. The user requirement is
that the heads must be **easily trainable**.

## Decision

**Split by lifecycle, not by service.** Python is a *build-time training tool*;
TypeScript is the *only runtime*:

1. **Training happens in Python, offline, as a batch job** — a `training/` workspace
   (pinned environment) containing the PyTorch head definitions and a training script
   that consumes recorded session logs (feature vectors + outcome labels) and emits
   model artifacts. It is invoked on demand (after N sessions, or manually) — it is
   **not a service**, has no port, and never runs in CI's runtime path.

2. **Trained artifacts are exported to ONNX** and versioned. The ONNX file is the
   *only* interface between the two worlds — no REST/gRPC bridge exists.

3. **Runtime inference happens in TypeScript** via `onnxruntime-node`, inside the
   perception layer and the PPER scheduler (gating), and the memory subsystem
   (importance composition).

4. **The Golden Rule is amended** from "TS never touches neural networks, embeddings,
   or unstructured text" to:

   > **TS never *trains* models — it only runs exported ONNX inference over
   > deterministic feature vectors. All gradient updates, dataset construction, and
   > model architecture iteration happen in Python, offline.**

5. **Model versioning is part of the artifact.** Every exported ONNX head carries a
   version; the runtime logs which head version produced each gating decision, so
   behavior changes are auditable across retrains.

## Alternatives Considered

### A. Full Python cognitive microservice (original vision)
**Rejected.** vLLM/Qdrant/gRPC would reintroduce: a second always-on daemon (the yaam
daemon class of operational failures — memory saturation, RPC timeouts wedging agent
sessions), a network hop in front of microseconds of MLP compute, and a heavier CI
footprint on memory-constrained runners. The LLM itself is already served externally
(ollama.com) — there is no local LLM inference that would justify a Python service.

### B. Training in TypeScript directly
**Rejected.** The PyTorch ecosystem (optimizers, schedulers, debugging, export) is the
industry standard for head training; replicating it in TS (_tfjs_ or hand-rolled
gradient descent) gives up tooling for no runtime benefit, since training is offline.

### C. No heads — keep LLM-assigned importance and ungated cycles
**Rejected.** Importance stays LLM-hallucinated, agents re-deliberate every tick
(5x token variance between equivalent runs), and identity consolidation has no
salience signal to weight it.

## Consequences

**Positive:**
- Single runtime process; CI-friendly; no RPC hop on the cognition path
- Training cadence fully decoupled from runtime (retrain after N sessions; the runtime
  keeps working with the previous artifact between retrains)
- The heads are "easily trainable" per the original requirement — a standard PyTorch
  script over JSONL session logs
- Auditability: head version + revision numbers on every gating/identity decision

**Negative / accepted costs:**
- Model updates require a retrain-export-redeploy cycle (no online learning in the live
  runtime). Mitigation: scheduled retrain from accumulated session logs; the runtime is
  never blocked by it.
- A pinned Python environment exists in `training/` (requirements + version lock) —
  a build-time dependency, not a runtime one.
- Feature schemas (the scalar state features) are a contract between TS feature
  extraction and the Python trainer — changes require coordinating both sides.
  Mitigation: the feature schema lives in `shared` with a version constant.

## Scope boundary (explicitly out)

- No vLLM/llama.cpp service (the LLM is already external via ollama.com)
- No Qdrant/Chroma (the in-memory vector store suffices at current scale; revisit at
  ~1M nodes)
- No gRPC/REST bridge (ONNX artifacts are the bridge)
- No online/in-runtime gradient updates

## Relations

- **Implements the head requirement of** issue #132 (System 1 trainable heads)
- **Supersedes** the TS/Python service split from the original architecture vision
- **Follows the pattern of** ADR-0001 (lean structure; avoid premature operational
  complexity)
- **Amends** §5 Fast-Path Classifier architecture doc (adds the trainable head + the
  amended Golden Rule)