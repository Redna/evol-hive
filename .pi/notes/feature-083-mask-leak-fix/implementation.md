# Implementation Notes — Spec 020 (PPER Mask Leak Fix, Issue #83)

## What was built

### Shared layer (`@evol-hive/shared`)
- **`packages/shared/src/types/cognition.ts`** — Added an optional
  `maskedAffordances?: Affordance[]` field to the `PerceptionResult`
  interface. Updated the JSDoc on `prunedAffordances` to clarify it is the
  **unmasked** classifier output used by the Plan builder. The new
  `maskedAffordances` field holds the output of
  `GuardrailEngineImpl.maskAffordances` for use by the Perception/Action-choice
  builder; it is `undefined` when no guardrail engine is configured (Req 1, 2;
  AC-1, AC-2).

### Cognition layer (`@evol-hive/cognition`)
- **`packages/cognition/src/pper/index.ts`** —
  `PerceptionServiceImpl.perceive()` now stores the **unmasked** classifier
  output in `prunedAffordances` and the **masked** result in
  `maskedAffordances` (omitted from the return object when no guardrail is
  present). Added `Affordance` to the type imports (Req 3; AC-3 through AC-6).
- **`packages/cognition/src/pper/perception-builder.ts`** —
  `PerceptionBuilderImpl.build()` now reads
  `maskedAffordances ?? prunedAffordances` for constructing
  `availableAffordances` and `tools` in the `LLMContextPayload`. The
  `noPlan && maskingEnabled` defense-in-depth check is retained. Removed the
  now-unused `prunedAffordances` from the local destructure (Req 4, 6; AC-7
  through AC-9).
- **`PlanBuilderImpl.build()`** — No source change required. It already reads
  `prunedAffordances`; the fix is that `prunedAffordances` now contains the
  correct (unmasked) value (Req 5; AC-10, AC-11).

### Test layer (`packages/cognition/tests`)
- **`guardrails.test.ts`** — Updated AC-15/AC-16 and backward-compat /
  masking-disabled tests to assert on `maskedAffordances` (and that
  `prunedAffordances` retains the unmasked classifier output) (Req 7, 8, 9;
  AC-12 through AC-15 of spec 020).
- **`spec-016-coverage.test.ts`** — Updated the AC-15 and AC-16 `it.todo`
  scaffolds to reference `maskedAffordances` for the masking assertion and
  `prunedAffordances` for the unmasked preservation assertion (Req 10; AC-16
  of spec 020).
- **`spec-020-pper-mask-leak-fix.test.ts`** (new) — Integration regression
  tests verifying:
  - `PlanBuilderImpl.build()` always sees affordance tools (built from
    unmasked `prunedAffordances`) regardless of masking state — including the
    critical case where `maskedAffordances` is `[]` and the agent has no plan
    (AC-10, AC-11).
  - `PerceptionBuilderImpl.build()` reads `maskedAffordances ?? prunedAffordances`
    and hides affordance tools when no plan + masking enabled, while still
    including them when a plan exists or masking is disabled (AC-7, AC-8, AC-9).

### Spec 016 amendment
- **`docs/specs/016-cognitive-guardrails.md`** — Amended Req 8 (masked result
  stored in `maskedAffordances`, not replacing `prunedAffordances`), Req 10
  (Perception builder reads `maskedAffordances`; masking applies only to the
  Perceive/Choose phase), and AC-15/AC-16 (assert on `maskedAffordances` plus
  `prunedAffordances` retaining unmasked output) (Req 13–16; AC-17 through
  AC-20 of spec 020).

### Index
- **`docs/specs/INDEX.md`** — Added the spec 020 row with status
  "🔍 In Review" and bumped the spec status summary totals.

## Verification
- `pnpm typecheck` — passes (all packages).
- `pnpm lint` — passes.
- `pnpm format:check` — passes.
- `pnpm build` — passes (all packages, including DTS generation).
- `pnpm test` — all 467 cognition tests + 488 engine tests + 77 examples
  tests pass; no regressions.

## Branch / PR
- Branch: `feature/083-pper-mask-leak-fix`