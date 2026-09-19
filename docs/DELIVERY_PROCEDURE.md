# Delivery Procedure — Local Relay Legs + GitHub Ledger

> **Status (2026-09-18): current working model.** Supersedes the _fully-autonomous
> Actions pipeline_ described in [`AGENT_TEAM_SETUP.md`](AGENT_TEAM_SETUP.md) for the
> **intellectual steps** only. The Actions infrastructure (CI, QA coverage runs, bot
> identity, GitGuardian, branch protection, memory branch) is retained as the
> **ledger + verification layer**.

## Why this split (evidence, not taste)

Measured over 7 days of running both side by side:

| Signal                                                             | Measurement                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Actions runs that did no useful work                               | **~40%** (Responder 97 skipped + 44 cancelled; QA 33 cancelled; Developer 18 cancelled; Pipeline 33 failed; CI 47 failed) |
| Agent-authored specs that needed human correction against the code | **every one** (059: R4/R6; 060: R4/AC-2/AC-8/Decision 3; 061: AC-1)                                                       |
| QA coverage depth                                                  | spec 060: honestly recorded **0/6 code ACs testable**; spec 061 (docs-only): **no tests**, correctly                      |
| Deep work impossible in CI                                         | 40-minute live sims, tick-axis metrics, root-cause of the YAAM OOM                                                        |

The two deciding failure modes:

1. **Spec drift** — the Architect drafts from the issue + docs and has no code
   access, so its specs diverge from the real implementation and need correction
   every time. A spec must be written _against the code_, which is local work.
2. **No live closure** — engine-behavior issues (plan livelock, shape-invalid
   ramp, skip-share honesty) can only be _accepted_ from a real 40-minute run with
   a real LLM. CI can never produce that evidence.

So: **local legs do the thinking; GitHub does the checking.**

## Role split

| Layer             | Owner          | What it owns                                                                                  |
| ----------------- | -------------- | --------------------------------------------------------------------------------------------- |
| Ledger            | GitHub         | issues, PRs, branches, merge gates, the audit trail                                           |
| Verification      | GitHub Actions | CI (build/test/typecheck/lint), QA coverage runs, GitGuardian, branch protection              |
| Identity          | GitHub App     | `evol-hive-agent[bot]` commits/PRs; the PAT approves bot-authored PRs and vice versa          |
| Intellectual work | **Local legs** | spec drafting + code-grounded review, implementation, unit tests, live validation, root-cause |
| Memory            | Local YAAM     | durable notes/workspaces (the handoff channel); regenerable code topology                     |

## Skills (pipeline stage → skill)

Each pipeline stage has a matching skill under `.pi/skills/` (symlinked into
`~/.pi/agent/skills/` for pi discovery). Consult the relevant one when doing that
stage's work.

| Stage | Skill | Borrows from |
| --- | --- | --- |
| Feed the ledger | `evol-hive-triage` | mattpocock `triage` |
| Chart a foggy issue | `evol-hive-spec` | `wayfinder` + `to-spec` + `domain-modeling` |
| Decompose into legs | `evol-hive-slice` | `to-tickets` (tracer bullets, expand–contract) |
| Execute a leg | `evol-hive-build` | `tdd` + `implement` |
| Review a PR / spec | `evol-hive-review` | `code-review` |
| Fix a bug / regression | `evol-hive-diagnose` | `diagnosing-bugs` |

The skills carry the *disciplines* only; the tracker/scaffold assumptions of the
upstream suite (their label vocabulary, `.scratch/`, `.out-of-scope/`) are **not**
adopted — the GitHub ledger, the spec/AC skeleton, and YAAM memory remain the
infrastructure. Skills load at session start; a new skill needs a `/reload` to
appear in a running session.

## The three human gates

The human sits at exactly three gates. Everything else is a leg or an automated check.

1. **Pick the issue** — choose the next unit of work (one issue = one unit).
2. **Approve the spec** — a spec PR must be reviewed _against the code_, not just the
   prose, before it merges (this is what catches drift).
3. **Merge the PR** — after CI + QA green. The merge itself can be the human's click
   or a bot approval depending on the PR author (see "Approval rule").

## Leg lifecycle

One **leg** = one bounded, context-contained unit of progress in a fresh session.
A **packet** = the written charter + handoff a leg starts from. A **chain** =
spec → build → verify → QA → live, as a sequence of legs.

1. **Brief.** The dispatcher (the human, or a dispatcher leg) writes:
   - a **YAAM briefing note** — only _non-charter_ context: prior attempts and why
     they failed, live-run numbers, decisions from other chains, the constraints the
     charter doesn't state. A note that restates the spec is noise (measured: "no
     effect").
   - the **leg packet** (see below).
2. **Leg.** One fresh session does one bounded job, then records its outcome as a
   YAAM note (awaited, report the message verbatim) and commits on the branch.
   It must not push, merge, or open PRs.
3. **Spec gate** (only when the issue needs a spec). Review the spec against the
   code, correct the ACs that don't match reality, then merge.
4. **PR + CI/QA.** Push the branch, open the PR; GitHub runs CI + QA. Bot-approve
   or human-approve per the approval rule; squash-merge.
5. **Live validation** (engine-behavior issues). Rebuild dist, run the 40-minute
   sim, measure against the spec's ACs **on the tick axis** (log-line quintiles are
   skewed by late failure bursts). Record evidence in `docs/specs/notes/`.
6. **Close.** Evidence comment on the issue, close it, update `docs/specs/INDEX.md`.

## Leg packet (the fields a leg starts from)

```
charter:   issue #, spec # and path, branch
scope:     exactly which requirements this leg owns (and which are the next leg's)
constraints: the invariants that must not be violated (enum = legality, byte-identity, no retry, …)
verify:    the exact commands + pass counts that prove the leg
memory:    the briefing note id (workspace + note) to retrieve via yaam_search
handoff:   what the next leg inherits and where the state lives
```

## Approval rule (cross-identity)

- PR authored by the **PAT** (`Redna`) → the **bot** approves (helper:
  `node /home/anima/botapprove.mjs <pr> "<body>"`; it discovers the App ID against
  `GET /app` and mints an installation token).
- PR authored by the **bot** (`app/evol-hive-agent`) → the **PAT** approves
  (`gh pr review <pr> --approve`).
- Check `pr.author.login` before approving — GitHub blocks self-approval.

## Environment discipline (learned the hard way)

The local box's session daemon holds every session's transcript in memory. The
largest transcript in the workspace is ~19 MB, and the daemon has OOM'd at
4–6 GB heap on a 7.7 GB box.

- **Short legs.** Do not accumulate one giant conversation; hand off instead.
- **Close finished sessions.** Twelve idle sessions are the other half of the heap.
- **Restart the daemon** when its heap creeps up (`systemctl --user restart
pi-web-sessiond`) — and do it _between_ legs, not mid-leg.
- **Never read transcripts or giant logs into a long-running session** — each such
  read inflates the very heap that kills the session.
- **YAAM stays bounded** (`YAAM_MAX_RSS_MB=600`, `YAAM_MAX_EMBED_CHUNKS=2`,
  `YAAM_EMBED_ON_RECONCILE` off, kill-switch `YAAM_DISABLED`) — it is not the thing
  that OOMs; the session daemon is.

## Verification matrix (must all be true before merge)

- spec-021 / spec-055 **goldens unmodified** (byte-identity is pinned to real fixtures)
- full package test suite green (cognition 1,209+; engine 903; assembly 89; …)
- `pnpm typecheck` clean (note: it excludes `tests/`; a tests-inclusive run has ~703
  known errors — do not chase them)
- `pnpm build` before any live run (live sims resolve workspace packages to `dist/`)
- CI green + QA coverage run green on the PR head
- for engine-behavior issues: the live ACs measured on the tick axis, full 40 minutes

## Checklist (quick reference)

- [ ] Issue picked; branch off current `main` (`pnpm build` first if it feeds a sim)
- [ ] YAAM briefing note written (non-charter context only) + packet fields filled
- [ ] Leg(s) run; each commits on the branch and records a YAAM note (message verbatim)
- [ ] Spec reviewed against code, ACs corrected, merged (if spec needed)
- [ ] PR opened; CI + QA green; correct identity approves; squash-merge
- [ ] Live validation evidence in `docs/specs/notes/` (engine-behavior issues)
- [ ] Issue closed with evidence; `docs/specs/INDEX.md` updated
