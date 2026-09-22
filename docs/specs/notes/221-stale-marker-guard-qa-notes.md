# Issue #221 fault 3 QA Notes — Stale YAAM Marker Guard (PR #240)

> QA coverage verification for PR [#240](https://github.com/Redna/evol-hive/pull/240)
> (`221-stale-marker-guard`), which closes **fault 3** of issue
> [#221](https://github.com/Redna/evol-hive/issues/221). **There is no spec
> document for this change** — the reference acceptance criteria are the seven
> *draft* ACs in the issue body. The PR explicitly scopes itself to fault 3 plus
> the AC-7 diagnostic; faults 1 (CI note emission) and 2 (`LINK_NODES` churn)
> are untouched.

> YAAM tooling note: the `yaam_*` pi tools were **not exposed in this session**
> (only `read`/`write`/`edit`/`bash`). The daemon *was* reachable via the raw
> TCP JSON-RPC port in `.yaam/daemon.port` (method `search`), and a Scratchpad
> note was appended via `upsert_node`/`link_nodes` — the same shape
> `yaam_workspace_append_note` uses. This markdown file is the durable record
> (per `217-…-qa-notes.md`, `061-…-qa-verification-notes.md`).

## Verdict

The change does exactly what it claims: a marker *newer* than the store
(store reset/replaced after a restore) is no longer a silent, exit-0 no-op. It
fails loudly with a grep-able reason, re-baselines the marker so the next save
is correct, and skips only that run instead of pushing a wrong slice. The AC-7
diagnostics are emitted on both save paths and on restore. **All gates pass.**
QA added **14 tests** in one new `packages/cli/tests/` file, executing the real
shell scripts against throwaway git repos and a bare remote.

The issue's other draft ACs (AC-1, AC-4, AC-5, AC-6) are out of scope for this
PR and remain **open gaps**, as does the literal "path consistency" wording of
AC-3 (see below). This matches the PR's stated scope.

## Coverage map (issue #221 draft AC → tests)

| AC | Status | Evidence |
| --- | --- | --- |
| **AC-2** — `save-memory.sh` pushes a **non-empty** delta (`NEW_LINES > 0` asserted), artifact on `memory` branch contains it | ✅ in-repo | **QA added** `spec-221-stale-marker-guard-e2e.test.ts`: a sandbox repo with a bare `origin` and an existing `memory` branch, 4 existing + 2 new lines → asserts `[yaam] saving=2 start=4 current=6`, `Memory pushed successfully.`, `[yaam] saved=2 run=…`, and that `memory:events-22101.jsonl` contains **exactly** `l5\nl6` (not `l1`/`old1` — the wrong-slice failure mode). A second test asserts **no** delta file is pushed when the store has no new events. **Gap:** the AC also says "the artifact … contains it *after compaction*"; compaction (`scripts/compact.js`, `.github/workflows/compaction.yml`) is explicitly out of this PR's scope (fault 2) and is not covered here. |
| **AC-3** — path/store consistency mismatch fails loudly instead of silently saving nothing | ⚠️ partial | The concrete failure the issue measured is the stale marker (`start=5,613,661` vs `current=807`), and that path is now loud + self-healing: **QA added** the stale-marker test (reason, `STALE MARKER`, re-baseline to `current`, no push) and the self-heal test (second run → `no-new-events`). **Gap:** the AC's literal wording — "the extension's `events.jsonl` location and the restore/save scripts' location are the same file" — is *not* asserted by the PR; there is still no check that the daemon writes to the file the scripts read. That is hypothesis 2 in the issue and remains untested. |
| **AC-7** — one grep-able `[yaam] restored=<n> saved=<m>` diagnostic per run | ✅ in-repo | `save`: `[yaam] saved=<n> reason=<stale-marker\|no-new-events>` / `[yaam] saving=<n>`, `marker-invalid`, and the trailing `[yaam] saved=<n> run=<id>`. `restore`: `[yaam] restored=<n> events size=<size> run=<id>`. **QA added** tests asserting each exact line from executions, plus the invalid/empty-marker warning (`...start='<x>' — treating as 0`) and the restore diagnostic; a `bash -n` syntax test guards both scripts. |
| AC-1 — one local leg session writes a durable Scratchpad note | ⛔ out of scope | Not this PR (it is #215's first task). No test written. |
| AC-4 — compaction retention explicit + unchanged-base rewrite skipped | ⛔ out of scope | Fault 2; `compact.js`/`compaction.yml` untouched. No test written. |
| AC-5 — lock-poll in every save removed or bounded | ⛔ out of scope | Untouched by this PR. The unbounded `while git ls-tree … ; sleep 15` loops remain. No test written. |
| AC-6 — the role decision (keep YAAM vs retire) is recorded | ⛔ out of scope | A process decision, not implementable/testable here. No test written. |

## Tests added

`packages/cli/tests/spec-221-stale-marker-guard-e2e.test.ts` — **14 tests**,
all executing the real `scripts/save-memory.sh` / `scripts/restore-memory.sh`
(no re-implementation) in `mkdtemp` sandboxes; every temp repo/worktree is
removed in `afterAll`:

**Fault 3 / stale marker (5)**

1. Stale marker (`start=999 > current=3`) exits 0, prints
   `reason=stale-marker`, `STALE MARKER`, re-baselines the marker to `3`, and
   pushes nothing (the old `No new events to save.` string is gone).
2. Self-heal: a second run reports `reason=no-new-events`, not stale.
3. Rejects a non-numeric marker — warns `marker-invalid start='not-a-number'`,
   treats it as 0.
4. Rejects an empty marker file — warns `marker-invalid start=''`.
5. An empty delta keeps the quiet `no-new-events` path (no false alarm).

**AC-2 — delta reaches the memory branch (2)**

6. End-to-end push: exactly the new lines land as the delta artifact, `saved=2`
   reported.
7. No-new-events run pushes no delta file.

**AC-7 — restore diagnostic + round trip (3)**

8. Restore of a gzip base reports `[yaam] restored=5 events size=… run=…`,
   re-baselines the marker, and replaces a stale local store.
9. Restore merges a gzip base with a delta in chronological order and cleans
   the delta files from the workspace.
10. Restore → save round trip reports `no-new-events`, not a stale false
    positive.

**Script hygiene (4)**

11–12. `bash -n` clean on both scripts.
13. Save diagnostic reason taxonomy present in source.
14. Restore diagnostic present in source.

## Gate results

`pnpm build` was run first (examples-reaching tests resolve built `dist/` per
`AGENTS.md`), then:

- `pnpm test` — **exit 0**, all 8 projects green:
  | package | tests |
  | --- | --- |
  | shared | 399 passed |
  | memory | 101 passed (+24 todo) |
  | visualizer | 92 passed |
  | engine | 922 passed (+141 todo) |
  | cognition | 1242 passed (+1 skipped, +26 todo) |
  | assembly | 89 passed |
  | examples | 253 passed (+3 todo) |
  | **cli** | **38 passed (was 24; +14 QA)** |
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.

## Gaps / observations for the reviewer

1. **AC-3 literal gap.** The PR fixes the *symptom* of a stale marker but does
   not assert path identity between the daemon's `events.jsonl` and the
   scripts' file. If the daemon ever writes elsewhere, the scripts still cannot
   tell (the marker simply never advances). Recommend narrowing AC-3 to the
   stale-marker condition actually fixed, or filing a follow-up for the
   daemon/script path assertion.
2. **AC-2 "after compaction" clause.** The delta artifact is asserted on the
   `memory` branch, but survival through `compact.js` is not covered; that is
   fault 2 and remains open.
3. **Faults 1 and 2 stay open.** The issue's core symptom (19 identical-count
   compaction cycles, empty deltas from CI) is not addressed by this PR; the
   stale-marker guard only makes one class of silent failure loud.
4. **`restore-memory.sh` trailing newline.** The diff adds a diagnostic but the
   file still lacks a trailing newline (pre-existing; `bash -n` clean). Cosmetic.
5. **No spec document.** #221 is a bug/observability change; the seven draft
   ACs in the issue are the only criteria and remain *draft*.
