# Design Notes — Spec 030 (Dynamic Scenes / Living Worlds) — Issue #117

> Note: recorded here because the YAAM daemon/JSON-RPC workspace API is not
> available in this environment; these are the design decisions that would
> have been stored as YAAM workspace notes for `feature-030-dynamic-scenes`.

## D1 — Mutation funnel (Req 1)
All structural changes funnel through ONE `SceneMutationService`. The issue's
"existing event system" is realized as the append-only `SceneMutationEvent`
log (Req 2): agent-initiated changes enter via the Execute service
(spec 028 pattern), LLM-proposed changes via the `modify_scene` cognitive
tool — both end at the same validated queue. This keeps the deterministic
core untouched (explicit tick-boundary application, no ambient mutation).

## D2 — Connections as state, not structure (Req 9)
`rooms[].connections` stays the adjacency source of truth; doorway smart
objects (spec 022 Req 12) mirror it. Opening/closing toggles adjacency +
doorway `state.open` so perception/pathfinding need no new query path —
they just see filtered `getConnectedRooms`. Avoids inventing a parallel
topology graph.

## D3 — Dormancy instead of deletion (Req 7/8)
Despawn exports profile + internal state + plan + memories into a
`DormantAgentStore` rather than dropping data, so re-spawn restores exact
state (AC-3) and save/load round-trips dormancy (AC-7).

## D4 — YAAM writes are coarse-grained (Req 12)
Only spawn/despawn/session boundaries write YAAM events (`UPSERT_NODE` /
`DELETE_NODE`, agent-scoped labels). Per-tick writes would flood the
append-only JSONL and blow up compaction cost in the memory pipeline.

## D5 — LLM proposes, engine disposes (Req 13/14)
`modify_scene` can only enqueue proposals; validation errors are fed back
as tool output for self-correction. Guardrails: §10 masking, per-cycle
rate limit (`maxSceneMutationsPerCycle`), never direct mutation.

## D6 — Version bump with graceful fallback (Req 11)
`SAVE_FORMAT_VERSION` bumps; old saves load fine because "no dynamic data"
is equivalent to "zero mutations replayed".
