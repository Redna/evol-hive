# Feature: Plan Skip Honesty — Completed-By-Skipping Plans Report Their Skipped Steps (Issue #204)

## Context

- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md) (Execute advances the plan; Reflect stamps the outcome that the next plan prompt renders), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (the spec-037 step-skip livelock guard that advances past repeatedly failing steps), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (`lastPlanOutcome`), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (plan outcomes as episodic self-model data)
- Related specs: [055 — World Saturation + Plan Memory + Hours-Horizon](055-world-saturation-plan-memory-horizon.md) (introduced `lastPlanOutcome`, `stampPlanOutcome`, and the "Your last plan was" rendering this spec makes honest), [056 — Plan Supersession Stamping](056-plan-supersession-stamping.md) (the `[plan-memory]` diagnostic and the outcome-verdict vocabulary this spec extends), [037 — Enum-Bound Plan Formulation](037-enum-bound-plan-formulation.md) (the step-skip livelock guard — the skip semantics that stay unchanged), [040 — Idle-Tick Memory Suppression](040-idle-tick-memory-suppression.md) (the existing `ExecuteResult.stepSkipped` boolean), [049 — Diagnostic Pattern](049-dialogue-completion-urge-observability-reply-window.md) (zero-LLM stderr diagnostics), [021 — KV-Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (stable-prefix discipline the new prompt line must respect)
- Package: `shared` (one additive type field), `cognition` (Execute accumulator, Reflect stamp, PlanBuilder rendering, `[plan-memory]` diagnostic)
- Issue: [#204 — Plan outcomes lie about skipped steps](https://github.com/Redna/evol-hive/issues/204)

## Problem Summary (live-run verified, spec 056 run `/home/anima/056brun.log`)

| Signal                     | Value                                                      |
| -------------------------- | ---------------------------------------------------------- |
| `[plan-memory]` renders    | 127 (127/127 `verdict=succeeded`)                          |
| plan creates               | 130                                                        |
| step advances              | 164 = **54 executed + 110 skipped (67% skipped)**          |
| `[plan-superseded]`        | 0                                                          |
| `[plan-repeat]`            | 2 (max count 3 — bounded)                                  |

A plan that reaches its end by advancing past failed steps is stamped `success: true`,
so the prompt tells the agent *"Your last plan was "…" — it succeeded."* The skipped
steps — dominated by narrative-bound steps whose affordance became unexecutable
between formulation and execution — are invisible:

```
[step-skip] agent=iris-1 step='Join the conversation to interact with others.' failed 2x consecutively — advancing past it
[plan-memory] agent=iris-1 verdict=succeeded steps=- reflected=true
```

This is the live-path analog of the supersession defect spec 056 repaired: the plan
ran out of *runnable* steps, not out of *steps*, and the agent is blind to its own
abandonment — the exact self-visibility gap the #191 repetition defense depends on.
The fix is **honesty in reporting only**: the spec-037 skip behavior (advance after 2
consecutive failures) does not change.

## Requirements

- **R1 — Per-plan skip count in `ExecuteResult` (cognition):** `ExecuteServiceImpl`
  accumulates the number of steps skipped by the spec-037 livelock guard for each
  in-flight plan. The accumulator is keyed per agent on the plan's `id`; when the
  plan id changes (a new plan) the accumulator resets to 0. The counter increments
  exactly once per `[step-skip]` advance in `registerStepFailure` and is **not**
  reset by a successful step between skips (it is a per-plan total, unlike the
  existing consecutive-failure `stepFailures` counter). Every `ExecuteResult`
  returned by `execute()` for a plan whose accumulated skip count is `> 0` carries
  `stepsSkipped: <count>` (an additive optional field); skip-free results omit the
  field so their shape is byte-identical. The final cycle of a completed plan
  therefore carries the cumulative count that Reflect reads.
- **R2 — Additive `LastPlanOutcome.stepsSkipped` (shared):** `LastPlanOutcome` gains
  an optional `stepsSkipped?: number`. It is conditionally spread by producers and
  never required of consumers; legacy saves, spec-055 completion/failure stamps, and
  spec-056 supersession stamps keep their exact shape (`exactOptionalPropertyTypes`-safe).
- **R3 — Reflect stamp carries the skip count (cognition):** `stampPlanOutcome`
  reads `executeResult.stepsSkipped` and includes it in the stamped outcome when it
  is defined and `> 0`. Stamps without skips are byte-identical to today. The
  stamp's existing trigger (`planJustCompleted || planFailed`) and try/catch
  discipline are unchanged — this is one extra field, not a new stamp path.
- **R4 — Skipped verdict in the plan prompt (cognition):** `PlanBuilderImpl` renders,
  in the dynamic section only (spec 021), a skipped outcome as
  `Your last plan was "<stepList>" — N of M steps were skipped.` where `N` is
  `stepsSkipped` and `M` is `outcome.steps.length`. (The success/failure word is
  dropped for skipped outcomes because an unqualified "it succeeded" is precisely
  the lie being repaired; `[plan-memory]` retains the success verdict for logs.)
  Drive deltas, when present, append in the existing `formatDriveDeltas` form before
  the period; the reflection line still follows when `reflected` is true. Verdict
  precedence: `superseded` (spec 056) > `stepsSkipped > 0` > `succeeded`/`failed`.
  An outcome with no `stepsSkipped`, or one with `steps.length === 0`, renders
  byte-identically to spec 055/056.
- **R5 — `[plan-memory]` skipped diagnostic (cognition):** `plan-memory-diagnostic`
  appends ` skipped=<N>` to the line when `outcome.stepsSkipped` is defined
  (e.g. `[plan-memory] agent=iris-1 verdict=succeeded steps=- skipped=2 reflected=true`).
  Lines whose outcome has no `stepsSkipped` render byte-identically, so existing
  spec-056 exact-format assertions keep passing and `grep 'skipped='` is a direct
  live signal for skip frequency.
- **R6 — Skip semantics unchanged (cognition):** `MAX_STEP_FAILURES === 2`, the
  advance-on-skip behavior, the `[step-skip]` line, the system-feedback suffix, and
  the `stepSkipped: true` flag on skip results are untouched. This spec changes what
  is *reported*, never what the engine *does*.

## Acceptance Criteria

- [ ] **AC-1** (R1): Unit test — an agent on a 3-step plan where step 0 is skipped,
      step 1 executes, and step 2 is skipped yields a final `ExecuteResult` with
      `planComplete === true` and `stepsSkipped === 2`; the intermediate result after
      the first skip carries `stepsSkipped === 1`. _(maps to R1)_
- [ ] **AC-2** (R1): Unit test — a skip-free plan never carries `stepsSkipped`
      (`toBeUndefined()`), and switching to a new plan id resets a previously
      accumulated count to 0. _(maps to R1)_
- [ ] **AC-3** (R1, R6): Regression test — the spec-037 skip suite passes unchanged:
      a step still advances only after 2 consecutive failures of the same step,
      `stepSkipped === true` is still returned, `[step-skip]`'s format is unchanged,
      and skip-free execution results keep their existing shape. _(maps to R1, R6)_
- [ ] **AC-4** (R2): Type-level / additive test — `LastPlanOutcome` literals without
      `stepsSkipped` typecheck and behave as before; one with `stepsSkipped: 2`
      typechecks; `pnpm typecheck` passes under `exactOptionalPropertyTypes`.
      _(maps to R2)_
- [ ] **AC-5** (R3): Reflect test — a completed plan whose `ExecuteResult` carries
      `stepsSkipped: 2` stamps `lastPlanOutcome.stepsSkipped === 2`; a completed plan
      with no `stepsSkipped` stamps an outcome with the field absent
      (`toBeUndefined()`). _(maps to R3)_
- [ ] **AC-6** (R4): Builder test — an outcome with `steps: ['a','b','c']`,
      `success: true`, `stepsSkipped: 2` renders exactly
      `Your last plan was "a, b, c" — 2 of 3 steps were skipped.` in the dynamic
      section; with `driveChanges` the deltas render before the period; with
      `reflected: true` the reflection line follows; a superseded outcome still wins;
      an outcome without `stepsSkipped` renders byte-identically to spec 055.
      _(maps to R4)_
- [ ] **AC-7** (R5): Diagnostic test — `planMemoryDiagnosticLine` contains
      `skipped=2` for a skipped outcome and contains no `skipped=` substring when
      `stepsSkipped` is absent; the existing spec-056 exact-string tests still pass.
      _(maps to R5)_
- [ ] **AC-8** (R1–R5): Live run (`USE_REAL_LLM=true SCENE_DURATION_MS=... npx tsx
      examples/dynamic-world-sim.ts`, ~7 min like the #204 evidence run) shows
      `[plan-memory]` lines carrying `skipped=N` for plans that had step skips, and
      the skip count is `<=` the run's `[step-skip]` count; `[plan-repeat]` stays
      bounded. Evidence attached to issue #204. _(maps to R1–R5)_

## Constraints

- Package boundaries: only `shared` (one additive optional field) and `cognition`
  (execute-service, reflect-service, plan-builder, plan-memory-diagnostic, plus their
  tests) may change. No new cross-package dependencies; `shared ← cognition` holds.
  No import cycles. The engine is not modified — the skip decision and its count both
  live in `ExecuteServiceImpl`, which is where the spec-037 threshold is enforced
  (`advanceStep` cannot distinguish a skip advance from a normal advance, so it is
  not the right counter home).
- Additive-optional discipline: `stepsSkipped` is optional everywhere and
  conditionally spread. Skip-free `ExecuteResult`s, spec-055/056 `LastPlanOutcome`
  renders, and existing `[plan-memory]` lines keep their exact shapes.
- Prompt discipline: the skipped line lives in the **dynamic section only**
  (spec 021 KV-cache discipline); the stable prefix is untouched; no outcome → no
  line (never fabricate history).
- Diagnostic discipline (spec 049): one line per formulation, zero LLM calls, pure
  string arithmetic, and a diagnostic failure must never break a cycle.
- What NOT to do:
  - **Do not change skip semantics.** The 2-consecutive-failure guard (spec 037) is
    deliberate livelock defense; this is honesty in reporting, not behavior.
  - **Do not add a new stamp path or make Reflect count skips itself.** Reflect only
    sees the final `ExecuteResult`; the cumulative count must ride that result from
    the Execute phase.
  - **Do not report a per-skip cause** (e.g. "(unavailable affordance)"). Skips are
    generic — precondition failure, execution failure, and navigation `no-route` all
    reach the same guard — so the verdict names the count, not a cause.
  - **Do not break the existing `stepSkipped` boolean** or its memory-suppression
    consumer (spec 040) — `stepsSkipped` (number, per plan) and `stepSkipped`
    (boolean, current step) are distinct fields.
  - **Do not reset the per-plan skip count on a successful step** — it is a plan
    total, not a consecutive-failure streak.
