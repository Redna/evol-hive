# Feature: Enum-Bound Conversation Targeting — Close the Free-Choice Talk Loop

> Issue: [#186](https://github.com/Redna/evol-hive/issues/186) — "Talk loop re-emerges via free tool
> choice: 529 monologues despite correct urge gating (diagnostics prove directive suppressed, hints
> decayed) — the +2 monologue reward still sustains s=100". The spec 050 live run (30 min, cc=3,
> promoted assembler, `/home/anima/050run.log`, session-logs-050) showed Tomas (apprentice-1) emit
> **529 `talk_to`→gardener-1 monologues** with social pinned at 100 and only 3 direct replies — while
> every urge-model verdict was *correct* (urge 0.110 < 0.45 threshold, reciprocity decayed 1.0 → 0.275,
> classifications `decayed-hint` 505× / `none` 422×). The spec 024 directive is properly suppressed and
> spec 047's cap keeps `talk_to` un-promoted — but the LLM (gemma) simply picks `talk_to` from the plain
> tool list: **free choice, no urgency, no hint in 422 cycles**. The +2 monologue reward
> (`SOCIAL_MONOLOGUE_REWARD`) keeps s saturated, so the affordance stays plausible forever. This spec
> implements the user-directed design: the `talk_to` target argument becomes an **enum bound per cycle
> to the agents actually present and not past the unanswered cap** (spec 037/039 pattern).

## Context

- Architecture: [§7 — Structured Outputs](../architecture/07-structured-outputs.md) (enum binding as value-space constraint), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (`talk_to` execution path, Req 17 error-feedback), [§2 — System Overview](../architecture/02-system-overview.md) (ADR-0001: interfaces in shared, engine implements, cognition consumes)
- Related specs: [037 — Enum-Bound Plan Formulation](037-enum-bound-plan-formulation.md) (the enum-as-value-space pattern, validator-as-backstop discipline, `[plan-bind]` retry lessons), [039 — Spatial Phase 2](039-spatial-phase2-targetarea-fog.md) (enum-bound `targetArea` on plan steps — the pattern the issue explicitly cites), [046 — talk_to Target Resolution](046-talk-to-target-resolution-sentiment-passthrough.md) (`resolveSocialTarget` choke point, structured-failure pattern, AC-10 backward-compat guard), [047 — Talk Loop Fix](047-talk-loop-urge-gating-asymmetric-reward.md) (`SOCIAL_TALK_CAP = 3`, asymmetric reward, "influence, not force"), [044 — Social Urge Model](044-social-urge-model.md) (reciprocity counters `sentCount`/`receivedCount`, reciprocity factor), [049 — Urge Observability](049-dialogue-completion-urge-observability-reply-window.md) (the `[social-urge]` diagnostic that made this issue precisely measurable), [018 — Multi-Agent Social](018-multi-agent-social.md) (social tools included only when agents are present, Req 34)
- Package: `shared` (per-cycle `talk_to` tool factory, `SocialActionBridge` interface extension), `engine` (`SocialManagerImpl` target enumeration), `cognition` (perception-builder + plan-builder enum wiring, executor validation). No `examples/` changes required.
- Issue: [#186](https://github.com/Redna/evol-hive/issues/186)

### Evidence summary (from the issue — spec 050 live run)

| Signal | Value |
| --- | --- |
| Tomas→Maren monologues | 529 `talk_to` emissions, s pinned at 100, 3 direct replies |
| Urge model verdict | Correct every cycle: urge 0.110 (threshold 0.45), reciprocity 1.0 → 0.275 (floor region) |
| Diagnostic classification | `decayed-hint` 505×, `none` 422× — directive suppressed, cap kept talk_to un-promoted |
| LLM behavior | Free tool choice: picked `talk_to` from the plain tool list with no urgency and no hint in 422 cycles |
| Loop fuel | +2 per monologue emission × 529 keeps social saturated → need never subsides → affordance stays plausible |
| Rest of the run | Validates #166 promoted assembler: 2 conversations, replies flowing, 0 idle closures, 3,707 urge diagnostics, zero wiring errors |

### Root cause

Specs 044/047 gate *attention* (directive, hints, promotion) but never the *value space*: after the
directive suppression and hint decay, `talk_to` remains a plain tool whose `targetAgentId` accepts any
string. Gemma treats the informational decayed hint's mention of Maren as a cue and picks the tool
anyway; the +2 monologue reward re-saturates social on every emission, so the loop is
self-sustaining through free choice alone. The cap (spec 047 R4) only removes urgency-promotion — it
never blocks emission. The missing piece is mechanical: a capped or absent target must not be a
*valid choice*, not merely an un-promoted one.

### User-directed design (authoritative, from the issue)

Fixed enum list for the talk affordance — **only other agents are available to talk to** — following
the spec 038/039 pattern (enum-bound intents, e.g. `targetArea`). The issue's originally proposed
executor-side refusal (R-a) becomes the enum's **last-resort validation** instead of the primary
mechanism; R-b (monologue reward 0 vs +2) is deferred as a secondary consideration (see Decision 3).

## Requirements

### R1 — Per-cycle enum-bound `talk_to` tool (shared + cognition)

A `talkToToolFor(validTargetIds: string[])` factory (mirroring `formulatePlanToolFor`) builds the
`talk_to` tool definition with `targetAgentId` as `{ type: 'string', enum: [...validTargetIds] }`.
The enum is **bound per cycle** to the agent IDs actually present in perception; there is no
free-form target string. `message` and `sentiment` keep their current shape. The static
`talkToTool`/`talkToSchema` remain exported for backward compatibility of tests that assert schema
shape, but both the perceive/action-choice tool list (perception-builder) and the plan-phase tool
list (plan-builder `buildPlanTools`) must consume the per-cycle factory. When the valid-target list
is empty, `talk_to` is **not offered at all this cycle** (nothing valid to talk to) — the tool is
omitted from the tools array while `observe_agent`/`help`/`ignore` render as today. The schema
description is updated: "an agent ID from the enum (agents present right now, not past the
unanswered cap)".

### R2 — The spec 047 cap participates in enum construction (cognition)

The per-cycle valid-target list is: present agent IDs **minus** any target whose
`sentCount − receivedCount ≥ SOCIAL_TALK_CAP` (= 3) for that relationship. A capped target is
excluded from the enum — not a valid choice, not merely un-promoted. The exclusion is per-target
(not global): a fresh target with a healthy reciprocity remains in the enum. The condition clears
mechanically when the target replies (`receivedCount` catches up → the unanswered gap drops below
the cap), which is the reciprocity-recovery path — no separate cooldown timer is introduced.
Classification: the existing `capped` bucket in the social-urge assessment (spec 047/049) is the
single source of the exclusion decision — the enum builder consumes it, no second cap computation.

### R3 — Executor choke-point validation (shared + engine + cognition)

`SocialActionBridge` (shared interface) gains an optional
`enumerateTalkTargets(requesterAgentId): string[]` method returning the per-cycle valid talk targets
for the requester — co-located, active agents minus capped targets, computed engine-side where
agent-state and reciprocity counters live (same ADR layering as `resolveAgentId`).
`SocialManagerImpl` implements it. The executor's `resolveSocialTarget` choke point (spec 046 R2)
validates the resolved target against `enumerateTalkTargets` at call time: a resolved-but-excluded
target returns the standard structured tool failure (spec 046 AC-8 pattern) with an actionable
message — e.g. "You've sent N unanswered messages to {name} — give them space. They'll be available
to talk to again after they reply." — and **nothing is written** (no queue message, no conversation,
no relationship delta, no reciprocity counter). Bridges predating this spec may not carry the method:
for those, the membership check is skipped and the raw resolution passes through bit-for-bit
(spec 046 AC-10 `typeof` guard pattern).

### R4 — Telemetry for the decision review (cognition)

Extend the spec 049 `[social-urge]` diagnostic line with the enum outcome per cycle (present count,
valid count, excluded IDs), e.g. `[talk-enum] agent=apprentice-1 present=1 valid=0 excluded=[gardener-1]`.
This is the evidence base for Decision 3 below.

### R5 — Deferred decision: monologue reward sign (shared — intentionally unchanged)

`SOCIAL_MONOLOGUE_REWARD` stays `+2` in this spec. The issue directs evaluating whether R1–R3 alone
extinguish the loop **before** changing the reward sign: the minimal mechanism consistent with the
urge philosophy (influence, not force) is preferred, and the retroactive +8 exchange top-up already
makes real exchanges strictly better. The R4 telemetry (monologue emission rate per agent-pair before
vs after) is the review artifact; a follow-up spec flips the constant to 0 only if the loop persists.

## Acceptance Criteria

- [ ] **AC-1** (R1): `talkToToolFor(['agent-bob'])` produces a tool definition whose
  `targetAgentId` schema is `{ type: 'string', enum: ['agent-bob'] }` with `message`/`sentiment`
  unchanged — unit-tested in `shared`.
- [ ] **AC-2** (R1): with agents present, the perception-builder's tool list contains `talk_to` with
  the per-cycle enum of present, uncapped agent IDs; no free-form target description remains —
  unit-tested in `cognition`.
- [ ] **AC-3** (R2): a target with `sentCount − receivedCount ≥ 3` is absent from the enum while
  another present target with a healthy gap remains — unit-tested (extends
  `spec-047-talk-loop-urge-gating.test.ts` fixtures).
- [ ] **AC-4** (R1/R2): when no agents are present, or every present agent is past the cap,
  `talk_to` is absent from the perceive/action-choice and plan tool arrays — no crash, other social
  tools render — unit-tested.
- [ ] **AC-5** (R2): after the target replies (`receivedCount` incremented so the gap < cap), the
  target re-enters the enum on the next cycle — unit-tested.
- [ ] **AC-6** (R3): `executeTalkTo` with a resolved target outside `enumerateTalkTargets` returns
  the structured failure naming the cap, writes nothing (queue, conversation, relationships,
  counters), and leaves prior state untouched — unit-tested in `cognition` + `engine`.
- [ ] **AC-7** (R3): a bridge without `enumerateTalkTargets` preserves spec 046 behavior exactly
  (backward-compat `typeof` guard) — unit-tested.
- [ ] **AC-8** (R4): the `[talk-enum]` (or extended `[social-urge]`) diagnostic renders present /
  valid / excluded counts per cycle — unit-tested, and the spec 049 diagnostic tests keep passing.
- [ ] **AC-9** (R5): `SOCIAL_MONOLOGUE_REWARD` remains `2` after this spec's implementation — the
  deferred decision is tracked by R4 telemetry, not by a code change in this spec.
- [ ] **AC-10** (R1–R3, live): in a 30-min live run (cc=3, same scene as spec 050), Tomas's
  monologue count toward Maren drops from 529 to a bounded number (target: ≤ 10), social is not
  pinned at 100 for the run, and no `[social]` line shows a message queued to an excluded target.

## Constraints

- **KV-cache (spec 021)**: the enum lives inside the per-cycle tool-definition block, never in the
  stable system prompt prefix — same discipline as the spec 037 `targetAffordance` enum.
- **Validator is the backstop**: Ollama/gemma tool calling does not hard-enforce enums
  (grammar-constrained only — spec 037 constraint); R3's executor validation is what actually
  guarantees the value space at runtime. Telemetry (R4) measures the real constraint rate.
- **Do not make new schema fields `required`**: the required-field revert hazard (`2267354`, spec 037)
  applies to adding *new* required properties. `targetAgentId` is already required and enum is only a
  value constraint on the existing property — the same shape as spec 039's `targetArea`, which
  validated live.
- **Reuse, don't duplicate**: the cap condition derives from `SOCIAL_TALK_CAP` and the existing
  reciprocity counters — no new thresholds, no second cap computation; the enum builder consumes the
  `capped` classification the urge model already computes.
- **Engine is source of truth for validity**: the enum the LLM sees is built from
  `agentsPresent` (what it perceives), but runtime validation consults the engine bridge — a
  transient disagreement resolves to a structured tool error, never a write.
- **Influence, not force (spec 044)**: the enum constrains the *value space* of invalid targets; it
  does not force any action, promote anything, or remove the agent's decision among valid targets.
- **Package boundaries**: `shared` owns the factory + bridge interface; `engine` implements
  enumeration; `cognition` consumes. No changes to `examples/` wiring; spec 050's assembler stays
  untouched.
- **Backward compat**: bridges predating this spec (no `enumerateTalkTargets`) must behave exactly
  as spec 046 — the guard is a `typeof` check, not an interface break.
- **Rebuild dist before live validation** — live sims import built dist; a stale dist silently runs
  old code (2026-09-06 operational note, spec 037).

## Design Decisions

**Decision 1 — Enum-first, executor-refusal-last (user-directed).** The issue's R-a (executor-side
refusal at cap) is demoted: the primary mechanism is the enum construction (R2), and the executor
check (R3) is the last-resort validator for the un-enforceable-backend case and for engine/cognition
timing drift. This inverts the original proposal per the issue's authoritative addendum.

**Decision 2 — Recovery is mechanical, not timed.** "Until the target replies or reciprocity
recovers" needs no cooldown timer: `receivedCount` increments only on a reply, so the unanswered gap
is the clock. A pure function of existing state — deterministic, testable, and consistent with the
urge model's arithmetic (reciprocity factor recovers through the same reply).

**Decision 3 — R-b deferred, measured, then maybe flipped.** Zeroing the monologue reward is the
blunt instrument; the enum removes the *invalid* outlet while leaving valid social exchange intact.
If live validation (AC-10) still shows a self-sustaining loop through valid-but-unanswered targets
below the cap, a follow-up spec evaluates `SOCIAL_MONOLOGUE_REWARD = 0` with R4's telemetry as
evidence. One mechanism per spec — reviewable, revertible.
