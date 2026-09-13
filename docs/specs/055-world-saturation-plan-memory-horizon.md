# Feature: World Saturation + Plan Memory + Hours-Horizon — Watering Must Deplete, the Agent Must See Its Last Plans, and `longTermGoals` Must Reach the Plan Prompt

> Issue: [#198](https://github.com/Redna/evol-hive/issues/198) — "World saturation + plan memory + hours-horizon
> planning: watering must deplete, the agent must see its last plans, and longTermGoals must reach the plan
> prompt". User-directed design, three connected fixes arising from #191's plan stickiness (356× identical
> plans): **R-world** — resource-bearing affordances must saturate (the world says no); **R-history** — the
> plan prompt must carry the agent's last plan + its outcome; **R-horizon** — `longTermGoals` and a
> hours-horizon directive must reach the planner with a raised step cap.

## Context
- Architecture: [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (declared affordances, `conditions`, `state`), [§6 — PPER Loop](../architecture/06-pper-loop.md) (the perceive→plan seam; cycle outcome), [§7 — Structured Outputs](../architecture/07-structured-outputs.md) (the `formulate_plan` schema), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (plan validation + retry-with-feedback), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (drives, `currentPlan`, agent profile)
- Related specs: [018 — Object Interactions](018-object-interactions.md) (declarative `conditions` availability + `crossObjectStateChanges` — the saturation and refill mechanisms), [037 — Enum-Bound Plan Formulation](037-enum-bound-plan-formulation.md) (the dynamic `formulatePlanSchemaFor` this spec caps), [039 — Spatial Phase 2 `targetArea`](039-spatial-phase2-targetarea-fog.md) (additive-optional-field pattern), [021 — KV-Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (stable-prefix byte-identity discipline all prompt changes must respect), [012 — Persona System](012-agent-persona-system.md) (`longTermGoals` on the profile; today only the reflect prompt sees them), [034 — Drive→Affordance Hints](034-drive-affordance-hints-hunger-chain.md) (the hint system that stays the #191 fallback), [049 — Per-Cycle Diagnostic Pattern](049-dialogue-completion-urge-observability-reply-window.md) (the `[drive-hint]`-style zero-LLM diagnostic this spec extends), [052 — Greenhouse Drive Bottoming-Out](052-greenhouse-drive-restoration-diagnostics.md) (restoration economics the water loop joins), [030 — Dynamic Scenes](030-dynamic-scenes-living-worlds.md) (the demo scene that owns the water economy)
- Package: `shared` (additive provider/result types, `PLAN_MAX_STEPS` config, `maxItems` in the schema factory), `cognition` (perception population, plan-builder rendering, plan-service cap validation, orchestrator repeat diagnostic), `engine` (data-provider impl + `lastPlanOutcome` stamping), `examples` (water economy, refill path, phantom-affordance audit test)
- Issue: [#198 — World saturation + plan memory + hours-horizon planning](https://github.com/Redna/evol-hive/issues/198)

## Problem Summary

| Signal | Value |
| --- | --- |
| `water_plants` handler | exists (`examples/dynamic-world.ts`), depletes `water_level −1` per execution |
| Declared `water_plants` affordance | **none** — no scene object declares it; the handler is orphaned |
| `water_level` initialization | **never** — planter `state` lacks the key; handler `?? 0` → should always fail |
| Dream5 run | Iris executed `water_plants` **29× "successfully"** — phantom-affordance execution path to verify |
| Plan prompt history | **zero** — no last plan, no outcome, no reflection recall; the LLM plans blind to what it just did (root of the 356× repetition) |
| `longTermGoals` reach | reflect prompt only (`reflect-builder.ts`); never the planner |
| Plan shape | 2–3 step reactive snippets (prompt-shaped; no schema `maxItems`) |

Three structural findings at HEAD:

1. **The world cannot say no.** `water_plants` is executable without being declared, and its resource is
   uninitialized — the economy is incoherent rather than finite. Spec 018's declarative `conditions` already
   support "affordance disappears from the enum when the resource is exhausted", but nothing uses them for
   watering, and nothing audits the phantom/stateless gap across scenes.
2. **The planner has no self-visibility.** The plan context carries drives/affordances/hints/urges but zero
   plan history — the agent cannot see that its last plan was "go_to_greenhouse, water_plants" and that it
   just succeeded. Repetition was inevitable; hints (spec 034) escalate the symptom, not the cause.
3. **The planner has no horizon.** `longTermGoals` reach only `reflect-builder.ts`; the plan prompt frames
   only the current drive. Plans stay 2–3-step reactive snippets because both the prompt and (absence of)
   the schema allow nothing more.

## Requirements

### Req 1 — Water economy: declared, initialized, depleting, saturating (examples)
`water_plants` becomes a **declared affordance on `planter-1`** in `examples/dynamic-world.ts` with a
declarative availability condition (spec 018): `[{ field: 'water_level', operator: '>', value: 0 }]` — when
the supply is exhausted the affordance **leaves the enum** (perception-time gating, no LLM exposure). The
planter's initial state is `{ water_level: 5, seeds_planted: 0, vegetables: 0 }` — every resource-bearing
object declares initialized state. The existing handler's depletion rule (−1 per execution) is kept; its
failure branch ("The watering can is empty.") stays as execution-time defense in depth. Drive effects are
unchanged (`curiosity +10, comfort +5`).

### Req 2 — Refill path closes the loop (examples)
A water source object is added to the garden: `water-butt-1` ("Rain Barrel", type `furniture`) declaring
`fill_watering_can`, whose handler refills the planter's supply via
`AffordanceResult.crossObjectStateChanges` (spec 018, Req 9 mechanism —
`[{ objectId: 'planter-1', statePatch: { water_level: 5 } }]`). The loop becomes closed:
`water_plants` depletes `planter-1.water_level` → affordance vanishes at 0 → the agent must plan a
navigation + `fill_watering_can` chain to restore it. The barrel itself is an unbounded **source** (not a
sink) — saturation lives at the planter, per the issue's user quote ("watering gets full → it stops
working"). The declared `effects` on both new affordances mirror their handler `driveChanges` (spec 032,
Req 6) so tool descriptions and the spec-034 matcher see the real economy.

### Req 3 — Phantom-affordance audit test (examples + cognition test support)
A deterministic audit test over every exported scene in `examples/` asserts, for the full
handler-registry × scene-affordance cross product:
- **No phantom handlers**: every registered affordance-handler id is declared by at least one scene object.
- **No phantom affordances**: every scene affordance id with an `engineEffect` resolves to a registered
  handler or a builtin engine effect.
Deliberately stateless affordances (`pick_herbs`, `eat_herbs`, `rest_among_seedlings`, `repot_seedlings`,
`observe`, `relax`, `sit_outside`, `take_tool`, `open_gate`, `go_to_*`, `work`, `build_planter`,
`plant_seeds`…) are enumerated in an explicit, documented `STATELESS_BY_DESIGN` allowlist inside the test —
visible, justified in a comment each (drive-only changes, no object resource), and any NEW stateless handler
fails CI until allowlisted. The audit is data-driven (reads the scene definitions and the registry); no
hardcoded scene-specific expectations beyond the allowlist.

### Req 4 — Last plan + outcome in the plan context (shared, engine, cognition)
The plan prompt gains the agent's **last plan + its outcome**:
- `AgentInternalState` gains an additive optional `lastPlanOutcome` field:
  `{ planDescription: string; steps: string[]; success: boolean; driveChanges?: Record<string, number>; reflected: boolean }`,
  stamped by the engine's PPER data layer when a plan completes or fails (plan id/description, steps,
  success, drive deltas; `reflected: true` when the reflect phase wrote a memory node for it).
- `PerceptionDataProvider` gains an **optional** `getLastPlanOutcome?(agentId)` method (legacy providers
  omit it → behavior byte-identical, the established spec-039/052 additive pattern);
  `PerceptionServiceImpl` populates it on `PerceptionResult` as an optional field.
- `PlanBuilderImpl` renders it as **dynamic-section lines** (spec 021 discipline — stable prefix untouched),
  e.g. `Your last plan was "go_to_greenhouse, water_plants" — it succeeded (curiosity +10).` — and, when
  present, a follow-up line surfacing the recent reflection outcome. Absent record → no lines.

### Req 5 — `longTermGoals` + horizon directive in the plan prompt (cognition)
- `buildSystemPrompt` renders an **Aspirations line** from `persona.longTermGoals` immediately after the
  persona text (`Aspirations: goal; goal`). The system prompt is already stable per persona (spec 021,
  Req 1), so the KV-cache prefix still hits per persona — the stable line is persona-adjacent by
  construction. Agents without goals render byte-identical prompts to today.
- A **horizon directive** is added to the dynamic section: plans may chain several steps and connect to what
  the agent intends over the coming hours (example framing: morning — water, harvest, trade; afternoon —
  rest, socialize). Horizon framing, not a forced schedule: the LLM keeps the decision.

### Req 6 — Raised, bounded step cap (shared, cognition)
The 2–3-step behavior is prompt-shaped today; the schema has no bound. `formulatePlanSchemaFor` gains
`steps.maxItems = PLAN_MAX_STEPS` (new shared config constant, env-configurable, default **6**). The
plan-service shape validation rejects over-cap plans with the existing one-retry-with-feedback path
(spec 037 pattern). Prompt cost stays bounded: cost grows O(`PLAN_MAX_STEPS`); enum/value spaces,
`targetArea`/`targetAffordance` semantics, and the validator contract are otherwise untouched.

### Req 7 — Consecutive-identical-plan diagnostic (cognition)
Following the spec-049 discipline (orchestrator owns diagnostics; zero LLM calls; never breaks a cycle),
`PPEROrchestratorImpl` emits one `[plan-repeat]` stderr line per cycle when the agent's plan fingerprint
(sorted `targetAffordance` sequence + description hash) matches the previous cycle's, carrying the
consecutive-identical count. This makes the #191 signature (356× identical plans) auditable from logs and
the live-run bound below testable. Defense layering: **world saturation (Req 1–3) + self-visibility
(Req 4) are the first-line structural defenses; the #191 hint-escalation remains the documented fallback**
if the signature persists.

### Req 8 — Live-run validation protocol (evidence)
A 30-min real-LLM run (`USE_REAL_LLM=true SCENE_DURATION_MS=1800000 npx tsx examples/dynamic-world-sim.ts`)
is the acceptance instrument: `[plan-repeat]` lines collected; the watering loop observed end-to-end
(deplete → disappear → refill → reappear); final `logState()` sample per the spec-048 pattern. Evidence
attached to issue #198.

## Acceptance Criteria
- [ ] **AC-1**: Deterministic scene test: `planter-1` declares `water_plants` with the
  `water_level > 0` condition and initialized state `{ water_level: 5, … }`; with `water_level` at 0 the
  affordance is absent from the room's available-affordance set; with `water_level` at 3 it is present; a
  handler execution decrements `water_level` by exactly 1. *(maps to Req 1)*
- [ ] **AC-2**: Deterministic refill test: executing `fill_watering_can` on `water-butt-1` sets
  `planter-1.water_level` to 5 via `crossObjectStateChanges` (spec 018 patch semantics), after which
  `water_plants` re-enters the available set — the loop is closed and the exhausted state is recoverable.
  *(maps to Req 2)*
- [ ] **AC-3**: Phantom-affordance audit test passes over all exported example scenes with the documented
  `STATELESS_BY_DESIGN` allowlist; introducing an undeclared handler or an unresolvable affordance id in a
  test fixture fails the audit. *(maps to Req 3)*
- [ ] **AC-4**: Deterministic plan-context test: with a stamped `lastPlanOutcome` (success, drive delta),
  the plan payload's `perceptionContext` contains the last-plan line with steps, outcome, and drive deltas,
  rendered in the dynamic (post-`---`) section only; with no record, the payload is byte-identical to the
  pre-change builder for the same perception. *(maps to Req 4)*
- [ ] **AC-5**: Deterministic prompt tests: a persona with `longTermGoals` renders `Aspirations:` in the
  system prompt after the persona text; a persona without goals renders a system prompt byte-identical to
  pre-change; the horizon directive appears in the dynamic section. Stable-section byte-identity preserved
  for a fixed (room, object set, persona) per spec 021. *(maps to Req 5)*
- [ ] **AC-6**: Deterministic schema test: `formulatePlanSchemaFor` emits `steps.maxItems = PLAN_MAX_STEPS`;
  a plan with `PLAN_MAX_STEPS + 1` steps fails shape validation with actionable feedback and passes the
  one-retry path when resubmitted within cap; `PLAN_MAX_STEPS` is env-overridable; with the legacy default
  the schema is otherwise unchanged. *(maps to Req 6)*
- [ ] **AC-7**: Deterministic diagnostic test: two consecutive cycles with identical plan fingerprints emit
  exactly one `[plan-repeat]` line with count 2; a changed plan resets the count (no line, or count reset
  semantics per the emitted contract); a diagnostic failure cannot break the cycle. *(maps to Req 7)*
- [ ] **AC-8**: Live-run evidence: in the 30-min run, no agent repeats an identical plan more than a bounded
  consecutive count (target ≤ 5, judged from `[plan-repeat]` lines); the watering chain completes
  (depletion → affordance exit → refill → re-entry observed in the event log); the #191 signature cannot
  recur with world-saturation + self-visibility as first-line defenses. Evidence attached to issue #198.
  *(maps to Req 8, Req 1, Req 4)*

## Constraints
- **Package boundaries**: `shared` stays dependency-free; additive optional types only
  (`lastPlanOutcome`, `getLastPlanOutcome?`, `PLAN_MAX_STEPS`) so legacy providers/prompts stay
  byte-identical when the fields are absent. `memory` is untouched (reflection surfacing rides the existing
  `getAssociativeMemories` path). No import cycles.
- **KV-cache discipline (spec 021)**: the stable prefix stays byte-identical for a given (persona, room,
  object set). Last-plan/outcome lines, horizon directive, and all repetition diagnostics are dynamic-section
  or console-side only. `Aspirations` lives in the system prompt precisely because the system prompt is
  already persona-keyed.
- **Determinism**: the game loop is synchronous; diagnostics and prompt assembly do tick arithmetic and
  string building only — never block on I/O or LLM calls (spec 049 Constraints).
- **Patterns to follow**: additive-optional provider methods (spec 039/052); declarative `conditions` for
  availability gating and `crossObjectStateChanges` for cross-object effects (spec 018); declared `effects`
  mirror handler `driveChanges` (spec 032, Req 6); dynamic-tool-schema factories over static schemas
  (spec 037); grep-able per-cycle diagnostics (spec 049/052).
- **What NOT to do**: do not make the horizon a forced schedule (the LLM keeps the decision); do not bound
  the water *source* — saturation belongs at the planter; do not fix saturation in engine core (the economy
  is scene-owned data); do not remove `wait` from the enum or tighten `targetAffordance` `required`
  semantics (spec 037, Req 3 lesson: required enums broke backend tool-calling); do not remove the #191
  hint-escalation — it is the fallback layer; do not edit `dist/` — rebuild (`pnpm build`) before any live
  validation run (spec 037 Evidence).
