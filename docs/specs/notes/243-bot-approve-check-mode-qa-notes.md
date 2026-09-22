# PR #243 QA notes — `bot-approve.mjs --check` without a PR

**PR:** [#243](https://github.com/Redna/evol-hive/pull/243) — `chore(scripts): bot-approve --check works without a PR`
**Branch:** `chore/bot-approve-check-mode`
**Spec:** none — this is a chore follow-up to #242. The reference contract is the
PR body plus `docs/BOT_APPROVAL.md`.
**New tests:** `packages/cli/tests/spec-243-bot-approve-check-mode.test.ts` (7 tests).

## Acceptance-criteria coverage

| # | Criterion (from PR body / `docs/BOT_APPROVAL.md`) | Test(s) | Status |
|---|---------------------------------------------------|---------|--------|
| AC-1 | `--check` **with** a PR is unchanged: probes the pull and reports title/state | `AC-1 — probes the pull and prints its title and state` | covered |
| AC-2 | `--check` **without** a PR mints the installation token, calls `GET /installation/repositories`, and states whether the configured repo is among them | `AC-2 — lists installation repositories and reports the repo IS among them`; `... NOT among them (negative branch)`; `... zero repositories without crashing` | covered |
| AC-3 | A bare invocation (no PR, no `--check`) still fails with the usage error | `AC-3/AC-4 — rejects a bare invocation ... before any network call` | covered |
| AC-4 | A missing/invalid config still fails with an actionable message before any network call | `AC-3/AC-4 — fails with an actionable message when the config file is missing` | covered |

7/7 testable criteria covered; no gaps.

## How the tests work

The script hardcodes the GitHub API origin, so the tests execute it **for real**
in a `node --import` child process. A generated preload module replaces
`globalThis.fetch` with a recording fake, so:

- the RS256 JWT signing path runs unmodified against a throwaway 2048-bit key;
- only the network boundary is faked;
- the recorded request log proves *which* endpoints each mode reaches:

  - no-PR `--check` → `POST /app/installations/<id>/access_tokens`,
    `GET /installation/repositories`, **no** `/pulls/` request;
  - PR `--check` → `POST .../access_tokens`,
    `GET /repos/<owner>/<repo>/pulls/<n>`, **no** `/installation/repositories`.

The negative "is NOT among them" branch and the zero-repository case are both
exercised, since `names.includes(...)` is the only new logic the PR adds.

## Results

- `pnpm test` — **exit 0**. 257 test files, 3144 passed / 0 failed
  (shared 399, memory 101, visualizer 93, engine 922, cognition 1242,
  assembly 89, examples 253, cli 45).
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.

## Notes / non-gaps

- `packages/shared/dist` was missing at first, so the shared suite failed to
  resolve its own package entry. `pnpm build` was run (dist is gitignored), after
  which the full suite is green. This is a pre-existing environment prerequisite,
  not a regression from this PR.
- No `dist/`, `session-logs*/`, key material, or config is committed. The test's
  key/config live in a `mkdtemp` sandbox removed in `afterAll`; a final assertion
  checks no `app.env` ever lands in the repo root.
- The real App ID / installation ID are never committed — the test uses the
  already-public example values from the PR body inside its sandbox only.
