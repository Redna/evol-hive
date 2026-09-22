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

### One-time setup (needs the App ID)

Get both values from the App's settings page
(`https://github.com/settings/apps/evol-hive-agent` → **App ID**, and
**Private keys → Generate/Download**), then create a file **outside the repo**:

```bash
mkdir -p ~/.config/evol-hive
cat > ~/.config/evol-hive/app.env <<'EOF'
APP_ID=123456
APP_PRIVATE_KEY=/home/anima/evol-hive/.pi-web/attachments/<the>.private-key.pem
EOF
chmod 600 ~/.config/evol-hive/app.env
```

`APP_PRIVATE_KEY` is the existing `.pem`; point at whichever one is current.

### Use

```bash
node scripts/bot-approve.mjs <pr> --check           # verify config + repo access
node scripts/bot-approve.mjs <pr>                   # post the APPROVE review
gh pr merge <pr> --squash                           # now a normal, gated merge
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
