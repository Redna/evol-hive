# training/ — Offline baseline trainer (spec 035, Req 10)

Build-time batch workspace for training the System 1 heads from accumulated
JSONL session logs. **Python is a build-time batch tool only** — no port, no
daemon, never in the CI runtime path (spec 035 constraint). The runtime never
imports anything from this directory; it only loads the committed artifacts.

## Golden rule (ADR-0002, amended)

> TS never *trains* models — it only runs inference over deterministic feature
> vectors. All gradient updates happen in Python offline (this directory), or
> as audited one-line sleep-time updates at dream boundaries
> (`applyDreamUpdate` in `@evol-hive/cognition`).

## Environment

Pinned env: **any Python ≥ 3.10 with the standard library only** — no numpy,
no pip packages, no venv required. The trainer implements the closed-form
ridge solve (Gauss-Jordan) and a minimal ONNX protobuf writer itself, so the
environment is trivially reproducible:

```bash
python3 --version   # ≥ 3.10, stdlib only
```

## Usage

```bash
# 1. (Optional) regenerate the fixture session log (deterministic):
python3 training/fixtures/generate_fixture.py

# 2. Train the baseline React/Ignore probe from a session log:
python3 training/train_react_gate.py \
    --input training/fixtures/react-gate-fixture.jsonl \
    --out-json training/artifacts/react-gate-fixture-v1.json \
    --out-onnx training/artifacts/react-gate-fixture-v1.onnx \
    --lambda 0.1 \
    --head-version 1
```

Outputs:
- `training/artifacts/react-gate-fixture-v1.json` — the versioned weight
  artifact (`kind`, `headVersion`, `featureSchemaVersion`, `bias`,
  `scalarWeights`, `embeddingWeights: null`). The TS runtime loads this via
  `makeFileArtifactLoader` (spec-007 pattern) — point
  `SYSTEM1_GATE_ARTIFACT` at it in the examples assembly.
- `training/artifacts/react-gate-fixture-v1.onnx` — the ONNX parity export
  (MatMul → Add → Sigmoid). Verify parity with onnxruntime-node:
  the fixture artifact reproduces the JSON probe's `p(react)` within
  float32 tolerance (~5e-9, verified).

## Retrain cadence

- **After every N sessions** (default `N = 20`): collect the per-agent JSONL
  session logs (`<log-dir>/<agentId>.jsonl`), concatenate, retrain, and
  bump `headVersion` (v1 → v2 → …). Prior artifacts stay on disk for audit.
- **On demand**: whenever the gate's A/B metrics regress (missed hard
  triggers, over-reactive gating), retrain with a fresh λ if needed.
- The feature schema is a cross-world contract: any change to
  `SCALAR_FEATURE_FIELDS` / normalization bumps `FEATURE_SCHEMA_VERSION` in
  `@evol-hive/shared` AND this directory's copy, and invalidates prior
  artifacts (the runtime fails open on mismatch, Req 6).

## Files

| Path | Purpose |
|------|---------|
| `train_react_gate.py` | Closed-form ridge trainer + ONNX export (stdlib only) |
| `fixtures/generate_fixture.py` | Deterministic fixture session-log generator |
| `fixtures/react-gate-fixture.jsonl` | 24-sample committed fixture (scalar-only features) |
| `artifacts/react-gate-fixture-v1.{json,onnx}` | Committed artifacts the Node-side tests validate |