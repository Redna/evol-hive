# Feature: Exhaustible Preconditions — Offers the World Can Never Satisfy

## Context

- Architecture: [§4 — Smart Objects](../architecture/04-smart-objects.md), [§5 — Fast-Path Classifier](../architecture/05-fast-path-classifier.md), [§9 — Engine Routing](../architecture/09-engine-routing.md)
- Related specs: [039 — Spatial Phase 2 (targetArea + fog)](039-spatial-phase2-targetarea-fog.md) (known areas), [064 — Context-Executable Offers](064-context-executable-offers.md) (offers must be executable this cycle), [065 — Reachable Area Offers](065-reachable-area-offers.md) (the **reachability** channel — this spec is its sibling in the **state** channel), [058 — Eligibility-Bound Plan Affordances](058-eligibility-bound-plan-affordances.md)
- Package: `engine` (precondition checking + the offer projection), `examples` (the coffee-shop scene content), `cognition` (the diagnostic surface).
- Status: 📝 Drafted
- Issue: [#225](https://github.com/Redna/evol-hive/issues/225) (the "offers that cannot be executed" audit; this is a new finding from live observation, not one of the original ten)

## Problem Summary

A real-LLM run was left running ~16 h. Mined from its archived log, the agents were **stuck**, and the cause is mechanical.

Two affordance preconditions read **exhaustible counters**, and the only code that writes those counters **decrements** them:

| precondition | reads | written by | ever incremented? |
| --- | --- | --- | --- |
| `has_cups` | `cup_count > 0` | `scene-loader/handler-plugins.ts` → `cup_count: cups - 1` | **no** |
| `has_water_supply` | `water_supply > 0` | `scene-loader/handler-plugins.ts` → `water_supply: supply - 1` | **no** |

The coffee-shop scene seeds them once — `cup_count: 3` on the coffee machine, `water_supply: 20` on the sink — and **nothing restocks them**. After three pours and twenty refills, `pour_cup` and `refill_pitcher` become **permanently unexecutable while continuing to be offered** in the plan enum, forever.

The run's own step outcomes confirm the arithmetic:

```
19,200  step-ok
 2,894  error:Preconditions not met: has_water_supply
 2,284  error:Preconditions not met: has_cups        → 5,178 rejections
```

This is not noise. The agents' **only** hunger-restoring affordance was the coffee sequence, so:

- **hunger could never be satisfied** — the drive-hint diagnostic (which only fires when a hintable drive is below 40) recorded hunger min 0 / max 40 / mean 4, and energy mean 17 / min 0;
- 48% of 33,266 planned steps were `observe` + `wait`, and 28% were exactly the water/coffee sequence (`add_water` 3,905, `refill_pitcher` 2,956, `pour_cup` 2,377);
- the agents spent ~85% of all cycles in the kitchen;
- **10,875 of 30,075 execute attempts (36%) were skipped** after failing twice.

So a spend of ~47,808 LLM calls over 16 h bought a livelock: an agent that cannot eat, retrying an action the world will never let it complete.

### Why the existing guards did not catch it

Spec 064 made offers context-executable (participants), spec 065 made them **routable** (reachability). Neither asks whether an offer's **preconditions can be satisfied by the current world state**. `prunedAway=[]` throughout the run is the tell: the restoring affordances were never *pruned away* — they were never *satisfiable*.

## Requirements

### R1 — An offer is not presented when its preconditions cannot be satisfied this cycle (`engine`)

- The affordance enum/offer projection MUST NOT include an affordance whose declared precondition(s) evaluate to **permanently** unsatisfiable given the world's current writable state — specifically: a precondition reading a count/quantity that is `0` **and** for which no known affordance can increase it.
- The distinction is deliberate and matches spec 065's: **knowledge is preserved, the offer is restricted.** The agent still knows `pour_cup` exists; it must not be invited to choose it as this cycle's executable step.
- An affordance whose precondition is *temporarily* unmet (a value that some reachable affordance can raise) stays offered exactly as today.
- Where nothing is offered as a result, the existing empty-enum degradation applies — no invented destinations.

### R2 — Anything that can be exhausted has a way to be replenished, or is not exhaustible (`engine` / `examples`)

- For every precondition field that gates an **offered** affordance, the scene+engine MUST provide at least one affordance that **increases** it, and that affordance must itself be reachable and satisfiable (spec 065's lesson applied to the satisficer).
- Where replenishment is intentionally impossible, the field MUST NOT gate an offer: the affordance either stops being offered (R1) or the design states the terminal condition explicitly.
- The coffee-shop scene MUST stop being a world where hunger cannot be satisfied. Whether that is a restock affordance (a cupboard/dishwasher/tap), a depleting-but-renewable model, or a bounded-but-sufficient budget is a **content/design decision for this spec's leg**, but the invariant (R2) is not optional.

### R3 — The failure is visible without a 16-hour run (`engine` / `cognition`)

- When a precondition rejects because a field is exhausted **and** no satisficer is known for it, emit a zero-LLM `[tag]` diagnostic (spec-049 discipline) naming the agent, the affordance, the field and its value.
- The diagnostic MUST be emitted once per (agent, affordance, field) exhaustion episode rather than per tick, so a long run does not flood its own log.
- The existing `[drive-hint]` line already reports the pruning funnel; this adds the missing *state* fact, so "why is this agent stuck" is answerable from the log rather than by inference.

### R4 — The invariant is guarded, not remembered (`engine` / `examples`)

- A test MUST fail when a precondition field that gates an offered affordance has **no writer that increases it** — derived from the scene definition plus the handler plugins, so the next exhaustible field is caught the same day it is introduced rather than by a 16-hour run.
- A test MUST fail when an exhaustible affordance is offered with its gate at zero and no satisficer present (R1), asserted on the offer projection as data.
- A test MUST assert the satisficer itself is reachable/satisfiable when one exists (R2), so "we added a restock affordance nobody can use" fails too.

### R5 — Regression discipline (`engine`)

- Specs 039/064/065 guarantees MUST hold: this narrows the offer, never widens it, and never deletes knowledge.
- Existing precondition semantics (`has_cups`, `has_water_supply` and any others) MUST NOT silently change meaning; if a field becomes replenishable, the change is explicit in the scene and covered by a test.
- Any live validation MUST be measured on the **tick axis** and launched through `scripts/live-sim.mts` with an evidence sink (spec 067) — the run that found this defect produced nothing.

## Acceptance Criteria

- [ ] **AC-1 (R1)** — an affordance whose precondition reads an exhausted field with no satisficer is **absent** from the offer projection; asserted as data on the enum.
- [ ] **AC-2 (R1)** — an affordance whose precondition reads a low-but-raisable field **remains** offered (the narrowing must not over-fire).
- [ ] **AC-3 (R1)** — knowledge is preserved: the affordance remains in the agent's known affordances even while it is not offered (mirrors spec 065's knowledge/offer split).
- [ ] **AC-4 (R2)** — for every precondition field gating an offered affordance in the coffee-shop scene, at least one affordance increases it, and that affordance is reachable and its own preconditions are satisfiable.
- [ ] **AC-5 (R2)** — the coffee-shop scene can restore hunger: a run can complete a hunger-restoring cycle without exhausting a permanently-dry gate (asserted on state transitions, not on LLM behaviour).
- [ ] **AC-6 (R3)** — an exhaustion episode emits exactly one `[tag]` diagnostic naming agent, affordance, field and value; a second identical episode in the same run emits a second line, and per-tick repetition does not.
- [ ] **AC-7 (R4)** — a guard test fails on a scene/plugin combination where a gating field has no increaser (verified red on the pre-change tree).
- [ ] **AC-8 (R4)** — a guard test fails when a satisficer exists but is itself unreachable or unsatisfiable.
- [ ] **AC-9 (R5)** — specs 039/064/065 suites stay green; the offer never gains an area/affordance it previously lacked.
- [ ] **AC-10 (R5)** — full suite green, `typecheck` clean, `prettier` clean; a live validation through the launcher records a **rejection-rate on the tick axis** for the pre-change and post-change builds, and the sample sink contains the run's samples.

## Constraints

- **Package boundary**: `engine` (preconditions, offer projection, diagnostic) and `examples` (scene content). No `shared` type changes; no protocol changes.
- **No new dependencies.**
- **Do not invent an economy.** The smallest honest fix is a replenishment path plus the offer filter; a restocking simulation, resource markets or consumption modelling are out of scope.
- **Determinism**: the offer projection stays pure (no clocks, no randomness); the guard's static inventory must be derived from data, not from a hand-maintained list.
- **The precondition check is per cycle over a small enum** — no new BFS or world scan on the hot path (spec 065's Constraints clause applies unchanged).
- **Do not weaken preconditions to make the livelock disappear** (e.g. accepting `cup_count >= 0`). That hides the defect and makes the sim lie about what the affordance requires.
- **A run is not evidence.** Any live claim must come from a run launched with an evidence sink (spec 067) and measured on the tick axis; the 16 h run that found this produced no samples because none existed yet.

## Test Seams

1. **The offer projection** — the enum builders (specs 064/065 territory, `cognition` + `engine` binding): assert absent/present as data (AC-1, AC-2, AC-3).
2. **The precondition inventory** — a pure function over the scene definition + handler plugin registry returning, for each gating field, the affordances that increase it (AC-4, AC-7, AC-8). This is the load-bearing new seam: it turns a runtime livelock into a static assertion.
3. **The exhaustion diagnostic** — a zero-LLM `[tag]` line, asserted by emitting twice and counting lines (AC-6), the spec-049 pattern.
4. **Scene state transitions** — drive a scripted sequence (pour × n, refill × n, restock) and assert the counters rise as well as fall (AC-5). No LLM.
5. **Live, tick-axis** — rejection counts (`Preconditions not met: …`) per tick quintile for a pre/post build, via `scripts/live-sim.mts` (AC-10).

## Design Decisions

1. **Fix the cause first, filter second — and do both.** Filtering alone (R1) stops the *noise*: agents would stop choosing a doomed affordance. It leaves them **unable to eat**, which is the actual failure. Replenishment (R2) is the fix; the filter is what keeps the offer honest in the meantime and covers fields a future scene makes exhaustible. Doing only one of these is a known half-measure, so the spec requires both and says why.
2. **This is a new channel, not a new mechanism.** Spec 064 restricted *participants*, spec 065 restricted *reachability*; both narrowed an enum using a decision owned elsewhere. This restricts *state satisfiability* and reuses that shape, including its "one decision, reused" rule — rather than inventing a second offer pipeline.
3. **The guard is the point.** A 16-hour run found this; a static inventory (Seam 2) could have found it in a test on day one. The invariant "every gating field has a reachable increaser" is cheap to assert and generalises to every future exhaustible field.
4. **Explicitly not weakening preconditions.** The cheap way to silence 5,178 rejections is to loosen the check. That would convert a visible stuck state into an invisible lie about the world, and the spec forbids it in Constraints.
5. **Scene content is in scope.** The defect needs a content decision (what restocks cups/water), not only engine code; pretending otherwise would leave R2 unsatisfiable and the agents hungry.

## Out of Scope

- Economic or ecological modelling of resources beyond the single restock path R2 requires.
- Changing the LLM's planning quality — the agents chose reasonably given a world that could not satisfy them.
- Spec 065's reachability port, or spec 064's participant rules (this composes with them).
- Persisting agent memory across runs (spec 067's companion; separate spec).
- Retention/analysis tooling for `session-logs/`.

## Notes

- **Evidence source**: the archived log of the 16 h run — `~/.local/share/evol-hive-archive/viz-run-16h-2026-09-26.log.gz` (46 MB → 2.4 MB), deliberately outside this public repository. Every count in the Problem Summary comes from it.
- **How it was found**: by asking whether the run taught us anything, then mining the log rather than assuming. The rejection counts were visible all along; nothing was reading them.
- **Relationship to #225**: the audit's ten findings are about context that is wrong or unexecutable. This is the same family in the **state** channel, discovered by observation after the audit closed — a reminder that the audit's list was a snapshot, not a boundary.
- **Evidence for this spec lives in** `docs/specs/notes/068-*-notes.md` per ADR-003.
