# Design Notes — Spec 048 (Drive-Economy Rebalance for cc=3) — Issue #168

> Workspace: `feature-048-drive-economy-rebalance` — "Decay outruns restoration
> at 3-agent cadence; hunger chain stalls at 2/3 seeds."
> Note: recorded here because the YAAM daemon/JSON-RPC workspace API is not
> available in this environment (`yaam_workspace_initialize` /
> `yaam_workspace_append_note` not callable); these are the design decisions
> that would have been stored as YAAM workspace notes for this feature.

## D1 — Scale decay by live agent count, not by concurrency config (Req 1)
Effective per-agent decay = `decayRate / N` with `N = getActiveAgents().length`
per tick. Scaling by `maxConcurrentCycles` instead would keep charging full
decay to dormant/late-spawned agents and would couple two unrelated knobs
(scheduler capacity ≠ population). At N=1 the effective rate is identical to
today, so cc=1 scenes and the spec-019 contract are untouched by default.
`ENGINE_DECAY_SCALING='none'` is the escape hatch for experiments.

## D2 — Audit-first rebalancing, no preemptive magnitude bumps (Req 2)
The tempting fix is bumping `relax` +5 → +10, but that overshoots once decay
scaling lands (per-interval decay drops to ~2–3) and would push drives toward
monotone maxing — destroying the #139 oscillation the demo exists to show
(AC-3). Instead the ledger becomes a deterministic test (AC-5): restoration >
decay/interval per drive; magnitudes move only where the audit names a failure.

## D3 — Chain progress is declared scene data, not inferred (Req 3)
`Affordance.progresses?: { drive, note }` on `plant_seeds` and `harvest`. The
matcher cannot infer that planting leads to eating — that's scene knowledge —
and a hardcoded cognition table would violate spec 034 Req 3. Explicitly
rejected: faking hunger `effects` on `plant_seeds` (misreports a restoration
that never executes). Chain hints render after direct-restoration hints and are
social-excluded, mirroring the spec-034 hint pipeline.

## D4 — Verification split (Req 5)
Deterministic ACs (4/5/6/7) gate the merge; live ACs (1/2/3) are the issue
evidence protocol: 3 × 30-min cc=3 runs with `logState()` traces. AC-2's
"≥2 of 3 runs" is a run-count, not a flake tolerance — a single-run fix is not
accepted because the stall was intermittent (2 of the last 4 runs).
