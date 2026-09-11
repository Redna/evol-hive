# Feature: Greenhouse Drive Bottoming-Out — Restoration Pruning Exemption, Critical-Drive Wait Guard & Drive-Hint Run Observability

> Issue: [#183](https://github.com/Redna/evol-hive/issues/183) — "Greenhouse agents still bottom out: Iris &
> Tomas at all-zero drives at run end while garden-based Maren stays healthy (e=8 h=3 s=5)". In the spec-049
> live run (30 min, cc=3) the greenhouse-resident agents ended at all-zero drives (Tomas co=0 cu=19) while
> garden-resident Maren stayed healthy (e=8 h=3 s=5 co=39 cu=38). Spec 048's decay scaling works (Maren never
> crashed), so the remaining failure is greenhouse-local: restoration affordances pruned/unreachable, or wait
> domination at low drives.

## Context
- Architecture: [§5 — Fast-Path Classifier](../architecture/05-fast-path-classifier.md) (System-0 similarity pruning — the pruning funnel sits *before* both the LLM tool list and the drive→affordance matcher), [§6 — PPER Loop](../architecture/06-pper-loop.md) (the perceive→plan seam where diagnostics land), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (masking / forcing / plan validation), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (drives, decay, primary drive = lowest value), [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (declared `effects` as the single restoration source of truth)
- Related specs: [032 — Dynamic-World Drive Restoration](032-dynamic-world-drive-restoration.md) (greenhouse restorers: `rest_among_seedlings` comfort+15/energy+4, `eat_herbs` hunger+20; "every room must restore energy"), [034 — Drive→Affordance Hints](034-drive-affordance-hints-hunger-chain.md) (`DRIVE_URGENCY_THRESHOLD = 40`, matcher contract, no hardcoded tables), [048 — Drive-Economy Rebalance for cc=3](048-drive-economy-rebalance-cc3.md) (decay scaling — validated working by Maren's trace in #183; economy audit; chain progress), [049 — Dialogue Completion Observability](049-dialogue-completion-urge-observability-reply-window.md) (the `[social-urge]` perceive→plan diagnostic pattern this spec extends to drives), [016 — Cognitive Guardrails](016-cognitive-guardrails.md) (plan-validation mechanism for the wait guard), [021 — KV-Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (diagnostics are console-side — prompt stability untouched), [039 — Spatial Fog of War](039-spatial-navigation-fog-of-war.md) (door-sighting gate — movement exemption context)
- Package: `cognition` (classifier pruning exemption, orchestrator diagnostic, plan-builder critical-drive directive, guardrail wait check), `shared` (additive `PruneOptions`/config fields), `engine` (none expected), `examples` (scene reconciliation: Tomas)
- Issue: [#183 — Greenhouse agents still bottom out](https://github.com/Redna/evol-hive/issues/183)

## Problem Summary

| Signal | Value |
| --- | --- |
| Maren (gardener-1, garden) | e=8 h=3 s=5 co=39 cu=38 — restoration ran, no crash (048 scaling works) |
| Iris (iris-1, greenhouse) | e=0 h=0 s=0 co=0 cu=0 — all zero |
| Tomas (apprentice-1, greenhouse) | e=0 h=0 s=0 co=0 cu=19 — all but curiosity zero |
| Greenhouse restorers present in scene | `rest_among_seedlings` (+15 comfort/+4 energy, potting-table-1), `eat_herbs` (+20 hunger, seed-shelf-1) |
| System-0 pruning | cosine ≥ 0.3 vs primary-drive label, `CLASSIFIER_TOP_K = 5`; only `go_to_*` exempt |
| Run scene | contained `apprentice-1` (Tomas) — **not present in `examples/dynamic-world.ts` at HEAD** |

Three structural findings at HEAD:

1. **The pruning funnel can hide the restorers exactly when they matter.** The matcher
   (`drive-affordance-matcher.ts`) and the perception hint renderer both consume
   `maskedAffordances ?? prunedAffordances`. The System-0 classifier prunes by cosine similarity between
   the *primary drive label* and affordance *labels* (`threshold 0.3`, `topK 5`), with one exemption:
   `go_to_*` movement. The greenhouse's `rest_among_seedlings` ("Rest among the seedlings") and
   `eat_herbs` ("Eat a fresh herb") have no exemption — when the primary drive label embeds far from
   "rest among the seedlings" (e.g. primary drive `energy`, or `hunger` vs an energy-restoring label),
   the restorer is dropped. Then **both** the hint system and the LLM's tool enum lose it: the agent
   cannot hint at, or call, the affordance that would save it. Maren survives because the garden room
   offers six objects, so restorers survive topK and threshold; the greenhouse offers only three objects.
2. **An all-`wait` plan is never rejected while drives starve.** The plan-builder system prompt
   *endorses* wait ("Use wait when no affordance is relevant"), and no guardrail rejects a
   wait-only plan when a critical drive has a directly-restoring affordance in the current enum. At low
   drives the LLM can rationally pick wait cycle after cycle (suspect 3 in the issue) — hints are
   information, and nothing structural stops passivity.
3. **Drive-hint behavior is unauditable from run logs** — the exact diagnosis gap spec 049 closed for
   social urges: we cannot distinguish "the restorer was pruned away" from "the hint rendered and the LLM
   chose wait". The issue's next step ("dump what the greenhouse agents actually see when drives are near
   zero") is this spec's R1.
4. **Reproducibility**: the run used a 3-agent scene variant (Tomas) that does not exist at HEAD, so the
   #183 observation cannot be reproduced from `main` without re-deriving the scene by hand.

## Requirements

### Req 1 — `[drive-hint]` perceive→plan diagnostic (cognition)
Following the spec-049 `[social-urge]` pattern (Decision 1: the orchestrator, not the builders, owns
console diagnostics), `PPEROrchestratorImpl` emits exactly one grep-able diagnostic line per cycle,
prefixed `[drive-hint]`, when **any hintable drive** (`HINTABLE_DRIVES`) is below
`DRIVE_URGENCY_THRESHOLD`. The line carries, on one console.log line:
- agent id, current room id, primary drive label (the classifier's pruning query);
- the pruning funnel: affordances in room → after pruning → after masking (counts + final enum IDs);
- per urgent drive: whether a perception/plan hint rendered, and the restoring-affordance IDs that
  exist **in the room** but were **dropped by pruning** (the "rendered vs pruned-away" distinction);
- the plan's `targetAffordance` choices (R3's choice side) after the plan phase completes — so
  "rendered but not chosen" vs "not rendered" vs "not present" is mechanically distinguishable from logs.
Pure bookkeeping off data the orchestrator already holds (perception result, drive snapshot, plan) —
tick arithmetic and strings only; no LLM calls; no prompt changes (spec 021 KV-cache discipline
untouched).

### Req 2 — Restoration exemption in System-0 pruning (cognition)
`AffordanceClassifierImpl.prune` must never drop an affordance whose declared `effects` contain a
strictly positive entry for a drive that is **currently urgent** (below `DRIVE_URGENCY_THRESHOLD`) —
the same data-driven rule the matcher uses (spec 034 Req 3: declared `effects` are the only source of
truth; no hardcoded drive→affordance table). This extends the existing movement exemption
(`go_to_*` is never pruned because navigation is the means to every drive) to restoration: a declared
restorer is the remedy for its drive and must survive the funnel that sits before the tool enum.
Mechanically: `PruneOptions` gains an optional `urgentDrives?: readonly string[]` field (additive,
legacy call sites omit it and behavior is byte-identical); the perceive path
(`packages/cognition/src/pper/index.ts`) passes the agent's urgent hintable drives. The greenhouse
failure mode becomes structurally impossible: with energy or hunger urgent, `rest_among_seedlings` /
`eat_herbs` survive pruning and appear in both the tool enum and (via the existing matcher) the hints.

### Req 3 — Critical-drive wait guard (cognition guardrails)
A plan-level guardrail check (§10 mechanism family, spec 016 pattern): when (a) a hintable drive is
below a **critical threshold** (config, `DRIVE_CRITICAL_THRESHOLD`, default 10) and (b) a
directly-restoring affordance for that drive is present in the current post-prune enum, a plan whose
steps' `targetAffordance` values are **all** `wait` is rejected with an actionable reason
(`critical drive <drive> is starving and "<restorer>" is available — plan a restoring step`). The
existing plan-failure recovery path re-prompts; the strengthened imperative hint
(`formatPlanDriveHint`'s "Call such an affordance NOW") already tells the LLM what to do. `wait`
stays in the enum — mid-chain agents legitimately wait for ripening states (spec 034's gated `eat`) —
only total passivity under a critical, directly-restorable drive is rejected. Gated by a
`GuardrailConfig` flag (`waitSuppression`, default `true`) with the established env→config plumbing.

### Req 4 — Scene reconciliation: Tomas at HEAD (examples)
Add `apprentice-1` (Tomas) to `DYNAMIC_WORLD_SCENE` in `examples/dynamic-world.ts` as a third agent,
matching the #183 run population (3 agents: gardener-1 garden, iris-1 greenhouse, apprentice-1
greenhouse; Tomas's inferred seed 0.8 per the spec-049 seed audit). This makes the cc=3 decay scaling
(spec 048 Req 1: divisor = live agent count) and the #183 observation reproducible from `main` without
re-deriving the scene. No affordance/handler changes — agent profile only, additive to the scene's
`agents` array.

### Req 5 — Live-run validation protocol (evidence)
A 30-min real-LLM run at cc=3 with the reconciled scene (`USE_REAL_LLM=true SCENE_DURATION_MS=1800000
npx tsx examples/dynamic-world-sim.ts`) is the acceptance instrument: the `[drive-hint]` lines are
collected, and the issue's question is answered with data — for each greenhouse agent, whether each
urgent drive's restorer was pruned (R1 dropped-IDs), rendered (R1 hint flag), and chosen (R1
targetAffordance). Final `logState()` sample per spec-048 Req 5. Evidence (drive traces + diagnostic
excerpts) attached to issue #183.

## Acceptance Criteria
- [ ] **AC-1**: Deterministic pruning-exemption test: with energy < 40, an agent in the greenhouse keeps
  `rest_among_seedlings` in the pruned set even when its label embeds below the similarity threshold;
  with hunger < 40, `eat_herbs` survives; with all drives ≥ 40, pruning behaves byte-identically to
  pre-change (legacy `PruneOptions` omission path — existing classifier tests pass unmodified).
  *(maps to Req 2)*
- [ ] **AC-2**: Deterministic wait-guard test: with a hintable drive at 8 and its direct restorer in the
  enum, an all-`wait` plan is rejected with a reason naming the drive and the restorer; with the drive at
  25, the same plan passes; with no restorer in the enum, the same plan passes (no phantom forcing);
  with `waitSuppression: false` the guard is inert. *(maps to Req 3)*
- [ ] **AC-3**: Deterministic diagnostic test: with a greenhouse agent below the urgency threshold, the
  orchestrator emits exactly one `[drive-hint]` line containing agent id, room, primary drive label, the
  three funnel counts, per-drive hint-rendered flags, pruned-away restorer IDs, and the chosen
  `targetAffordance` after the plan phase; no line when all hintable drives ≥ 40. *(maps to Req 1, Req 4's
  funnel data, and the choice side of the issue's question)*
- [ ] **AC-4**: Deterministic scene test: `DYNAMIC_WORLD_SCENE` declares exactly `gardener-1`, `iris-1`,
  `apprentice-1`; Tomas starts in the greenhouse; the spec-049 seed-audit ordering (Tomas 0.8 > Iris
  0.25 > Maren 0.15) still holds. *(maps to Req 4)*
- [ ] **AC-5**: Live 30-min cc=3 run with the reconciled scene ends with **no greenhouse agent drive at 0**
  (every drive > 0 for iris-1 and apprentice-1 in the final sample — the #183 headline symptom); Maren's
  spec-048 behavior is unchanged (no regression). Evidence attached to issue #183. *(maps to Req 2, Req 3,
  Req 5 — the issue's acceptance, extending spec-048 AC-1 to the per-agent level)*
- [ ] **AC-6**: From the AC-5 run's `[drive-hint]` log, for each urgent greenhouse drive, exactly one of
  "pruned away (IDs listed)", "hint rendered, LLM chose <aff>", or "hint rendered, LLM chose wait
  (guard fired)" is assertable from logs alone — the R1 diagnosis table is filled with data, not inference.
  *(maps to Req 1, Req 5)*
- [ ] **AC-7**: In the AC-5 run, no all-`wait` plan survives while a critical drive has a visible direct
  restorer (the guard's rejection count > 0 is permitted; an unrejected all-wait plan under the guard's
  conditions is a failure). *(maps to Req 3, Req 5)*
- [ ] **AC-8**: `pnpm -r test && pnpm typecheck && pnpm lint` pass; spec-032/034/048/049 tests pass
  unmodified except where this spec's additive changes extend them; the matcher stays a pure synchronous
  function; `social` remains excluded from every hint path (spec 034/047). *(maps to all)*

## Constraints
- **`cognition`**: the pruning exemption is data-driven from declared `effects` only — no hardcoded
  drive→affordance table (spec 034 Req 3). The matcher and hint renderers are untouched (the exemption
  fixes the funnel *before* them). The orchestrator diagnostic is console-only — no prompt-content changes,
  no KV-cache-prefix drift (spec 021).
- **`shared`**: `PruneOptions.urgentDrives` and the guardrail flag/config field are additive and optional;
  legacy call sites omitting them behave exactly as today.
- **`engine`**: no changes expected; the guard lives in cognition's plan-validation path (spec 016's
  engine-side `validateAction` is per-action and out of scope).
- **`examples`**: Req 4 is additive (a third agent entry); reuse the existing agent-profile shape and the
  spec-049 seed-audit expectations; no affordance or handler changes.
- **Equilibrium guard**: the pruning exemption and wait guard must not turn the economy into a monotone
  maxing slide (spec 048 Req 4 / #139 oscillation semantics remain the reference) — AC-5's traces are
  checked for visible oscillation, not just non-zero endpoints.
- **What NOT to do**: do not exempt *all* positive-effect affordances from pruning unconditionally (it
  would bloat tool lists with irrelevant restorers and drift the enum every cycle — the urgency gate is
  the point); do not remove `wait` from the enum wholesale (mid-chain waiting is legitimate); do not
  "fix" the greenhouse by hardcoding greenhouse-specific logic in cognition (rooms stay scene data); do
  not bump restoration magnitudes without a failing spec-048-AC-5 audit row; do not change
  `DriveSystemImpl.applyDecay` or the decay scaling (spec 048's contract, validated working by Maren's
  trace).
