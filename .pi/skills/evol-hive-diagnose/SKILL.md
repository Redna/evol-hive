---
name: evol-hive-diagnose
description: 'Discipline for hard bugs and performance regressions in evol-hive: build a tight red-capable feedback loop before theorizing, then reproduce, minimise, hypothesise, and instrument one variable at a time. Use when the user says "diagnose"/"debug this", or reports something broken, throwing, failing, or slow — especially live-sim anomalies and memory spikes.'
---

# Diagnose (evol-hive)

The single highest-value discipline in this repo: our history is long diagnostic
arcs, and one false alarm came from theorising before verifying the evidence.
This skill prevents that.

## Phase 1 — build the feedback loop FIRST

**This is the skill.** A *tight, red-capable* pass/fail signal that goes red on
*this* bug. Reading code to build a theory before that command exists is the
exact failure this skill prevents.

Construct one, roughly in this order: failing test at a seam → curl/HTTP → CLI
invocation vs a known-good snapshot → headless browser → replay a captured trace
→ throwaway harness (minimal subset, one function call) → property/fuzz →
bisection harness → differential (old vs new).

**Completion:** name **one command** you have **already run** that is red-capable
(asserts the user's *exact* symptom), deterministic, fast (seconds), and
agent-runnable.

## Phase 2 — reproduce + minimise

Confirm the loop shows the **user's** failure, not a nearby one. Then shrink to
the smallest scenario that still goes red — cut inputs/callers/config one at a
time, re-running after each cut, keeping only what is load-bearing.

## Phase 3 — hypothesise

Generate **3–5 ranked, falsifiable** hypotheses before testing any:
"If <X> is the cause, then <changing Y> makes the bug disappear / <changing Z>
makes it worse." A hypothesis without a prediction is a vibe — discard it.
**Show the ranked list to the user**; they re-rank instantly. Proceed with your
ranking if they're AFK.

## Phase 4 — instrument one variable at a time

Debugger/REPL > targeted logs. Never "log everything and grep". Tag throwaway
logs `[DEBUG-xxxx]` so cleanup is one grep; prefer the permanent zero-LLM `[tag]`
diagnostics (spec-049) for anything that should outlive the session.

## Phase 5 — fix + regression test at a correct seam

Write the regression test **before** the fix, and only if the seam reproduces the
real bug pattern. If no correct seam exists, **that itself is the finding** — the
architecture is preventing the bug from being locked down; flag it.

## evol-hive gotchas

- **Stale dist is a classic false lead** — `pnpm build` before every live run.
- Measure on the **tick axis**, not log-line quintiles (late bursts skew fifths).
- **Never cut a 40-minute run short**; a 15–20 min "healthy" reading is an artifact.
- Harness: `/tmp/run-metrics.mjs` (tick-quintile metrics) and `/tmp/ac7-run.sh`
  (rebuild + launch); metrics come from the `[tag]` stderr lines.
- **Redact every secret** (`<REDACTED>`); build loops against env vars so the
  credential stays in the environment.
