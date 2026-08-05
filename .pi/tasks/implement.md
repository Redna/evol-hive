Implement the feature described in the spec at ${SPEC_FILE} for GitHub Issue #${ISSUE_NUMBER}.

Steps:
1. Read the spec file at ${SPEC_FILE}
2. Search YAAM for the workspace notes from the Architect: `yaam_search("feature-")` 
3. Read the acceptance criteria — these are your test cases
4. Create a feature branch: `git checkout -b feature/NNN-name`
5. Write tests first in the appropriate package's tests/ directory
6. Run `pnpm test` — confirm tests fail for the right reasons
7. Write the implementation
8. Run `pnpm test` — iterate until all tests pass
9. Run `pnpm typecheck && pnpm lint && pnpm format:check` — fix any issues
10. Run `pnpm build` — confirm it builds
11. Commit tests and implementation
12. Push the branch: `git push -u origin feature/NNN-name`
13. Open a PR using `gh pr create` with:
    - Title: "feat: [feature name]"
    - Body: reference the spec file and issue number
14. Record what you built in YAAM notes
15. Update `docs/specs/INDEX.md` — change the spec status to "🔍 In Review"

You MUST write tests BEFORE implementation. No exceptions.