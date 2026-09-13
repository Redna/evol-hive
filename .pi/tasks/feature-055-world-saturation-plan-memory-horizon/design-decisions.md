# Design Decisions — Feature 055: World Saturation, Plan Memory & Hours-Horizon (Spec 055, Issue #198)

## Decision 1: Saturation is scene-owned declarative data, not engine core
**Why**: All needed mechanisms already exist and compose: `AffordanceCondition` perception-time gating
(spec 018, `evaluateConditions` in `engine/world/affordances`), `crossObjectStateChanges` for the
refill transfer (spec 018 Req 8–9), and the handler's execution-time check as defense in depth.
Declaring `water_plants` with `conditions: [{ water_level > 0 }]` means exhaustion removes the
affordance from the **value space** (the spec-037 enum) — saturation blocks behavior structurally,
not by scolding the LLM. Engine-side physics would duplicate a declarative capability and drift the
ADR-0001 package boundary. The `examples` package owns the economy.

## Decision 2: Saturation lives at the planter; the source stays unbounded
**Why**: The issue's user quote is "watering gets full → it does not work anymore" — saturation is
about the *recipient* absorbing no more (planter reservoir at capacity in the handler's patch
semantics; empty source blocks refills via its own condition). A bounded source would need a renewal
rule (ObjectStateRule `approach`) to keep the loop closed, which adds a ticking economy for no
additional structural insight — the planter's finite absorption + the source's condition gate already
make "water forever" impossible. If live-run evidence (Req 8) shows refill camping, a renewal rule is
the additive follow-up, not a requirement now.

## Decision 3: Phantom/stateless audit as a data-driven CI fence with an explicit allowlist
**Why**: The #198 phantom class is mechanical (undeclared handler ID, unresolvable affordance ID,
uninitialized state field a handler reads) — so the fence is a deterministic test over the handler
registry × scene-affordance cross product, not a code review convention. The deliberately stateless
affordances (`pick_herbs`, `eat_herbs`, `rest_among_seedlings`, `observe`, `go_to_*`, `take_tool`, …)
are **bounded by fiction** (the shelf "full of herbs", resting consumes nothing) — bounding them in
code without a fictional resource would relocate the saturation problem without closing any loop and
would break the spec-052 greenhouse restoration path #183 validated. New stateless handlers fail CI
until justified in the `STATELESS_BY_DESIGN` allowlist.

## Decision 4: LastPlanOutcome is engine-stamped state surfaced via an optional provider method
**Why**: The engine's PPER data layer already completes each cycle (it applies drives, stores memory,
clears plans) — stamping the outcome there is one write at the moment the data exists, and it
persists across orchestrator instances/restarts. `PerceptionDataProvider.getLastPlanOutcome?` as an
**optional** method (spec-039/052 additive pattern) keeps legacy providers byte-identical and keeps
the cognition→engine boundary via the shared bridge (ADR-0001) instead of inventing a new seam.
Rendering is dynamic-section-only → spec-021 KV-cache discipline preserved; no record → no lines
(never fabricate history on cycle 1).

**Alternative considered**: orchestrator-owned in-memory per-agent map passed through the
PlanBuilder options channel. Rejected — it duplicates engine-held cycle state, dies on restart, and
needs a new parameter tunnel where an optional provider method already fits the established pattern.

## Decision 5: `Aspirations` in the system prompt; horizon directive dynamic-section
**Why**: The system prompt is already persona-keyed (spec 021, Req 1) — goals are persona-stable, so
the KV prefix still hits per persona and agents without goals render byte-identical prompts. The
horizon directive is per-tick context (it speaks to "the coming hours" framing) and lives after the
`---` separator, so it costs nothing against the cache. A dynamic-section directive also lets a
future tick-aware horizon (time-of-day framing) evolve without touching the frozen prefix.

## Decision 6: Cap via schema `maxItems` + shape validation, not prompt wording alone
**Why**: Prompt guidance alone is what produced the emergent 2–3-step shape — unenforceable. A
schema-level `steps.maxItems = PLAN_MAX_STEPS` (default 6, env-overridable) is a hard value-space
constraint the backend tool-calling path enforces (spec 037/051 pattern), with the shape-validation
rejection + one-retry-with-feedback path as the recovery route. Default 6 keeps every existing 2–3
-step plan valid (no behavioral regression) while permitting morning/afternoon chains; prompt cost
stays O(PLAN_MAX_STEPS).

## Decision 7: Defense layering — saturation + self-visibility first, hint-escalation fallback
**Why**: The issue is explicit: repetition's root causes are (a) a world with no consequences and
(b) a planner with no memory. A code-side anti-repeat force (rejection by fingerprint, prompt
scolding loops) would mask the world's causal signal and turn the repetition signature — the
observable — into noise. `[plan-repeat]` (Req 7) makes the signature auditable per cycle
(spec-049 zero-LLM diagnostic discipline) so the live-run bound (AC-8) is judged from logs, not
inference. The #191 hint-escalation stays wired as the fallback layer.

## Session-2 review (independent verification at HEAD, recorded 2026-09-13)
Re-verified all problem-summary rows against `main` (post-#197):
- `water_plants` handler exists in `examples/dynamic-world.ts` (`createDynamicWorldHandlers`,
  `water - 1`, fails at `<= 0`); planter-1 lists only `plant_seeds`/`harvest`/`eat`/`observe` —
  handler orphaned; `makeObject` stamps `state: {}` → `water_level` never initialized (`?? 0`).
- Execution-path note: at HEAD, `resolveAffordance` requires a declared affordance on a room object
  (`engine/agents/execute/index.ts`) and `physics.executeAffordance` re-checks declaration — so the
  dream5 29× successes imply a pre-spec-031/037 run or scene variant; Req 3's audit is the regression
  fence either way.
- Plan prompt (`plan-builder.ts`) confirmed: drives/affordances/hints/urges/system feedback only —
  zero plan history, zero reflection recall. `longTermGoals` reach only `reflect-builder.ts:72`
  (`Aspirations:` line precedent reused by Req 5).
- `formulatePlanSchemaFor` (`shared/schemas/llm-schemas.ts`) has no `maxItems` on `steps` — the
  2–3-step shape is purely prompt-shaped; Req 6's cap is a new constraint, not a loosening.
- `GuardrailConfig.waitSuppression` (spec 052) env→config plumbing is the pattern for
  `PLAN_MAX_STEPS` env-overridability.
