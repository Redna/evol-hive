# PR #269 QA notes — `scripts/live-sim.mts` spend budget + no-orphan cleanup

**PR:** [#269](https://github.com/Redna/evol-hive/pull/269) — `feat(scripts): live-sim launcher with a spend budget and no-orphan cleanup`
**Branch:** `feat/live-sim-budget-guard`
**Spec:** none. This is a tooling/docs change with **no linked issue and no spec
document** — the PR body is the reference contract, together with the two docs it
edits (`AGENTS.md` safety rule; `docs/DELIVERY_PROCEDURE.md` live-validation
step). Precedent: `217-docs-only-qa-skip-qa-notes.md`, `243-bot-approve-check-mode-qa-notes.md`.

**New tests:** `packages/cli/tests/live-sim-budget-qa.test.ts` — **9 tests**.
**Developer tests (already in the PR):** `packages/cli/tests/live-sim-budget.test.ts` — 4 tests.
**Result:** `pnpm test` exit 0; `typecheck` 0 errors; `lint` clean; `format:check` clean.

> YAAM tooling note: `yaam_*` pi tools were not exposed in this session (only
> `read`/`write`/`edit`/`bash`), so this markdown file is the durable record, per
> the established convention (`060-…-qa-verification-notes.md`,
> `243-…-qa-notes.md`).

## Coverage map (PR-body/docs criteria → tests)

| # | Criterion | Test(s) | Status |
|---|-----------|---------|--------|
| AC-1 | Prints the **model and budget before starting** | QA `prints the model and budget before the child starts, with the default 30-minute budget` (asserts the exact banner, its ordering before `child pid`, and the default `30 min`) | ✅ covered |
| AC-2 | **Warns on a `:cloud` model** | QA `warns that a :cloud model spends quota`; `does not print the cloud warning for a local model` | ⚠️ **gap — see defect below** |
| AC-3 | **Pauses** the child when the budget is spent; prints the exact continue command | Developer `pauses the child when the budget is spent, and says how to continue` (also asserts prompt shutdown < 15 s) | ✅ covered |
| AC-4 | **Refuses to run unbounded** unless `SIM_UNBOUNDED=1` | Developer `refuses to run unbounded…`; QA `runs the acknowledged-unbounded branch (SIM_UNBOUNDED=1, budget 0)` (positive branch, so it is not an unconditional block) | ✅ covered (both branches) |
| AC-5 | Kills the **whole process group** on Ctrl-C, including a *stopped* child | Developer `leaves no orphan when the wrapper is interrupted while paused` (direct child, SIGCONT-before-SIGTERM); QA `kills the whole process group on interrupt, not just the direct child` (a forked **grandchild**) | ✅ covered |
| AC-6 | `LLM_MODEL` overrides the default | QA `passes the LLM_MODEL override and USE_REAL_LLM through to the child` (asserts the child's env, not just the banner) | ✅ covered |
| — (robustness) | A malformed budget is refused before any child starts | QA `refuses a non-numeric or negative budget before launching anything` (`abc`, `-5` → `REFUSING`, non-zero, no `child pid`) | ✅ covered |
| AC-7 (Docs) | `AGENTS.md` + `DELIVERY_PROCEDURE.md` both point at the launcher, including the **40-minute** case | QA `AGENTS.md points live sims at the launcher…`; `DELIVERY_PROCEDURE.md points at the launcher and shows the 40-minute…` | ✅ covered |

**8/8 criteria covered; 1 (AC-2) is only partially covered because of a real defect.**

## Defect found (not asserted as a red test — QA does not land failing tests)

**The default cloud model draws no quota warning.** The guard warns only when
`model.includes(':cloud')` (`scripts/live-sim.mts:71`), but the default model is
`gemma4:31b-cloud` — it contains `-cloud`, not `:cloud`. Verified live:

```
$ SIM_CMD='echo hi' node --import tsx scripts/live-sim.mts
[live-sim] model=gemma4:31b-cloud budget=30 min realLlm=true      # <- no NOTE
$ SIM_CMD='echo hi' LLM_MODEL='deepseek-v4.1-flash:cloud' node --import tsx scripts/live-sim.mts
[live-sim] model=deepseek-v4.1-flash:cloud budget=30 min realLlm=true
[live-sim] NOTE: a cloud model spends quota on every agent cycle; …  # <- warns
```

The PR's premise is "print the model and budget, and warn on a cloud model"; the
model the wrapper *defaults to* is itself a cloud model, so the exact spend the
guard exists to surface starts silently. The QA cloud test therefore asserts the
`:cloud` tag (which the PR literally claims) and the local-model negative, but
does **not** assert the default — that would be red. Suggested fix (developer's
call): match `/(^|[-:])cloud$/` or warn whenever a non-local model is in use.

## What the new tests do

Behavioural, no LLM: every test spawns the launcher with a stub `SIM_CMD`
(`echo …` or `sleep 60 & …`) via `node --import tsx`, and asserts what the
process actually does. Ambient `SIM_*` / `LLM_MODEL` / `USE_REAL_LLM` are
stripped so the tests own the configuration.

The `alive()` helper mirrors the developer test's: `kill(pid, 0)` is true for a
**zombie**, so `/proc/<pid>/stat` state is checked; a reaped-but-unwaited child
must not read as a runaway. The grandchild test was validated against a naive
direct-child-only kill, which leaves the grandchild alive — so it would catch the
leak it targets.

## Gate results (post-build)

`pnpm build` first (CLI/live tests resolve workspace packages to built `dist/`),
then:

- `pnpm test` — **exit 0**: 273 test files, **3296 passed** / 0 failed
  (shared 399, memory 101 (+24 todo), visualizer 125, engine 942 (+141 todo),
  cognition 1252 (+1 skipped, +26 todo), assembly 92, examples 253 (+3 todo),
  **cli 132** — was 123 before QA; 16 files).
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.
- `pnpm format:check` — exit 0 (the new test file is prettier-clean).

## Non-gaps / notes

- No `dist/`, `session-logs*/`, or generated artifact is committed.
- The PR has no linked issue (`closingIssuesReferences` empty), so the
  `Status: In Review/QA` label is applied to the **PR** itself.
- The developer's test and QA's test both leave the launcher's real child in its
  own process group, but only while the test is running; both clean up with
  SIGKILL fallbacks, and the grandchild test additionally kills the group on
  failure so a red run cannot leak an orphan.
