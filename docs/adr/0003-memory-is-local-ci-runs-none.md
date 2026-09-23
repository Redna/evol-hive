# ADR-003: Memory Is Local — CI Runs No Memory Machinery, the Repo Is the Agent Handoff

## Status

**Accepted** (2026-09-22). Supersedes the CI-facing half of the `Memory` row in
[DELIVERY_PROCEDURE.md](../DELIVERY_PROCEDURE.md); the local half stands.

## Context

`DELIVERY_PROCEDURE.md` already declared the operating model:

```
| Memory | Local YAAM | durable notes/workspaces (the handoff channel); regenerable code topology |
```

CI contradicted that document. Five agent workflows (`architect`, `developer`,
`doctor`, `qa`, `responder`) cached the YAAM binary and embedding models,
ran `scripts/restore-memory.sh` at startup and `scripts/save-memory.sh` at
teardown; `scripts/bootstrap-agent.sh` installed YAAM on the runner; and a sixth
workflow (`compaction.yml`) ran a compactor bot on a 6-hour cron against the
`memory` branch.

Measured on 2026-09-22, of the shared log:

```
124,558 link events  →  REFERENCES       98,006   (78.7%)   code graph
                        HAS_SCRATCHPAD       50   (0.04%)  knowledge
 5,945 node upserts  →  Entity            5,635   (94.8%)   code graph
                        Scratchpad           53   (0.9%)   knowledge
```

so the cross-agent payload was **50 links of 124,558**, stored as a **41.6 MB**
compressed blob on a branch that cannot be reviewed or diffed. The remainder is a
code graph CI already holds in its checkout and re-derived every run. Wall-clock
cost was small (≈10 s/run), so the objection was never run time — it was **what
was shared, and who wrote it**.

Because a local daemon, five workflows and a compactor bot all appended to one
log, the defects were structural rather than patchable:

- mixed timestamp units — 6,121 events in **seconds** vs 124,382 in **ms**
  (recency weighting off by 1000× for one population);
- 5+ note-id conventions coexisting;
- a compaction counter reporting `103,616` **28×**, plus physically impossible
  values (2.5M / 3.1M / 3.7M) against an actual 130,503;
- 95.4% of all events being `LINK_NODES`.

The read path never closed either: agents → local session required
`restore-memory.sh`, which had never been run on the development box.

Meanwhile the repository already carried the handoff: `docs/specs/notes/` holds
45 files — 21 `qa-notes`, 10 `implementation-notes`, 8 `design-notes`,
3 `qa-verification-notes`.

## Decision

**CI runs no memory machinery. The repository is the agent handoff channel.**

1. The five agent workflows no longer cache YAAM, restore memory, or save memory.
   `scripts/bootstrap-agent.sh` no longer installs it.
2. `.github/workflows/compaction.yml` is deleted — with CI no longer writing,
   there are no deltas to compact.
3. The agent prompts (`.pi/agents/*.md`, `.pi/tasks/*.md`, and the inline prompt
   in `responder.yml`) direct agents to committed notes instead of YAAM
   scratchpads. The handoff convention is explicit and file-based:

   ```
   docs/specs/notes/NNN-<topic>-design-notes.md          (architect)
   docs/specs/notes/NNN-<topic>-implementation-notes.md  (developer)
   docs/specs/notes/NNN-<topic>-qa-notes.md              (QA)
   ```

   Each leg reads the previous leg's file from the branch/PR — reviewable,
   diffable, and reachable with ordinary file tools.
4. **The branch-sync toolchain is deleted.** `scripts/restore-memory.sh`,
   `scripts/save-memory.sh`, `scripts/run-compaction.sh`, `scripts/compact.js`
   and `scripts/compact-stream.js` existed only to move `events.jsonl` through
   the `memory` branch for GitHub Actions. With CI out of the memory business
   they have no caller — nothing in the repo, the docs or the skills instructed
   a human to run them — so they are removed rather than kept as vestigial
   "local" tooling. **Local memory is unaffected**: the daemon reads and appends
   `events.jsonl` directly, with no branch sync. `packages/memory` (in-engine
   retrieval) and the engine's dormancy log are untouched.
5. `origin/memory` is **deleted** (tip `3c20d804…`, a 41.6 MB blob). CI no longer
   writes it and the tooling that read it is gone, so an unreviewable binary on a
   branch nobody could diff bought nothing. The final contents were archived
   out-of-repo before deletion, and the tip SHA is recorded here, so the branch
   stays recoverable while GitHub retains the objects — nothing in the repo
   depends on it (a guard test asserts no script drives the branch).

## Consequences

**Gained.** One writer per log, so the class of defects above cannot recur.
Nothing to compact, so the bot, the lock protocol and the delta artifacts go
away. The handoff becomes reviewable and versioned with the change it describes.
CI stops storing a 41.6 MB derivative of content it already has. Roughly 1,500
lines of branch-sync tooling (five shell/JS scripts, their e2e test, and
`pipeline.sh`'s Phase 6) leave the repo, along with two unreferenced analysis
scripts that hardcoded an operator's home directory.

**Given up.** Semantic search over CI agents' notes *from inside CI* — those
agents read the notes files instead. A single cross-run audit trail of agent
activity — PRs, review comments and commits already provide one. And the
`memory` archive is gone from the repo: the branch was deleted rather than left
frozen, so recovering that history now rests on the out-of-repo archive instead
of on `git fetch`.

**Unchanged.** The engine's dormancy persistence
(`packages/engine/src/world/mutations/yaam-event-log.ts`, spec 030 Req 12) is a
*different mechanism that shares the name*: it persists despawned NPC state in
YAAM's event format through the in-engine memory pipeline. It is not CI memory
and is untouched. `packages/memory` (the in-engine dual-track retrieval) is
likewise untouched.

## Notes

If hosted, multi-agent memory is ever wanted, it needs a service with a real
read path — not a git branch with a compaction bot. This ADR does not foreclose
that; it stops pretending the current arrangement is it.
