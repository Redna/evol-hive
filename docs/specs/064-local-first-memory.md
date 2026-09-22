# Feature: Local-First Memory — Retire YAAM from CI, Make the Repo the Handoff

## Context

- Architecture: [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (the **in-engine** dual-track memory — unrelated to this spec and untouched), [§2 — System Overview](../architecture/02-system-overview.md)
- Related specs: [030 — Dynamic Scenes, Living Worlds](030-dynamic-scenes-living-worlds.md) (Req 12, the engine's YAAM-format **dormancy log** — explicitly out of scope, see Constraints). Precedent for CI-policy tests under `packages/cli/tests/`: the #217 docs-only QA gate and the #221 stale-marker guard.
- Operational docs: [DELIVERY_PROCEDURE.md](../DELIVERY_PROCEDURE.md), [MEMORY_PIPELINE.md](../MEMORY_PIPELINE.md), [AGENT_TEAM_SETUP.md](../AGENT_TEAM_SETUP.md)
- Package: none. This is a **CI / agent-prompt / docs / scripts** change. No `packages/*/src` file may be modified.
- Issue: [#221](https://github.com/Redna/evol-hive/issues/221)
- Status: 📝 Drafted

## Problem Summary

`DELIVERY_PROCEDURE.md` already states the operating model — _"Memory | Local YAAM | durable notes/workspaces (the handoff channel); regenerable code topology"_ and _"Intellectual work | Local legs"_. **The CI wiring contradicts that document.** Five agent workflows (`architect`, `developer`, `doctor`, `qa`, `responder`) cache the YAAM binary and embedding models, `restore-memory.sh` at startup, and `save-memory.sh` at teardown; a sixth workflow (`compaction.yml`) runs a compactor bot on a 6-hour cron against the `memory` branch. This spec makes CI conform to the model already written down.

### What CI is actually putting in that log (measured 2026-09-22)

```
124,558 link events  →  REFERENCES       98,006   (78.7%)   code graph
                        CALLS            11,285
                        IMPORTS           7,002
                        DECLARED_IN       5,419
                        MAPPED_TO         2,695
                        HAS_SCRATCHPAD       50   (0.04%)  knowledge
 5,945 node upserts  →  Entity            5,635   (94.8%)   code graph
                        Scratchpad           53   (0.9%)   knowledge
```

The cross-agent payload is **50 links out of 124,558 — 0.04%**. The rest is a code graph that CI **already has in its checkout** and re-derives on every run, stored as a **41.6 MB** compressed blob on a branch humans cannot review, diff, or merge.

Cost is _not_ wall-clock — the memory steps measure `Cache 2.0s / Restore 2.0s / Save 6.0s` (≈10 s per run). **The problem is what is shared, and who writes it.**

### The multi-writer damage is structural, not a bug to patch

| defect                | measurement                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| mixed timestamp units | 6,121 events in **seconds**, 124,382 in **ms** → recency weighting off by 1000×                                       |
| note-id conventions   | 5+ schemes coexist (`note_<ms>`, `note_<s>`, `note_<ms>_<rand>`, `note_qa_<spec>_<ms>_<i>`, `scratchpad:<ws>:note-N`) |
| compaction counter    | `103,616` reported **28×**; also impossible values (2.5M / 3.1M / 3.7M) against an actual 130,503                     |
| link churn            | 95.4% of all events                                                                                                   |

Every one traces to _many writers appending to one log_ — a local daemon, five workflows, and a compactor bot, with a lock protocol and delta artifacts existing to referee collisions. The read path never closed either: agents → local session required `restore-memory.sh`, which **has never run on the development box**.

### Meanwhile the repo already carries the handoff

`docs/specs/notes/` holds **45** files — **21** `qa-notes`, **10** `implementation-notes`, **8** `design-notes`, **3** `qa-verification-notes`. The note-file handoff (design → implementation → qa) is already the dominant practice, is committed with the PR, is reviewable, and is reachable by a session's ordinary file tools. It needs formalising, not replacing.

## Requirements

### R1 — No memory machinery in CI

- The five agent workflows (`architect`, `developer`, `doctor`, `qa`, `responder`) MUST NOT invoke `scripts/restore-memory.sh` or `scripts/save-memory.sh`, and MUST NOT cache `~/.yaam-cache` or `~/.yaam/models`.
- No workflow may add a YAAM binary/model download or a memory restore/save step.

### R2 — The repo is the handoff channel

- Every agent prompt that names a YAAM tool or scratchpad is rewritten to use committed notes — in `.pi/agents/`: `qa-tester.md`, `developer.md`, `responder.md`, `architect.md`, `doctor.md`, `overseer.md`; in `.pi/tasks/`: `implement.md`, `draft-spec.md`, `continue.md`, `qa-verify.md`, `diagnose.md`; plus the inline prompt in `.github/workflows/responder.yml` ("Use YAAM search and graph explore…").
- The handoff convention is explicit and documented: `docs/specs/notes/NNN-<topic>-design-notes.md` (architect) → `-implementation-notes.md` (developer) → `-qa-notes.md` (QA). The next leg reads the previous leg's file **from the branch/PR**, not from a memory daemon.
- Prompts must not instruct an agent to call `yaam_search` / `yaam_graph_explore`; code discovery is `rg` / `read` over the checkout.

### R3 — Compaction stops; the branch is frozen, not deleted

- `.github/workflows/compaction.yml` is disabled: no `schedule:` cron, no compaction steps. No bot may write further commits to `refs/heads/memory`.
- `origin/memory` is **retained as history** and must not be deleted or rewritten by this change.

### R4 — Local YAAM is untouched and stays useful

- `scripts/restore-memory.sh` and `scripts/save-memory.sh` remain in the repo for **local, manual, opt-in** use; the local daemon, `yaam_search`, `yaam_graph_explore` and workspace/scratchpad notes keep working for interactive sessions.
- Nothing about `packages/memory` (in-engine retrieval), the engine's spec-030 dormancy log, or the local daemon's configuration changes.

### R5 — Documentation tells the truth

- `DELIVERY_PROCEDURE.md`'s identity/memory table and leg-packet `memory:` field are updated so no stage instructs a CI agent to use YAAM; the memory row keeps "local" and gains where the handoff actually lives.
- `AGENT_TEAM_SETUP.md` and `MEMORY_PIPELINE.md` are corrected where they describe CI memory.
- An ADR records the decision and what it supersedes.

### R6 — A regression guard

- A CI-policy test (following the spec-217 / spec-221 precedent of tests under `packages/cli/tests/`) fails if any workflow reintroduces the memory scripts / YAAM caches, if `compaction.yml` regains a cron trigger, or if a CI agent prompt instructs the use of a YAAM tool.

## Acceptance Criteria

- [ ] **AC-1** — `grep -rn "restore-memory.sh\|save-memory.sh" .github/workflows/` returns **no** matches, and no workflow references `~/.yaam-cache` or `~/.yaam/models`.
- [ ] **AC-2** — `.github/workflows/compaction.yml` has no `schedule:` trigger and no compaction run step; `grep -c "cron" .github/workflows/compaction.yml` is 0.
- [ ] **AC-3** — No file under `.pi/agents/` or `.pi/tasks/` contains an instruction to call `yaam_search` / `yaam_graph_explore` or to "record in YAAM".
- [ ] **AC-4** — `.github/workflows/responder.yml`'s inline prompt instructs reading repo docs/spec notes rather than YAAM.
- [ ] **AC-5** — The design → implementation → qa notes-file convention is stated in `DELIVERY_PROCEDURE.md` and referenced by the agent prompts that previously used YAAM notes.
- [ ] **AC-6** — The R6 guard test exists, covers AC-1/AC-2/AC-3, and **fails** when a memory step is re-added to a workflow (verified red before green).
- [ ] **AC-7** — No `packages/*/src` file is modified (`git diff --name-only` touches no path under `packages/*/src`), and the engine's spec-030 YAAM dormancy tests still pass unchanged.
- [ ] **AC-8** — `origin/memory` still exists, and its tip is unchanged by this work (`git ls-remote origin memory` equals the pre-change value).

## Constraints

- **Package boundaries**: only `.github/`, `.pi/`, `docs/`, `scripts/` (and a test under `packages/cli/tests/`) may change. `packages/*/src` MUST NOT change.
- **Out of scope — do not touch**: the engine's dormancy persistence (`packages/engine/src/world/mutations/yaam-event-log.ts`, `scene-mutation-service.ts`, spec 030 Req 12), `packages/memory`, the local daemon's config and `scripts/run-compaction.sh`/`compact.js` (they stay for local use), and any hosted/multi-agent memory redesign. Two different things share the name "YAAM" — this spec removes neither from the codebase, only from CI.
- **No new dependencies.** No secrets, hostnames, paths or environment values committed.
- **Do not delete or rewrite `origin/memory`.** Freeze only; history is retained.
- Do not edit `dist/` or generated `.d.ts`.
- The measured numbers in this spec are evidence, not requirements — do not encode counts into tests.

## Test Seams

Agreed surface, following the spec-217 / spec-221 precedent:

1. **`packages/cli/tests/spec-064-ci-memory-scope.test.ts`** — parses `.github/workflows/*.yml` and `.pi/{agents,tasks}/*.md` and asserts AC-1/R2/R3. This is the primary seam: red first (add a memory step, watch it fail), then green.
2. **Existing suites stay green**, notably `packages/cli/tests/spec-221-stale-marker-guard-e2e.test.ts` (proves the local scripts still work) and `packages/engine/tests/spec-030-yaam-events.test.ts` (proves the dormancy log is untouched).

## Out of Scope

- Deleting the `memory` branch or purging its history.
- Any change to `packages/memory`, the engine's dormancy log, or the local daemon.
- Hosted / multi-agent memory (if ever wanted, it needs a service, not a git branch with a compaction bot).
- Fixing the logged defects (timestamp-unit split, compaction counter, note-id drift). Once CI stops writing, those stop growing; repairing historical data is not required.
