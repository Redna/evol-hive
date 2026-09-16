# Feature: Plan-Context Budgeting — Bound the Plan Prompt's Perception Context (Issue #219)

## Context

- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md) (the Plan phase is the only place a plan is formulated; the prompt is assembled per cycle), [§7 — Structured Outputs](../architecture/07-structured-outputs.md) (the `formulate_plan` tool-call contract the shape check guards), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (§11.1 dual-track injection, §11.2 weighted retrieval — the ranking already applied by the provider), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (plan validation), [§5 — Fast-Path Classifier](../architecture/05-fast-path-classifier.md) (the pruned affordance value space), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (`currentPlan`, `isThinking`)
- Related specs: [060 — Plan-Formation Shape-Failure Diagnostics, Bounded Repair & Fallback Floor](060-plan-formation-shape-failure-recovery.md) (the `[plan-prompt]`/`[plan-invalid]` diagnostics, the client-seam repair, Decision 5 that deferred this root-cause fix), [059 — Plan-Retention Re-Validation](059-plan-retention-revalidation.md) (the run that first saw the ramp; re-formulation frequency was deliberately raised there), [055 — World Saturation & Plan-Memory Horizon](055-world-saturation-plan-memory-horizon.md) (the last-plan/outcome lines and the horizon directive; the `getAssociativeMemories` integration point), [014 — Memory Consolidation, Decay & Weighted Retrieval](014-memory-consolidation-decay-retrieval.md) (§11.2 weighted retrieval — the existing ranking, not re-implemented here), [021 — KV-Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (stable-prefix discipline), [049 — Diagnostic Pattern](049-dialogue-completion-urge-observability-reply-window.md) (zero-LLM stderr diagnostics, never break a cycle), [037 — Enum-Bound Plan Formulation](037-enum-bound-plan-formulation.md) / [058 — Eligibility-Bound Plan Affordances](058-eligibility-bound-plan-affordances.md) (the tool enum is the plan's value space — it must not be silently changed), [002 — Plan Phase](002-plan-phase.md) (plan stickiness), [008 — PPER Error Recovery](008-pper-error-recovery.md)
- Package: `cognition` (prompt assembly, budgeter, diagnostics, probe dump). `shared`/`engine`/`memory` are **untouched**.
- Issue: [#219 — Plan-prompt context growth drives the shape-invalid ramp](https://github.com/Redna/evol-hive/issues/219)
- Parent: [#214 — Plan formation returns shape-invalid plans at a rising rate](https://github.com/Redna/evol-hive/issues/214) (AC-8 is the shared live gate)

## Problem Summary

The spec-060 40-minute live run (main `9bd28b8`, 3 agents, `gemma4:31b-cloud`, `ENGINE_MAX_CONCURRENT_LLM=3`) names the mechanism behind the rising shape-invalid rate: the plan prompt's per-cycle **perception context** grows monotonically, and the provider's shape-invalid rate tracks it almost exactly.

| tick-quintile | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| avg `[plan-prompt]` chars | 9,435 | 11,230 | 13,167 | 15,251 | **17,783** |
| shape-invalid rate (pre-repair) | 2.1% | 16.3% | 79.2% | 89.3% | **89.2%** |

Spec 060 made each malformed response *cheap* — the client-seam repair recovered 98% (884 repairs / 17 failed) and `[plan-failed]` fell from 1,537 to 157 — but it cannot lower the *rate*, which is a prompt-construction property. It explicitly deferred the durable fix (Decision 5). That deferral is this spec, and it is the remaining blocker for #214 AC-8.

The reason distribution is 98.6% `empty-step-description`: the model returns a well-shaped plan object whose per-step descriptions are empty — an attention/truncation failure on a long structured-output call, not a decode failure (H3 is falsified by the repaired responses).

**Codebase finding (Architect, pre-design).** `PlanBuilderImpl` renders, in order: stable lines (room, objects, agents present, relationships, compound actions, object dependencies) and dynamic lines (primary drive, drives, last-plan/outcome, reflection follow-up, social messages, social directives, drive hints, known/unexplored areas, the horizon directive, system feedback, the stuck warning). Two facts matter for scoping:

1. `PassivePerception.associativeMemories` is *populated* by `PassivePerceptionAssembler` (spec 055 / spec 014 integration point) but is **not rendered by any builder today** — so "long-term recall" is not currently a plan-prompt contributor. The spec-055 intent ("reflection surfacing rides the existing `getAssociativeMemories` path") is unrealised in the plan builder.
2. `systemPrompt` and the `formulate_plan` tool definitions are constant for a given (persona, room, affordance set). The `knownAreas` list feeds the `targetArea` enum *and* the `Known areas` context line, so if it were the grower the tool definitions would **not** be constant — the issue's observation says they are.

The exact growing block is therefore **unnamed**. The issue's H1 (prompt/context growth) and H2 (provider load/degradation) are still collinear within one run. This spec's first deliverable is the instrument that names the block, its second is the ceiling that bounds it, and its third is the discriminating probe.

## Requirements

### R1 — One pure, deterministic plan-context budgeter (`cognition`)

Add `packages/cognition/src/pper/plan-context-budget.ts`:

- `type PlanContextBlockId = string` — a stable, grep-able id per rendered block (e.g. `room`, `objects`, `agents-present`, `relationships`, `compound-actions`, `object-dependencies`, `primary-drive`, `drives`, `last-plan`, `last-plan-reflection`, `social-messages`, `social-primary-hint`, `social-directive`, `drive-hints`, `known-areas`, `known-areas-directive`, `unexplored-areas`, `horizon`, `system-feedback`, `stuck-warning`).
- `interface PlanContextBlock { id: PlanContextBlockId; text: string; required?: boolean; }` — a block is a contiguous run of one or more already-rendered lines; `text` never contains the join separator.
- `interface BudgetedPlanContext { perceptionContext: string; originalChars: number; chars: number; budgeted: boolean; droppedBlockIds: string[]; truncatedBlockId?: string; }`.
- `function budgetPlanContext(blocks: readonly PlanContextBlock[], maxChars: number): BudgetedPlanContext` — pure and synchronous:
  - Blocks are joined with `'\n'` **in their original order**. Under budget (`totalChars <= maxChars`) the result is **byte-identical** to `blocks.map(b => b.text).join('\n')` — no reordering, no dedup, no whitespace change.
  - When over budget, drop whole **optional** blocks from the lowest priority upward (priority table in R2) until the total fits, then re-join. Dropped ids are reported in `droppedBlockIds` in drop order.
  - `required` blocks are never dropped. If required blocks alone exceed `maxChars`, keep every required block and hard-truncate the **last required block** at the char boundary that fits, appending the explicit marker `…[truncated]` (the marker counts toward the budget); report the block id in `truncatedBlockId`. The function never throws on a negative/zero budget — it returns the required blocks truncated to `max(0, maxChars)`.
- `function planPromptMaxChars(): number` — the effective ceiling from `PLAN_PROMPT_MAX_CHARS` at call time, parsed with the existing env pattern (`packages/cognition/src/pper/plan-service.ts::planFloorAfterFailures`): absent/empty/non-finite/non-positive → `DEFAULT_PLAN_PROMPT_MAX_CHARS`. Exported `DEFAULT_PLAN_PROMPT_MAX_CHARS = 10_000`.

### R2 — The plan builder enforces the ceiling without touching the legality surface (`cognition`)

Refactor `PlanBuilderImpl.build` so the assembled context is an ordered `PlanContextBlock[]`, then budget it:

- Compute `systemPrompt` and `tools` first; `headroom = planPromptMaxChars() - systemPrompt.length - JSON.stringify(tools).length`; call `budgetPlanContext(blocks, Math.max(0, headroom))`; assign `perceptionContext` from the result. The `'---'` separator between the stable and dynamic sections is preserved as part of the block stream (it is not a droppable block).
- **`systemPrompt` and `tools` are never budgeted, reordered, truncated, or regenerated by the budgeter.** The `formulate_plan` enum value space (spec 037/058) and the KV-cache stable prefix (spec 021) are therefore untouched. This is a hard constraint: a budget that shrank the affordance enum would silently change what a legal plan is.
- **Priority table** (highest survives longest; the budgeter drops from the bottom first). `required` = never dropped:

  | Tier | Blocks | Kind |
  | --- | --- | --- |
  | 0 | `room`, `objects`, `primary-drive`, `drives` | required |
  | 1 | `system-feedback`, `stuck-warning`, `social-directive`, `social-primary-hint`, `drive-hints` | required |
  | 2 | `known-areas`, `unexplored-areas`, `known-areas-directive`, `agents-present` | optional (keep last) |
  | 3 | `last-plan`, `last-plan-reflection` | optional |
  | 4 | `social-messages`, `relationships`, `compound-actions`, `object-dependencies` | optional |
  | 5 | `horizon` | optional (drop first) |

  Rationale: Tier 0–1 is what the agent must know to act safely (room, urgent drives, the restorer hints, failure feedback). Tier 2 keeps the spatial value space visible. Tier 3 is plan memory ("dropping plan-memory lines beyond N" — the issue's stated option). Tier 5 is always-on boilerplate. A `required` block set that alone exceeds headroom is truncated, never dropped, so a plan request is always well-formed.
- Byte-identity when under budget: the spec-021 stable-prefix goldens and the spec-055 `GOLDEN_CONTEXT_NO_RECORD` must pass **unmodified** for fixtures whose total is under `DEFAULT_PLAN_PROMPT_MAX_CHARS`.
- The builder **does not add** any new memory/recall rendering. Bounding the current context is the fix; closing the spec-055 `associativeMemories` gap is out of scope (Deferred) and would *increase* the prompt it is trying to bound.

### R3 — Bounded recall tier, applied whenever a memory block exists (`cognition`)

The budgeter's Tier 3 explicitly owns plan memory, and a reserved `recall` id (Tier 3.5, between plan memory and Tier 4) owns long-term recall lines. If/when a recall block is present, its text is capped by `PLAN_RECALL_MAX_LINES` (default `3`, env-overridable) snippets and `PLAN_RECALL_MAX_CHARS` (default `400`, env-overridable), preserving the provider's existing weighted-retrieval order (§11.2, spec 014) — no new ranking, no provider change, no cross-package import. This requirement is **defensive and test-only in this spec**: it guarantees that the tier that grows unboundedly in a future wiring is bounded before it can, and gives AC-3's "oversized memory payload" a concrete subject.

### R4 — Observability: name the growing block (`cognition`)

- Keep the existing `[plan-prompt] agent=<id> chars=<n> estTokens=<n>` line **byte-identical** (spec-060 tests parse it and it is the pre-repair rate denominator).
- Add one `[plan-context]` line per plan formulation, zero-LLM, pure string arithmetic, emitted at payload assembly and individually wrapped so a throwing writer never breaks a cycle (spec 049):
  `[plan-context] agent=<id> orig=<n> budget=<n> kept=<n> dropped=<id,id|none> top=<id:chars>[ trunc=<id>]`
  - `orig`/`budget` are the pre-/post-budget `perceptionContext` chars; `top` is the largest surviving block and its char count. `top` is the live instrument that **names the growing block** from logs alone (issue AC-4's precondition).
- Add an env-gated full-payload dump so a **late-run** payload can be replayed offline (the existing `/tmp/empty-args-<agent>.json` dump captures only the *first* malformed payload per agent — too early for an H1/H2 discriminator):
  - When `PLAN_PAYLOAD_DUMP_DIR` is set, write the full `{ messages, tools, systemPrompt, perceptionContext, agentId }` for the **largest** plan payload seen per agent to `<dir>/plan-payload-<agent>.json`, overwriting only when the new payload is larger. Zero-LLM, wrapped, and inert when the env var is unset (no live-run behavior change).

### R5 — H1/H2 discriminator and context-ceiling re-run (evidence, issue-owned)

1. **Probe (standalone replay).** Replay a captured late-run payload (`PLAN_PAYLOAD_DUMP_DIR` dump, or the existing `[llm-raw]` dump) at concurrency 1 and concurrency 3 with a fixed model, plus an early small payload at concurrency 3 as a control. Compare shape-invalid counts at matched prompt size. **H1** (prompt/context) predicts the late payload fails at `cc=1`; **H2** (provider load) predicts it fails only at `cc=3`.
2. **Ceiling re-run.** Re-run the 40-minute #206 harness with the ceiling enforced and compare the per-quintile `[plan-invalid]`/`[plan-prompt]` rate against the spec-060 run; use `[plan-context] top=` to confirm the capped block(s).
3. Record both results, with numbers, in the spec notes and on #219.

### R6 — Live validation (`cognition` + live-env, issue-owned)

A 40-minute real-LLM run of the #206 AC-7 harness on a freshly built `dist` (live sims resolve built `dist/`, per spec 037 Evidence) is the acceptance instrument for the ramp. The run must also confirm the spec-060 repair recovery and the spec-059 retention bounds still hold in the same run.

### R7 — Regression discipline (`cognition`)

All existing plan/guardrail suites pass **unmodified**, in particular spec 021/031/037/039/051/055/056/057/058/059/060. The builder's under-budget output must be byte-identical to today's. No `shared`, `engine`, or `memory` source changes.

## Acceptance Criteria

- [ ] **AC-1** (R1, R2, R4): `PLAN_PROMPT_MAX_CHARS` (env-overridable, default conservative) bounds the plan payload's perception context; `estimatePlanPrompt(payload).chars ≤ PLAN_PROMPT_MAX_CHARS` for every assembled payload; the effective `[plan-prompt]` size and the `[plan-context] top=`/`dropped=` breakdown are present on every request. _(maps to R1, R2, R4)_
- [ ] **AC-2** (R6): In a 40-minute live run, the final tick-quintile `[plan-invalid]`/`[plan-prompt]` rate (measured **pre-repair**) is **≤ the run-wide rate** and **≤ 10%** — this is #214 AC-8, and the two issues share this one live gate. `[plan-repair]` recovery and `[plan-floor]` account for any residual failures; `[plan-repeat]` stays bounded (spec 055) and no plan+step is handed to Execute unboundedly (spec 059). Evidence attached to #219/#214. _(maps to R6; live/issue-owned — not run in the implementation PR)_
- [ ] **AC-3** (R1, R2): Unit tests — an under-budget fixture is byte-identical to the pre-change builder (spec-021/055 goldens); a fixture with a deliberately oversized recall/plan-memory payload is budgeted so the required Tier 0–1 blocks survive and the reported `droppedBlockIds` follow the Tier-5-first order; a `required`-only payload forces the truncation path and never throws; `estimatePlanPrompt` on the budgeted payload is `≤` the configured ceiling; `planPromptMaxChars()` parses env overrides and rejects invalid values. _(maps to R1, R2)_
- [ ] **AC-4** (R3): Unit tests — a recall block over `PLAN_RECALL_MAX_LINES`/`PLAN_RECALL_MAX_CHARS` is dropped/truncated preserving the provider's weighted-retrieval order; the caps are env-overridable; the budgeter applies no ranking of its own. _(maps to R3)_
- [ ] **AC-5** (R5): The H1/H2 discriminator result is recorded in the notes with its numbers (a standalone replay of a late-run payload at `cc=1` and `cc=3`, plus the early control), and the ceiling re-run's per-quintile rate is recorded against the spec-060 table. The verdict names prompt/context growth, provider load, or both. _(maps to R5; live/issue-owned)_
- [ ] **AC-6** (R7): Regression — spec 021/031/037/039/051/055/056/057/058/059/060 suites pass **unmodified**; `pnpm -r test && pnpm typecheck && pnpm lint` pass; `shared`/`engine`/`memory` have no source changes. If any listed suite needs editing, the implementation has left this spec's scope. _(maps to R7)_

## Constraints

- **Package boundaries (ADR-0001)**: only `cognition` changes. The budgeter imports from `@evol-hive/shared` types at most; no `engine`/`memory` import, no new cross-package dependency, no import cycle. Weighted retrieval stays in `memory`; the plan builder consumes the provider's already-ranked order.
- **The legality surface is immutable**: the budgeter must **not** modify, reorder, shrink, or regenerate `systemPrompt` or `tools`. The `formulate_plan` `targetAffordance`/`targetArea` enums and the persona-keyed stable prefix stay byte-identical (spec 021, spec 037/058). A ceiling that silently removes a legal plan choice is a correctness bug.
- **Boundedness, not a new retry**: no new LLM call, no retry, no second repair. Spec 060's client-seam repair stays the correctness defense; this ceiling is the **cost/rate control** (the issue: 884 repairs → 20.6M prompt tokens vs 9.7M pre-060).
- **Diagnostic discipline (spec 049)**: every new line is one line per event, zero LLM, pure string arithmetic, wrapped so logging can never break a cycle. No diagnostic is added to the stable system prompt prefix.
- **Determinism**: `budgetPlanContext` is pure and synchronous; equal inputs yield equal outputs; no clock, no I/O, no env read inside the pure function (the env-derived ceiling is passed in).
- **Default must be conservative and calibrated**: `DEFAULT_PLAN_PROMPT_MAX_CHARS = 10_000` is a starting ceiling chosen **below** the measured danger zone (the rate crossed ~16% at 11,230 chars and ~79% at 13,167), not an empirical optimum. The probe (R5) calibrates it; it is never lowered into the constant prefix (the builder logs the `over-prefix` case rather than emitting an empty context).
- **What NOT to do**:
  - **Do not** budget by mutating `tools`/`systemPrompt`, or budget the enum to reduce size.
  - **Do not** add long-term memory rendering to the plan builder in this spec (that is an unbounded new input; the spec-055 gap is Deferred).
  - **Do not** re-rank or re-implement weighted retrieval in `cognition` (spec 014 owns it); do not touch `memory`.
  - **Do not** change the `[plan-prompt]` line format (spec-060 tests and the rate denominator), the spec-037 service shape contract, or the spec-060 repair/floor behavior.
  - **Do not** make the ceiling a hard failure: a budgeted plan request must still be sent, never skipped or errored.
  - **Do not** edit `dist/` — rebuild (`pnpm build`) before any live validation run (spec 037 Evidence).

## Design Decisions

**Decision 1 — Budget the assembled context, not a named culprit.** The exact growing block is unnamed (the issue's "long-term recall" is not currently rendered; `systemPrompt`/tools are reported constant) and H1/H2 are collinear. A block-level budgeted context with a `[plan-context] top=` diagnostic both bounds the prompt now and names the grower from logs, so the fix does not depend on a guess. Byte-identity under budget keeps the change invisible to every existing golden.

**Decision 2 — Prioritise, don't truncate blindly.** A raw char cut can sever the drive/hint lines that make a plan safe (spec 052's wait-guard compatibility, spec 034's restorer hints). A fixed priority table drops boilerplate and history first and never drops the room/drive/feedback/hint floor, so a budgeted prompt remains actionable. Required blocks truncate only as a last resort, and never silently disappear.

**Decision 3 — Never budget the tool enum.** The `formulate_plan` enum is *plan legality* (spec 037/058), not prompt text. Budgeting `tools` would make previously-legal plans invalid and re-introduce the exact class of `empty-step-description`/binding failures this work is meant to reduce. The ceiling therefore applies to `perceptionContext`; the total-prompt bound is `constantPrefix + ceiling`, which is enforceable because the prefix is constant.

**Decision 4 — Keep spec 060's repair; add the ceiling as cost control.** The repair already converts a malformed response into a usable plan (98% recovery) and lowered `[plan-failed]` 90%. The remaining defects are (a) the provider *rate* and (b) the 2× token cost of 884 repairs. A ceiling attacks both without removing the safety net; if the probe confirms H2, the ceiling is defense-in-depth and the load fix is operational.

**Decision 5 — `cognition`-only, recall tier reserved but not wired.** Weighted retrieval already lives in `memory` and the provider already returns a ranked top-K; the builder needs only to cap the count. Adding `associativeMemories` rendering here would inject a new unbounded input, so the tier is defined and tested but the wiring is Deferred. This keeps the package boundary strict and the prompt-size change purely downward.

**Decision 6 — A dedicated late-payload dump.** The existing `[llm-raw]` full-payload dump fires on the *first* malformed response per agent — early-run and small — while H1/H2 must be discriminated on a **late-run** payload. An env-gated largest-payload dump is the minimum instrumentation needed to make AC-5 possible without changing default live behavior.

## Deferred / Out of Scope

- **Wiring `PassivePerception.associativeMemories` into the plan prompt.** This spec reserves and bounds a recall tier but does not add the rendering; closing the spec-055 intent is a separate change (it is a new prompt input and its own budget/legality question).
- **If the probe names `knownAreas`/the `targetArea` enum as the grower.** Bounding the enum changes plan legality (spec 039/058) and needs its own spec; this spec's `top=` diagnostic will surface it. This is the one place Decision 3 would need revisiting.
- **Provider-side load mitigation (H2).** Concurrency/queue tuning is operational and belongs with the #206/#214 live-run protocol, not this code contract.
- **Spec 060's fallback floor tuning** and the conversation-affordance plan-enum executability deferred from spec 059 remain out of scope.
