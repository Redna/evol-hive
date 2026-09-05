#!/usr/bin/env python3
"""
training/train_react_gate.py — Offline baseline trainer for the System 1
React/Ignore gate (spec 035, Req 10 / AC-5).

Trains the baseline linear probe from accumulated JSONL session logs:

    p(react) = sigmoid(W·x + b)

via the closed-form ridge solution

    W = (XᵀX + λI)⁻¹ Xᵀy        (bias absorbed unregularized)

and emits:
  1. a versioned JSON weight artifact (headVersion + featureSchemaVersion) —
     the artifact the TS runtime loads (`ReactGateHead` + `makeFileArtifactLoader`);
  2. an ONNX export of the head (MatMul → Add → Sigmoid) for parity checks and
     architecture research (ADR-0002: ONNX remains the Python↔TS interface for
     offline-trained baselines).

STDLIB ONLY — no numpy, no pip, no daemon, no port. Python is a BUILD-TIME
batch tool and is never in the CI/runtime path (spec 035 constraint).

Usage:
    python3 training/train_react_gate.py \
        --input training/fixtures/react-gate-fixture.jsonl \
        --out-json training/artifacts/react-gate-fixture-v1.json \
        --out-onnx training/artifacts/react-gate-fixture-v1.onnx \
        --lambda 0.1 --head-version 1

Retrain cadence: after every N sessions (N = 20 is the documented default) or
on demand — see training/README.md.
"""

import argparse
import json
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

FEATURE_SCHEMA_VERSION = 1

# The ordered scalar field contract — MUST match shared SCALAR_FEATURE_FIELDS.
SCALAR_FEATURE_FIELDS = [
    "driveEnergy",
    "driveHunger",
    "driveSocial",
    "driveComfort",
    "driveCuriosity",
    "deltaEnergy",
    "deltaHunger",
    "deltaSocial",
    "deltaComfort",
    "deltaCuriosity",
    "novelty",
    "messagePending",
    "conversationOpen",
    "conversationTurns",
    "nearbyObjectStateChange",
    "worldMutation",
    "driveThresholdCrossing",
    "ticksSinceLastCycle",
]


def load_samples(path: Path):
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            rows.append(row)
    return rows


def build_matrices(rows):
    X, y = [], []
    for row in rows:
        if row.get("schemaVersion") != FEATURE_SCHEMA_VERSION:
            raise SystemExit(
                f"sample schemaVersion {row.get('schemaVersion')!r} != {FEATURE_SCHEMA_VERSION} "
                "(the feature schema is the cross-world contract — regenerate the log)"
            )
        scalar = row["scalar"]
        X.append([float(scalar[field]) for field in SCALAR_FEATURE_FIELDS])
        y.append(1.0 if row["label"] == "react" else 0.0)
    return X, y


def ridge_solve(X, y, lam):
    """Closed-form ridge with an UNREGULARIZED bias column (Gauss-Jordan)."""
    d = len(X[0])
    # Design matrix with a leading bias column of ones.
    Xb = [[1.0] + row for row in X]
    dim = d + 1
    # A = XbᵀXb + λ·diag(0,1,…,1); b = Xbᵀy
    A = [[0.0] * dim for _ in range(dim)]
    b = [0.0] * dim
    for i, row in enumerate(Xb):
        for r in range(dim):
            for c in range(dim):
                A[r][c] += row[r] * row[c]
            b[r] += row[r] * y[i]
    for r in range(1, dim):
        A[r][r] += lam

    # Gauss-Jordan with partial pivoting → solve A·w = b
    M = [A[r][:] + [b[r]] for r in range(dim)]
    for col in range(dim):
        pivot = max(range(col, dim), key=lambda r: abs(M[r][col]))
        if abs(M[pivot][col]) < 1e-12:
            raise SystemExit("ridge matrix is singular — increase --lambda")
        M[col], M[pivot] = M[pivot], M[col]
        for r in range(dim):
            if r == col:
                continue
            factor = M[r][col] / M[col][col]
            for c in range(col, dim + 1):
                M[r][c] -= factor * M[col][c]
    w = [M[r][dim] / M[r][r] for r in range(dim)]
    return w[0], w[1:]  # bias, weights


def sigmoid(z):
    if z >= 0:
        ez = pow(2.718281828459045, -z) if z < 700 else 0.0
        return 1.0 / (1.0 + ez)
    ez = pow(2.718281828459045, z) if z > -700 else 0.0
    return ez / (1.0 + ez)


# ── Minimal protobuf encoding (ONNX) ─────────────────────────────────────────


def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        bits = n & 0x7F
        n >>= 7
        if n:
            out.append(bits | 0x80)
        else:
            out.append(bits)
            return bytes(out)


def tag(field: int, wire: int) -> bytes:
    return varint((field << 3) | wire)


def ld(field: int, payload: bytes) -> bytes:
    return tag(field, 2) + varint(len(payload)) + payload


def vint(field: int, value: int) -> bytes:
    return tag(field, 0) + varint(value)


def pack_floats(values) -> bytes:
    return b"".join(struct.pack("<f", v) for v in values)


def tensor_proto(name: str, dims, float_data) -> bytes:
    dims_bytes = b"".join(varint(d) for d in dims)
    data = pack_floats(float_data)
    out = ld(1, dims_bytes)  # dims (packed int64)
    out += vint(2, 1)  # data_type = FLOAT
    out += ld(4, data)  # float_data (packed float)
    out += ld(8, name.encode())  # name
    return out


def value_info(name: str, dims) -> bytes:
    # ValueInfoProto { name=1, type=2: TypeProto { tensor_type=1:
    #   Tensor { elem_type=1 (FLOAT), shape=2: TensorShapeProto { dim=1:
    #     Dimension { dim_value=1 | dim_param=2 } } } } }
    shape_dims = b""
    for d in dims:
        if isinstance(d, str):
            shape_dims += ld(1, ld(2, d.encode()))  # dim_param
        else:
            shape_dims += ld(1, ld(1, varint(d)))  # dim_value
    tensor_type = vint(1, 1) + ld(2, shape_dims)  # elem_type FLOAT + shape
    type_proto = ld(1, tensor_type)
    return ld(1, name.encode()) + ld(2, type_proto)


def node_proto(op_type: str, inputs, output: str) -> bytes:
    out = b""
    for i in inputs:
        out += ld(1, i.encode())  # input
    out += ld(2, output.encode())  # output
    out += ld(4, op_type.encode())  # op_type
    return out


def build_onnx(weights, bias) -> bytes:
    d = len(weights)
    node_protos = [
        node_proto("MatMul", ["features", "W"], "pre_bias"),
        node_proto("Add", ["pre_bias", "B"], "logits"),
        node_proto("Sigmoid", ["logits"], "p_react"),
    ]
    # Repeated protobuf fields: each element carries its own tag+length.
    nodes = b"".join(ld(1, n) for n in node_protos)
    initializers = ld(
        5, tensor_proto("W", [d, 1], weights)
    ) + ld(5, tensor_proto("B", [1], [bias]))
    graph_inputs = ld(11, value_info("features", ["N", d]))
    graph_outputs = ld(12, value_info("p_react", ["N", 1]))
    graph = nodes + initializers + graph_inputs + graph_outputs
    opset = ld(1, b"") + vint(2, 13)  # domain "" , version 13
    model = vint(1, 8)  # ir_version 8
    model += ld(2, b"evol-hive-train-react-gate")  # producer_name
    model += ld(7, graph)  # graph
    model += ld(8, opset)  # opset_import
    return model


# ── Main ──────────────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="JSONL session-log fixture")
    parser.add_argument("--out-json", required=True, help="output weight artifact JSON")
    parser.add_argument("--out-onnx", required=True, help="output ONNX parity export")
    parser.add_argument("--lambda", dest="lam", type=float, default=0.1, help="ridge λ")
    parser.add_argument("--head-version", type=int, default=1)
    args = parser.parse_args()

    rows = load_samples(Path(args.input))
    X, y = build_matrices(rows)
    bias, weights = ridge_solve(X, y, args.lam)

    # Training-set fit report (informational).
    p = [sigmoid(bias + sum(w * xij for w, xij in zip(weights, xi))) for xi in X]
    bce = sum(
        -(yi * _log(pi) + (1 - yi) * _log(1 - pi)) for pi, yi in zip(p, y)
    ) / len(y)
    print(f"samples={len(X)} lambda={args.lam} train_bce={bce:.6f}")
    print(f"bias={bias:.6f}")

    artifact = {
        "kind": "react-gate",
        "headVersion": args.head_version,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "bias": bias,
        "scalarWeights": {
            field: weights[i] for i, field in enumerate(SCALAR_FEATURE_FIELDS)
        },
        "embeddingWeights": None,
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "source": f"training/train_react_gate.py ridge λ={args.lam}",
    }
    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out_json}")

    out_onnx = Path(args.out_onnx)
    out_onnx.parent.mkdir(parents=True, exist_ok=True)
    out_onnx.write_bytes(build_onnx(weights, bias))
    print(f"wrote {out_onnx}")
    return 0


def _log(v: float) -> float:
    import math

    v = min(max(v, 1e-12), 1 - 1e-12)
    return math.log(v)


if __name__ == "__main__":
    sys.exit(main())