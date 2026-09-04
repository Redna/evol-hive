Continue implementing the feature for GitHub Issue #${ISSUE_NUMBER} (spec: ${SPEC_FILE}).

A previous session was interrupted mid-work. Resume it:

1. Read the spec at ${SPEC_FILE} — the acceptance criteria are the definition of done
2. Check what already exists:
   - `git log --oneline -10` and `git status` on your feature branch (create it if missing: `git checkout -b feature/${ISSUE_NUMBER}-<name>`)
   - `gh pr list --head <branch>` — if a PR already exists, keep pushing to that branch
   - YAAM notes: `yaam_search("feature-")` — previous sessions left progress breadcrumbs
3. Finish whatever remains: tests written? implementation complete? typecheck/lint/build green?
4. Commit and push after every completed step (uncommitted work is lost on session end)
5. When tests pass and everything is green: open/refresh the PR with
   `GH_TOKEN=$GH_PAT gh pr create` (REQUIRED — App-token PRs can't run CI)
   - Title: "feat: [feature name]"
   - Body: reference the spec file and issue number
6. Update `docs/specs/INDEX.md` — spec status to "🔍 In Review"
7. Record final state in YAAM notes

Rules: never work on main; never narrate without acting; write tests before
implementation; leave YAAM breadcrumbs.