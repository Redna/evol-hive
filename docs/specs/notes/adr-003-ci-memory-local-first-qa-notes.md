# PR #247 QA notes — CI retires YAAM; committed notes become the handoff (ADR-003)

**PR:** [#247](https://github.com/Redna/evol-hive/pull/247) — `ci: retire YAAM from CI — local-first memory, committed notes as the handoff (ADR-003)`
**Branch:** `adr/003-ci-memory-local-first`
**Reference contract:** [ADR-003](../adr/0003-memory-is-local-ci-runs-none.md)
**Spec:** none — this is a harness change recorded as an ADR, not an app feature
(`docs/specs/` is the feature ledger; ADR-0001/0002 set the precedent). The ADR's
five numbered decisions are the acceptance criteria.

## Verdict

The change is coherent and the developer's guard (`adr-003-ci-memory-scope.test.ts`,
16 tests) locks most of it. QA found **three decisions only partially guarded**
and added **19 tests** in one new file. All 5 ADR decisions are now covered to
the extent the repo can cover them; the only residual gap is the remote
`origin/memory` branch itself, which no in-repo test can observe.

Full suite green: **3182 passed**, 0 failed across 8 packages (plus 194 todo, 1
skipped). `pnpm typecheck` and `pnpm lint` clean. No `packages/*/src` change.

## Acceptance criteria (ADR-003 decisions → tests)

| # | ADR-003 decision | Test(s) | Status |
| --- | --- | --- | --- |
| D1 | Five agent workflows no longer cache YAAM/restore/save memory | `adr-003…test.ts` — `neither restores nor saves memory` (×5) | ✅ covered |
| D1b | `bootstrap-agent.sh` no longer installs YAAM | `adr-003…test.ts` — `CI bootstrap installs no YAAM` | ✅ covered |
| D2 | `.github/workflows/compaction.yml` deleted | `adr-003…test.ts` — `compaction workflow is gone` | ✅ covered |
| D3a | Prompts (agents, top-level tasks, **and the `responder.yml` inline prompt**) no longer call YAAM tools / write YAAM notes | `adr-003…test.ts` — prompt scan (agents + tasks) · **QA added** `workflow bodies carry no YAAM at all` (all `yaam` absent from the 5 workflow files, inline `run:` prose included) | ✅ covered |
| D3b | Every prompt names the committed-notes handoff channel | `adr-003…test.ts` — `it.each` names 5 files · **QA added** `every prompt names the committed-notes channel` (all 6 agents + 5 top-level tasks contain `docs/specs/notes`) | ✅ covered |
| D4 | Local YAAM path preserved (`restore-memory.sh`, `save-memory.sh`, `run-compaction.sh`, daemon) | `adr-003…test.ts` — `local path is preserved` (×3) | ✅ covered (existence) |
| D5 | `origin/memory` frozen, not deleted; history not rewritten | **QA added** `no workflow or script deletes or force-pushes the memory branch` + ADR states the decision | ⚠️ partial — in-repo automation guarded; the remote ref itself is not observable here |

7/7 in-repo testable criteria covered; 1 partial (see Gaps).

## Why the developer's file was not enough

The developer's `adr-003…test.ts` guard is good, but three holes were material:

1. **Inline prompt prose slipped the net.** The workflow scan matched only
   `yaam-cache|yaam/models|restore-memory|save-memory` in the step blob and
   `/yaam/i` in the step *name*. The `responder.yml` regression that ADR-003
   explicitly removes — the prose line "Use YAAM search and graph explore" inside
   a `run:` block — matched neither. The natural fix is to assert the five agent
   workflow files contain no `yaam` at all.
2. **Presence was asserted for 5 of 11 prompts.** ADR-003 decision 3 names all of
   `.pi/agents/*.md` and `.pi/tasks/*.md`. Six prompts (`doctor`, `overseer`,
   `responder`, `continue`, `diagnose`, `draft-spec`) named the notes channel but
   were untested.
3. **"Frozen, not deleted" had no guard.** `origin/memory` is retained by
   decision, so automation must be unable to delete or force-push it.

## Tests added

`packages/cli/tests/adr-003-ci-memory-scope-qa.test.ts` — 19 tests:

1. Each of the 5 agent workflows (`architect`, `developer`, `doctor`, `qa`,
   `responder`) contains **no `yaam` reference at all** (whole file, not just
   step names/blobs) — closes the inline-prompt hole. **Red-first verified**:
   restoring `Use YAAM search and graph explore` to `responder.yml` fails this
   test (1 failed / 18 passed), then green after restore.
2. The top-level prompt set is enumerated exactly (6 agents + 5 tasks) so adding
   a prompt without the notes channel is visible.
3. All 11 top-level prompts contain `docs/specs/notes`.
4. ADR-003 is committed and states `CI runs no memory machinery` and
   `frozen, not deleted`.
5. No workflow or script under `.github/workflows/*.yml` / `scripts/*.sh`
   contains a `git push --delete|--force` or `git branch -D` / `update-ref -d`
   referencing `memory`. (`git worktree remove --force` is deliberately not
   matched — it does not touch the remote branch and is used by the retained
   local scripts.)

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
| cli | 10 | 83 passed (was 64; +19 QA, and the developer's 16 are included) |
| **Total** | **260** | **3182 passed, 0 failed** |

- `pnpm test` — exit 0.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.

## Gaps / non-gaps

- **D5 remote ref (partial).** A test can assert that no committed automation
  deletes or force-pushes `memory`, but it cannot observe the remote branch. A
  human deleting `origin/memory` through the GitHub UI, or a one-off unpushed
  command, is outside what any in-repo test can catch. The `git ls-remote`
  check is a live-CI/human action, recorded here rather than asserted.
- **`responder.yml` inline prompt naming the channel (observation, not a bug).**
  The PR body says the inline prompt was converted "→ the committed notes
  convention", but the actual line reads "Read the relevant files in the repo to
  understand the codebase." It no longer points at YAAM (the contractual part of
  D3), and the Responder consumes notes rather than writing them, so QA did not
  assert that it literally names `docs/specs/notes/`. Flagging the wording
  mismatch for the author; no test failure.
- **Local scripts "unchanged".** D4's existence is tested; byte-for-byte
  unchangedness is intentionally not, since the scripts are meant to keep
  evolving for local use. The ADR's guarantee is that they survive, not freeze.
- **Historical `.pi/tasks/<feature>/` records and `.pi/notes/`** still mention
  YAAM as prose. They are history, not instructions, and are out of scope in
  both the developer's guard and this file — matching the stated scope note.
- No `dist/`, `session-logs*/`, `app.env`, key material, or generated artifact is
  committed.

## Verification provenance

- `pnpm build` run before the suite so workspace packages resolve to fresh
  `dist/` (per `AGENTS.md` and the #245 notes).
- Red-first check performed on a temporary edit and reverted; `git diff` clean
  before committing the tests.
