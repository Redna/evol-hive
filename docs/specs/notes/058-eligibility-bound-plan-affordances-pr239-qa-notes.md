# Spec 058 QA Notes — Test-Coverage Verification for PR #239 (INDEX status drift repair)

> YAAM note (QA session record): coverage verification for PR #239
> (`test/spec-058-index-status`), the CI repair that follows PR #238's INDEX
> reconciliation. Convention: durable session records live here as
> `docs/specs/notes/*.md`; the YAAM daemon indexes them and they are findable
> via the raw-TCP JSON-RPC `search` method on `127.0.0.1:<.yaam/daemon.port>`
> (used in this session). Prior spec-058 QA round for the implementation PR
> #209: `058-eligibility-bound-plan-affordances-qa-notes.md`.

## Verdict

**All gates green; every testable acceptance criterion is mapped; no
acceptance-criterion test was missing.** PR #239 is a test-only change — it
makes the spec-058 INDEX assertion drift-proof instead of pinning the mutable
`🔍 In Review` value. The change does not touch production code, and the
per-layer AC coverage from the implementation PR is intact and still green.

- Coverage: **7/8 ACs covered**; AC-7 (40-minute live run) is live-environment
  evidence owned by issue #206 and is **not CI-testable** (no LLM backend in
  the sandbox). Exactly the same known gap as the #209 QA round.
- QA added **1 guard test** (3 assertions) for the change under review, not for
  an uncovered AC (none exist): `packages/engine/tests/spec-058-index-status-legend.test.ts`.

## Change under review (PR head `3409d77`)

`packages/engine/tests/spec-058-coverage.test.ts` replaced
`expect(row).toContain('🔍 In Review')` with a regex accepting any
legend-declared status marker. Root cause of the CI-red `Test` job: PR #238
correctly reconciled the ledger `🔍 In Review → ✅ Done`, but the coverage test
had pinned the mutable value. The fix is correct in shape (assert validity, not
a specific state).

## Acceptance-criterion → test coverage map (unchanged by this PR)

| AC | Status | Tests |
|----|--------|-------|
| AC-1 (R1) | ✅ COVERED | `packages/engine/tests/spec-058-eligibility-bound-plan-affordances.test.ts` ×4 (participant / non-participant / closed / unwired) |
| AC-2 (R1) | ✅ COVERED | same engine suite ×2 (unknown `go_to_<room>` fogged out alongside eligibility; known one survives) |
| AC-3 (R2) | ✅ COVERED | same engine suite ×2 (duplicate `observe` preserved; conversation-only id dropped) |
| AC-4 (R3) | ✅ COVERED | `packages/assembly/tests/spec-058-plan-enum-e2e.test.ts` ×3 (pruned / `targetAffordance` enum / affordance tool list) |
| AC-5 (R3) | ✅ COVERED | `packages/cognition/tests/spec-058-plan-enum-diagnostic.test.ts` ×3 (filtered matcher, social-effect control, plan-builder render) |
| AC-6 (R4) | ✅ COVERED | same cognition suite ×6 (golden line, `chosen=[none]`, `enum=[]`, exactly one per formulation, thrown diagnostic never propagates, wiring pin) |
| AC-7 (R1–R4, live) | 📋 LIVE GAP | 40-minute `USE_REAL_LLM=true SCENE_DURATION_MS=2400000 npx tsx examples/dynamic-world-sim.ts` run — evidence belongs on issue #206; no LLM backend in CI. Deterministic substrate: `examples/tests/spec-058-eligibility-bound-plan-affordances-e2e.test.ts` (AC-1-RS / AC-4-RS / AC-7-RS proxy) |
| AC-8 (R1–R3) | ✅ COVERED | full-suite regression gate + `packages/engine/tests/spec-058-legacy-path-byte-identity.test.ts` (unwired byte-identity) |

## QA-added test (guards the change under review)

`packages/engine/tests/spec-058-index-status-legend.test.ts` — derives the
status set from the INDEX `## Status Legend` table and asserts the spec-058
row's **status cell** is one of them. This is the semantically-correct version
of the PR's intent: it survives the `In Review → Done` transition (no mutable
value pinned) yet still fails on an empty or undeclared status. It is
independent of the coverage suite's regex, so it cannot silently over-accept.

**Meaningfulness checked:** temporarily substituting a bogus status cell makes
the guard fail; the real `✅ Done` cell passes. No production code touched.

## Verification (fresh `pnpm build` first — fresh checkout has no dists)

- `pnpm test` → **EXIT 0**, 8/8 projects green, zero real failures:
  shared **399**, memory 101 (+24 todo), visualizer **92**, engine **922**
  (+141 todo; +3 QA assertions), cognition 1242 (+1 skipped / +26 todo),
  assembly **89**, examples 253 (+3 todo), cli **24**.
- `pnpm typecheck` → EXIT 0.
- `pnpm lint` → EXIT 0, 0 findings.
- `pnpm format:check` → clean (including the new QA test).

## Gaps / notes

1. **AC-7's live half remains the only open item** — not CI-testable; requires
   a real LLM backend and a freshly built `dist`. Must be attached to issue
   #206 by QA/live-env (`skip share ≤ 25%`, no agent > half of `[step-skip]`,
   `[plan-enum]` cleanliness over 40 minutes).
2. **No open issue is associated with PR #239.** `closingIssuesReferences` is
   empty; the body's `Refs #238` points at a *merged PR*. Spec 058's issue #206
   is closed and already carries `Status: In Review/QA`, so step 11 is applied
   to PR #239 itself (an issue-type object) — the label description is
   literally "PR is under review and QA".
3. Environment note (pre-existing): a bare `pnpm test` on a fresh checkout needs
   `pnpm build` first because workspace `@evol-hive/*` resolve to `dist/`.

## Pipeline actions taken

- QA report posted as a comment on PR #239.
- `Status: In Review/QA` applied to PR #239 (no open tracking issue exists).
- This note + the guard test committed to the PR branch.
