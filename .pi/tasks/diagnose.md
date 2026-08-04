A CI pipeline has failed on Pull Request #${PR_NUMBER}.

Steps:
1. Get the PR diff: `gh pr diff ${PR_NUMBER}`
2. Get the CI failure output: `gh run view --log-failed` or read the check run annotations
3. Read the changed files to understand what was modified
4. Search YAAM for related code and previous failure notes: `yaam_search` with relevant keywords
5. Diagnose the root cause
6. Document the diagnosis in a YAAM note
7. If the fix is clear and isolated (≤3 files, no API changes, no new deps):
   - Apply the fix
   - Run `pnpm typecheck && pnpm test && pnpm lint`
   - Commit with message: "fix: [root cause description]"
   - Push to the PR branch
8. If the fix is unclear or architectural:
   - Post a comment on the PR with the diagnosis
   - Do NOT attempt a fix

Call goal_complete when: either the fix is applied and local checks pass, OR you've posted a diagnosis comment and escalated.