Read GitHub Issue #${ISSUE_NUMBER} and draft a specification for it.

Steps:
1. Read the issue body: use `gh issue view ${ISSUE_NUMBER}` or read the issue file at ${ISSUE_FILE}
2. Search the codebase for related code: `grep -rn` with keywords from the issue
3. Read relevant architecture docs in `docs/architecture/`
4. Draft a spec file in `docs/specs/` using the next available number
5. Write the design notes to `docs/specs/notes/NNN-<topic>-design-notes.md`
6. Record the rationale for your design decisions in those notes, and commit them with the spec
7. Commit the spec file with message: "spec: draft spec for issue #${ISSUE_NUMBER}"
8. Push the commit: `git push origin main`
9. Post the spec summary as a comment on the issue
10. Add label "Status: Ready for Dev" to the issue

The spec must follow the format in your system prompt. Every requirement must map to at least one acceptance criterion.