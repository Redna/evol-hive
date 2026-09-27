# Feature: Agent Memory Survives the Run — Checkpoint and Replay

## Context

- Architecture: [§11 — Memory Architecture](../architecture/11-memory-architecture.md), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md)
- Related specs: [030 — Dynamic Scenes / Living Worlds](030-dynamic-scenes-living-worlds.md) (R12 is the dormant-agent **event log** this spec generalises), [017 — Persistence: Save/Load Game State](017-persistence-save-load-game-state.md) (whole-world snapshots), [067 — A Live Run Must Leave Evidence](067-live-run-evidence.md) (the **samples** sink; this spec is the companion for **memory**), [039 — Spatial Phase 2 (targetArea + fog)](039-spatial-phase2-targetarea-fog.md)
- Package: `engine` (the event log + where memory is written), `assembly` (wiring the sink), `examples` (the run paths), `scripts` (the launcher).
- Status: 📝 Drafted
- Depends on: [067](067-live-run-evidence.md) (the launcher/evidence convention this follows)

## Problem Summary

Spec 067 fixed the *samples* sink. This is the other half of the same 16-hour hole: **the agents' memory is discarded at process exit and nothing is wired to keep it**, even though the mechanism is already built.

`packages/engine/src/world/mutations/yaam-event-log.ts` documents itself as:

> `append-only event log (UPSERT_NODE with agent-scoped labels …)`
> `agent-scoped label, e.g. agent:diarist:state or agent:diarist:mem:<nodeId>`
> `The log is JSONL-serializable (toJsonl) and replayable in a fresh session (fromJsonl → replayNodes), matching YAAM's "concatenation is a merge" semantics.`
> `Append-only YAAM event log. In-memory by default; appendTo(path) also appends the JSONL lines to a file for daemon-style persistence.`

So the engine can persist each agent's **state summary** (`agent:<id>:state`) and each of its **memory nodes** (`agent:<id>:mem:<nodeId>`, carrying content, embedding, importance and timestamp), and can **replay** them into a fresh session.

**Nothing calls it.** `YaamEventLog` and `appendTo` appear nowhere in `examples/` or `packages/assembly`. The only reason it exists is spec 030 R12 — persistence **for dormant agents** — a condition a live run may never reach, and which no current path triggers.

Measured consequence, from the archived 16-hour run: **33,005 reflections wrote memory** and every one of them died with the process. The verifications are negative and complete:

- `session-logs/` was last written six days before the run (the samples gap, spec 067);
- no file anywhere under `~/.yaam`, `/tmp`, or any `session-logs*` was touched during the run window except the stdout log and two tsx transpile caches;
- `events.jsonl` contains **zero `agent:` labels** — it is the harness's code graph, not the sim's.

So the run is not merely un-analysed; it is **unrecoverable**, and a future run would be too.

## Requirements

### R1 — A run checkpoints agent memory and state to a file (`engine` / `assembly`)

- A run MUST be able to write the agent event log to disk (`appendTo(path)`), configured by environment with a default beside the run's other evidence (spec 067's convention), so memory survives process exit.
- The **cadence** MUST be defined and MUST NOT be per tick — the engine's own doc says per-tick writes would flood an append-only log. Write on a boundary (reflection, plan completion, conversation close) and on **shutdown**, including the launcher's signal path.
- A **spending** run (`USE_REAL_LLM=true`) MUST NOT be able to run without a memory sink configured, mirroring spec 067's sink rule — a run that produces memories may not discard them.
- `USE_REAL_LLM=false` runs MUST remain cheap: no file, no default path, samples/memory in memory only.

### R2 — A fresh run can replay what a previous run recorded (`engine`)

- Replay MUST reconstruct the recorded nodes from the log (`fromJsonl` → `replayNodes`) and make a stated subset of them available to the new run.
- The spec MUST state **exactly what replay restores and what it does not**. At minimum the memory nodes (`agent:<id>:mem:<nodeId>`) and the state summary (`agent:<id>:state`) are in scope; whether the spatial fog memory (`visitedRooms`, `knownDoors`, `observedObjects`) is restored MUST be decided explicitly, because restoring it changes what specs 039/064/065 consider "known" on a fresh run.
- Replay MUST be **idempotent**: loading the same log twice MUST NOT duplicate nodes, and replay MUST be order-stable (the log's own semantics: concatenation is a merge).
- Replay MUST NOT invent content for agents absent from the log.

### R3 — Records are attributable (`engine` / `scripts`)

- Each run's records MUST be identifiable — a run/session identifier and timestamps — so two runs' logs can be distinguished on disk rather than silently interleaving in one file.
- If a deployment deliberately merges logs (the YAAM merge semantics), that MUST be an explicit configuration and documented, not an accident of two runs writing the same path.
- A run MUST NOT append to a log belonging to a *different* run without that being intended.

### R4 — Guards (`engine` / `scripts`)

- A test MUST fail if a spending run can start with no memory sink, and a test MUST fail if a cheap run is forced to write one (the spec-067 guard shape, applied to memory).
- A test MUST assert the **round trip** as data: append events → `toJsonl` → `fromJsonl` → `replayNodes` returns the same labels, content and count.
- A test MUST assert replay idempotency (load twice, no duplication) and order independence for the same event set.
- A test MUST fail if the checkpoint cadence can degenerate to per-tick writes.

### R5 — The record is documented, bounded and safe (`scripts` / docs)

- The log's location, format and how to replay it MUST be documented in the same places spec 067 documents the samples sink (`AGENTS.md` safety rules; the procedure's live-validation step).
- The log contains **agent memory content** — it is run output, therefore **gitignored**, never committed, and its location MUST NOT be a path inside the repository tree by default.
- Growth MUST be bounded: a long run's memory log has a documented size expectation and a rotation or cap, so "persist everything forever" is not the silent default.

## Acceptance Criteria

- [ ] **AC-1 (R1)** — a spending run writes an agent event log to the configured path (default beside the run's evidence); asserted by running the path with a stub model and finding the file.
- [ ] **AC-2 (R1)** — the log contains `agent:<id>:state` and `agent:<id>:mem:<nodeId>` records for an agent that wrote memory during the run.
- [ ] **AC-3 (R1)** — a spending run with no memory sink is refused (or requires an explicit acknowledgement), asserted as behaviour on the launcher/assembly seam.
- [ ] **AC-4 (R1)** — a `USE_REAL_LLM=false` run writes no file.
- [ ] **AC-5 (R1)** — writes happen on the defined boundaries and on shutdown, and a test fails if the cadence can become per-tick.
- [ ] **AC-6 (R2)** — `fromJsonl` → `replayNodes` over a log produced by a run returns the same node labels and content (round trip, asserted as data).
- [ ] **AC-7 (R2)** — replaying the same log twice is idempotent: the node set is unchanged.
- [ ] **AC-8 (R2)** — the restored subset is exactly what the spec states (nothing more): a test asserts which categories are present and, for those deliberately excluded, asserts their absence.
- [ ] **AC-9 (R3)** — two runs produce identifiable records; an unattributed merge cannot happen by accident.
- [ ] **AC-10 (R4)** — the guards exist and were **red** on the pre-change tree for the stated reasons.
- [ ] **AC-11 (R5)** — documentation names the path/format/replay command; the default path is outside the repository tree and is gitignored; a growth bound is stated and enforced (or explicitly deferred with a reason).
- [ ] **AC-12** — full suite green, `typecheck` clean, `prettier` clean; a live validation through `scripts/live-sim.mts` with a sample sink (spec 067) produces **both** samples and a memory log, and a second run replays the first.

## Constraints

- **Reuse the existing mechanism.** `YaamEventLog`, `toJsonl`, `fromJsonl`, `replayNodes`, `appendTo` already exist. Do not design a second memory format, and do not change the sample schema (spec 067 R4/ADR-0002 depend on it).
- **No new dependencies.** JSONL via `node:fs`.
- **Package direction stays strict** (`shared ← engine ← …`, `memory ← cognition`). The engine's log and `packages/memory`'s store must not be conflated: state which holds the canonical nodes and what the log is *of*.
- **Determinism**: replay is order-stable and idempotent; no clock/randomness in the reconstruction path.
- **No LLM or network in any test.**
- **No environment specifics** (paths, hosts, ports) in the repository — public repo, placeholders only.
- **Do not make memory persistence a precondition for cheap runs**, and do not make a run fail because a *previous* run's log is absent.

## Test Seams

1. **The log's serialization round trip** — `toJsonl` / `fromJsonl` / `replayNodes` as pure data (AC-6, AC-7): the load-bearing seam, and it needs no run at all.
2. **The checkpoint decision** — where the sink and cadence are resolved (extends spec 067's `resolveSampleSink` shape): assert file-vs-memory and the boundary set as data (AC-3, AC-4, AC-5).
3. **A stub run's artifacts** — launch the real path with `SIM_CMD` into a temp directory and assert the log exists with the expected labels (AC-1, AC-2), then replay it in a second invocation (AC-12).
4. **Replay scope** — assert the restored categories explicitly, including the excluded ones (AC-8).
5. **Attribution** — two stub runs produce distinguishable records (AC-9).

## Design Decisions

1. **Prefer the engine's agent-scoped event log over a memory-store dump.** The log is already agent-scoped, already carries the memory nodes' content/embedding/importance, and already documents replay and merge semantics — spec 030 R12 built the hard part. A store-level snapshot would be a second representation to keep consistent, and `packages/memory`'s store is a retrieval structure, not a record.
2. **Cadence on boundaries + shutdown, never per tick.** The engine's own documentation warns per-tick writes flood an append-only log; the launcher already traps signals (spec 069/#269), so shutdown-time flushing is available rather than hoped for.
3. **Replay scope must be explicit, not inherited.** Restoring fog memory silently would change what "known" means for specs 039/064/065 — a fresh run could start with an agent that has already seen the world, which may be desirable but must be a stated decision with a test on the excluded categories too.
4. **Attribution by default, merging by intent.** "Concatenation is a merge" is a feature, but a *silent* merge of two runs' memories would be indistinguishable from corruption. Runs get identifiers; merging is configured.
5. **This is not the learning signal.** Spec 067's samples are what the System-1 head consumes and what makes a run improve the system; this spec makes the *agents'* state durable so a run can be resumed, inspected, or reasoned about. Conflating them would overstate what persisting memory achieves.

## Out of Scope

- Cross-run **consolidation**, reflection or memory summarisation (a run's memories persist; merging their *meaning* is a different feature).
- Changing embeddings, retrieval weighting, or the reflection prompt.
- Whole-world save/load (spec 017) — this is agent memory and state, not the clock, scene or drive state.
- Cloud sync, multi-host aggregation, or any network transport for the log.
- Retention policy for spec 067's samples (already out of scope there).
- A privacy redaction policy beyond documenting that the log contains agent-generated content and must not be committed.

## Notes

- **Evidence source**: the archived 16-hour run log — `~/.local/share/evol-hive-archive/viz-run-16h-2026-09-26.log.gz` — plus negative checks: no repository file changed during the run window; `events.jsonl` holds zero `agent:` labels; the only run-window artifacts were stdout and tsx caches.
- **How this was found**: by asking whether the run produced anything meaningful and then *checking* rather than assuming. The answer — 33,005 memory writes, none recoverable — is the measurement this spec exists to make impossible to repeat.
- **Relationship to spec 067**: 067 keeps the **outcome samples** (what the system can learn from); 069 keeps the **agent memory** (what the agent knew). The 16-hour run lost both, for two different reasons: samples fell back to an in-memory writer, memory was never wired at all.
- **Evidence for this spec lives in** `docs/specs/notes/069-*-notes.md` per ADR-003.
