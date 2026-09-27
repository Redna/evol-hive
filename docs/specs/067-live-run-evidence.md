# Feature: A Live Run Must Leave Evidence — Never Spend Compute Without a Record

## Context

- Architecture: [§9 — Engine Routing](../architecture/09-engine-routing.md), [§11 — Memory Architecture](../architecture/11-memory-architecture.md), [ADR-0002 — Trainable Heads (System 1)](../adr/0002-trainable-heads-python-train-ts-serve.md)
- Related specs: [035 — System 1 Trainable Heads](035-system1-trainable-heads.md) (the consumer of session samples), [030 — Dynamic Scenes / Living Worlds](030-dynamic-scenes-living-worlds.md) (the YAAM event log), [017 — Persistence: Save/Load Game State](017-persistence-save-load-game-state.md) (state snapshots), [027 — Real-LLM Visualizer Demo](027-real-llm-visualizer-demo.md) (the launch path that discards everything), [066 — Visualizer Live-Observation Defects](066-visualizer-live-observation-defects.md) (removed Save/Load because there was nothing to save — this spec addresses *why*)
- Package: `assembly` (where the sample sink is chosen), `examples` (which run paths pass a sink), `scripts` (the launcher), docs.
- Status: 📝 Drafted

## Problem Summary

**Measured, not hypothesised.** A real-LLM visualizer run was left running unattended for ~16 h. It made **47,808 cloud LLM calls** and did a great deal of work. When it was stopped, **nothing remained**:

| What the run did (from its log) | What survived |
| --- | --- |
| 8,139 plans (3,140 succeeded, 0 failed) | — |
| **632 conversations** (each ran to idle → timeout) | — |
| 36,997 reflections, **33,005 of which wrote memory** | — |
| 23,707 social-urge lines surfaced | — |
| 33,266 planned steps (48% `observe`/`wait`) | — |
| 10,875 skipped steps of 30,075 (36%) | — |
| 5,178 precondition rejections | — |

`session-logs/` was last written **six days earlier**; nothing in the repository changed during the run window; `events.jsonl` is the *harness's* memory, not the sim's. The sole artifact was a 46 MB stdout log (now archived, 2.4 MB gzipped), and even that records only *that* conversations happened — never what was said. **The run is unrecoverable.**

### Why it could not have been otherwise

`packages/assembly/src/assembly.ts` chooses the sample sink at construction:

```ts
const sampleLog = options.sessionLogDir
  ? new JsonlSessionSampleLog(makeFileSampleLogWriter(options.sessionLogDir))
  : new JsonlSessionSampleLog(new InMemorySampleLogWriter());
```

Without `sessionLogDir` the samples are still produced — at every tick, for every agent — and written to **memory**, then discarded when the process exits. The run was generating exactly the data that makes it evaluable, and throwing it away.

Two example paths pass a directory, both via env with a sane default:

- `examples/coffee-shop.ts` → `SYSTEM1_SESSION_LOG_DIR`
- `examples/dynamic-world-sim.ts` → `SYSTEM1_SESSION_LOG_DIR` **or `session-logs`**

`examples/visualizer-demo.ts` — the path used for **live visual observation**, i.e. the one most likely to run for hours unattended — passes **nothing**.

So the expensive path is the one with no sink, and the cheap paths are the ones that keep their data. That is backwards, and it is silent: nothing warns that a 16-hour run cannot be evaluated.

## Requirements

### R1 — A live run writes its samples, or says why it cannot (`assembly` / `examples` / `scripts`)

- `examples/visualizer-demo.ts` MUST pass a session-log directory whenever the real-LLM path is used, defaulting to `session-logs` like `dynamic-world-sim.ts`, overridable by `SYSTEM1_SESSION_LOG_DIR`.
- The chosen directory and the fact that samples are being written MUST be announced at startup, alongside the model and budget the launcher already prints (spec #269), so the operator can see where the evidence will land *before* spending anything.
- **A real-LLM run with no sink MUST NOT start silently.** `scripts/live-sim.mts` MUST refuse to launch (or require an explicit acknowledgement flag) when the run cannot write samples, naming the reason.
- An in-memory sink remains valid for tests and for `USE_REAL_LLM=false`, where the run is cheap and deterministic; the rule targets runs that spend.

### R2 — A stopped run leaves a summary of what happened (`scripts` / `examples`)

- When a run ends — budget reached, Ctrl-C, or exit — it MUST write a machine-readable **run summary** next to its samples: at minimum the run's duration, tick count, plans attempted/succeeded, conversations started/completed, reflections, memory writes, steps executed vs skipped, precondition rejections, the model used, the budget, and the sample count with the samples' path.
- The summary MUST be written on a normal shutdown **and** on Ctrl-C (the launcher already traps signals; the summary must not depend on a clean exit that a paused run may never reach).
- A human MUST be able to answer "was this run worth anything?" by reading the summary, without grepping a 46 MB log. Today that answer required mining the log by hand.

### R3 — Nothing runs without learning from it (`scripts` / docs)

- The launcher's banner MUST state, in one line, what this run will produce: model, budget, and evidence destination (samples + summary).
- The prohibition is documented where launches happen: the safety section of `AGENTS.md` and the live-validation step of `docs/DELIVERY_PROCEDURE.md`.
- The `AGENTS.md` claim that *"live sims write outcome samples to `session-logs/`"* is **currently false for the visualizer demo** and MUST be corrected to say which paths do it and how a new path opts in — a doc that asserts evidence exists is worse than no doc, because it is the reason nobody checked.

### R4 — The evidence is verifiable, not merely written (`scripts` / tests)

- A test MUST fail if a live-LLM run path can start without a sample sink.
- A test MUST fail if the in-memory sink can be selected for a `USE_REAL_LLM=true` run.
- The summary's shape MUST be asserted as data (a parsed object with the required fields), not by grepping for prose.
- Samples written by a run MUST be parseable as JSONL with the existing sample schema (`schemaVersion`, `agentId`, `tickNumber`, `simTime`, `outcome{planChanged,drivesChanged,memoryWritten,conversationContinued}`, `scalar{…}`, `embedding`) — this spec does not change that schema.

## Acceptance Criteria

- [ ] **AC-1 (R1)** — `examples/visualizer-demo.ts` passes a session-log directory on the real-LLM path, defaulting to `session-logs`, and `SYSTEM1_SESSION_LOG_DIR` overrides it.
- [ ] **AC-2 (R1)** — starting a real-LLM run prints the evidence destination (directory) and model before the first agent cycle.
- [ ] **AC-3 (R1)** — the launcher refuses (non-zero exit, clear message) a real-LLM run that has no sample sink, unless an explicit acknowledgement flag is set; and the refusal names the reason.
- [ ] **AC-4 (R1)** — `USE_REAL_LLM=false` still works with the in-memory sink (no directory required, no samples written).
- [ ] **AC-5 (R2)** — on a normal stop a run summary file appears next to the samples, containing the fields R2 lists, asserted by parsing it.
- [ ] **AC-6 (R2)** — on Ctrl-C (the launcher's signal path) the summary is still written.
- [ ] **AC-7 (R2)** — the summary is enough to judge the run: a test asserts each required field is present and non-null for a stub run.
- [ ] **AC-8 (R3)** — `AGENTS.md` and `docs/DELIVERY_PROCEDURE.md` state the rule and name which example paths write samples; the stale unconditional claim is gone.
- [ ] **AC-9 (R4)** — a test fails if a live-LLM path can start without a sink (red on current `main`).
- [ ] **AC-10 (R4)** — a test fails if `USE_REAL_LLM=true` can select the in-memory sink (red on current `main`).
- [ ] **AC-11 (R4)** — samples from a stub run parse as JSONL with the existing schema fields.
- [ ] **AC-12** — full suite green, `typecheck` clean, `prettier` clean on touched files.

## Constraints

- **No new dependencies.** The samples already have a JSONL writer (`JsonlSessionSampleLog` + `makeFileSampleLogWriter`); reuse it. The summary is JSON written with `node:fs`.
- **Do not change the sample schema** (R4). The System-1 consumer (`scripts/dream-update.mts`, ADR-0002) depends on it; this spec is about *not discarding* samples, not about their content.
- **Package direction stays strict**: `assembly` may choose a sink; `examples` may pass one; `scripts` may guard and summarise. No new cross-package imports that violate `shared ← engine ← …`.
- **Cheap runs must stay cheap**: `USE_REAL_LLM=false` must not be forced to write files, and no test may require an LLM or a network.
- **Do not make the summary a substitute for samples.** It answers "was this run worth anything", not "what did the head learn"; the samples remain the learning artifact.
- **A run that already produced samples must not be rewritten or pruned** by the summary path — append-only.
- `session-logs/` stays **gitignored** (it is run output, not repository content); a run summary is run output too and belongs beside the samples, not in the tree.

## Test Seams

1. **The sink choice** — the function/option that decides `file` vs `in-memory` given a run's configuration. Primary seam for AC-1, AC-4, AC-9, AC-10: assert the *decision* as data rather than by launching anything.
2. **A stub run's artifacts** — launch the real path with a stub command (`SIM_CMD`, already supported by `scripts/live-sim.mts` and used by its tests) into a temp directory, then assert the sample file and summary exist and **parse** (AC-5, AC-7, AC-11). No LLM, no network.
3. **The launcher's signal path** — the existing no-orphan harness in `packages/cli/tests/live-sim-budget.test.ts` extends naturally to AC-6: interrupt the wrapper and assert the summary is still present afterwards.
4. **Docs** — a guard test asserting the corrected statements exist and the stale unconditional claim does not (AC-8). Precedent: the ADR-003 scope guard already tests documentation claims.

## Design Decisions

1. **Sink the samples, not the whole world.** Agent memories and conversation transcripts are *in-process* state whose persistence is spec 017 territory and a larger product decision; the samples are the artifact the System-1 head already consumes, contain `memoryWritten` / `conversationContinued` per tick, and are what ADR-0002 defines as the thing that improves over time. Persisting the memory store itself is deliberately **out of scope** and needs its own spec — recorded here so the gap is visible rather than assumed handled.
2. **The guard belongs in the launcher, not in the demo.** The demo should do the right thing by default (default `session-logs`); the launcher is where a *spending* run is admitted, so the refusal to start without evidence belongs with the other spending controls (#269's budget and model banner).
3. **Refuse rather than warn by default.** The measured failure was silent: nothing about a 16 h run announced that it could not be evaluated. A warning would have been skimmed; a refusal with a one-flag override is what makes "nothing runs without learning from it" true rather than aspirational.
4. **Summaries are run output beside samples.** Not in the repository tree, not in CI, not in YAAM: a run's evidence belongs with the run's data.
5. **Summary on signal, not only on clean exit.** The launcher's whole purpose is that a run may be *paused* indefinitely, so a summary that requires a graceful exit would be missing exactly when someone stops a long run by hand.

## Out of Scope

- Persisting the agent **memory store** or conversation transcripts across process restarts (spec 017 persistence; its own spec — see Decision 1).
- Changing the sample schema, the System-1 head, or `scripts/dream-update.mts`.
- The visualizer's rendering, the budget/model guard from #269 (already shipped), or AC-9/AC-12 of spec 063.
- Retention policy for old `session-logs/` trees (there are 107 files from earlier runs; nothing here deletes or prunes them).
- Anything about the cost of LLM calls themselves — this spec only ensures that when cost is spent, evidence is produced.

## Notes

- **How this was found.** By asking the plain question "did anything evolve out of that simulation?" and then checking, rather than assuming. The answer required mining a 46 MB log by hand — which is itself the defect this spec fixes.
- **The archived evidence**: `~/.local/share/evol-hive-archive/viz-run-16h-2026-09-26.log.gz` (2.4 MB from 46 MB) is the only surviving record of that run and the measurement source for the tables above. It is out of the repository deliberately (run output, and the repo is public).
- **A wrong turn worth recording.** The first version of this investigation asserted "no door state exists" style conclusions twice more in this arc — a stale read and a wrong-grep symbol — so the numbers here come from re-checked greps, and `sessionLogDir` (camelCase) was grepped case-correctly after a hyphenated pattern missed it.
- **Evidence for this spec lives in** `docs/specs/notes/067-*-notes.md` per ADR-003.
