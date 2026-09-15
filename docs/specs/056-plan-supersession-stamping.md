# Feature: Plan Supersession Stamping — Abandoned In-Flight Plans Get a `superseded` Outcome So "Your last plan was" Actually Renders (Issue #201)

## Context

- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md) (the perceive→plan seam where plans are replaced; the reflect phase that stamps completed/failed plans), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (`currentPlan`, `lastPlanOutcome`), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (outcome stamps as episodic self-model data)
- Related specs: [055 — World Saturation + Plan Memory + Hours-Horizon](055-world-saturation-plan-memory-horizon.md) (introduced `lastPlanOutcome`, `stampLastPlanOutcome`, and the plan-context rendering this spec repairs), [054 — Live Tick Provider](054-live-tick-provider.md) (the epoch-stamp defect family this spec's clock fix belongs to), [037 — Enum-Bound Plan Formulation](037-enum-bound-plan-formulation.md) (step-skip livelock guard — the skip path that advances plans), [021 — KV-Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (stable-prefix discipline the new prompt lines must respect), [049 — Diagnostic Pattern](049-dialogue-completion-urge-observability-reply-window.md) (zero-LLM stderr diagnostics)
- Package: `shared` (additive `LastPlanOutcome` fields), `engine` (supersession stamp in `PlanManagerImpl.createPlan`, plan-id clock fix), `cognition` (plan-builder superseded rendering)
- Issue: [#201 — Plan-memory stamping blind spot: plans are replaced every cycle before completing](https://github.com/Redna/evol-hive/issues/201)

## Problem Summary (live-run verified, 055 run)

| Signal                                       | Value                                                           |
| -------------------------------------------- | --------------------------------------------------------------- |
| "Your last plan was" renders in the live run | **0** — the spec-055 plan-memory line never appeared            |
| Plan creates                                 | 145 ≈ one per cycle (batch plan path re-formulates every cycle) |
| Plan length distribution                     | {1: 20, 2: 162, 3: 90, 4: 38, 6: 1} — 363 total steps           |
| Step advances across those plans             | 145 (40 execs + 105 skips) ≈ **1 step per plan**                |
| `planJustCompleted` fires                    | only the 20 single-step plans — and even those rendered 0 lines |

**Root cause — plans are ephemeral.** The dominant live path is the batch plan phase
(`batch-plan-service.ts` → `storePlan` → `PlanManagerImpl.createPlan`), which runs
**every cycle** and **unconditionally replaces** `agentState.currentPlan`. A multi-step
plan is abandoned mid-flight every cycle: the next cycle's `createPlan` overwrites it
before `currentStepIndex >= steps.length` can ever hold. `stampPlanOutcome` (spec 055
Req 4) fires only when the plan _just completed_ or _failed_ at the Reflect phase — a
condition the dominant path almost never reaches, so the plan prompt renders no
last-plan lines and the agent stays blind to its own abandonment pattern (the exact
#191 repetition signature spec 055's plan memory was built to defend against).

**Fix (R-supersession):** stamp the outcome at the moment the plan is _replaced_ —
in `PlanManagerImpl.createPlan`, before overwriting a still-in-flight plan, stamp a
`{ success: false, superseded: true, stepsCompleted: N, stepsTotal: M, reflected: false }`
outcome for the OLD plan. The next cycle's plan prompt then renders
_"Your last plan was "…" — superseded after N of M steps."_ — giving the LLM
self-visibility of exactly the abandonment pattern.

## Requirements

- **Req 1 — Supersession stamp on plan replacement (engine):** `PlanManagerImpl.createPlan`
  gains a pre-overwrite guard: when `agentState.currentPlan` is non-null **and**
  `currentStepIndex < steps.length` (the plan is still in flight), stamp a
  `LastPlanOutcome` for the OLD plan via `agentManager.updateState(agentId, { lastPlanOutcome })`
  _before_ the new plan replaces it. The stamped outcome carries: the old plan's
  `planDescription`, its per-step rendered identities in plan order
  (`targetAffordance` when bound, else `description` — the same rendering
  `stampPlanOutcome` uses), `success: false`, `superseded: true`,
  `stepsCompleted: currentStepIndex`, `stepsTotal: steps.length`, `reflected: false`
  (no reflection ever happened for the abandoned plan). The stamp is wrapped in
  try/catch — a stamping failure must never break plan creation.
- **Req 2 — Additive `LastPlanOutcome` fields (shared):** `LastPlanOutcome` gains three
  optional fields: `superseded?: boolean`, `stepsCompleted?: number`, `stepsTotal?: number`.
  Existing producers and consumers are untouched; fields are conditionally spread
  (`exactOptionalPropertyTypes` safe). Legacy saves and completion/failure stamps keep
  rendering byte-identically.
- **Req 3 — Superseded verdict in the plan prompt (cognition):** `PlanBuilderImpl` renders
  a superseded outcome as the dynamic-section line
  `Your last plan was "step, step, …" — superseded after N of M steps.`
  (dynamic section only — spec 021 stable-prefix discipline). When `driveChanges` is
  present it is appended in the existing `formatDriveDeltas` form; when `reflected` is
  true the existing reflection line follows. Outcomes without `superseded` render
  exactly as today; `stepsCompleted`/`stepsTotal` are only read when `superseded` is true.
- **Req 4 — Plan ids use the injected clock (engine):** `PlanManagerImpl.createPlan`
  builds plan ids as `plan_${agentId}_${this.clock()}_${counter}` — the `Date.now()`
  call (line 38) is removed. This is the same epoch-stamp family as spec 054 / issue
  #195: the constructor-injected `SimulationClock` is the only time source, keeping
  plan ids deterministic under fixed-clock tests and consistent with sim time.
- **Req 5 — `[plan-superseded]` diagnostic (engine):** on every supersession
  `createPlan` emits one stderr line in the spec-049 diagnostic discipline:
  `[plan-superseded] agent=<id>: superseded after N of M steps ("<40-char description>")`.
  Zero LLM calls; a diagnostic failure never breaks the cycle.
- **Req 6 — Non-regression of completion/failure stamps (engine/cognition):** the
  Reflect-phase `stampPlanOutcome` path is unchanged. A replaced plan that is already
  complete (`currentStepIndex >= steps.length`) is **not** stamped superseded — its
  outcome belongs to the reflect stamp, and supersession only covers plans that died
  in flight. The `PlanServiceImpl.plan()` early-return for agents with an active plan
  and the batch-plan flow are otherwise untouched.
- **Req 7 — Live-run validation protocol (evidence):** a 30-min real-LLM run
  (`USE_REAL_LLM=true SCENE_DURATION_MS=1800000 npx tsx examples/dynamic-world-sim.ts`)
  is the acceptance instrument: plan-memory lines render > 0 in the plan prompts;
  `superseded after N of M steps` lines appear for abandoned multi-step plans;
  `[plan-repeat]` remains 0-firing; `[plan-create]` ids carry the injected clock.
  Evidence attached to issue #201.

## Acceptance Criteria

- [ ] **AC-1** (Req 1): Unit test — agent holds a 3-step plan with `currentStepIndex = 1`
      (step 0 completed, `targetAffordance` bound); a new `createPlan` call then reads
      `lastPlanOutcome` as: `planDescription` = old description, `steps` = the old plan's
      three rendered identities in order, `success === false`, `superseded === true`,
      `stepsCompleted === 1`, `stepsTotal === 3`, `reflected === false`. _(maps to Req 1)_
- [ ] **AC-2** (Req 1): Unit test — a plan with 0 completed steps that is replaced is
      still stamped (`stepsCompleted === 0`); the new plan's own state
      (`currentPlan.steps`, `currentStepIndex === 0`) is exactly the new formulation, and
      stamping a deliberately-throwing state write does not prevent plan creation. _(maps to Req 1)_
- [ ] **AC-3** (Req 1, 6): Unit test — replacing a **complete** plan
      (`currentStepIndex >= steps.length`) does NOT stamp `superseded: true` — the existing
      `lastPlanOutcome` (or `undefined`) survives the replacement untouched. _(maps to Req 1, Req 6)_
- [ ] **AC-4** (Req 2): Type-level / additive test — `LastPlanOutcome` objects built
      without the new fields typecheck and behave as before; the shared `agent-types` tests
      pass unchanged; `pnpm typecheck` passes under `exactOptionalPropertyTypes`. _(maps to Req 2)_
- [ ] **AC-5** (Req 3): Builder test — a superseded outcome renders exactly
      `Your last plan was "go_to_greenhouse, water_plants, repot_seedlings" — superseded after 1 of 3 steps.`
      in the dynamic section; with `driveChanges` the deltas render after the verdict; with
      `reflected: true` the reflection line follows; with `superseded` absent the
      spec-055 rendering (succeeded/failed) is byte-identical to today. _(maps to Req 3)_
- [ ] **AC-6** (Req 4): Determinism test — `PlanManagerImpl` constructed with a fixed
      fake clock produces ids `plan_${agentId}_${fakeTime}_${counter}`; no `Date.now()`
      reference remains in `PlanManagerImpl`. _(maps to Req 4)_
- [ ] **AC-7** (Req 5): Diagnostic test — a superseding `createPlan` emits one
      `[plan-superseded]` line with agent id, `N of M`, and a truncated description;
      a first-plan creation (no prior plan) emits none. _(maps to Req 5)_
- [ ] **AC-8** (Req 6, 7): Regression suite — the full spec-055 plan-memory test suite
      (`spec-055-plan-context-memory.test.ts`) passes unchanged (completion/failure stamps
      and rendering intact); the live run shows > 0 plan-memory renders with at least one
      `superseded after N of M steps` line and `[plan-repeat]` still at 0. _(maps to Req 6, Req 7)_

## Constraints

- Package boundaries: only `shared` (types), `engine` (`PlanManagerImpl`), and
  `cognition` (`plan-builder.ts`) may change. No new cross-package deps —
  `shared ← engine`, `shared ← cognition` hold as-is. No import cycles.
- Prompt discipline: the superseded line lives in the **dynamic section only**
  (spec 021 KV-cache discipline) — the stable prefix is untouched; absent record →
  no lines (never fabricate history on cycle 1).
- Additive-optional discipline: new `LastPlanOutcome` fields are optional and
  conditionally spread; legacy stamps, legacy saves, and the spec-055 rendering
  contract stay byte-identical.
- What NOT to do:
  - Do **not** change plan-flow semantics — `PlanServiceImpl.plan()`'s early-return,
    the batch plan path, and `clearPlanIfComplete` stay untouched. The defense is
    self-visibility (the agent sees its abandonment), not plan persistence; making
    plans survive cycles is a different feature and is out of scope.
  - Do **not** stamp supersession for plans that already completed or failed — the
    Reflect-phase stamp owns those outcomes; double-stamping would clobber real
    outcome data with a misleading `success: false`.
  - Do **not** let stamping throw into plan creation (`createPlan` must always
    produce a plan; the stamp is diagnostic-grade data, spec-049 discipline).
  - Do **not** introduce new `Date.now()` calls in `engine` — the injected
    `SimulationClock` is the only time source (spec 054 family).

## Addendum (live validation, 2026-09-13) — the premise was inverted, the real defect was unobservability

### 1. "0 renders" was a measurement artifact, not a signal

Every render count in this spec's Problem Summary (and in spec 055's) came from
grepping the run log for `Your last plan was` — **but the plan prompt is never
logged** (`grep -c "Available affordances|Your task|affordances:"` = 0 over a
12,116-line 055 run). The plan-memory line had been rendering all along; there
was simply no stderr signal carrying it.

**Fix — `[plan-memory]` (committed, `00be882`):** `cognition/pper/plan-memory-diagnostic.ts`
emits one zero-LLM line per plan FORMULATION that carries a `lastPlanOutcome`
(the stickiness short-circuit returns before the payload build, so continuations
stay silent), with the builder's own verdict vocabulary:

```
[plan-memory] agent=gardener-1 verdict=superseded steps=1/3 reflected=false
[plan-memory] agent=iris-1 verdict=succeeded steps=- reflected=true
```

Wired in `plan-service.ts` right after the payload build, wrapped per the
spec-049 discipline (a throwing caller never breaks the cycle); 11 tests
(trichotomy, exact format, `0/0` degradation, single emission, undefined-outcome
silence, production `PlanServiceImpl` wiring, short-circuit silence, throw guard).

**Live result (`/home/anima/056brun.log`, ~7 min):** `[plan-memory]` fired **127×**
against 130 plan creates — i.e. **98 % of formulations render a last-plan line**
(verdicts 127/127 `succeeded`). Plan memory works live; the spec-055 AC that
depended on this reading is satisfied.

### 2. Supersession is unreachable through production wiring

`[plan-superseded]` fired **0×** — and that is correct behavior, not a defect.
`PlanServiceImpl.plan()`'s spec-002 stickiness guard (`plan-service.ts:44`)
returns the active plan **before** any LLM call, so `createPlan` is only reached
when `currentPlan` is `null`, i.e. after the previous plan completed and
`clearPlanIfComplete` cleared it. The live single-agent path therefore **never
replaces an in-flight plan**, and `stampSupersededOutcome`'s guard
(`currentStepIndex < steps.length`) can never hold at the call site.

The only path that replaces unconditionally is `BatchPlanService.processBatch`
(spec 056 Req 7's E2E exercises exactly this), and **no production wiring
instantiates `BatchPlanService`** — it appears only in `spec-022` and
`spec-056-batch-supersession-e2e` tests.

Consequence for **AC-8**: its live clause ("at least one `superseded after N of M
steps` line") is **unsatisfiable under current wiring**, by construction. The
stamp itself stays — it is correct, additive, and fires the moment a replacing
path is wired — but it is defensive code, not a live behavior change.

### 3. The live-path analog of supersession is the step skip — and it is dishonest

164 step advances in the run = 54 executed + **110 skipped (67 %)**; the skips are
narrative-bound steps whose affordance became unexecutable between formulation
and execution (`Join/Contribute to the conversation…` — the spec-051 talk-target
enum changes as targets leave the room or hit the talk cap; `Plant seeds…` —
`plant_seeds` unavailable). `stampPlanOutcome` reads only the FINAL
`executeResult`, so those plans are stamped `success: true` and the agent is told
`it succeeded` — blind to the abandonment that actually happened. Filed as
**#204**.

### 4. Live evidence summary (this addendum's run)

| Signal                               | Value                                             |
| ------------------------------------ | ------------------------------------------------- |
| `[plan-memory]`                      | 127 (127 `succeeded`, 0 `superseded`, 0 `failed`) |
| plan creates / `[plan-bind]` retries | 130 / 0                                           |
| step advances                        | 164 = 54 executed + 110 skipped                   |
| `[plan-superseded]`                  | 0 (see §2 — unreachable, not broken)              |
| `[plan-repeat]`                      | 2 (max count 3; bounded, far below the #191 356×) |
| world saturation                     | `planter is full` × 6                             |
| conversations / social               | 9 / 17                                            |

### 5. Correction — the "healthy end state" readings were short-run artifacts

The runs backing the spec-055/056 validation reports were stopped at 137 state
samples (~15–20 min), which is _before_ the population's collapse phase. A 40-min
run of the same built code reproduces the 053/054/055 signature instead: 68
affordance executions against **503 step skips (88 %)**, `[step-skip]` split 500
(iris-1) / 3 (gardener-1), and every drive decaying monotonically to zero
(`gardener-1` ends `e=0 h=0 s=0`; two of three agents at zero after 40 minutes).
Conversations stop at ~10 min, after which every proposed social step is
guaranteed to fail-and-skip. Filed with the cross-run table as **#206**.
