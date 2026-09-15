# Spec 058 QA Notes — Test-Coverage Verification for PR #209

> YAAM note (QA session record): QA coverage verification for PR #209
> (spec 058, issue #206). Same convention as
> `057-plan-skip-outcome-honesty-qa-notes.md` /
> `056-plan-supersession-stamping-qa-notes.md`: notes are written as
> `docs/specs/notes/*.md` files, indexed by the YAAM daemon's document adapter
> and findable via `search` (raw-TCP JSON-RPC on `127.0.0.1:<daemon.port>`,
> method `search`, param `text`; `note_write`/`graph_explore` are not exposed
> by this daemon build).

## Verdict

**Coverage complete for every testable acceptance criterion — 7/8 ACs pinned;
AC-7 (40-minute live run) is live-environment evidence owned by issue #206.
All gates green. Recommend approve/merge. QA added 7 tests (2 engine, 5
real-scene E2E) and verified both new suites fail against the pre-fix code.**

## What was verified (PR head `882aece` on `feature/206-eligibility-bound-plan-affordances`)

- `pnpm build` first (fresh checkout has no dists), then `pnpm test` —
  **8/8 projects green, 0 failures**: shared 382, visualizer 48, memory 101
  (+24 todo), cognition 1117 (+1 skipped / +26 todo), engine **898**
  (+141 todo; +2 QA tests), assembly 79, examples **248** (+3 todo; +5 QA
  tests), cli 15 — **2,888 passing** (exit 0).
- `pnpm typecheck` — exit 0 (under `exactOptionalPropertyTypes`).
- `pnpm lint` — exit 0, 0 findings.
- `pnpm format:check` — clean (including both QA test files).
- `pnpm build` — exit 0.
- PR #209 is OPEN/MERGEABLE; issue #206 already carries
  `Status: In Review/QA`.

## Acceptance-criterion → test coverage map

| AC | Status | Tests |
|----|--------|-------|
| AC-1 (R1) | ✅ COVERED (+ QA breadth) | `packages/engine/tests/spec-058-eligibility-bound-plan-affordances.test.ts` ×4 (participant / non-participant / closed / unwired); QA real-scene participant-vs-bystander in `examples/tests/spec-058-eligibility-bound-plan-affordances-e2e.test.ts` |
| AC-2 (R1) | ✅ COVERED | engine suite ×2 — unknown `go_to_<room>` fogged out in the same call that applies eligibility; known `go_to_<room>` survives |
| AC-3 (R2) | ✅ COVERED (+ QA real-scene collision) | engine suite ×2 (duplicate `observe` preserved, conversation-only id dropped); QA asserts the real greenhouse's observe count drops by exactly the conversation's one copy |
| AC-4 (R3) | ✅ COVERED (+ QA real-scene breadth) | `packages/assembly/tests/spec-058-plan-enum-e2e.test.ts` ×3 (pruned / `targetAffordance` enum / affordance tool list for no-conversation, participant, bystander); QA runs the same checks over the real #206 scene |
| AC-5 (R3) | ✅ COVERED | `packages/cognition/tests/spec-058-plan-enum-diagnostic.test.ts` ×3 (filtered matcher, social-effect control, plan-builder render) |
| AC-6 (R4) | ✅ COVERED | cognition suite ×6 (golden line, `chosen=[none]`, `enum=[]`, exactly one per formulation, thrown diagnostic never propagates, wiring pin) |
| AC-7 (R1–R4, live) | 📋 ISSUE-EVIDENCE (live) | 40-minute `USE_REAL_LLM=true SCENE_DURATION_MS=2400000 npx tsx examples/dynamic-world-sim.ts` run on issue #206 — no LLM backend in this sandbox. Deterministic substrate: AC-1–AC-6 + the QA AC-7-RS proxy (below) |
| AC-8 (R1–R3) | ✅ COVERED (+ QA byte-identity) | full-suite regression gate (`pnpm test/typecheck/lint`, spec-033/037/039/051 suites unmodified); QA `packages/engine/tests/spec-058-legacy-path-byte-identity.test.ts` pins the "unwired provider byte-identical" clause |

## Coverage gaps found and closed by QA

**Gap 1 — no real-scene coverage.** The PR's suites use synthetic fixtures:
the engine suite a trowel + one conversation mirror, the assembly suite a
bench trio, the cognition suite a hand-built perception. None loads the
`DYNAMIC_WORLD_SCENE` — the scene where the #206 skip storm was observed and
whose `observe`-on-every-object collision is the explicit motivation for spec
058 R2. **Closed** with `examples/tests/spec-058-eligibility-bound-plan-affordances-e2e.test.ts`
(5 tests, zero LLM): the real scene through the real `assembleWorld` stack
(real `ConversationManagerImpl` wired into the perception bridge), real
`PerceptionServiceImpl`, real `PlanBuilderImpl`, plus one full deterministic
`PPEROrchestratorImpl` cycle.

- **closed conversation (the skip-storm shape)** — the mirror still *declares*
  join/contribute/leave/observe in the registry, yet none of join/contribute/
  leave reaches `prunedAffordances` or the `formulate_plan` enum; the
  non-conversation greenhouse `observe`s all survive (the count drops by
  exactly the conversation's one copy — R2).
- **open conversation roles** — participants yield contribute/leave (never
  join); a co-located bystander (gardener-1 moved into the greenhouse) yields
  join/observe (never contribute/leave).
- **AC-7-RS proxy** — the invariant the live run greps: every `[plan-enum]`
  line for an agent with no eligible conversation is free of
  join/contribute/leave across all #206 agents/rooms, and a full orchestrator
  cycle over a closed real conversation emits exactly one clean line.

**Gap 2 — AC-8's byte-identity clause was only membership-checked.** The PR's
AC-1 unwired case asserts the four affordances *appear*; it does not pin the
spec's stronger claim that the unwired path is *byte-identical*. **Closed**
with `packages/engine/tests/spec-058-legacy-path-byte-identity.test.ts` (2
tests): `getVisibleAffordancesInRoom` and `getEligibleAffordancesInRoom` both
`toEqual` the registry's available set (same order, same values) when the
conversation manager is unwired — even with a live conversation mirror in the
room.

**Meaningfulness verified.** Both QA suites were run against the pre-fix
implementation (temporary local reverts, restored immediately): bypassing the
eligibility composition fails the closed-conversation and participant tests;
reverting to the flat-id owner lookup fails the R2 observe-count assertion.
No production code was touched by QA.

## Gaps / notes

1. **AC-7's live half is the only open item** and is not CI-testable — it
   requires a real LLM backend and a freshly built `dist`; the evidence
   (`skip share ≤ 25%`, no agent > half of `[step-skip]`, `[plan-enum]`
   cleanliness over 40 minutes) must be attached to issue #206 by QA/live-env.
   The deterministic mechanism is fully pinned by AC-1–AC-6 + the QA
   real-scene AC-7-RS proxy.
2. **Pre-existing test repair in the PR is legitimate.** The change to
   `examples/tests/spec-057-plan-skip-honesty-e2e.test.ts`
   (`verdict=succeeded` → `verdict=skipped`) matches the spec-057 addendum
   source (commit `1ac8a4c`); the corrected assertion is green in the full
   suite and no production behavior changed.
3. Environment note (pre-existing, not a regression): a bare `pnpm test` on a
   fresh checkout needs `pnpm build` first (workspace `@evol-hive/*` dists).

## Pipeline actions taken

- QA report posted on PR #209 (comment).
- Issue #206 confirmed carrying `Status: In Review/QA` (already present).
- This note + the two QA test files committed to the PR branch (precedent:
  spec-056/057 QA notes committed to PR #203/#207).
