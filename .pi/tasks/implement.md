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

## CRITICAL: checkpoint discipline
Your session can be interrupted at any moment and a NEW session will resume
your work from the git branch and YAAM notes. Therefore:

- **Branch first**: your very first action must be `git checkout -b feature/<N>-<name>`.
  NEVER work on `main`. NEVER run `git checkout main` or `git checkout --force`.
- **Commit after every completed step**: each time tests pass, or a file is
  complete, run `git add -A <specific files> && git commit -m "..."` (never
  `git add -A` alone) and `git push -u origin <branch>` immediately.
  Uncommitted work WILL be lost — pushing is your save point.
- ** narrate → act**: never describe the next step in text without immediately
  making the tool call for it. If you catch yourself writing "Now add X",
  add X with a write/edit tool call in the same turn.
- **Leave breadcrumbs**: before ending a turn, record progress in YAAM notes
  (what's done, what remains, current file paths).