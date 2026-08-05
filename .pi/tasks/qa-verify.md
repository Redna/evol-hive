Verify test coverage for Pull Request #${PR_NUMBER}.

Steps:
1. Read the PR: `gh pr view ${PR_NUMBER} --json body,title,headRefName`
2. Read the PR diff: `gh pr diff ${PR_NUMBER}`
3. Find the spec file referenced in the PR body (look for "spec" or "docs/specs/")
4. Read the spec's acceptance criteria
5. Search YAAM for workspace notes: `yaam_search("feature-")`
6. Map each acceptance criterion to existing tests
7. Write missing tests (integration, E2E) for uncovered acceptance criteria
8. Run `pnpm test` — all must pass
9. Run `pnpm typecheck && pnpm lint`
10. Post a QA report as a comment on the PR with coverage summary
11. If all tests pass and coverage is complete, add label "Status: In Review/QA" to the issue
12. Record findings in YAAM notes