# Spec 061 live validation — AC-8 NOT MET, and H1 (prompt growth) falsified

> Run: 40 min, 3 agents, `gemma4:31b-cloud`, `ENGINE_MAX_CONCURRENT_LLM=3`,
> `PLAN_PROMPT_MAX_CHARS=10000`, `PLAN_PAYLOAD_DUMP_DIR` on, `dist` rebuilt from
> the merged R1–R4 code. Log `/home/anima/061run.log` (42,199 lines, 2,276 plan
> prompts). Metrics on the tick axis (`/tmp/run-metrics-061.mjs`, validated
> against the 060 log — it reproduces 060 exactly).

## AC-8 verdict: NOT MET

| tick-quintile | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| avg `[plan-prompt]` chars | 8,984 | 9,619 | 9,746 | 9,901 | **9,885** |
| shape-invalid rate (pre-repair) | 3.6% | 55.1% | 79.9% | 86.6% | **96.1%** |

Run-wide 63.5% (1446/2276). Criterion: final quintile ≤ run-wide **and** ≤ 10%.
Compare the spec-060 run: chars 9,435 → 17,783; rate 2.1% → 89.2%; run-wide 53.5%.

## The ceiling itself works

`avg-chars` is **flat** (~9k–9.9k) across the whole run, versus the unbounded
9.4k → 17.8k growth in the 060 run. The budgeter caps the perception context as
designed; the total prompt no longer grows.

## Therefore H1 (prompt-size growth) is falsified

With prompt size held flat, the shape-invalid rate **still** ramps 3.6% → 96.1%.
Prompt growth was a correlation in the 060 run, not the cause of the ramp.

## What grew instead — the `[plan-context] top=` diagnostic names it

`top` distribution over 2,276 formulations:

| top block | count |
| --- | --- |
| **objects** | **1,541** |
| known-areas | 650 |
| system-feedback | 72 |
| horizon | 8 |
| social-directive | 4 |
| drive-hints | 1 |

The context is dominated by the **`objects`** block — i.e. the leaked
conversation objects from **#224** (62 dead `Conversation: …` mirrors in a single
26-minute window). The second grower, `known-areas`, feeds the `targetArea` enum
(the spec's named contingency).

## Why the cap did not help: the enum is never budgeted

`systemPrompt` and `tools` are deliberately **not** budgeted (enum = plan
legality, spec 037/058). The affordance/tool enum grows with the leaked
conversation mirrors (#224, each carrying `contribute/join/leave`) and with
`known-areas`. So the *constant prefix* grew while the *budgeted context* shrank:
the `[plan-context] budget=` headroom fell from ~3,347 to ~1,000 chars, and the
budgeter then **starved** the context — dropping `known-areas`, `last-plan`,
`social`, `relationships` and truncating `system-feedback`.

So the ceiling treated a symptom (context size) that was not the driver, while
the real growth (the un-budgeted enum) continued unchecked.

## Secondary signals (plan quality degraded)

- `[plan-invalid]` reasons **flipped**: `missing-description` 1,002,
  `empty-step-description` 444 (060: empty-step 888, missing-description 12). A
  new dominant failure mode.
- `[plan-floor]` engaged **207×** (060: 0); `[plan-repeat]` 182 (060: 1).
- Step skip share ramped 1.8% → **20.4%** (060: ~1.3%).
- Executions 1,705 (060: 768) — continuity held, but at a much higher skip cost.

## Conclusion and next action

1. **#224 (conversation-object leak) is the prime suspect** and the next work
   item: it inflates the un-budgeted tool enum and the `objects` context block
   without bound.
2. **#212** (non-executable conversation affordances in the plan enum) is
   entangled — the leaked mirrors are exactly what puts `contribute/join/leave`
   in the enum.
3. **Re-run this ceiling validation after #224** to separate the leak's effect
   from the ramp; and re-evaluate whether `PLAN_PROMPT_MAX_CHARS=10_000` is right
   once the enum stops leaking (it may currently be too tight, given the enum
   alone can exceed 9k chars).
4. Do **not** treat spec 060's AC-7 "mechanism = prompt growth" as established;
   the next spec on this ramp must start from the enum (legality-bearing, never
   budgeted), not the context.
