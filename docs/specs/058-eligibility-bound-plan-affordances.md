# Feature: Eligibility-Bound Plan Affordances — Constrain the Plan Value Space to the Agent's Moment-Scoped Eligible Set

## Context

- Architecture: [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (affordances are the value space; `conditions`/`engineEffect` are the engine's contract), [§6 — PPER Loop](../architecture/06-pper-loop.md) (Perceive builds the affordance set; Plan enum-binds it; Execute fails ineligible steps and the spec-037 guard skips them), [§7 — Structured Outputs](../architecture/07-structured-outputs.md) (enum binding as a value-space constraint), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (validator-as-backstop, masking/forcing), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (social drive, plan outcomes), [§5 — Fast-Path Classifier](../architecture/05-fast-path-classifier.md) (the pruning funnel that consumes the affordance set)
- Related specs: [051 — Enum-Bound Conversation Targeting](051-enum-bound-talk-targets.md) (the identical pattern one layer down — free-choice `talk_to` target → per-cycle enum; 529 monologues → 3), [037 — Enum-Bound Plan Formulation](037-enum-bound-plan-formulation.md) (`formulatePlanToolFor` enum + the step-skip livelock guard whose skip counters this issue reports), [033 — Conversations as Perceivable Temporal Objects](033-conversations-identity-evolution.md) (`getEligibleAffordances` role projection — the source of truth this spec wires into the plan path), [039 — Spatial Phase 2](039-spatial-phase2-targetarea-fog.md) (`getVisibleAffordancesInRoom` fog filter), [031 — Execute-Time Co-Location Guard](031-execute-colocation-guard.md) (residual stale-plan re-validation), [052 — Greenhouse Drive Diagnostics](052-greenhouse-drive-restoration-diagnostics.md) (`[drive-hint]` funnel that already logs `enum=[…]`), [056 — Plan Supersession](056-plan-supersession-stamping.md) / [057 — Plan Skip Honesty](057-plan-skip-outcome-honesty.md) (honest skip reporting — a prerequisite already at HEAD), [049 — Diagnostic Pattern](049-dialogue-completion-urge-observability-reply-window.md) (zero-LLM stderr diagnostics), [021 — KV-Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (the enum rides the dynamic tool block only)
- Package: `engine` (perception provider + registry owner resolution; the eligibility projection), `cognition` (one diagnostic + tests). `shared` is unchanged; no new dependencies.
- Issue: [#206 — Plan channel livelock](https://github.com/Redna/evol-hive/issues/206)

## Problem Summary (live-run verified, four 40-min runs from the issue)

| Run                        | states | affordance execs | step skips | skip share | final drives (e/h/s)           |
| -------------------------- | ------ | ---------------- | ---------- | ---------- | ------------------------------ |
| 053run                     | 355    | 40               | 600        | **94%**    | 8/4/11 · 42/54/25 · 15/12/8    |
| 054run                     | 356    | 44               | 611        | **93%**    | 7/14/11 · 42/54/27 · 13/12/8   |
| 055run                     | 356    | 44               | 322        | **88%**    | 18/4/16 · 32/44/28 · 27/22/43  |
| 056run (killed ~15–20 min) | 137    | 56               | 10         | 15%        | 51/51/67 · 64/61/66 · 52/48/49 |
| 056brun (40 min)           | 475    | 68               | 503        | **88%**    | **0/0/0** · 40/54/13 · 5/2/11  |

The plan-phase value space is built from the room's **declared** affordance list. That list contains the
conversation smart object's four static affordances (`join`, `contribute`, `leave`, `observe` —
`conversation-manager.ts:97`), but whether each is _executable_ is per-agent and dynamic:
`ConversationManagerImpl.getEligibleAffordances()` (`conversation-manager.ts:382`) projects
`['contribute','leave']` for participants, `['join','observe']` for co-located non-participants,
`['observe']` otherwise, and `[]` when the conversation is closed. An affordance therefore sits in the
plan enum while being **ineligible for that agent, at that moment**: the LLM plans it (it reads as a
social restorer for a low social drive), it fails twice, the spec-037 livelock guard advances past it,
and the plan channel is consumed by steps that could never run. In the 056brun evidence one agent
(`iris-1`) accounted for **500 of 503 skips**, with `[plan-create]` narrating the loop explicitly, and
`[plan-repeat]` never fired because each re-proposal is a different narrative phrasing.

**Root cause.** The eligibility projection already exists (`getEligibleAffordancesInRoom`,
`perception/index.ts:291`) and the conversation manager is already wired into the perception bridge
(`engine/src/assembly.ts:303`), but the PPER perceive path never calls it:
`getVisibleAffordancesInRoom()` (`perception/index.ts:151`) applies only the spec-039 fog filter over
`getAvailableAffordancesInRoom()`. `getEligibleAffordancesInRoom` has **zero production callers**. The
plan builder then enum-binds `formulatePlanToolFor(prunedAffordances…)` to the unfiltered set, so
ineligible conversation affordances are first-class values the LLM can choose. This is the spec-051
failure shape (free choice of an invalid target) one layer up — the fix is the spec-051 fix, generalized
from the `talk_to` target to the whole affordance enum: **an ineligible affordance must not be a valid
choice, not merely an un-promoted one.**

## Requirements

### R1 — Compose the conversation-eligibility projection into `getVisibleAffordancesInRoom` (engine)

`getVisibleAffordancesInRoom(agentId, roomId)` returns the room's available affordances after **both**
the spec-039 fog filter **and** the spec-033 eligibility filter. A conversation-owned affordance is
included only when its owning conversation's `getEligibleAffordances(conversationId, agentId)` lists its
id; a closed conversation therefore contributes nothing. Non-conversation affordances pass through
unchanged, and the existing availability rules (`conditions` evaluation, the movement filter) still
apply. This makes `perception.prunedAffordances` the agent-scoped, moment-scoped eligible set, which is
what `formulatePlanToolFor` enum-binds and what the perception builder's tool list and the drive→
affordance matcher consume. When the conversation manager is unwired (legacy doubles), behavior is
byte-identical to today (the established `undefined` guard).

### R2 — Correct per-object owner resolution (engine)

Eligibility must be decided from the **owning object**, never by looking up an affordance id across a
room's flat list. `getEligibleAffordancesInRoom`'s current owner lookup
(`objects.find((o) => o.affordances.some((a) => a.id === affordance.id))`) is ambiguous for ids shared
with non-conversation objects — `observe` is declared on nearly every smart object in the dynamic world
(`examples/dynamic-world.ts`), so a conversation's `observe` can be misattributed to a non-conversation
owner and leak through. `getEligibleAffordancesInRoom` and `getVisibleAffordancesInRoom` share one
eligibility predicate that resolves ownership per object (e.g. an owner-annotated registry read:
`{ objectId, objectType, affordance }`), so a duplicate id on a non-conversation object is preserved
and a conversation affordance is filtered on its own object's eligibility. `getEligibleAffordancesInRoom`
keeps its current public contract and output for the no-collision case.

### R3 — The plan value space and all its consumers use the projection (verification, no bypass)

The plan tool enum (`formulatePlanToolFor`), the affordance tool list
(`affordancesToToolDefinitions`), `prunedAffordances`, the perception/action-choice tool list
(`maskedAffordances ?? prunedAffordances`), and the drive→affordance matcher must all see the
eligibility-filtered set in the production path (the cognition pipeline already prefers
`getVisibleAffordancesInRoom`; this requirement verifies no fallback re-introduces ineligible
conversation affordances). No cognition behavior change is intended beyond R4 and tests; the spec-037
plan validator remains the last-resort backstop for any hallucinated value. Execute-time semantics are
unchanged: if a step becomes ineligible between formulation and execution (conversation closes
mid-plan), the existing failure + spec-037 skip + spec-031 re-validation path still applies.

### R4 — `[plan-enum]` formulation diagnostic (cognition)

One zero-LLM `console.log` line per plan formulation at the perceive→plan seam (the spec-049/052
diagnostic home), carrying: agent id, room id, the `targetAffordance` enum IDs the LLM was offered
(the `prunedAffordances` projection), and the chosen step `targetAffordance` values. This makes "was
`join`/`contribute`/`leave` in the enum?" mechanically checkable from run logs — the live evidence that
the skip storm's fuel is gone. Wrapped so a logging failure can never break a cycle; prompt stability
untouched (spec 021). No line is a failure: the line states `enum=[]` when the set is empty.

## Acceptance Criteria

- [x] **AC-1** (R1): Engine unit test — with an open conversation in the agent's room, a participant's
      `getVisibleAffordancesInRoom` contains the conversation's `contribute`/`leave` and **not**
      `join`; a co-located non-participant contains `join`/`observe` and not `contribute`/`leave`; when
      the conversation is closed, none of the four appear; with the conversation manager unwired, all
      four appear (byte-identical legacy path). Non-conversation affordances are present in every case.
      _(maps to R1)_
- [x] **AC-2** (R1): Fog composition test — a `go_to_<unknown-room>` affordance is still removed by the
      door-sighting gate in the same call that applies eligibility, and a known `go_to_<room>`
      survives; both filters compose without either one short-circuiting the other. _(maps to R1)_
- [x] **AC-3** (R2): Collision test — a room containing a non-conversation object that declares
      `observe` plus a closed conversation object declaring `observe` keeps the non-conversation
      `observe` in the result; a conversation-only id (`contribute`) is filtered from the conversation
      object and never dropped from an unrelated object. _(maps to R2)_
- [x] **AC-4** (R3): Cognition/integration test over the assembled engine + cognition stack — an agent
      with no open conversation in its room yields `prunedAffordances`, the `formulate_plan` tool's
      `targetAffordance` enum, and the affordance tool list all free of `join`/`contribute`/`leave`,
      while non-conversation affordances remain; an eligible participant yields `contribute`/`leave`.
      _(maps to R3)_
- [x] **AC-5** (R3): Matcher test — `matchDrivesToAffordances` and the rendered drive/chain hints never
      reference an ineligible conversation affordance, because they consume the same filtered set.
      _(maps to R3)_
- [x] **AC-6** (R4): Diagnostic test — exactly one `[plan-enum]` line is emitted per formulation,
      containing the agent id, room, the enum IDs, and the chosen `targetAffordance` values (or
      `chosen=[none]`/`enum=[]` for the empty cases); a thrown diagnostic never propagates.
      _(maps to R4)_
- [ ] **AC-7** (R1–R4, live — QA/live-env; not run in this PR, see [implementation notes](notes/058-eligibility-bound-plan-affordances-implementation-notes.md)): A **40-minute** live run (`USE_REAL_LLM=true SCENE_DURATION_MS=2400000 npx tsx examples/dynamic-world-sim.ts`, cc=3, 3 agents, the #206 scene) shows skip share
      `skips / (execs + skips) ≤ 25%` (baseline 88–94%) and no single agent accounting for more than
      half of all `[step-skip]` lines; every `[plan-enum]` line for an agent with no eligible
      conversation contains none of `join`/`contribute`/`leave`; `[plan-repeat]` stays bounded; the run
      is executed against a freshly built dist (`pnpm build`). Evidence attached to issue #206.
      _(maps to R1–R4)_
- [x] **AC-8** (R1–R3): Regression — `pnpm -r test && pnpm typecheck && pnpm lint` pass; the spec-033
      eligibility tests, the spec-037 enum/skip tests, the spec-039 fog tests, and the spec-051
      `[talk-enum]` tests pass unmodified; legacy providers without a conversation manager are
      byte-identical. _(maps to R1, R2, R3)_

## Constraints

- **Package boundaries**: only `engine` (the `getVisibleAffordancesInRoom`/`getEligibleAffordancesInRoom`
  predicate, plus the registry read that lets ownership be resolved per object) and `cognition` (the R4
  diagnostic + tests) may change. `shared` is untouched — no new type fields, no new dependency,
  `shared ← engine`/`shared ← cognition`/`memory ← cognition` all hold; no import cycles.
- **One source of truth**: the eligible set is `ConversationManagerImpl.getEligibleAffordances()`. The
  fix consumes it; it must not be duplicated, re-derived, or re-implemented in cognition. No new
  threshold, no cooldown, no cap.
- **Compose, never replace**: eligibility is orthogonal to fog (spec 039), `conditions`, and the
  movement filter (spec 030). All four apply to the same result. Determinism is preserved — the filter
  is pure, synchronous, and reads only the conversation manager + registry.
- **Validator is the backstop**: Ollama/gemma tool calling does not hard-enforce enums (grammar-only);
  the spec-037 plan validator and the execute-time failure path remain the runtime guarantee. This spec
  removes invalid values from the offered set; it does not assume the backend honors the enum.
- **Influence, not force (spec 044)**: constraining the value space removes invalid choices; it does not
  force an action, promote an affordance, or change `getEligibleAffordances`' role rules. The
  conversation lifecycle, idle timeout, and close conditions are untouched.
- **KV-cache (spec 021)**: the filtered enum rides the per-cycle tool-definition block, never the stable
  system prefix. No new line is added to the stable section.
- **Diagnostic discipline (spec 049)**: one line per formulation, zero LLM calls, pure string
  arithmetic, and a diagnostic failure never breaks a cycle.
- **Live-run discipline**: live sims resolve workspace packages to built `dist/`, so `pnpm build` must
  run before the AC-7 run (a stale dist silently runs old code — spec 037 operational note).
- **What NOT to do**:
  - **Do not change execute/skip semantics.** The spec-037 two-consecutive-failure guard, the
    `[step-skip]` line, and the `stepSkipped` flag are deliberate livelock defense. This spec changes
    what the LLM is _offered_, never what the engine _does_.
  - **Do not filter by affordance id across the flat room list.** `observe` collides with
    non-conversation objects; ownership is per object (R2).
  - **Do not make eligibility a cognition-side check.** The projection lives engine-side where
    conversation state and agent location live (ADR-0001 layering); cognition consumes what the
    provider returns.
  - **Do not add a new required schema field** — the required-field revert hazard (spec 037) applies.
  - **Do not break the legacy provider path** — an unwired conversation manager must behave exactly as
    before.

## Design Decisions

**Decision 1 — Generalize the spec-051 enum philosophy to the whole plan affordance value space
(user-directed).** Spec 051 removed the free-choice `talk_to` target by enum-binding it per cycle
(529 monologues → 3). The skip storm is the same defect one layer up: the plan's `targetAffordance`
enum advertises values the agent cannot execute. The highest-leverage, best-precedented fix is to make
the enum the _eligible_ set — not to add another suppression heuristic around it.

**Decision 2 — Compose the existing projection rather than build a new one.** `getEligibleAffordances`
already encodes participant/non-participant/closed role rules and is already wired into the perception
bridge. The defect is purely that the plan path never calls it. Reusing it keeps one source of truth
and avoids drift between the talk-target enum (spec 051) and the affordance enum.

**Decision 3 — Fix owner resolution while wiring it.** The existing `getEligibleAffordancesInRoom`
lookup is ambiguous for ids shared with non-conversation objects (`observe`). Wiring an ambiguous
predicate into the hot plan path would silently mis-filter common affordances, so R2 is a prerequisite,
not an optional cleanup.

**Decision 4 — Honest outcomes are a prerequisite, already at HEAD.** Spec 057 (issue #204) makes
skipped steps visible in plan memory; without it the false `success: true` keeps the loop
self-reinforcing. This spec assumes 057 and does not duplicate it.

**Decision 5 — Deferred: chain reachability and conversation liveness.** The issue's other two candidate
designs are real but distinct root causes and are intentionally out of scope here, one mechanism per
spec:

- **Chain matcher reachability** (gardener-1's hunger decay: no in-room restorer, `hint=false`,
  `prunedAway=[]`, only `go_to_greenhouse` in the enum) is a cross-room/perception-and-fog problem —
  surfacing a restorer two rooms away requires a known-room affordance scan and multi-hop planning,
  not an enum fix. It needs its own spec.
- **Conversation liveness** (threads die within ~10 minutes, removing the social channel) is a
  lifecycle/economy question for specs 044–051, not a value-space fix.
  The issue's headline plan-channel pathology (500/503 skips, one agent) is addressed here; the
  drive-decay amplifier is tracked by the follow-ups.

## Amendment (issue #224 — a closed conversation is removed, not filtered)

The AC-4-RS mechanism originally assumed a **closed** conversation's mirror persists in the registry,
so the eligibility filter — not absence — is what keeps its affordances out of the value space, and
AC-3 used such a mirror to prove the filter is per-object rather than a flat-id lookup.

Issue **#224** invalidated that assumption: the mirror was never removed, so every conversation ever
opened kept contributing a room object plus its four affordances — unbounded room state, perception
pollution and enum growth (62 dead mirrors after 26 minutes of one live run). That is precisely the bug
class spec 033 forbids in its own Constraints ("**No unbounded growth anywhere** (Redna/yaam#124 class of
bug)"), so the bounded-state constraint wins: `close()` now removes both halves of registration
(`registry.remove` + the `room.objectIds` reference).

What changes here and what does not:

- **Unchanged (R1/R3 property):** a closed conversation contributes nothing to `prunedAffordances`, the
  `formulate_plan` enum or the affordance tool list. The property is now *stronger* — the offer is
  absent rather than offered-and-rejected, so a closed conversation cannot fuel a skip storm at all.
- **Unchanged (R2 protection):** the filter must still be per-object, never a flat id. That protection is
  now exercised through an **open** conversation instead: a participant's eligible set is
  `contribute`/`leave`, so the conversation mirror's own `observe` copy is the offered-but-ineligible
  collision case — the single copy the filter removes, with every non-conversation `observe` preserved.
- **Changed:** the closed case is no longer the offered-but-ineligible shape, and spec 033's
  `getEligibleAffordances` closed→`[]` rule is now belt-and-braces rather than the only guard.

Mechanism coverage: `examples/tests/spec-058-eligibility-bound-plan-affordances-e2e.test.ts` (both the
closed→absent case and the open-collision case) plus
`packages/engine/tests/spec-224-conversation-mirror-lifecycle.test.ts`.
