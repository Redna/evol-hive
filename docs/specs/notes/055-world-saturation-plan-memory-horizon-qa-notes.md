# Spec 055 QA Notes — Test-Coverage Verification for PR #200

> YAAM note (QA session record): QA coverage verification for PR #200
> (spec 055, issue #198). Same convention as
> `054-live-tick-provider-qa-notes.md` / `051-enum-bound-talk-targets-qa-notes.md`:
> notes are written as `docs/specs/notes/*.md` files, indexed by the YAAM
> daemon's document adapter and findable via `search` (raw-TCP JSON-RPC on
> `127.0.0.1:<daemon.port>`, method `search`, param `text`).

## Verdict

**Coverage complete for all deterministic acceptance criteria (AC-1..AC-7); all
tests green. AC-8 is the live-run instrument (30-min real-LLM), explicitly
deferred to the live-validation stage by the PR and the spec — its deterministic
watering-chain proxy was added during QA. Recommend approve/merge.**

## What was verified (HEAD `f3389db` on `feature/055-world-saturation-plan-memory-horizon`)

- `pnpm test` — **8/8 projects green, 0 failures**: shared 376, memory 101
  (+24 todo), visualizer 48, cognition 1070 (+1 skipped / 26 todo), engine 855
  (+141 todo), assembly 76, examples 240 (+3 todo), cli 15 — 2,781 passing
  across 209 test files (exit 0).
- `pnpm typecheck` — exit 0. `pnpm lint` — exit 0 (0 warnings).
- `prettier --check` — clean on every PR-touched file. Two pre-existing
  warnings (`spec-047-talk-loop-urge-gating.test.ts`,
  `spec-052-greenhouse-scene.test.ts`) are in files this PR does not touch —
  out of scope, flagged here for the formatter owner.

## Acceptance-criterion → test mapping (75 spec-055 tests: 73 in the PR + 2 QA)

| AC | Tests | Notes |
|----|-------|-------|
| AC-1 (Req 1) | `examples/tests/spec-055-water-economy.test.ts` ×7 | declaration + exact spec-018 condition `water_level > 0`, initialized state `{5,0,0}`, enum exit at 0 / presence at 3 (real registry), missing-field condition fail, exact −1 depletion through the real Execute phase, `The watering can is empty.` defense, declared `effects` mirror handler `driveChanges` |
| AC-2 (Req 2) | same file ×4 | `water-butt-1` ("Rain Barrel", furniture, garden), unbounded source (no condition), refill to exactly 5 via real physics `crossObjectStateChanges` (spec 018 Req 9), closed loop deplete→exit→refill→re-enter |
| AC-3 (Req 3) | `examples/tests/spec-055-phantom-affordance-audit.test.ts` ×9 + `phantom-audit.ts` | zero violations over all 5 exported scenes with production wiring read from the REAL registry; allowlist justifications >20 chars; fixture-injected phantom-handler / phantom-affordance / stateless-unaccounted / stale-allowlist all fail; resource-gated pattern accounts cleanly |
| AC-4 (Req 4) | `packages/cognition/tests/spec-055-plan-context-memory.test.ts` ×10 + `spec-055-reflect-stamp.test.ts` ×6 + real-stack stamping in water-economy | last-plan line with steps/outcome/deltas + reflection follow-up, dynamic-section-only (stable prefix byte-identical), no-record byte-identity to goldens, empty-deltas omission; `PerceptionServiceImpl` optional-provider population (legacy undefined, throwing provider degrades); `ReflectServiceImpl` stamps success/failure/per-cycle-progress/no-plan/memory-store-failure (`reflected=false`) and legacy-provider no-op |
| AC-5 (Req 5) | plan-context-memory ×4 | `Aspirations:` immediately after persona text (before the directive), persona-without-goals byte-identical to the pre-change template, `Horizon:` in the dynamic section only, framing-not-schedule pinned |
| AC-6 (Req 6) | `packages/shared/tests/spec-055-plan-max-steps.test.ts` ×9 + `packages/cognition/tests/spec-055-plan-cap-validation.test.ts` ×8 | `DEFAULT_PLAN_MAX_STEPS=6`, env override at call time, explicit-arg precedence, tool-factory passthrough, non-numeric/non-positive fallback (+floor), legacy schema byte-identity minus `maxItems`, wait-only masked enum intact; `checkPlanBinding` rejects 7>6 with actionable feedback (retryable, not shape-invalid), env/arg override, within-cap valid, wait-only skip; `PlanServiceImpl` exactly-one-retry (2 LLM calls, 6 steps stored), second over-cap fails, CORRECTION appended with byte-identical stable prefix |
| AC-7 (Req 7) | `packages/cognition/tests/spec-055-plan-repeat-diagnostic.test.ts` ×12 | fingerprint (order-insensitive + description-sensitive + description fallback), tracker contract (first silent, count=2/3, reset silent, same-id exempt, per-agent isolation, grep-able line with fingerprint + description), orchestrator E2E with fakes (identical → count=2, changed → reset, still-executing never counts, throwing console.error cannot break the cycle) |
| AC-8 (Req 8) | live-run instrument — ⏳ deferred to the live-validation stage | deterministic proxy added by QA (below) |

## Coverage-gap analysis and QA fix

**Gap found**: every seam was tested individually, but no test ran the closed
watering loop through the production `PPEROrchestratorImpl` — the orchestrator
tests used fake providers; the real-stack tests drove phases one-by-one without
the orchestrator's plan service / repeat tracker. The AC-8 loop's deterministic
skeleton was unexercised at the integration level.

**QA fix** (commit `f3389db`, `examples/tests/spec-055-water-loop-orchestrator-e2e.test.ts`,
2 tests, green): a 4-cycle scripted-LLM run over the REAL dynamic-world engine —
cycle 1–2 water (`[plan-repeat]` count=2 fires at the orchestrator level),
reservoir drained to 0 → cycle 3 asserts the REAL plan payload carries
`Your last plan was "water_plants" — it succeeded` + the reflection follow-up,
the enum excludes `water_plants` but offers `fill_watering_can`, and the emitted
`formulate_plan` schema carries `steps.maxItems = 6` (Req 6 rides the real
payload) → refill restores 5 → cycle 4 re-plans `water_plants` successfully with
no new repeat line (fingerprint reset) and no hidden binding retries; plus a
final logState sample (reservoir recovered, last outcome = refill success, zero
repeat lines). No production code touched — one test file only.

## Notes for the live-validation stage (AC-8)

- Collect `[plan-repeat]` lines (`grep '\[plan-repeat\]'`); the emitted contract
  (`agent=<id> count=<n> fingerprint=<hash> "<description>"`) is pinned by the
  diagnostic suite — the bound (target ≤ 5 consecutive) is judged from these.
- The watering-chain events to look for: `water_plants` successes until the
  reservoir exits the enum, then a `fill_watering_can` chain, then re-entry.
- Rebuild (`pnpm build`) before the run per the spec's Constraints.

## Recorded by

QA session, 2026-09-13. PR comment:
https://github.com/Redna/evol-hive/pull/200#issuecomment-5654001268 —
issue #198 labeled `Status: In Review/QA`.