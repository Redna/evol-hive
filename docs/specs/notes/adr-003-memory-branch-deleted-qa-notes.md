# PR #249 QA notes — origin/memory is deleted, and every live doc says so (ADR-003)

**PR:** [#249](https://github.com/Redna/evol-hive/pull/249) — `docs(adr-003): origin/memory is deleted, not frozen`
**Branch:** `docs/adr-003-memory-branch-deleted`
**Reference contract:** [ADR-003](../adr/0003-memory-is-local-ci-runs-none.md) decision 5 (as corrected by this PR) plus the PR body's knock-on doc claims. **Spec:** none — docs/harness change recorded as an ADR, not an app feature (same precedent as #247/#248).

## Verdict

The correction is sound. ADR-003 originally decided the `memory` branch would be **frozen, not deleted**; an operator deleted it, so this PR makes the record match reality and records the tip SHA for recoverability. The developer updated the #247 guard (`adr-003-ci-memory-scope-qa.test.ts`) to assert the ADR says **deleted** and records a tip, and left the "no automation deletes or force-pushes memory" guard untouched — both still hold.

The developer's changed assertions only cover the ADR decision text. The PR body's other claims — the ADR *Given up* paragraph, and the corrections in `AGENT_TEAM_SETUP.md` and `MEMORY_PIPELINE.md` — were unguarded. QA added **11 tests** in one new file that lock all of them, including the *exact* recoverable tip SHA. All in-repo testable criteria are covered; the only residual gap is the remote ref itself, which no in-repo test can observe (unchanged from #247/#248).

Full suite green: **3204 passed, 0 failed** across 8 packages (plus 194 todo, 1 skipped, 261 files). `pnpm typecheck`, `pnpm lint` and `pnpm format:check` clean. No `packages/*/src` change.

## Acceptance criteria (PR body → tests)

| # | Contract | Test(s) | Status |
| --- | --- | --- | --- |
| AC-1 | `origin/memory` deleted (tip `3c20d804`, 41.6 MB) — ref gone | No in-repo test can observe the remote ref; a fresh clone / `git ls-remote` would be network-dependent | ⚠️ not in-repo testable (gap, see below) |
| AC-2a | Recoverability preserved: tip SHA recorded in the ADR | developer `adr-003-ci-memory-scope-qa.test.ts` `records the deletion and the recoverable tip` · **QA added** `decision 5 … pins the exact tip SHA` (`3c20d804`) | ✅ covered |
| AC-2b | Final contents archived **out-of-repo** before deletion | **QA added** `the ADR documents where the contents were archived` (`/out-of-repo/`) | ✅ covered (documented claim) |
| AC-3a | ADR decision 5 now says **deleted**, not frozen, + tip | developer-updated `adr-003-ci-memory-scope-qa.test.ts` + QA `decision 5 …` | ✅ covered |
| AC-3b | ADR *Given up* paragraph corrected — no frozen in-repo archive / "read-only historical artifact"; recovery moved out of `git fetch` | **QA added** `the ADR no longer offers a frozen in-repo archive` | ✅ covered |
| AC-3c | `AGENT_TEAM_SETUP` memory table row marks the branch deleted/retired | **QA added** `the YAAM memory table row is deleted/retired, not "Permanent"` | ✅ covered |
| AC-3d | `AGENT_TEAM_SETUP` file-tree line says local daemon only | **QA added** `the file-tree line says local daemon only` | ✅ covered |
| AC-3e | `AGENT_TEAM_SETUP` decision-log row retires the git-memory-branch decision | **QA added** `the decision-log row retires the Git memory branch decision` | ✅ covered |
| AC-3f | `MEMORY_PIPELINE` superseded banner records the deletion and points at the ADR for the tip | **QA added** `the superseded banner notes the branch was deleted…` | ✅ covered |
| AC-4a | The #247 test asserts deleted + tip + `not.toContain('frozen, not deleted')` | developer change (verified by running); QA reinforces with **no live doc keeps the old frozen claim** (×3 docs) | ✅ covered |
| AC-4b | The companion automation guard — no workflow/script deletes or force-pushes the branch — is unchanged and passes | `adr-003-ci-memory-scope-qa.test.ts` `no workflow or script deletes or force-pushes the memory branch` | ✅ covered |
| AC-5 | `pnpm typecheck`, `pnpm lint`, prettier clean; cli suite 94 passed | Process, not a static assertion — run below (cli now 105 after QA additions) | ✅ verified |

**10 of 11 ACs fully covered; AC-1 is the carried-over remote-ref gap.**

## Why the developer's change was not enough

The developer correctly updated the ADR decision guard, but the PR body claims four doc corrections outside that assertion:

1. **The ADR *Given up* paragraph** still talked about a "frozen `memory` archive … read-only historical artifact" in the pre-PR text. The developer changed it, but nothing asserted the old framing was gone, so it could silently return.
2. **`AGENT_TEAM_SETUP.md`'s YAAM memory table row** (was `| Permanent |` / git `memory` branch), **file-tree line** (was "on memory branch") and **decision-log row** (was an active rationale) were all corrected with no guard.
3. **`MEMORY_PIPELINE.md`'s superseded banner** gained the deletion sentence with no guard.
4. **The tip SHA was only matched as a loose hex regex** (`/tip …?[0-9a-f]{7,40}/i`). The recoverability promise rests on the *correct* SHA being recorded; a wrong-but-hex value would pass.

## Tests added

`packages/cli/tests/adr-003-memory-branch-deleted-qa.test.ts` — 11 tests in 5 blocks:

1. **ADR records the deletion + recoverable tip** — decision 5 says `**deleted**`, the exact tip `3c20d804` is present, `frozen, not deleted` is absent, and the out-of-repo archive is documented.
2. **ADR *Given up* paragraph** — the old `frozen \`memory\` archive` / `read-only historical artifact` framing is gone and recovery-from-`git fetch` is explicitly replaced.
3. **`AGENT_TEAM_SETUP`** — the `events.jsonl` table row is `(deleted)`/`Retired` (not `Permanent`); the file tree says `local daemon only` and never `on memory branch`; the decision-log row is struck through and cites ADR-003.
4. **`MEMORY_PIPELINE`** — the superseded banner names the branch deletion and points at the ADR for the tip (blockquote markers normalised so cross-line prose matches).
5. **Cross-doc consistency** — none of the three live docs still says `frozen, not deleted`. Historical `docs/specs/notes/` records are deliberately excluded; they document the superseded decision and are not instructions.

**Red-first verified:** checking out the three docs at the base commit (`ec18482`) and running the new file yields **8 failed / 3 passed**; restoring the PR docs yields **11 passed**. The working tree was restored (`git status` clean except the new test file).

The new file is a static policy test, following the `spec-217-docs-only-qa-gate.test.ts` / `adr-003-*` precedent. It reads the repo only and never touches `dist/`.

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
| cli | 11 | 105 passed (was 94; +11 QA) |
| **Total** | **261** | **3204 passed, 0 failed** |

- `pnpm test` — exit 0.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.
- `pnpm format:check` — exit 0 (`prettier --check` clean, tests included).
- `pnpm build` was run before the suite so `packages/cli`'s `cli.test.ts` invocations resolve workspace packages to fresh `dist/` (per `AGENTS.md`). Without it, 4 `cli.test.ts` cases fail with a stale/missing `dist/` — the same caveat recorded in the #248 notes.

## Gaps / non-gaps / observations

- **AC-1 remote ref (the one gap, carried over from #247/#248).** No in-repo test can observe `origin/memory`. A `git ls-remote origin memory` check is a live-CI/human action and would make the suite network-dependent, so QA recorded it rather than asserted it. The deletion itself was performed out-of-band by the operator; the repo-side contract that *is* testable — the docs record the deletion and the tip, and automation cannot re-create or rewrite the branch — is fully guarded.
- **Out-of-repo archive (AC-2b).** The existence of the archive is inherently outside the repo; the test asserts the ADR *documents* it, which is the only in-repo contract. Noted so the recoverability claim is not assumed verified.
- **Stale test description in the developer guard (documentation drift, not a failure).** `adr-003-ci-memory-scope.test.ts` still has a test named `the compaction workflow is gone (the memory branch is frozen)` and its file docstring says the local scripts survive. The assertions remain valid; per the add-only rule QA did not edit the developer's file. Flagged for the author.
- **Historical records keep the old wording deliberately.** `adr-003-ci-memory-local-first-qa-notes.md` and `adr-003-drop-toolchain-qa-notes.md` still table the `frozen, not deleted` decision — they are time-stamped QA records of what was believed then. This file is the superseding record for decision 5. The cross-doc consistency test excludes `docs/specs/notes/` for exactly this reason.
- **No issue is linked to this PR** (`closingIssuesReferences` is empty; the body only cites #247/#248, both merged PRs). QA therefore applied `Status: In Review/QA` to the PR itself, matching the label state of #247/#248.
- **No `dist/`, `session-logs*/`, `app.env`, key material or generated artifact is committed.** Only the new test file and this note are added.

## Verification provenance

- `git checkout ec18482 -- docs/adr/… docs/AGENT_TEAM_SETUP.md docs/MEMORY_PIPELINE.md` for the red-first check, then `git checkout HEAD --` on the same three paths; `git status` clean before committing.
- `pnpm build` run first (workspace packages resolve to `dist/`).
- The committed change is test-only plus this note; no `packages/*/src`, `scripts/` or doc file was modified by QA.
