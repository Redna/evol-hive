# Issue #217 QA Notes — docs-only QA short-circuit (PR #228)

> QA coverage verification for PR #228 (`217-skip-qa-docs-only`), which closes
> [issue #217](https://github.com/Redna/evol-hive/issues/217). **There is no
> spec document for this change** — the reference acceptance criteria are the
> four *draft* ACs in the issue body. This PR is CI-only: it touches
> `.github/workflows/qa.yml` and nothing else.

> YAAM tooling note: the `yaam_*` pi tools were **not exposed in this session**
> (only `read`/`write`/`edit`/`bash`), so — per the established convention
> (`061-…-qa-verification-notes.md`, `060-…-qa-verification-notes.md`) — this
> markdown file is the durable record.

## Verdict

The change is structurally sound and the gating contract is now locked by a
regression test. **2 of 4 draft ACs are covered in-repo; AC-1 and AC-4 are
live-CI evidence and cannot run in this suite.** All gates pass. QA added
**9 tests** in one new `packages/cli/tests/` file.

Two honest divergences from the issue's proposed fix are recorded as gaps:
the docs-only notice is a plain `echo` rather than a GitHub `::notice::`
annotation (AC-1 wording), and it does not say *where* QA will happen instead
(AC-3 wording).

## Coverage map (issue #217 draft AC → tests)

| AC | Status | Evidence |
| --- | --- | --- |
| AC-1 — docs-only PR → run completes fast with a notice line, no LLM work | 📋 live-CI only | The workflow skips all six LLM/tooling steps (`Cache YAAM binary`, `Cache ONNX model`, `Restore YAAM memory`, `Bootstrap agent environment`, `Run QA Agent`, `Push QA test commits`); structural assertion `gates every expensive step`. Wall-clock `<1 min` and "no LLM work" need a real GitHub run — not runnable in this suite. **Divergence:** the notice is `echo "Docs-only change — …"`, not a `::notice::` annotation as the issue proposed. |
| AC-2 — any non-doc file runs the full verify-coverage path unchanged | ✅ in-repo | **QA added** `spec-217-docs-only-qa-gate.test.ts`: the classifier is extracted from the workflow's own `grep -vE '^(docs/\|.*\\.md$)'` and tested against the four live-verified shapes plus extra cases (`.github/workflows/qa.yml`, `scripts/*.sh`, `training/*.onnx` → non-doc; `README.md`, `docs/assets/*.png` → docs). Each of the six expensive steps carries `if: steps.docs.outputs.docs_only != 'true'`. Live check: **this PR itself** touches `.github/workflows/`, so it is non-doc and ran the full path. |
| AC-3 — docs-only path cannot lose artifacts; must not reach push; notice says where QA happens | ⚠️ partial | The artifact push **is** gated on `docs_only != 'true'` (asserted), so the docs-only path cannot reach it. **Gap:** the notice text does not say where QA will happen instead — it only says coverage is skipped. The issue's AC-3 explicitly requires that. |
| AC-4 — manual dispatch vs merged docs-only PR + one real impl PR, recorded in notes | 📋 live-CI only / gap | The PR body records `yaml.safe_load` + a four-shape detection exercise, but no `gh workflow run qa.yml --ref main -f pr_number=…` result is persisted. This note is the committed record; the live dispatch results are not. |

## Tests added

`packages/cli/tests/spec-217-docs-only-qa-gate.test.ts` — 9 tests:

1. `qa.yml` is valid YAML with `jobs.verify-coverage` and enough steps.
2. The detection step is named/id'd `docs`, is unconditional, and precedes
   every expensive step (so it is not itself gated).
3. Detection writes `docs_only=true` / `docs_only=false` to `$GITHUB_OUTPUT`.
4. The classifier reproduces the four shapes in the PR body: spec-only → skip,
   spec + `INDEX.md` → skip, spec + source file → run, spec + `docs/` image →
   skip.
5. Non-doc paths outside `docs/` (`.github/workflows/qa.yml`,
   `scripts/bootstrap-agent.sh`, `training/*.onnx`) → run; root `README.md` → skip.
6. Every expensive step carries the exact gate
   `steps.docs.outputs.docs_only != 'true'`.
7. The push step is gated **and** its run still stages
   `packages/*/tests` + `docs/specs/notes` (artifact contract preserved).
8. `Save YAAM memory` keeps `always()` while adding the docs-only gate.
9. The `pull_request` trigger is **not** `paths-ignore` (only `types: [opened]`),
   preserving the "required check must always report" property.

## Gate results

Baseline `dist` rebuilt first (`pnpm build`; CLI source execution resolves
workspace packages to built `dist/`), then:

- `pnpm test` — **exit 0**, all 9 projects green: shared 399, memory 101
  (+24 todo), visualizer 48, engine 919 (+141 todo), cognition 1240
  (+1 skipped, +26 todo), assembly 89, examples 253 (+3 todo),
  **cli 24 (was 15; +9 QA)**.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.
- `prettier --check` on the new file — clean.

## Gaps / observations for the reviewer

1. **AC-3 notice content.** The docs-only branch's `echo` does not state that
   verify-coverage is deferred to the implementation PR. Suggested (not
   applied — QA does not edit implementation): extend the message to name the
   follow-up PR/run.
2. **No `::notice::` annotation.** The issue proposed a `::notice::` so the
   deferral surfaces in the GitHub UI; the PR uses a plain log line.
3. **Cosmetic YAML bug.** The step name is written as
   `Detect a docs-only PR (issue #217)` unquoted; YAML treats ` #217)` as a
   comment, so the step actually parses as `Detect a docs-only PR (issue`.
   Quote the name to keep the full title in the UI. (Harmless to behaviour; the
   test matches the stable prefix.)
4. **No spec document.** Since #217 is a bug/CI change, the four draft ACs are
   the only criteria; they remain *draft* in the issue.
