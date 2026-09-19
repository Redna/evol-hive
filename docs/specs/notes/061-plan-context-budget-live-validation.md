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

## Why the cap did not help: the prefix is ~88% of the ceiling, and the leak lands in `targetArea`

Measured from the run's own payload dump (`PLAN_PAYLOAD_DUMP_DIR`, largest payload per agent):

| part | chars | ~tokens |
| --- | --- | --- |
| `systemPrompt` | 1,256–1,310 | ~320 |
| `tools` (whole array, 14–15 defs) | 5,514–6,080 | ~1.4–1.5k |
| — of which `formulate_plan` | 1,905–2,305 | ~480–580 |
| — of which `talk_to` | 869 | ~220 |
| `perceptionContext` | 2,639–3,171 | ~660–790 |
| **total** | **~9.9–10.0k** | **~2.5k** |

Units matter: the enum is **~6k characters (~1.5k tokens)**, not "9k tokens". The `10000 − budget` figure is the constant-prefix **chars**; across the run that prefix has **median ≈ 8,758 chars** (min 4,373, max 10,000), i.e. ~88% of the ceiling is consumed before any context, leaving ~1.2k chars of headroom at the median.

**The leak's vector is `targetArea`, not `targetAffordance`:**

- `targetAffordance`: 9 values, 117 chars, **0** conversation values (the earlier "each mirror adds contribute/join/leave" claim was **wrong**).
- `targetArea` (built from `knownAreas`): 44 / 50 / 69 values for the three agents, of which **27 / 33 / 52 are leaked conversation ids** (`conv-…`). Most of that enum is the #224 leak.

So the mechanism is: leak → conversation mirrors in `room.objectIds` → `knownAreas` → the **`targetArea` enum** and the `known-areas` context block grow → the un-budgeted prefix consumes the ceiling → the budgeter starves the context. (`systemPrompt` and `tools` are deliberately never budgeted: enum = plan legality, spec 037/058.)

Separately observed: `observe` is emitted **three times** as an affordance tool def (~165 chars each) — a small independent duplication waste.

## Secondary signals (plan quality degraded)

- `[plan-invalid]` reasons **flipped**: `missing-description` 1,002,
  `empty-step-description` 444 (060: empty-step 888, missing-description 12). A
  new dominant failure mode.
- `[plan-floor]` engaged **207×** (060: 0); `[plan-repeat]` 182 (060: 1).
- Step skip share ramped 1.8% → **20.4%** (060: ~1.3%).
- Executions 1,705 (060: 768) — continuity held, but at a much higher skip cost.

## Conclusion and next action

1. **#224 (conversation-object leak) is the prime suspect** and the next work
   item: it injects 27–52 dead conversation ids into the `targetArea` enum (via
   `knownAreas`) and into the `known-areas` context block, unbounded.
2. **#212** (non-executable conversation affordances in the plan enum) is
   adjacent but **not** what this run shows: `targetAffordance` carried no
   conversation values. #212's path was not observed here and should be
   re-checked against its own reproduction.
3. **Re-run this ceiling validation after #224** to separate the leak's effect
   from the ramp; and re-evaluate whether `PLAN_PROMPT_MAX_CHARS=10_000` is right
   once the enum stops leaking (it may currently be too tight, given the enum
   alone can exceed 9k chars).
4. Do **not** treat spec 060's AC-7 "mechanism = prompt growth" as established;
   the next spec on this ramp must start from the enum (legality-bearing, never
   budgeted), not the context.

---

## R5 probe (H1/H2 discriminator) — the ramp's mechanism identified

**Method.** Replay the run's own late-run payloads (`PLAN_PAYLOAD_DUMP_DIR`,
largest per agent) against `gemma4:31b-cloud`, faithful to
`OpenAICompatibleLLMClient.sendRequest` (`{model, messages, tools, stream:false,
tool_choice:'auto'}`), classified with the shared `classifyPlanShape` + the
client's `decodeFormulatePlanArgs` (`/tmp/r5-probe.mjs`).

| experiment (late payload, cc=1, n=20) | tool chosen | reason |
| --- | --- | --- |
| unmodified, cc=1 | `talk_to` 20/20 | `missing-description` |
| unmodified, **cc=3** | `talk_to` 20/20 | `missing-description` |
| social-imperative lines removed | `observe_agent` 20/20 | `missing-description` |
| social tools removed from `tools` | `talk_to` 19/20 | `missing-description` |
| social framing + social tools removed | **`formulate_plan` 20/20** | `empty-step-description` |

- **H2 (provider load) falsified:** cc=1 and cc=3 are identical (0/20 each).
- **H1 (prompt size) already falsified** by the run (size flat, rate ramped).
- The model is **not producing malformed plans** — it is calling `talk_to`, which
  `completePlan` classifies as a shape failure (`missing-description`).

**Why: the plan phase's own context instructs it.** The system message ends
`… do not use formulate_plan for social actions.` immediately followed by
`You must use formulate_plan to create a plan before taking any physical
action.` The user message adds `Agents present: …`,
`Primary drive: low social, need to restore social`,
`Your social drive is your most urgent need. Call talk_to or help NOW … Do not
formulate a plan first.` and
`IMPORTANT: Other agents are present. Call talk_to, … Do not use formulate_plan
for social actions.` The model obeys the plan phase's own instruction, and the
plan phase rejects the obedient answer.

**The "invalid rate" therefore conflates two modes** (061 run: 1,446 invalids):

1. **Social-routing contradiction** — `missing-description`, **1,002 (69%)**: the
   model calls a social tool. Rises as agents co-locate and social urgency
   grows — **this is the ramp**.
2. **Genuine shape failure** — `empty-step-description`, **444 (31%)**: the mode
   spec 060 targeted. Still real, but not the ramp's driver.

**Implications.**

- Spec 060's client repair and spec 061's context ceiling both address mode 2 /
  prompt size; neither can fix mode 1, because the model is doing what the prompt
  says.
- The fix is **routing**, not repair or compression: the plan phase must either
  stop rendering social imperatives / stop offering social tools, or accept a
  legitimate social tool call as an action rather than a plan failure — exactly
  **#212**'s "route them or narrow the value space".
- **#224** (dead conversation mirrors) remains a separate *correctness* bug
  (pollutes `objects`/`knownAreas`/`targetArea`); fix it, but it is not the ramp.
