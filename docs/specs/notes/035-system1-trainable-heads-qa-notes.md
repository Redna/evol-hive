# QA Notes — Spec 035 (System 1 Trainable Heads) — PR #135 coverage audit

> Note: the `yaam` CLI/tools were not available in this environment either
> (`yaam_search` / `yaam` not on PATH), matching the limitation recorded in
> `035-system1-trainable-heads-design-notes.md`. Findings are recorded here
> per the notes-directory convention; re-append to YAAM when the daemon/CLI
> is available.

## Scope

QA pass over PR #135 ("spec: draft spec for issue #132") — a docs-only spec
draft adding `docs/specs/035-system1-trainable-heads.md` (AC-1..AC-11) and
design notes. Every acceptance criterion was mapped to existing tests;
writable missing tests were added; full suite + typecheck + lint were run.

## AC → test coverage map

| AC | Status | Evidence |
|----|--------|----------|
| AC-1 (feature extractor determinism) | ❌ BLOCKED — no implementation yet | No feature extractor in `packages/cognition`; no `FEATURE_SCHEMA_VERSION` in `shared` (grep). Tests to be written with the implementation. |
| AC-2 (gate inference fail-open) | ❌ BLOCKED — no implementation yet | No linear-probe head or artifact loader exists. |
| AC-3 (scheduler gating, hard triggers, zero-LLM gating) | ❌ BLOCKED — no gate wiring yet | Pre-gate baseline covered by `packages/engine/tests/pper-scheduler.test.ts` (isThinking gate, concurrency slots, error resilience, despawn regression). |
| AC-4 (outcome labeling → JSONL) | ❌ BLOCKED — no implementation yet | No session-log plumbing exists. |
| AC-5 (training/ offline pipeline + ONNX parity) | ❌ BLOCKED — no implementation yet | No `training/` workspace exists. |
| AC-6 (dream updates + holdout-revert guardrail) | ❌ BLOCKED — no implementation yet | Trigger precondition covered: `packages/memory/tests/spec-014-reflection-loop.test.ts` AC-32 (`shouldReflect` idle trigger). |
| AC-7 (composite importance; frozen retrieval) | ⚠️ PARTIAL | Composite importance: blocked (not implemented). **Frozen-retrieval clause now covered** by new `packages/memory/tests/spec-035-retrieval-frozen-regression.test.ts` (golden values hand-computed from the documented formulas, tolerance 1e-12) plus existing `spec-014-retrieval-engine.test.ts`. |
| AC-8 (salience-weighted identity hook) | ⚠️ PARTIAL | Salience weighting / mid-session trigger: blocked (not implemented). Invariants that must survive are covered: `spec-033-identity-consolidation.test.ts` (pass budget, delta bounds, audited bridge) and `spec-033-update-self-model.test.ts` (`update_self_model` override). |
| AC-9 (manual A/B gate effectiveness) | ⏸ N/A | Manual, real-LLM run by design; evidence belongs on issue #132. |
| AC-10 (ADR-0002 → Accepted; §5 amended) | ❌ NOT IN PR | ADR-0002 is still **Proposed**; `docs/architecture/05-fast-path-classifier.md` has no Golden Rule amendment; the PR diff adds only the two spec docs despite the spec text saying the flip happens "by this spec". Actionable docs gap for the author. |
| AC-11 (`pnpm test`, typecheck, lint green) | ✅ PASS | 1,935 tests passed / 0 failed across shared, visualizer, memory, cognition, engine, examples, cli. `pnpm typecheck` clean. `pnpm lint` clean. |

## QA actions taken

1. Added `packages/memory/tests/spec-035-retrieval-frozen-regression.test.ts`
   — 5 tests pinning the spec-035 constraint "Retrieval is frozen": exact
   `defaultRetrievalWeights`, fixed-input golden scoring values derived
   independently from the documented §11.2 formulas, frozen ranking order,
   scoring never mutates `MemoryNode.importance` (write-time composition
   contract), and the weights-override contract. These are the tests AC-7
   can meaningfully have before the importance head exists.
2. Full-suite run: green (1,935 passed, 0 failed, 1 skipped, todo excluded).
3. `pnpm typecheck` and `pnpm lint`: clean. Prettier `format:check` clean on
   the new file (CI also enforces `format:check`).

## Environment observation (not a product bug)

In a fresh checkout without building, `pnpm test` fails in
`packages/cognition` (`spec-011-coverage.test.ts`): importing
`examples/minimal-scene.ts` resolves `@evol-hive/cognition` via built
`dist/` and throws "Failed to resolve entry". CI is unaffected
(`ci.yml` runs `pnpm build` before `pnpm test`), but local contributors
hitting `pnpm test` first will see 4 confusing failures. Consider a
pretest build hook or a `pnpm verify` convenience script.

## Verdict

- All criteria testable at this stage: **PASS**.
- Coverage of implementation ACs (AC-1..AC-6, AC-9): **blocked by design** —
  this PR is the spec, not the implementation; tests must land with the
  feature PRs.
- One actionable gap in the PR itself: **AC-10** (ADR flip + §5 amendment)
  is not included in the diff.