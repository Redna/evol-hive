# Design Notes — Spec 035 (System 1 Trainable Heads) — Issue #132

> Note: recorded here because the `yaam` CLI/tools were not available in this
> environment (no `yaam` binary on PATH; `yaam_search` /
> `yaam_workspace_initialize` not exposed). Workspace
> `feature-035-system1-trainable-heads` could not be initialized; codebase
> search was done with grep over `packages/*` instead. Re-append these
> decisions to YAAM when the daemon/CLI is available.

## D1 — Heads are linear probes, not MLPs (ADR-0002 amendments win)
Issue #132 drafts "small MLP (2–3 dense layers) + PyTorch training script",
but the most recent commit revises ADR-0002 with a user directive: **linear
probes, no backprop** — `p = σ(W·x + b)` over frozen features (embedding ⊕
scalars ⊕ optional random Fourier expansion), trainable via the one-line
update `W += lr · (p − y) · x`. The spec follows the ADR (latest word) and
documents the MLP-with-real-framework as the last-resort fallback if linear
capacity is insufficient. Rationale: the vision's MLP was a means; the
requirement is *easily trainable heads*.

## D2 — Inference: pure TS dot-product, ONNX only for the offline interface
ADR-0002 says "inference via onnxruntime-node" and "ONNX is the only
interface". For a linear layer, graph execution is pure overhead; spec 035
pins runtime inference as a plain dot-product + sigmoid over a versioned JSON
weight snapshot (with `headVersion` + `featureSchemaVersion`), while the
offline Python baseline trainer still emits an ONNX export for parity checks
and future architecture research. This refines the letter of ADR-0002 without
violating its spirit (TS never trains; ONNX remains the cross-world artifact).
Flagged for the Architect's sign-off alongside the ADR flip to Accepted.

## D3 — Fail-open, always (Req 6)
Missing/corrupt/mismatched head artifact ⇒ gate passes everything (today's
behavior), one warning. A broken System 1 must never brick agents or — worse —
suppress alarms. Hard-positive overrides (message, conversation invite,
nearby mutation, drive threshold crossing) bypass the gate score entirely:
System 1 gates, it never suppresses alarms.

## D4 — Importance composition at write time, retrieval formula frozen (Req 14/15)
The composite (predicted prior ⊕ drive-delta magnitude ⊕ downstream utility ⊕
LLM 1–10 as one feature) lands in `MemoryNode.importance` at memory write.
`RetrievalEngineImpl` (spec 014) is byte-for-byte untouched — verified by a
fixed-input regression test. Downstream utility is a background counter
(retrievals × plan success), not a scoring change. This keeps spec 014's
contract intact and confines the change to input quality.

## D5 — Outcome labels accrue for free; training data needs no humans (Req 9)
Every completed cycle already produces the label signal (plan changed / drive
deltas / memory written / conversation continued ⇒ REACT; nothing ⇒ IGNORE).
Appending feature-vector + label + versions to per-agent JSONL session logs
costs ~nothing and makes both the offline ridge baseline and the dream-time
updates possible. Hard-trigger samples always label REACT so the head never
learns to ignore alarms.

## D6 — Dream-time updates reuse spec 033's guardrail shape (Req 11/12)
Bounded steps (≤200) + LR cap + validation-holdout-with-revert + versioned
snapshot + `dream_update` audit event — the exact guardrail pattern spec 033
already established for identity consolidation. Hot-swap means no restart;
trigger reuses the existing idle signal
(`ReflectionLoop.shouldReflect`, spec 014) with no urgent drives. Shared head
first; per-agent deltas deferred (sample volume).

## D7 — Identity hook: salience as the drift dial (Req 16/17)
Spec 033's dream pass weights deltas by accumulated importance from the new
head; mid-session consolidation fires on an accumulated-salience threshold
*within* the existing pass budget/delta bounds. `update_self_model` stays the
conscious override — System 1 influences drift magnitude, never identity
content directly.
