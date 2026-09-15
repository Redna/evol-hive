# Spec 060 Implementation Notes — Plan-Formation Shape-Failure Diagnostics, Bounded Repair & Fallback Floor (issue #214)

> Branch: `feature/214-plan-formation-shape-failure-recovery`
> Spec: `docs/specs/060-plan-formation-shape-failure-recovery.md`
> PR: see the branch's pull request

## What was built

### R1 — one shared shape classifier (`shared`)

- `packages/shared/src/types/plan-shape.ts` (new)
  - `PlanShapeReason = 'missing-description' | 'missing-steps' | 'empty-step-description'`
  - `classifyPlanShape(result): PlanShapeReason | null` — first failing condition in the
    fixed order `missing-description` → `missing-steps` → `empty-step-description`;
    defensively typed so a runtime non-array `steps` / non-object step classifies rather
    than throws.
- `packages/shared/src/index.ts` re-exports the new module.
- `packages/cognition/src/pper/plan-service.ts`
  - `isValidFormulatePlanResult` is now exported and delegates to `classifyPlanShape`
    (`=== null`), so client and service cannot drift.
  - `PlanBindingVerdict` gains additive-optional `shapeReason?: PlanShapeReason`, set only
    on the shape branch. `violations: ['missing description or steps']` and the `feedback`
    text are byte-identical to the spec-037 contract.

### R2 — zero-LLM diagnostics (`cognition`)

- `packages/cognition/src/pper/plan-shape-diagnostic.ts` (new)
  - `estimatePlanPrompt({ systemPrompt, perceptionContext, tools })` — deterministic
    `chars = |system| + |context| + |JSON.stringify(tools)|`, `estTokens = ceil(chars/4)`.
  - `logPlanPrompt`, `logPlanInvalid`, `logPlanRepair`, `logPlanFloor` — one line each,
    pure string arithmetic. Every call site wraps the emission in `try/catch` (spec 049).
- `packages/cognition/src/llm/openai-client.ts`
  - `[plan-prompt]` once per `completePlan` call (the initial request only, so a successful
    repair cannot dilute the pre-repair invalid rate — AC-8).
  - `[plan-invalid]` on the pre-repair detection and again if the repaired response is
    still shape-invalid.
  - `[llm-raw]` now fires for **every** `PlanShapeReason` (the old top-level-only check did
    not cover `empty-step-description`).
- `PlanServiceImpl` emits `[plan-invalid]` on its shape backstop branch, covering
  non-default clients.
- No line was added to the stable system-prompt prefix (spec 021).

### R3 — bounded client-seam repair (`cognition`)

- `decodeFormulatePlanArgs(args)` (exported): defensive decode with the established alias
  map (`reason`→description, `action`/`affordance`/`target`/`tool`→targetAffordance); a
  bare string step is both its description and its `targetAffordance` (spec 019).
- `completePlan` decodes **before** classifying through `classifyPlanShape`, then reuses
  the single existing bounded repair for every reason. Exactly one repair request per
  `completePlan`; a still-invalid repair throws `LLMResponseError` (no second retry). The
  `empty-step-description` correction names the offending step.
- The spec-037 service no-retry contract is untouched — the service shape branch remains a
  hard failure and still does not retry.

### R4 — bounded, self-resetting fallback floor (`cognition`)

- `planFloorAfterFailures()` reads `PLAN_FLOOR_AFTER_FAILURES` at call time (default `3`,
  `0` disables, non-numeric/negative → default).
- `choosePlanFloorTarget(drives, availableAffordances, waitSuppression)` picks
  `observe` → a direct restorer for a critical drive (`HINTABLE_DRIVES`,
  `DRIVE_CRITICAL_THRESHOLD`) → `wait`, consulting the same `checkWaitSuppression`
  predicate as the spec-052 plan-level guard.
- `PlanServiceImpl` keeps a per-agent consecutive-failure counter, incremented on
  shape/binding formation failures (including `LLMResponseError` from the client seam),
  reset on any successful formulation. On the Nth failure it stores a shape-valid,
  binding-valid single-step floor plan, emits `[plan-floor]`, and resets the counter. If no
  binding survives, the cycle stays an honest failure and the counter is **not** reset.
- `[plan-floor] agent=<id> failures=<n> target=<affordanceId>`.

## Regression / interaction notes

- **Spec 008 interaction (deliberate, documented).** The floor stores a plan instead of
  failing the `PlanServiceImpl` call, so the orchestrator's `consecutiveFailures` counter
  resets and the spec-008 cooldown is superseded for floor-able formation failures. The
  spec's AC-6 "pass unmodified" list is 031/037/039/051/055/056/057/058/059 — spec 008 is
  deliberately excluded, and R4 explicitly says the spec-008 recovery path only owns the
  cycle when **no** binding survives. To keep the spec-008 suite exercising its own
  mechanism, `packages/cognition/tests/pper-error-recovery.test.ts` stubs
  `PLAN_FLOOR_AFTER_FAILURES=0` in a top-level `beforeEach`/`afterEach`. No spec-008
  assertions were changed.
- The listed AC-6 suites (031/037/039/051/055/056/057/058/059) are unmodified and green.
- `engine` and `memory` are untouched; `shared ← cognition` holds. `shared` still imports
  from no other package.

## Verification

- `packages/shared/tests/spec-060-plan-shape.test.ts` — 10 tests.
- `packages/cognition/tests/spec-060-plan-shape-diagnostic.test.ts` — 24 tests.
- `packages/cognition/tests/spec-060-plan-floor.test.ts` — 7 tests.
- `packages/cognition/tests/spec-060-plan-floor-honest-failure.test.ts` — 1 test.
- `pnpm test` (all packages), `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm build` — all green.

### AC mapping (resume-session final verification)

Re-run of the full gate on branch head and mapping of the code-testable ACs to
concrete tests. `pnpm test` exit 0 (all 8 projects; cognition 1186 passing,
shared/engine/assembly/examples/cli green); `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, and `pnpm build` all exit 0.

| AC | Status | Where |
| --- | --- | --- |
| AC-1 | ✅ | `spec-060-plan-shape.test.ts` (10) + `checkPlanBinding shapeReason` block in `spec-060-plan-shape-diagnostic.test.ts` |
| AC-2 | ✅ | `classifier agreement and client decode` block (`isValidFormulatePlanResult` ⇔ `classifyPlanShape`, bare-string step, alias map, defensive decode) |
| AC-3 | ✅ | `estimatePlanPrompt`, client `[plan-prompt]`/`[plan-invalid]`/`[llm-raw]`, throwing-writer safety, service backstop, single-request no-extra-LLM assertion |
| AC-4 | ✅ | client-seam repair block (one retry, empty-step naming, two-request throw, bounded across calls) |
| AC-5 | ✅ | `spec-060-plan-floor.test.ts` (7) + `spec-060-plan-floor-honest-failure.test.ts` (1) |
| AC-6 | ✅ | listed suites unmodified; the spec-008 suite stubs `PLAN_FLOOR_AFTER_FAILURES=0` (documented deviation above) |
| AC-7 (R6) | 📋 issue-owned | live mechanism diagnosis/probe numbers on #214 — not run in this PR |
| AC-8 (R7) | 📋 issue-owned | 40-minute real-LLM run — live env only |

AC-1–AC-6 are checked off in the spec; AC-7/AC-8 carry the live/issue-owned
annotation and stay unchecked.

## Not in this PR (issue-owned evidence)

- **R6/AC-7**: the live mechanism diagnosis (prompt growth vs provider load vs client
  parse) and the discriminating probe numbers belong to issue #214.
- **R7/AC-8**: the 40-minute real-LLM run is owned by the issue/live environment.
