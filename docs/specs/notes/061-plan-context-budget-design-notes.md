# Spec 061 — Plan-Context Budgeting — Design Notes (Architect)

Issue: [#219](https://github.com/Redna/evol-hive/issues/219) · Parent: [#214](https://github.com/Redna/evol-hive/issues/214) · Status: 📝 Drafted

> These notes are the Architect's rationale. The YAAM `yaam_workspace_initialize` /
> `yaam_workspace_append_note` tools were **not exposed in the drafting session**, so the
> decisions are recorded here in the repo's `docs/specs/notes/` convention.

## Codebase finding that shaped the scope

Before designing, I read the actual plan-prompt construction
(`packages/cognition/src/pper/plan-builder.ts`), the diagnostics
(`plan-shape-diagnostic.ts`), and the memory seam (`pper/index.ts`,
`packages/memory/src/retrieval/memory-injector.ts`):

1. **`PassivePerception.associativeMemories` is populated but never rendered.** The assembler
   fills it (`pper/index.ts:55,66`), but neither `PlanBuilderImpl` nor
   `PerceptionBuilderImpl` emits a line from it. The issue's "long-term recall injected into
   the plan payload" is therefore **not true of the current plan prompt**. This is a finding,
   not an assumption — it is why R3 defines/tests a recall tier but **does not wire** rendering
   (Decision 5), and why R4's `[plan-context] top=` diagnostic is the deliverable that actually
   names the growing block.
2. **`systemPrompt` and the `formulate_plan` tools are constant** for a given
   (persona, room, affordance set). `knownAreas` feeds both the `targetArea` enum and the
   `Known areas` line, so if it were growing the tools would not be constant. The issue reports
   them constant, so the grower is one of the dynamic context blocks.
3. A measured baseline on a representative fixture: `systemPrompt` 627 chars, tools JSON
   3,495 chars (8 affordances), context 1,030 chars — confirming tools dominate the constant
   prefix and that the 9,435 → 17,783 char ramp is context growth.

## Decisions (the WHY)

- **D1 — Budget the assembled context, not a named culprit.** H1 (context growth) and H2
  (provider load) are collinear in one run, and the exact growing block is unnamed. A
  block-level budget bounds the prompt immediately *and* the `top=<id:chars>` diagnostic names
  the grower from logs. The fix does not depend on a guess.
- **D2 — Priority, not blind truncation.** A raw char cut can sever the drive/restorer hints
  (spec 034/052) that keep plans executable. Required Tier 0–1 (room, drives, hints, feedback)
  is never dropped; boilerplate/history (horizon, social history) drops first. Byte-identical
  under budget keeps every existing golden green (spec 021/055).
- **D3 — Never budget the tool enum.** The enum is plan *legality* (spec 037/058). Shrinking it
  would invalidate previously-legal plans and re-create the failure class being fixed. The
  ceiling applies to `perceptionContext`; because the prefix is constant, the total-prompt
  invariant `prefix + ceiling` is enforceable.
- **D4 — Keep spec 060's repair; the ceiling is the rate/cost control.** The repair already
  converts 98% of malformed responses and cut `[plan-failed]` 90%; the residual defects are the
  provider *rate* and the 2× token cost of 884 repairs. A ceiling attacks both without removing
  the safety net.
- **D5 — `cognition`-only, recall tier reserved but not wired.** Weighted retrieval already
  lives in `memory` and the provider already returns ranked top-K; the builder only needs to cap
  the count. Adding `associativeMemories` rendering here would inject a new unbounded input into
  the very prompt being bounded, so it is Deferred. No `shared`/`engine`/`memory` change.
- **D6 — A dedicated late-payload dump.** The existing `/tmp/empty-args-*.json` dump captures
  the *first* malformed payload per agent — early and small. The H1/H2 discriminator needs a
  **late** payload; hence the env-gated largest-payload dump (`PLAN_PAYLOAD_DUMP_DIR`), inert
  by default so no live-run behavior changes.

## The two honest caveats carried into the spec

1. **H2 is not excluded.** If the probe shows the late payload fails at `cc=1`, prompt growth is
   confirmed (H1); if it only fails at `cc=3`, the ceiling is defense-in-depth and the real fix
   is operational (H2). AC-5 records whichever numbers result.
2. **`knownAreas`/the enum is the one grower Decision 3 cannot cap.** If the probe names it, the
   enum budget becomes its own spec because it changes plan legality; the `top=` line will
   surface it in the ceiling re-run.

## Default ceiling

`DEFAULT_PLAN_PROMPT_MAX_CHARS = 10_000` is deliberately **below the measured knee** (rate
2.1% at 9,435; 16.3% at 11,230; 79% at 13,167) and is env-overridable for probe calibration. It
is a starting value, not an optimum. See spec R5/AC-5.
