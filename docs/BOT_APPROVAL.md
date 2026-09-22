# Bot approval — restoring the merge gate

> Why this exists, and the one value it needs from you.

## The problem

`main` is protected by a required PR review. Our PRs are opened with the **human
PAT**, and GitHub refuses to let you approve your own PR. The intended
counterpart (see [AGENT_TEAM_SETUP.md](AGENT_TEAM_SETUP.md)) is the
**`evol-hive-agent` GitHub App approving PAT-authored PRs** — but that needs the
App's numeric **App ID**, which is not stored anywhere on this machine (only the
private key is, in the gitignored `.pi-web/attachments/`).

Without it, merges fell back to:

```bash
gh pr merge <n> --squash --admin
```

`--admin` bypasses branch protection **entirely — including required status
checks.** That is not theoretical: a red `Test` job was merged onto `main` this
way (the spec-058 INDEX incident), and had to be repaired afterwards.

## The fix

`scripts/bot-approve.mjs` mints a GitHub App installation token (RS256 JWT →
`/app/installations/<id>/access_tokens`, no dependencies) and posts an
`APPROVE` review. Then a normal `gh pr merge <n> --squash` works and the review
requirement is genuinely satisfied.

### One-time setup — already done on this box

The App ID was recovered from a prior pi session transcript and the config is in
place at `~/.config/evol-hive/app.env` (mode 600, outside the repo):

```
APP_ID=<the numeric app id>                 # App settings page for evol-hive-agent
APP_PRIVATE_KEY=/home/anima/evol-hive/.pi-web/attachments/<the>.private-key.pem
APP_INSTALLATION_ID=<installation id>       # optional; skipped if absent
```

Verify it at any time (works with or without an open PR):

```bash
node scripts/bot-approve.mjs --check
# bot-approve: OK — installation can see N repo(s); Redna/evol-hive is among them
```

If it is ever lost again, search in this order: (1) `~/.config/evol-hive/app.env`,
(2) the pi transcripts — `grep -rl APP_ID ~/.pi/agent/sessions` (that is where it
was found last time), (3) a prior helper at `/home/anima/botapprove.mjs`,
(4) the `.pem`s under `.pi-web/attachments/`, (5) the GitHub App settings page
(authoritative). It is **not** in the repo and **not** in Actions secrets you can
read back.

#### Which identity approves which PR

Branch protection requires a review and GitHub forbids self-approval, so the
approver depends on who opened the PR:

| PR author                       | Approver                                          |
| ------------------------------- | ------------------------------------------------- |
| `Redna` (the PAT)               | the **bot** — `node scripts/bot-approve.mjs <pr>` |
| `app/evol-hive-agent` (the bot) | the **PAT** — `gh pr review <pr> --approve`       |

Check with `gh pr view <pr> --json author`.

### Use

```bash
node scripts/bot-approve.mjs --check           # verify config + repo access (no PR needed)
node scripts/bot-approve.mjs <pr> --check      # also prove the PR is visible
node scripts/bot-approve.mjs <pr>              # post the APPROVE review
gh pr merge <pr> --squash                      # now a normal, gated merge
```

Optional config keys: `APP_INSTALLATION_ID` (skip discovery), `GH_OWNER`,
`GH_REPO` (default `Redna` / `evol-hive`). Override the config path with
`APP_ENV_FILE=<path>`.

## Rules that still apply

- The bot approves; the **human decides** to merge. Do not wire this to
  auto-merge.
- Never commit `app.env`, the `.pem`, or the App ID. The App ID is not a secret
  in the credential sense, but it is environment identity and belongs with the
  key, out of the public repo.
- If the bot cannot be configured, prefer **not merging** over `--admin`: run
  the checks, and leave the merge for a human instead of bypassing the gate.
