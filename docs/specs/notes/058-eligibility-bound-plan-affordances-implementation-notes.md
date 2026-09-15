# Implementation Notes — Spec 058 (Eligibility-Bound Plan Affordances) — Issue #206

> YAAM breadcrumb: the daemon (raw-TCP JSON-RPC on the port recorded in
> `.yaam/daemon.port`; read method `search` with param `text`) indexes the
> workspace notes. Durable session records live here as
> `docs/specs/notes/*.md` (spec-045/spec-050/spec-051 convention).
> PR: [#209](https://github.com/Redna/evol-hive/pull/209) ·
> branch `feature/206-eligibility-bound-plan-affordances`.

## Verdict

Implementation + tests complete and green. The plan `targetAffordance` enum,
the affordance tool list, `prunedAffordances`, the perception/action-choice
tool list, and the drive→affordance matcher all consume the agent-scoped,
moment-scoped **eligible** set. The only open criterion is **AC-7** (the
40-minute live run), which requires a real LLM backend and a freshly built
`dist` — it is QA/live-environment owned and left unchecked.

## What was built

### R1 — Eligibility composed into `getVisibleAffordancesInRoom` (engine)

`packages/engine/src/agents/perception/index.ts`

- New private `eligibleAffordances(roomId, agentId)` — the single eligibility
  predicate shared by `getEligibleAffordancesInRoom` (public contract kept)
  and `getVisibleAffordancesInRoom`.
- `getVisibleAffordancesInRoom` now starts from `eligibleAffordances(...)` and
  then applies the spec-039 explored-area gate + door-sighting gate. The two
  filters are orthogonal and both applied (no short-circuit). An unknown
  `go_to_<room>` still vanishes; an ineligible conversation affordance never
  enters the set.
- Unwired conversation manager (`this.conversationManager === undefined`)
  returns the available set byte-identically — the legacy provider path.

### R2 — Per-object owner resolution (engine)

- Affordances are paired with their **declaring object** via a
  `Map<Affordance, SmartObject>` built from `smartObjectRegistry.getByRoom`,
  matched by **reference identity** — never by scanning the room's flat list
  for a matching affordance id.
- `observe` is declared on nearly every smart object in the dynamic world, so
  the old flat-id lookup could misattribute a conversation affordance to a
  non-conversation owner (and leak it). A duplicate id on an unrelated object
  now passes through unchanged while the conversation's copy is filtered on its
  own object's eligibility.
- `SmartObjectRegistry`'s interface was **not** changed: reference identity is
  reliable because `getAvailableAffordancesInRoom` returns the same affordance
  object references that `getByRoom` exposes. This avoids breaking registry
  test doubles.

### R4 — `[plan-enum]` formulation diagnostic (cognition)

- New `packages/cognition/src/pper/plan-enum-diagnostic.ts`:
  `logPlanEnumDiagnostic(agentId, perception, plan)` emits exactly one line
  `[plan-enum] agent=<id> room=<roomId> enum=[...] chosen=[...]`.
  `enum` is the offered `prunedAffordances` projection; `chosen` is the plan's
  step `targetAffordance` values, or `none` when the plan is absent/failed;
  `enum=[]` when the eligible set is empty.
- Wired in `packages/cognition/src/pper/orchestrator.ts` immediately after the
  plan phase (the spec-049/052 diagnostic seam, alongside `[drive-hint]`),
  inside the existing `try/catch` so a logging failure can never break a cycle.
  The stable system prefix is untouched (spec-021 KV-cache discipline).
- Exported from `packages/cognition/src/pper/index.ts`.

### R3 — no consumer bypass (verification)

No production consumer changes were required: `formulatePlanToolFor`,
`affordancesToToolDefinitions`, `prunedAffordances`, and the perception
action-choice tool list (`maskedAffordances ?? prunedAffordances`) already read
the provider's visible set, and the drive→affordance matcher receives that same
set from the perception builder. This is pinned end-to-end by AC-4/AC-5.
Execute/skip semantics are unchanged — the spec-037 validator and the
execute-time failure/skip/re-validation path remain the runtime backstop.

## Acceptance-criterion → test mapping

| AC | Tests | Notes |
|----|-------|-------|
| AC-1 (R1) | `packages/engine/tests/spec-058-eligibility-bound-plan-affordances.test.ts` | participant sees `contribute`/`leave` not `join`; non-participant sees `join`/`observe` not `contribute`/`leave`; closed → none of the four; unwired → all four (legacy byte-identical); non-conversation affordances present throughout |
| AC-2 (R1) | same file | `go_to_<unknown-room>` removed by the door-sighting gate in the same call that applies eligibility; known `go_to_<room>` survives; both filters compose |
| AC-3 (R2) | same file | non-conversation `observe` survives next to a closed conversation's `observe`; `contribute` is filtered on the conversation object and never dropped from an unrelated object |
| AC-4 (R3) | `packages/assembly/tests/spec-058-plan-enum-e2e.test.ts` | assembled engine + cognition stack: `prunedAffordances`, the `formulate_plan` `targetAffordance` enum, and the affordance tool list are all free of `join`/`contribute`/`leave` for a no-conversation agent; a participant yields `contribute`/`leave` |
| AC-5 (R3) | `packages/cognition/tests/spec-058-plan-enum-diagnostic.test.ts` | `matchDrivesToAffordances` over the filtered set returns no ineligible conversation affordance (positive control over the unfiltered set demonstrates the mechanism) |
| AC-6 (R4) | same file | exactly one `[plan-enum]` line per formulation with agent/room/enum ids/chosen values; `chosen=[none]` and `enum=[]` cases; a thrown diagnostic never propagates |
| AC-7 (live) | — | **OPEN** — 40-minute live run, QA/live-env owned (see below) |
| AC-8 (R1–R3) | full suite | `pnpm test && pnpm typecheck && pnpm lint` green; spec-033/037/039/051 suites pass unmodified; legacy unwired providers byte-identical |

`packages/engine/tests/spec-058-coverage.test.ts` converts the spec scaffolds
into AC coverage pins and asserts the INDEX row status.

## Deviations / follow-ups

- **AC-7 (40-minute live run) NOT executed in this PR.** It requires a real LLM
  backend (`USE_REAL_LLM=true`) and a freshly built `dist`; this sandbox has no
  LLM endpoint. The eligible-enum mechanism is covered deterministically by
  AC-1–AC-6; the live evidence is to be attached to
  [issue #206](https://github.com/Redna/evol-hive/issues/206) by QA.
- **Pre-existing test repair.** `examples/tests/spec-057-plan-skip-honesty-e2e.test.ts`
  asserted `[plan-memory] verdict=succeeded` for a **non-empty skipped** plan,
  contradicting the spec-057 addendum source (commit `1ac8a4c`) which
  intentionally reports `skipped`. The expectation was corrected to match the
  source; no behavior changed.
- No new dependencies. `shared` is untouched. Package boundaries and import
  direction preserved (`shared ← engine`, `shared ← cognition`).

## Resume-verification session record

Resumed with the branch clean at `8c46c49`; all implementation work and the PR
were already in place. This session:

- Independently re-ran the full gate from a clean tree — all exit 0:
  `pnpm test` (8/8 packages; shared 382, visualizer 48, memory 101 (+24 todo),
  cognition 1117 (+1 skipped / +26 todo), engine 896 (+141 todo), assembly 79,
  examples 243 (+3 todo), cli 15), `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check`, `pnpm build`.
- Confirmed PR **#209** is OPEN/MERGEABLE with every CI check **SUCCESS** on
  `8c46c49` (Type Check & Lint, Build, Test, GitGuardian).
- Checked off the verified AC (AC-1–AC-6, AC-8) in the spec; AC-7 stays open
  with the live-run note above.
- Added this implementation-notes file (the durable mirror of the YAAM
  session record).

No further implementation work is outstanding for this spec.
