# Feature: System 1 — Trainable React/Ignore Gating + Trainable Importance Head

## Context
- Architecture: [§5 — Fast-Path Classifier](../architecture/05-fast-path-classifier.md) (System 0 pruner, ONNX-in-Node pattern), [§6 — PPER Loop](../architecture/06-pper-loop.md) (scheduler, perceive debouncing), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (importance, decay, weighted retrieval), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (5 drives)
- ADR: [ADR-0002 — Trainable Cognitive Heads](../adr/0002-trainable-heads-python-train-ts-serve.md) (linear probes, no backprop, sleep-time online updates; to be flipped Proposed → Accepted by this spec)
- Related specs: [007 — ONNX Embedding Provider](007-onnx-embedding-provider.md) (lazy-load + injectable-factory pattern this spec reuses), [014 — Memory Consolidation/Decay/Retrieval](014-memory-consolidation-decay-retrieval.md) (retrieval formula, unchanged), [033 — Conversations & Identity Evolution](033-conversations-identity-evolution.md) (dream pass, guardrails pattern, `update_self_model` conscious override), [031 — Execute Co-location Guard](031-execute-colocation-guard.md), [032 — Dynamic World Drive Restoration](032-dynamic-world-drive-restoration.md), [034 — Drive→Affordance Hints](034-drive-affordance-hints-hunger-chain.md)
- Package: `cognition` (feature extractor, gate heads, inference), `engine` (scheduler integration, session outcome logging, identity hook wiring), `memory` (composite importance, downstream utility tracking), `shared` (feature-schema types + version constant), `training/` (new build-time workspace — offline baseline trainer; never in the runtime path)
- Issue: [#132 — System 1: trainable React/Ignore gating + trainable importance head](https://github.com/Redna/evol-hive/issues/132)

## Problem

Every perception tick with an agent present runs a full PPER cycle (LLM calls) regardless of
whether anything changed: cycle count is driven by LLM latency, not by event salience, and
token spend varies ~5× between equivalent runs (72K vs 411K per 10 min observed). Importance
remains an LLM-hallucinated 1–10 at memory write, with no grounding in what actually mattered.
The original architecture vision (source-of-intent) called for easily-trainable classification
heads for (a) reaction gating and (b) importance rating; they were never built.

## Requirements

### A. Feature extraction (deterministic, TS engine)

- **Req 1 — Feature vector builder**: A pure, deterministic feature extractor in
  `packages/cognition` builds, per candidate event / per scheduler tick, a feature vector
  conforming to a versioned schema (`FEATURE_SCHEMA_VERSION` in `shared`): 384-dim embedding of
  the event/perception snapshot (from the existing `EmbeddingProvider`/ONNX model — shared
  with the classifier and memory store), 5 scalar drives + 5 drive deltas since the agent's
  last *completed* cycle, novelty (cosine distance of the snapshot embedding vs. the agent's K
  most recent memories), and binary/scalar flags: incoming message pending, conversation
  open/turn count, nearby object state changes, world mutation events, drive threshold
  crossings, ticks since last completed cycle. The extractor is a pure function of
  (engine state, perception snapshot, recent memories); the embedding call is its only
  asynchronous input.
- **Req 2 — Determinism & schema contract**: The scalar portion of the vector is produced by
  pure functions with fixed field order and normalization (drives 0–1, deltas −1–1, novelty
  0–1, flags 0/1). The scalar schema is the contract between TS extraction and any trainer
  (ADR-0002 "Negative costs" mitigation) — it lives in `shared` with a version constant, and
  session logs record the schema version alongside every sample.

### B. Trainable React/Ignore head (System 1 gate)

- **Req 3 — Linear-probe head per ADR-0002**: The gate is a linear probe over the frozen
  feature layer: `p(react) = σ(W·x + b)` (~400 parameters), with an optional frozen random
  Fourier feature expansion for capacity. No backprop exists anywhere in the TS runtime. The
  issue-draft "PyTorch MLP" is superseded by ADR-0002's amendments (MLP-with-real-framework
  is the documented last resort if linear capacity proves insufficient).
- **Req 4 — Inference in Node, versioned artifact**: Weights are a versioned artifact (JSON
  weight snapshot carrying `headVersion` + `featureSchemaVersion`); inference is a pure TS
  dot-product + sigmoid — no model graph execution needed for a linear layer. The offline
  Python baseline trainer additionally emits an ONNX export of the head for parity checks and
  architecture research (the ONNX artifact remains the Python↔TS interface for offline-trained
  baselines, per ADR-0002). Every gating decision logs the head version that produced it
  (auditability across retrains).
- **Req 5 — Hard-positive overrides**: Incoming agent message, conversation invite, nearby
  object mutation, and drive threshold crossing are hard triggers: the gate runs first, but a
  hard trigger forces a cycle regardless of `p(react)`. System 1 gates; it never suppresses
  alarms.
- **Req 6 — Fail-open semantics**: If the head artifact is missing, unloadable, or
  schema-version-mismatched, the gate passes all candidates (fail-open) and logs a warning
  once. A broken model must degrade to current behavior (every-tick cycles), never to a
  bricked agent.

### C. Scheduler integration (the payoff)

- **Req 7 — Gate before cycle**: `PPERScheduler.update` consults the gate before
  `startCycle`: `p(react) >= threshold` OR hard trigger → cycle; else the agent idles this
  tick. The gate is consulted synchronously from cached features/embeddings (no await in the
  scheduler hot path); when a cycle runs, its outcome label is recorded (Req 9).
- **Req 8 — Associative injection gating**: Spec 014's passive-track associative injection is
  gated by the same REACT decision — an idled tick performs no injection, no LLM calls.
  Gating adds zero LLM calls of its own.

### D. Self-supervised outcome labeling & session logging

- **Req 9 — Outcome labels, no human data**: When a cycle completes, the runtime labels the
  sample by outcome: plan changed | drive deltas applied | memory written | conversation
  continued → REACT (y=1); nothing changed → IGNORE (y=0). Hard-trigger samples are always
  labeled REACT. Feature vector + label + schema version + head version are appended to a
  per-agent JSONL session log (extendable to the existing persistence/session plumbing).
- **Req 10 — Offline baseline trainer (build-time)**: A `training/` workspace (pinned Python
  env) trains the baseline probe from accumulated session logs — closed-form ridge
  (`W = (XᵀX + λI)⁻¹Xᵀy`) or the one-line online update — and emits the versioned weight
  artifact (+ ONNX parity export). Python is a build-time batch tool: no port, no daemon,
  never in CI's runtime path. Retrain cadence documented (e.g., after every N sessions or on
  demand).

### E. Sleep-time (dream) updates

- **Req 11 — Dream-time weight updates**: On the existing idle/reflect trigger
  (`ReflectionLoop.shouldReflect`, no urgent drives), the runtime applies incremental updates
  to the shared head over all samples accumulated since the last dream: the one-line linear
  update `W += lr · (p − y) · x` per sample, or a closed-form ridge solve over the batch. No
  backprop, no ML library, milliseconds of arithmetic.
- **Req 12 — Dream guardrails (mirroring spec 033)**: Bounded steps per dream (≤200) + LR
  cap; validation holdout evaluated before commit — if loss degrades beyond tolerance, the
  previous weight snapshot is restored (never worse after a dream); every dream writes a
  versioned weight snapshot + an audited `dream_update` event (N samples, loss before/after,
  head version bump). New weights hot-swap for future gating — no restart.
- **Req 13 — Shared head first**: Start with a shared head updated at any agent's dream
  (more data per update). Per-agent weight deltas are a documented follow-up, not in scope.

### F. Trainable importance head

- **Req 14 — Composite importance**: The same frozen feature base feeds an importance probe
  producing a predicted importance prior. Final stored importance at memory write is the
  composite of: predicted prior ⊕ drive-delta magnitude (deterministic, from engine state) ⊕
  downstream utility (retrieval count × plan-success outcomes, retroactively folded into
  later writes/reflections for related content) ⊕ LLM-assigned 1–10 demoted to one feature
  among several. Composition happens **at memory-write time**; `MemoryNode.importance` holds
  the composite.
- **Req 15 — Retrieval formula unchanged**: `RetrievalEngineImpl`'s spec-014 scoring formula
  (recency/importance/relevance weights, decay-on-read) is untouched — composite importance
  improves the *input quality*, not the formula. Downstream-utility accumulation is a new
  background counter (retrievals + plan outcomes per memory), not a scoring change.

### G. Subconscious identity hook (spec 033 amendment)

- **Req 16 — Salience-weighted dream pass**: Session-end identity consolidation weights
  proposed deltas by accumulated event importance from the importance head — a high-salience
  session drifts identity more than a quiet one.
- **Req 17 — Mid-session consolidation trigger**: A mid-session consolidation pass triggers
  when accumulated salience crosses a configured threshold (within spec 033's existing pass
  budget and delta bounds), not only at session end. `update_self_model` remains the
  conscious override.

### H. ADR & docs

- **Req 18 — ADR-0002 accepted + §5 amended**: Flip ADR-0002 to Accepted; amend
  `docs/architecture/05-fast-path-classifier.md` to add the trainable System 1 heads and the
  amended Golden Rule: "TS never *trains* models — it only runs exported ONNX inference over
  deterministic feature vectors. All gradient updates happen in Python offline, or as
  one-line sleep-time updates in-runtime."

## Acceptance Criteria

- [ ] **AC-1**: The feature extractor is a pure function with deterministic unit tests: drive deltas match hand-computed values across a scripted tick sequence; novelty decreases as the snapshot embedding approaches recent-memory embeddings; every flag (message pending, conversation open, object state change, mutation, threshold crossing, ticks-since-cycle) toggles from engine state alone; field order and normalization are stable and `FEATURE_SCHEMA_VERSION` is stamped in output. (maps to Req 1, Req 2)
- [ ] **AC-2**: Gate inference is a deterministic test over a fixed weight artifact: known vector → known `p(react)`; artifact load failure, corrupt file, and schema-version mismatch all fail open (all candidates pass) with a single logged warning, not a throw. (maps to Req 4, Req 6)
- [ ] **AC-3**: Scheduler gating tests (mock orchestrator): with `p(react) < threshold` and no hard trigger, no cycle starts; at `p(react) ≥ threshold` a cycle starts; each hard trigger (incoming message, conversation invite, nearby mutation, drive threshold crossing) forces a cycle at `p(react) = 0`. An idled tick performs no associative injection. Gating adds zero LLM calls (mock LLM call counter unchanged by gate evaluation). (maps to Req 5, Req 7, Req 8)
- [ ] **AC-4**: Outcome labeling tests: a scripted cycle that changes the plan writes a REACT-labeled sample; a no-op cycle writes an IGNORE-labeled sample; hard-trigger samples are always REACT; samples in the JSONL log carry schema + head versions. (maps to Req 9)
- [ ] **AC-5**: Training pipeline: given a fixture JSONL session log, the `training/` script emits a versioned weight artifact + ONNX parity export; the artifact loads in Node and reproduces the fixture's expected `p(react)` within tolerance; `training/` is absent from CI runtime paths and has a documented retrain cadence. (maps to Req 10)
- [ ] **AC-6**: Dream-update tests: over an accumulated sample set, one dream applies bounded updates, writes a `dream_update` audit event with loss before/after, and hot-swaps weights for subsequent gating; a seeded case where the update degrades holdout loss reverts to the prior snapshot (post-dream loss is never worse). (maps to Req 11, Req 12)
- [ ] **AC-7**: Importance composition tests: importance at write is the documented composite (prior ⊕ drive-delta magnitude ⊕ downstream utility ⊕ LLM score as one feature) with deterministic fixtures; `RetrievalEngineImpl` source and scoring outputs for fixed inputs are byte-identical to spec 014's; downstream-utility counters increment on retrieval/plan-success without altering scores. (maps to Req 14, Req 15)
- [ ] **AC-8**: Identity hook tests: dream-pass delta weighting scales with accumulated salience (fixture: high-salience session → larger weighted delta than quiet session); a mid-session trigger fires when accumulated salience crosses the threshold, within spec 033's pass budget; `update_self_model` still overrides. (maps to Req 16, Req 17)
- [ ] **AC-9**: Gate effectiveness A/B (manual, real-LLM): 10-min run with gating shows cycle count driven by event salience, token spend ≤ 150K (vs. the 411K high-variance baseline), and zero missed hard-triggers (every incoming message/conversation invite answered). Evidence attached to issue #132. (maps to Req 7, Req 8, Req 5)
- [ ] **AC-10**: ADR-0002 status is Accepted; §5 doc amended with the trainable heads and amended Golden Rule. (maps to Req 18)
- [ ] **AC-11**: `pnpm -r test && pnpm typecheck && pnpm lint` pass; all existing tests green. (maps to all; regression guard)

## Constraints
- **No Python at runtime or in CI's runtime path** — `training/` is a build-time batch workspace only (pinned env, no port, no daemon). The amended Golden Rule holds: TS never trains; runtime "learning" is the audited one-line linear update at dream boundaries.
- **No new daemons, no RPC** — heads run in-process; the ONNX artifact is the only Python↔TS interface for offline baselines (ADR-0002). The linear probe itself needs no graph execution in TS.
- **Gate latency**: gating must be sub-millisecond per tick from cached features (dot product + sigmoid); embedding reuse via the existing provider's LRU cache; no new LLM calls anywhere in the gating path.
- **Fail-open, never fail-closed**: gate/model faults degrade to today's every-tick behavior; hard-triggers are unconditional. System 1 gates, it never suppresses alarms.
- **Package boundaries**: feature-schema types in `shared`; gate + extractor + heads in `cognition`; scheduler wiring + session logging + identity trigger in `engine`; importance composition + downstream utility in `memory`. Follow the spec-007 pattern (lazy load, injectable factories) for any model artifact loading.
- **Retrieval is frozen**: do not modify `RetrievalEngineImpl` scoring, decay rates, or `defaultRetrievalWeights` (spec 014); importance composition happens at write time.
- **Feature schema is a cross-world contract**: any scalar-feature change bumps `FEATURE_SCHEMA_VERSION` and invalidates prior artifacts (fail-open on mismatch) — coordinate TS extractor and trainer.
- **What NOT to do**: no PyTorch/tfjs in the runtime; no per-agent heads yet (Req 13 defers them); no Python cognitive microservice (explicitly out per ADR-0002); do not gate the classifier's System 0 affordance pruning (§5 pruning is orthogonal and stays); do not suppress cycles during conversations (conversation turns are a hard trigger); do not let dream updates bypass the holdout/revert guardrail.
