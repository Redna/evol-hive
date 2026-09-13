# Implementation Notes — Feature 056: Plan Supersession Stamping (Spec 056, Issue #201)

**Branch**: `feature/056-plan-supersession-stamping` · **PR**: #203 · **Status**: 🔍 In Review

## What was built (2026-09-13)

Test-first implementation of spec 056 — the plan-memory stamping blind spot
where the dominant batch plan path replaced `currentPlan` every cycle before
completing, so the spec-055 Reflect-phase stamp almost never fired and the
live run rendered **0** "Your last plan was" lines (145 plan creates ≈ one
per cycle, ~1 step advanced per plan).

### Changes (3 packages, additive only)

1. **`packages/shared/src/types/agent.ts`** (Req 2) — `LastPlanOutcome` gains
   three optional fields: `superseded?: boolean`, `stepsCompleted?: number`,
   `stepsTotal?: number`. Conditionally spread / omitted keys stay absent
   (`exactOptionalPropertyTypes` safe); legacy stamps and legacy saves
   untouched.

2. **`packages/engine/src/agents/plans/index.ts`** (Req 1, 4, 5) —
   - `private stampSupersededOutcome(agentId)` called at the top of
     `createPlan`: reads the OLD `currentPlan`; stamps
     `{ planDescription, steps: steps.map(s => s.targetAffordance ?? s.description),
     success: false, superseded: true, stepsCompleted: currentStepIndex,
     stepsTotal: steps.length, reflected: false }` via
     `agentManager.updateState(agentId, { lastPlanOutcome })` BEFORE the new
     plan is stored.
   - Guard: only in-flight plans (`currentStepIndex < steps.length`) —
     complete/failed plans belong to the Reflect-phase `stampPlanOutcome`
     (Req 6: no double-stamping with a misleading `success: false`). Empty
     plans (0 steps) count as complete.
   - Whole stamp block try/catch-wrapped (spec-049 discipline) — a throwing
     state write never prevents plan creation (pinned by test with a
     `vi.spyOn(updateState)` that throws on the `lastPlanOutcome` key).
   - `[plan-superseded] agent=<id>: superseded after N of M steps ("<40-char
     description>")` — one stderr line per supersession, zero LLM calls.
   - Plan ids: `plan_${agentId}_${this.clock()}_${counter}` — `Date.now()`
     removed (spec-054 epoch-stamp family); source-level test asserts no
     `Date.now` remains in the file.

3. **`packages/cognition/src/pper/plan-builder.ts`** (Req 3) — the plan-memory
   dynamic-section block now branches on `outcome.superseded === true` →
   verdict `superseded after N of M steps${deltas}` (deltas via the existing
   `formatDriveDeltas`, appended before the final period, same composition as
   the succeeded/failed verdicts). `stepsCompleted`/`stepsTotal` read only
   when `superseded` (`?? 0` fallbacks are dead code by construction — Req 1
   always stamps both). Non-superseded outcomes render byte-identically;
   reflection line still follows when `reflected: true`.

Untouched per spec constraints: `PlanServiceImpl.plan()` early-return, batch
plan path, `clearPlanIfComplete`, Reflect-phase `stampPlanOutcome` (engine
`reflect/index.ts:74`), no new cross-package deps, no new `Date.now()`.

## Test coverage (written BEFORE implementation)

| File | ACs |
| --- | --- |
| `packages/engine/tests/spec-056-plan-supersession-stamping.test.ts` (10 tests) | AC-1 (stamp shape incl. unbound-step description fallback), AC-2 (0-progress stamp + exact new-plan state + throwing-write robustness), AC-3 (complete plan → no stamp, prior outcome survives), AC-6 (fake-clock ids `plan_a1_12345_<n>`, counter monotonic, no `Date.now` in source), AC-7 (one line, agent id, N of M, 40-char truncation; none on first creation) |
| `packages/cognition/tests/spec-056-superseded-plan-rendering.test.ts` (7 tests) | AC-5 (exact golden line, dynamic-section-only placement, deltas after verdict, reflection adjacency, byte-identity of non-superseded verdicts, fields ignored when superseded absent, no record → no lines) |
| `packages/shared/tests/spec-056-last-plan-outcome-fields.test.ts` (3 tests) | AC-4 (type-level additive; no undefined-valued keys when omitted) |
| Regression | AC-8: `spec-055-plan-context-memory.test.ts` + `spec-055-plan-repeat-diagnostic.test.ts` 26/26 unchanged; full monorepo suite green |

## Verification

- `pnpm test` — all packages green (shared 379, memory 101, visualizer 48,
  cognition 1077, engine 865, assembly 76, examples 240, cli 15).
- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm format:check` ✅ · `pnpm build` ✅
- Environment note: a bare `pnpm test` from a fresh checkout fails suites with
  "Failed to resolve entry for package @evol-hive/<pkg>" until `pnpm build`
  produces dists (build-order artifact, pre-existing; spec-011/onnx failures
  on unbuilt trees are NOT regressions).

## Session 2 (resume) — in progress

- CI on PR head `0d0091f` was `action_required` (app-token PR) → `gh run rerun`
  → **all green** (Type Check & Lint ✅, Build ✅, Test ✅).
- Local re-verification on a clean tree: `pnpm build` / `typecheck` / `lint` ✅.
- **Req 7 live-run in flight**: Ollama Cloud wiring verified with a 90s smoke
  (`LLM_BASE_URL=https://ollama.com/v1 LLM_API_KEY=$OLLAMA_API_KEY
  LLM_MODEL=glm-5.3-flash` — real LLM, 3 multi-step plans, exit 0). Full 30-min
  acceptance run launched (`SCENE_DURATION_MS=1800000`, log `/tmp/live-run-056.log`),
  evidence to be attached to #201.
- Note: `[plan-create]` does not emit the plan id — id-carry-clock determinism
  stays pinned by AC-6 unit tests; live evidence = supersession/repeat lines.
- `docs/specs/INDEX.md` status → 🔍 In Review (done in this session).

## Session 3 (resume) — Req 7 completion

- Live run still executing on this machine (PID tree from session 2; log
  `/tmp/live-run-056.log` growing). Findings so far:
  - **Plan-memory renders > 0 — DIRECT prompt evidence**: the run's own
    `[llm-raw]` malformed-args dump (`/tmp/empty-args-apprentice-1.json`)
    contains a real built plan prompt rendering
    `Your last plan was "wait, repot_seedlings, …" — it succeeded.` — the
    spec-055 render path works live.
  - `[plan-repeat]` = 0 ✓ (third Req 7 clause).
  - `[plan-superseded]` = 0 — **mechanistic finding**: the wired single-agent
    path early-returns on ANY `currentPlan` (spec 002) and Reflect clears only
    completed plans, so `createPlan` only ever sees `currentPlan === null` in
    live runs. The supersession seam (plan REPLACED mid-flight) is reachable
    only via the batch path (`BatchPlanService.processBatch` → `storePlan`),
    which no production wiring enables (batching is opt-in, never wired). The
    issue's 055-run premise ("batch plan path re-formulates every cycle")
    misattributed the mechanism — nothing wires batching.
- **Gap-fill (055-QA precedent, deterministic E2E)**:
  `examples/tests/spec-056-batch-supersession-e2e.test.ts` — real
  `PlanManagerImpl` (fake clock) + real `BatchPlanService` (scripted client,
  zero LLM) + real `PlanBuilderImpl`: replaced in-flight plan → stamped
  `{superseded: true, 1 of 3, targetAffordance-when-bound steps}` → exactly
  one `[plan-superseded]` line → NEXT prompt renders `Your last plan was
  "water_plants, repot_seedlings, eat_herbs" — superseded after 1 of 3
  steps.` dynamic-section-only; new plan id `plan_gardener-1_12345_1`
  (injected clock).
- Verified: examples suite 241 ✓ (+1 new), spec-055 regression 32/32 ✓,
  spec-056 suites 20 ✓, `pnpm typecheck` ✅ `pnpm lint` ✅ `format:check` ✅
  (file prettier-formatted; CI format glob doesn't cover examples/tests).
- Pushed `95a446f` to PR #203 head. Full monorepo suite green.
- TODO this session: wait for live run end (~18:25), extract final counts,
  attach evidence comment to #201, check CI on new head (app-token PRs may
  need `gh run rerun`), final YAAM note.