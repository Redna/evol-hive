Read GitHub Issue #${ISSUE_NUMBER} and draft a specification for it.

Steps:
1. Read the issue body: use `gh issue view ${ISSUE_NUMBER}` or read the issue file at ${ISSUE_FILE}
2. Search the codebase for related code: `yaam_search` with keywords from the issue
3. Read relevant architecture docs in `docs/architecture/`
4. Draft a spec file in `docs/specs/` using the next available number
5. Create a YAAM workspace for this feature: `yaam_workspace_initialize("feature-NNN-name", "...")`
6. Record your design decisions as YAAM notes
7. Commit the spec file with message: "spec: draft spec for issue #${ISSUE_NUMBER}"
8. Post the spec summary as a comment on the issue
9. Add label "Status: Ready for Dev" to the issue

The spec must follow the format in your system prompt. Every requirement must map to at least one acceptance criterion.