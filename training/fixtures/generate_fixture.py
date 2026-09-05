#!/usr/bin/env python3
"""
training/fixtures/generate_fixture.py — Deterministic fixture session log for
the offline baseline trainer (spec 035, AC-5).

Generates a small, fully deterministic JSONL session log (24 labeled samples,
scalar-only features — `embedding: null`) shaped like the runtime's
`CycleOutcomeSample` lines. "Urgent" ticks (drive pressure, hard triggers,
large deltas, high novelty) are labeled `react`; "quiet" ticks are labeled
`ignore`. A linear probe can separate these cleanly, which makes the trainer's
output predictable and the Node-side parity test meaningful.

STDLIB ONLY; deterministic (no randomness). Re-runs produce byte-identical
output apart from timestamps (which are fixed here).
"""

import json
from pathlib import Path

FIELDS = [
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


def base_scalar():
    return {
        "driveEnergy": 0.5,
        "driveHunger": 0.5,
        "driveSocial": 0.5,
        "driveComfort": 0.5,
        "driveCuriosity": 0.5,
        "deltaEnergy": 0.0,
        "deltaHunger": 0.0,
        "deltaSocial": 0.0,
        "deltaComfort": 0.0,
        "deltaCuriosity": 0.0,
        "novelty": 0.3,
        "messagePending": 0,
        "conversationOpen": 0,
        "conversationTurns": 0.0,
        "nearbyObjectStateChange": 0,
        "worldMutation": 0,
        "driveThresholdCrossing": 0,
        "ticksSinceLastCycle": 0.5,
    }


def urgent_sample(i: int) -> dict:
    s = base_scalar()
    s["driveEnergy"] = 0.2
    s["driveHunger"] = 0.85
    s["deltaHunger"] = 0.4
    s["deltaEnergy"] = -0.3
    s["novelty"] = 0.9
    s["messagePending"] = 1 if i % 3 == 0 else 0
    s["nearbyObjectStateChange"] = 1 if i % 2 == 0 else 0
    s["worldMutation"] = 1 if i % 4 == 0 else 0
    s["driveThresholdCrossing"] = 1 if i % 5 == 0 else 0
    s["ticksSinceLastCycle"] = 0.9
    return s


def quiet_sample(i: int) -> dict:
    s = base_scalar()
    s["novelty"] = 0.1
    s["ticksSinceLastCycle"] = 0.1
    return s


def main() -> None:
    lines = []
    for i in range(24):
        urgent = i % 2 == 0
        scalar = urgent_sample(i) if urgent else quiet_sample(i)
        sample = {
            "schemaVersion": 1,
            "headVersion": 0,  # pre-training: no head assigned these
            "agentId": "agent-fixture",
            "tickNumber": 100 + i,
            "simTime": round(i * 0.0167, 6),
            "label": "react" if urgent else "ignore",
            "hardTrigger": bool(
                scalar["messagePending"] or scalar["driveThresholdCrossing"]
            ),
            "pReact": 0.5,
            "outcome": {
                "planChanged": urgent,
                "drivesChanged": urgent,
                "memoryWritten": urgent,
                "conversationContinued": False,
            },
            "scalar": scalar,
            "embedding": None,
        }
        lines.append(json.dumps(sample))
    out = Path(__file__).parent / "react-gate-fixture.jsonl"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {out} ({len(lines)} samples)")


if __name__ == "__main__":
    main()