# PR #248 QA notes — the CI-only YAAM branch-sync toolchain is deleted (ADR-003 follow-up)

**PR:** [#248](https://github.com/Redna/evol-hive/pull/248) — `ci: delete the CI-only YAAM branch-sync toolchain (ADR-003 follow-up)`
**Branch:** `adr/003-drop-ci-memory-toolchain`
**Reference contract:** [ADR-003](../adr/0003-memory-is-local-ci-runs-none.md) decision 4 (as corrected by this PR) plus the PR body's knock-on claims. **Spec:** none — harness change recorded as an ADR, not an app feature (same precedent as #247).

## Verdict

The correction is sound. ADR-003 decision 4 previously said the three branch-sync
shell scripts "remain in the repo for local use"; this PR established that
nothing in the repo, docs or skills ever instructed a human to run them, so they
are dead code and are deleted with their callers. The developer inverted its
guard (`adr-003-ci-memory-scope.test.ts`) to assert absence instead of presence.

QA found the PR's **non-ADR claims unguarded** — the two Python helpers, the
`pipeline.sh` Phase 6 removal, the deleted `spec-221` e2e, a real
`git check-ignore` on the replay backups, the "in-engine memory unchanged"
clause, and the "no dangling reference" claim — and added **21 tests** in one new
file. All testable criteria are covered. The only residual gap is the remote
`origin/memory` branch itself, which no in-repo test can observe (also a gap in
the #247 QA pass).

Full suite green: **3193 passed, 0 failed** across 8 packages (plus 194 todo,
1 skipped, 260 files). `pnpm typecheck` and `pnpm lint` clean. No
`packages/*/src` change.

## Acceptance criteria (ADR-003 decision 4 + PR body → tests)

| # | Contract | Test(s) | Status |
| --- | --- | --- | --- |
| D1 | Five agent workflows no longer cache YAAM / restore / save memory | `adr-003-ci-memory-scope.test.ts` `neither restores nor saves memory` (×5) · QA `workflow bodies carry no YAAM at all` (×5) | ✅ covered |
| D1b | `bootstrap-agent.sh` installs no YAAM | `adr-003-ci-memory-scope.test.ts` `CI bootstrap installs no YAAM` | ✅ covered |
| D2 | `.github/workflows/compaction.yml` deleted | `adr-003-ci-memory-scope.test.ts` `compaction workflow is gone` | ✅ covered |
| D3 | Prompts carry no YAAM tool/note instruction and all name `docs/specs/notes` | developer guard + QA `every prompt names the committed-notes channel` (11 prompts) | ✅ covered |
| D4a | The five branch-sync scripts (`restore/save/run-compaction`, `compact.js`, `compact-stream.js`) are deleted | developer guard `is deleted` (×5) | ✅ covered |
| D4b | Nothing left in `scripts/` drives the `memory` branch | developer guard `nothing left in scripts/ drives the memory branch` | ✅ covered |
| D4c | `analyze-memory.py` / `analyze-entities.py` deleted | **QA added** `…is deleted` (×2) | ✅ covered |
| D4d | No script re-introduces an operator-home absolute path | **QA added** `no script leaks an operator-home absolute path again` | ✅ covered |
| D5 | `origin/memory` frozen, not deleted; history not rewritten | QA #247 `no workflow or script deletes or force-pushes the memory branch` + ADR text | ⚠️ partial — remote ref unobservable in-repo |
| D6 | `pipeline.sh` Phase 6 removed, Phases 1–5 intact, `bash -n` clean | **QA added** `still syntactically valid bash` · `keeps the … phase header` (×5) · `does not run or reference the deleted compaction phase` | ✅ covered |
| D7 | `spec-221-stale-marker-guard-e2e.test.ts` deleted with its scripts | **QA added** `spec-221-… is deleted` | ✅ covered |
| D8 | `events.jsonl.bak*` stays ignored — replay backups included | developer pattern test + **QA added** `git check-ignore …` · `daemon log itself stays ignored` | ✅ covered |
| D9 | In-engine memory the ADR calls "unchanged" survives (`packages/memory`, engine dormancy log) | **QA added** existence (×2) | ✅ covered |
| D10 | No live reference to any deleted file (workflows, scripts, top-level prompts) | **QA added** `no workflow, script or top-level prompt names a deleted toolchain file` | ✅ covered |

**14 of 15 testable criteria fully covered; 1 partial (D5).**

## Why the developer's inverted guard was not enough

The developer's guard is correct on its own terms — it locks the five shell/JS
scripts and the memory-branch property. Six claims in the PR body were outside
it:

1. **The Python helpers were not in the ADR's five-script list.** `analyze-memory.py`
   and `analyze-entities.py` were deleted for a *different* reason (unreferenced,
   and they hardcoded an operator home directory in a public repo), so the
   `scripts/` memory-branch regex does not name them. A re-add would pass the
   developer's guard.
2. **`pipeline.sh` Phase 6 was only indirectly covered.** The memory-branch regex
   happens to match a `run-compaction` call, but nothing asserted the phase header
   is gone, that Phases 1–5 survive, or that the script is still valid bash.
3. **The deleted e2e test had no guard.** `spec-221-stale-marker-guard-e2e.test.ts`
   is the one file the PR's "no code to guard issue #221" argument rests on.
4. **The `.gitignore` assertion was a substring match, not behaviour.** It proved
   the pattern text exists, not that `git` ignores `events.jsonl.bak<date>`.
5. **"Local memory is unaffected" / "unchanged" was not guarded at all.**
6. **"No dangling references" was a manual verification.** No test scanned the
   live automation surfaces for the deleted basenames.

## Tests added

`packages/cli/tests/adr-003-drop-toolchain-qa.test.ts` — 21 tests in 5 blocks:

1. **Wholesale deletion** — each of the 7 deleted files is absent (5 shell/JS,
   2 Python), plus a scan of every file under `scripts/` for a `/home/<user>/`
   absolute path (the anti-pattern that motivated the Python deletion).
   **Red-first verified**: restoring `scripts/analyze-memory.py` with
   `events_file = "/home/anima/events.jsonl"` fails both the `is deleted` and
   the operator-home tests (2 failed / 19 passed), then green after removal.
2. **`pipeline.sh` Phase 6** — `bash -n` exits 0; the Phase 1–5 headers are
   present; and `PHASE 6`, `Memory Compaction`, `run-compaction`,
   `refs/remotes/origin/memory`, `origin memory:` are all absent.
3. **`spec-221` e2e** — deleted.
4. **Replay backups really ignored** — `git check-ignore -v` on
   `events.jsonl.bak`, `events.jsonl.bak.2026-09-22`, `events.jsonl.bak.old`
   succeeds (all resolved to `.gitignore:47:events.jsonl.bak*`), and
   `events.jsonl` itself stays ignored.
5. **In-engine memory untouched** — `packages/memory/src/index.ts` and
   `packages/engine/src/world/mutations/yaam-event-log.ts` exist.
6. **No live reference** — no `.github/workflows/*.yml`, `scripts/*` file, or
   top-level `.pi/agents|tasks/*.md` prompt contains any deleted basename.

The new file is a static policy test, following the
`spec-217-docs-only-qa-gate.test.ts` / `adr-003-*` precedent. It reads the repo
only and never touches `dist/`.

## Test results

| Package | Test files | Tests |
| --- | --- | --- |
| shared | 34 | 399 passed |
| memory | 13 | 101 passed (+24 todo) |
| visualizer | 14 | 93 passed |
| engine | 75 | 922 passed (+141 todo) |
| cognition | 80 | 1242 passed (1 skipped, 26 todo) |
| assembly | 11 | 89 passed |
| examples | 23 | 253 passed (+3 todo) |
| cli | 10 | 94 passed (was 73; +21 QA) |
| **Total** | **260** | **3193 passed, 0 failed** |

- `pnpm test` — exit 0.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.
- `pnpm build` was run before the suite so the `packages/cli` `cli.test.ts`
  invocations resolve workspace packages to fresh `dist/` (per `AGENTS.md`).

## Gaps / non-gaps / observations

- **D5 remote ref (partial, carried over from #247).** In-repo automation is
  guarded against deleting or force-pushing `memory`, but the remote branch
  itself is not observable from a test. A human through the GitHub UI, or a
  one-off unpushed `git push --delete`, is outside any in-repo guard. Recorded,
  not asserted.
- **Docs deliberately still name the deleted scripts.** `docs/MEMORY_PIPELINE.md`
  carries a banner saying the pipeline is retired and the scripts now deleted;
  `docs/AGENT_TEAM_SETUP.md` strikes the references through. These are historical
  records, not dangling references — the D10 scan is scoped to live automation
  and prompts and excludes `docs/`, `docs/adr/` and `docs/specs/notes/`.
- **Stale comments in the #247 QA guard (documentation drift, not a failure).**
  `adr-003-ci-memory-scope-qa.test.ts` still describes the deleted scripts as
  "retained local scripts" and its `automationFiles()` helper as "CI workflows
  plus local scripts". The assertions remain valid (they only scan `.sh` files
  and match rewrite patterns, none of which survive), so this does not fail.
  Flagged for the author; QA did not edit the existing test per the
  add-only rule.
- **#247 QA notes are superseded on one row.** `adr-003-ci-memory-local-first-qa-notes.md`
  records D4 as "Local YAAM path preserved (existence)". This PR inverts that
  decision; this file is the superseding record for D4.
- **Issue #221 should be closed (process finding).** With the scripts and their
  e2e test gone, #221 has no code to guard: fault 3 was fixed in #240 and faults
  1–2 were CI-only symptoms retired by ADR-003. #221 already carries
  `Status: In Review/QA`.
- **No `dist/`, `session-logs*/`, `app.env`, key material or generated artifact is
  committed.** Only the new test file and this note are added.

## Verification provenance

- Red-first check performed on a temporary `scripts/analyze-memory.py` and
  removed; `git status` clean before committing.
- `pnpm build` run first (workspace packages resolve to `dist/`).
- The committed change is test-only plus this note; no `packages/*/src` or
  `scripts/` file was modified.
