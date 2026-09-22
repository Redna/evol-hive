# PR #245 QA notes — bot-approve fixtures carry no environment identity

**PR:** [#245](https://github.com/Redna/evol-hive/pull/245) — `test(cli): don't hardcode the real App ID / installation ID in the bot-approve test`
**Branch:** `fix/app-id-not-a-fixture`
**Spec:** none — one-file test correction. The reference contract is the PR body
plus `docs/BOT_APPROVAL.md` ("Never commit `app.env`, the `.pem`, or the App ID
… it is environment identity and belongs with the key, out of the public repo").
The behavioural contract is unchanged from [#243](https://github.com/Redna/evol-hive/pull/243).

## What changed

`packages/cli/tests/spec-243-bot-approve-check-mode.test.ts` swapped two fixture
constants (`APP_ID`, `INSTALLATION_ID`) from the live values to synthetic
`123456` / `78901234`. No assertion referenced the literals; the script is driven
through a mocked `fetch`, so the values were always arbitrary. +6/−2, one file.

## Acceptance-criteria coverage

| # | Criterion (PR body + `docs/BOT_APPROVAL.md`) | Test(s) | Status |
|---|----------------------------------------------|---------|--------|
| AC-1 | No committed file pins the live App ID / installation ID | `spec-245-...test.ts` — "every committed APP_ID / INSTALLATION_ID literal is a synthetic placeholder" | covered |
| AC-2 | The bot-approve test uses synthetic fixture identifiers | `spec-245-...test.ts` — "declares exactly one synthetic APP_ID and one synthetic installation ID" | covered |
| AC-3 | The fixtures are irrelevant: the test is sandboxed and mock-fetch driven | `spec-245-...test.ts` — "points APP_ENV_FILE at the mkdtemp sandbox, never the live config" | covered |
| AC-4 | Behaviour unchanged — the #243 suite still passes (7/7) | `spec-243-bot-approve-check-mode.test.ts` (7 tests) | covered |

4/4 testable criteria covered.

## Tests added

`packages/cli/tests/spec-245-bot-approve-fixture-hygiene.test.ts` (4 tests). It is
a static audit in the same family as `packages/assembly/tests/wiring-audit.test.ts`:
it enumerates `git ls-files`, scans text files for numeric `APP_ID` /
`(APP_)?INSTALLATION_ID` assignments, and requires every value to be in an
explicit synthetic-allowlist. It intentionally does **not** embed the live
identifiers — doing so would recreate the leak. A regression was verified
locally: substituting a non-allowlisted App ID fails the guard at the offending
`file:line`.

## Results

- `pnpm test` — **exit 0**. See run output in the PR QA comment for the
  pass/fail counts.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.

## Gaps / non-gaps

- A *value*-based guard (assert the literal ≠ the live App ID) is deliberately
  not written: it would have to publish the live value in the repo, defeating
  the change. The allowlist approach catches any non-placeholder shape instead.
  The allowlist must be extended deliberately when a genuinely new synthetic
  placeholder is introduced.
- The live values remain in public history (commit `4ce3f704`, the #243 squash)
  and in the #243 description; purging that is a GitHub Support action, out of
  scope for this PR and not a test concern.
- No `dist/`, `session-logs*/`, key material, or config is committed.
- Pre-existing environment prerequisite: `packages/shared/dist` must exist before
  the suite resolves workspace packages, so `pnpm build` precedes the test run.
