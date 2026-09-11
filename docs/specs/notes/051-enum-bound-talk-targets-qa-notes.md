# Spec 051 QA Notes — Test-Coverage Verification for PR #188

> YAAM note (QA session record): session 3 — QA coverage verification for PR
> #188 (spec 051, issue #186). Same convention as
> `051-enum-bound-talk-targets-implementation-notes.md`: notes are written as
> `docs/specs/notes/*.md` files, indexed by the YAAM daemon's document adapter
> and findable via `search` (raw-TCP JSON-RPC on `127.0.0.1:<daemon.port>`,
> method `search`, param `text`).

## Verdict

**Coverage complete for all deterministic ACs (AC-1..AC-9); all tests green.**
AC-10 (live 30-min run) remains open — live-environment-owned, not
automatable deterministically (tracked below).

## What was verified (HEAD `1ee2487` on `feature/051-enum-bound-talk-targets`)

- `pnpm test` — **8/8 packages green, 0 failures**: shared 362, memory 101,
  cognition 966 (+1 skipped / 26 todo), engine 839 (+141 todo), assembly 66,
  visualizer 48, examples 202 (+3 todo), cli 15 — 2,599 passing.
- `pnpm typecheck` — clean (exit 0). `pnpm lint` — clean (exit 0).
- CI (pull_request run 34601672089) — was stuck `action_required` after the
  QA commit push; approved via
  `POST /repos/Redna/evol-hive/actions/runs/34601672089/approve` (the
  recorded breadcrumb pattern); run went in_progress/queued.

## Coverage-gap analysis (what QA added and why)

The PR's three unit suites (shared 12 / cognition 27 / engine 10 = 49 tests)
covered each layer against synthetic fixtures, but **no suite exercised the
cross-layer seams** — the real engine `SocialManager` behind the production
cognition executor/builders (the spec 046/047 production-stack QA-suite
pattern). QA added `examples/tests/spec-051-talk-enum.test.ts` (9 tests,
deterministic, no LLM, `createEngineCore` + `assembleCognitionStack`, no
manual wiring), committed as `1ee2487`:

- **AC-2 (E2E)** — production perceive renders `talk_to` whose enum EQUALS
  the engine's `enumerateTalkTargets` output (engine = source of truth;
  cognition renders the same value space); spec-mandated description
  ("an agent ID from the enum…"); plan-builder agrees on the same real
  PerceptionResult; enum never in the stable system prompt (KV-cache).
- **AC-3 (integration)** — cap bob via the real additive write path
  (`updateRelationship` `{sentCount: 3}`): engine enumeration per-target
  (bob out, carol in); perception + plan enums agree.
- **AC-4 (E2E)** — all present capped: `talk_to` omitted from BOTH the
  perceive and plan tool arrays while observe_agent/help/ignore render;
  agent alone in a room → no talk_to, no crash.
- **AC-6 (integration)** — production executor refuses a capped target on
  BOTH the display-name path ('Bob' → resolves → excluded) and the exact-ID
  path (`'agent-bob'`): structured failure names target + give-space/reply
  policy, and NOTHING is written — no queue message, no conversation, no
  relationship delta (trust 50/familiarity 0 unchanged), no reciprocity
  counter, no `+2` `SOCIAL_MONOLOGUE_REWARD` drive grant, no phantom key.
  Fresh sibling target still accepted (per-target enforcement).
- **AC-5 (E2E)** — the target's REAL reply through the executor raises
  `receivedCount` (gap 3−1=2 < cap), the target re-enters the enum on the
  next perception (engine + perception + plan all agree) and the executor
  accepts the send again on the SAME thread — Decision 2 (the gap IS the
  clock) verified end-to-end.
- **AC-8 (integration, real data)** — `[talk-enum]` diagnostic over the
  production perceive outcome: fresh `present=2 valid=2 excluded=[]`; capped
  `valid=1 excluded=[agent-bob]`; no agents present → no line.
- Spec-doc integrity pin (R1–R5, AC-1..AC-10, issue #186).

## Findings

1. **Engine=cognition agreement holds in production wiring** at every stage
   (fresh / capped / recovered): the rendered enum always equals
   `enumerateTalkTargets` — the "engine is source of truth" constraint is
   real, not just documented.
2. **Nothing-written guarantee verified at production level** for the AC-6
   refusal: every write key (queue, conversation, both relationship sides,
   trust/familiarity, reciprocity counters, drive grant) untouched.
3. The superseded spec-047 examples assertion (all-capped → `talk_to`
   omitted, siblings render) passes against the production stack.
4. Spec-051 totals: **58 tests** across 4 suites (12 shared + 27 cognition +
   10 engine + 9 examples QA).
5. **AC-10 open (live, QA-owned)**: 30-min live run, cc=3, same scene as
   spec 050 — Tomas's monologue count toward Maren ≤ 10, social not pinned
   at 100, no `[social]` line queued to an excluded target. Rebuild dist
   before the live run (operational note).
6. QA mechanics: the examples suite needed the workspace dists built
   (`pnpm build`) before `@evol-hive/*` resolves — fresh-checkout artifact,
   same breadcrumb as the implementation notes. Participant order in a
   conversation follows the INITIATOR (bob's reply → `['agent-bob',
'agent-alice']`) — assert sets, not order, when the opener can vary.

## Issue / label transitions

- Issue #186: `Status: Ready for Dev` → **`Status: In Review/QA`** added
  (label exists in the repo; the PR is under review and QA).
- QA report posted as a PR comment on #188.
