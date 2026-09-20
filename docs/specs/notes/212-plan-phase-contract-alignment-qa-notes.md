# Issue #212 — Plan-Phase Contract Alignment: QA Notes (PR #226)

> Spec referenced by the PR: **spec 061 R5 probe**
> (`docs/specs/061-plan-context-budget.md`, evidence in
> `notes/061-plan-context-budget-live-validation.md`). The code change implements
> the **"narrow" option** of issue
> [#212](https://github.com/Redna/evol-hive/issues/212) as identified by that probe
> (stop rendering instructions the plan phase rejects).
>
> QA run: cognition `79 files / 1240 passed`, examples `23 files / 251 passed`,
> engine `72 / 905`, assembly `11 / 89`, shared `34 / 399`, memory `13 / 101`,
> visualizer `9 / 48`, cli `4 / 15` — all green (exit 0). `pnpm typecheck` clean;
> `pnpm lint` clean; `pnpm format:check` clean after formatting the new files.

## Acceptance-criteria coverage

The PR does not add a spec file, so the criteria audited are the PR's own stated
contract plus the R5 probe's "narrow" option (issue #212 comment).

| AC  | Contract                                                                                                              | Status   | Tests                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | The plan-phase **system prompt** social directive is plan-shaped and no bypass phrase ("do not use formulate_plan", …) | COVERED  | `spec-212-plan-phase-contract-alignment.test.ts` (Developer), `spec-024-social-tool-invocation-fix.test.ts`; **QA**: whole-payload sweep (4 scenarios) + E2E-1                                         |
| AC-2 | The `social-directive` and `social-primary-hint` context blocks are plan-shaped                                       | COVERED  | `spec-212` (Developer), `spec-018-social.test.ts`, `spec-024`, `spec-034`; **QA**: whole-payload sweep + E2E-1                                                                                 |
| AC-3 | The plan-form drive/chain renderers (`formatPlanDriveHint` / `formatPlanChainHint`) instruct a plan step, not a direct call | COVERED  | `spec-034-drive-affordance-hints.test.ts`, `spec-048-drive-chain-hints.test.ts`; **QA**: direct renderer assertions + E2E-2                                                                     |
| AC-4 | A non-`formulate_plan` **initial** call logs `[plan-invalid] reason=wrong-tool tool=<name>`, never `missing-description` | COVERED  | `spec-212` (Developer); **QA**: exact-line format unit test                                                                                                                                     |
| AC-5 | A non-`formulate_plan` **repair/retry** call logs `reason=wrong-tool tool=<name>`                                      | COVERED  | **QA (new)**: `spec-212-qa-coverage.test.ts` — "a non-formulate_plan REPAIR response is named wrong-tool"                                                                                       |
| AC-6 | A throwing wrong-tool writer never propagates (spec 049)                                                              | COVERED  | **QA (new)**: "a throwing wrong-tool writer never propagates"                                                                                                                                  |
| AC-7 | Regression: existing plan/social suites pass; typecheck + lint clean                                                  | COVERED  | Full `pnpm test` (all packages green) + `pnpm typecheck` + `pnpm lint` + `pnpm format:check`                                                                                                     |

## Tests added by QA

- `packages/cognition/tests/spec-212-qa-coverage.test.ts` — 15 tests.
  - AC-3: direct renderer assertions for `formatPlanDriveHint` / `formatPlanChainHint`.
  - AC-1/2/3: banned-phrase sweep of the whole assembled `systemPrompt + perceptionContext`
    across four scenarios (social, direct drive restorer, hunger chain, plain), plus the
    legality pin that `formulate_plan` is still offered.
  - AC-5: repair-seam wrong-tool naming (pre-repair keeps `empty-step-description`, the
    obedient repair is named `wrong-tool tool=sit_outside`).
  - AC-4/6: exact `logPlanWrongTool` line format; throwing wrong-tool writer never propagates.
- `examples/tests/spec-212-plan-phase-contract-alignment-e2e.test.ts` — 3 tests.
  - E2E-1: real `DYNAMIC_WORLD_SCENE` + real `PerceptionServiceImpl` + real `PlanBuilderImpl`
    with a co-located urgent-social agent → plan-shaped directives, no bypass phrase,
    `formulate_plan` still offered.
  - E2E-2: the real hunger-chain hint through the production stack is plan-shaped; the
    perception (suggestion-form) line is unchanged and is not the plan surface.

## Gap found (not fixed by this PR)

**The `agents-present` context block still instructs a direct call on the plan surface.**

`packages/cognition/src/pper/plan-builder.ts:139` renders (whenever agents are present):

```
You can call talk_to, observe_agent, help, or ignore directly to interact with other agents.
```

This is the same class the PR set out to remove — a direct-call instruction the plan
phase rejects (the R5 probe's "social-imperative lines removed" variant still made the
model call `observe_agent` 20/20). The PR rewrote the `social-directive`,
`social-primary-hint`, and system-prompt strings but left this line. The Developer
suite's banned list covers `do not use formulate_plan` / `NOW` / `do not formulate`,
not `call … directly`, so the coverage gap is invisible to it.

- **Not asserted green** on purpose: a test that banned the phrase would fail against
  the current implementation, and QA must not modify the implementation.
- **Recommendation**: make the `agents-present` line plan-shaped (matching the
  `social-directive` wording) and add `call talk_to, observe_agent, help, or ignore
  directly` to the banned-phrase sweep in `spec-212-plan-phase-contract-alignment.test.ts`.

## Secondary observations (for the record; no test asserts them)

- The wrong-tool diagnostic is only reachable for **cognitive** tools (`talk_to`, …)
  when `cognitiveToolExecutor` is unset (the client's unit-test path). With an executor
  wired (live runs), `requestChat` executes the cognitive tool and loops; the tool name
  returned is the terminal one, so a social call that never becomes `formulate_plan`
  surfaces as `LLMError` ("Tool call loop exceeded"), not `wrong-tool`. This is issue
  #225 finding #7 and is out of this PR's scope; noted so the live "ramp" reading is not
  confused by the new diagnostic.
- The PR's new `spec-212` initial-call test uses `tools: []` and no executor, which
  reproduces the probe's "tools removed" condition but not the production executor path.
  The QA repair-seam test likewise uses no executor — sufficient to lock the diagnostic,
  not to model live tool-loop behaviour.

## Verdict

All testable criteria have passing tests, all suites are green, and typecheck/lint/format
are clean. One residual instruction (the `agents-present` line) means the plan phase is
**not fully** contract-aligned yet — flagged for the issue owner. The live gate
(spec 061 AC-2 / #214 AC-8) remains issue-owned and was not run in this PR.
