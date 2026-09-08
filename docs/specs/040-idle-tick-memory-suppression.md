# Feature: Idle-Tick Memory Suppression — Wait-Only Cycles Store Nothing (Third System 1 Label Domino)

## Context
- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md), [§11 — Memory Architecture](../architecture/11-memory-architecture.md), [MEMORY_PIPELINE.md](../../docs/MEMORY_PIPELINE.md)
- Related specs: [025 — Memory Entry Flatten & Auto-Fallback (R5 auto-fallback)](025-memory-entry-flatten-and-fallback.md), [035 — System 1 Trainable Heads (Req 9 outcome labeling)](035-system1-trainable-heads.md), [039 — Spatial Phase 2 (closed, adjacent dream-label work)](039-spatial-phase2-targetarea-fog.md), [037 — Enum-Bound Planning ('wait' escape hatch)](037-enum-bound-plan-formulation.md)
- Package: `shared`, `cognition` (no engine schema change required)
- Issue: [#149](https://github.com/Redna/evol-hive/issues/149)

## Problem

Dream retraining is starved of IGNORE labels. Two upstream fixes are already on main:
(a) wait-only plans no longer count as `planChanged` in `system1-outcome-recorder.ts`, and
(b) sub-1.0 drive deltas (decay noise) no longer count as `drivesChanged`. Despite this,
ignore labels remain ~1% (4/345 in the seal run; ~7,740 REACT vs ~16 IGNORE across 5 runs).

The remaining domino: **Reflect stores a memory unconditionally.** `resolveMemoryEntry`
(spec 025 R5.1) auto-falls back with an importance-3 entry on every cycle — for a wait-only
cycle that is literally `"Idle tick — no action taken. Goal: …"`. The System 1 outcome
recorder counts `memoryWritten = memoryCount increased` as a meaningful-change signal, so
EVERY cycle is labeled REACT regardless of anything else.

Two costs:
1. **Dream/training** — the React/Ignore head cannot learn to skip pointless cycles: the
   labeling says every cycle did something.
2. **Memory hygiene** — one idle-tick node per cycle (~672 nodes per 20-min run), noise
   polluting retrieval.

**Note on the reference implementation:** the issue mentions a draft in `git stash`
("direct memory-write implementation"). The stash is **empty** as of drafting — the
Developer implements from this spec, with their own TDD + QA pass.

## Design Decisions

1. **A wait-only cycle has nothing to remember.** The wait branch in
   `execute-service.ts` is semantically identical to the no-`targetAffordance` branch
   (both are intentional no-ops that advance the step), but only the latter returns
   `stepSkipped: true`. Fix: set `stepSkipped: true` in the `WAIT_AFFORDANCE` branch.
   The existing `stepSkipped?: boolean` field on `ExecuteResult` (spec 037 comment)
   already carries the semantics — no type change.

2. **Suppress the auto-fallback, not the LLM.** In `resolveMemoryEntry`
   (`reflect-service.ts`), return `undefined` (store nothing) when
   `executeResult.stepSkipped === true` **and** the LLM provided no explicit memory.
   Explicit LLM memories (fields 1/2: flattened `memoryContent`, legacy `memoryEntry`)
   are still honored even on skipped cycles — the agent may deliberately note something
   while waiting. This is the minimal change that breaks the `memoryWritten` signal
   without touching the outcome recorder.

3. **Failed actions keep memories.** Only the *intentional no-op* path is suppressed.
   Failed executions still auto-generate `"Action failed: …"` memories (learning
   signals for dreams). Spec 025 R5's fallback remains intact for all non-skipped paths.

4. **No change to `system1-outcome-recorder.ts`.** The recorder already handles
   wait-only plans (wait-plan fix) and sub-1.0 drive deltas. With the fallback
   suppressed, a wait-only cycle produces no delta on any dimension → `anythingChanged`
   is false → labeled IGNORE by spec 035 Req 9, end-to-end, with zero recorder edits.

## Requirements

### R1: Wait steps report `stepSkipped: true` — `cognition`
- **R1.1**: The `WAIT_AFFORDANCE` early-return branch in `packages/cognition/src/pper/execute-service.ts` must return `{ success: true, planComplete, stepSkipped: true }`.
- **R1.2**: The no-`targetAffordance` branch behavior is unchanged (it already sets `stepSkipped: true`).

### R2: Auto-fallback idle memories suppressed on skipped cycles — `cognition`
- **R2.1**: In `resolveMemoryEntry`, when `executeResult.stepSkipped === true` and the LLM response has no `memoryContent` (empty/whitespace counts as absent, per spec 025) and no legacy `memoryEntry`, the function must return `undefined` and the caller must NOT call `dataProvider.storeMemory`.
- **R2.2**: When suppression applies, `ReflectResult.memoryStored` must be `false` and no memory is stored.
- **R2.3**: Explicit LLM memories on a skipped cycle ARE still stored: flattened `memoryContent` (field 1) and legacy `memoryEntry` (field 2) take precedence over suppression, exactly as in spec 025 R4.2/R4.3.

### R3: Non-skipped fallback paths unchanged — `cognition`
- **R3.1**: `generateAutoFallbackMemory` remains untouched for non-skipped cycles: success → `"Action succeeded: …"` + drive changes; failure → `"Action failed: {error}. Goal: …"`; importance 3; type action/observation per spec 025 R5.3.
- **R3.2**: Failed actions on any cycle keep their fallback memories (learning signal preserved).

### R4: System 1 labeling end-to-end — `engine` (verification only)
- **R4.1**: A wait-only cycle with no plan change, no meaningful drive delta, no memory write, and no conversation continuation must be labeled IGNORE by `system1-outcome-recorder.ts` (spec 035 Req 9), verified end-to-end with the probe wiring in place.
- **R4.2**: No changes to `system1-outcome-recorder.ts` or `system1.ts` types are required or permitted by this spec.

## Acceptance Criteria

- [ ] **AC-1**: A wait-only cycle with no LLM memory stores nothing: the reflect result has `memoryStored === false` and `storeMemoryCalls` is empty. (maps to R1, R2.1, R2.2)
- [ ] **AC-2**: An explicit LLM memory (`memoryContent` or legacy `memoryEntry`) on a skipped cycle IS stored; `memoryStored === true`. (maps to R2.3)
- [ ] **AC-3**: Executing a plan step with `targetAffordance === 'wait'` returns `stepSkipped: true` from Execute. (maps to R1.1)
- [ ] **AC-4**: The System 1 outcome label for a wait-only cycle with no other changes is IGNORE, verified end-to-end with the probe wiring (spec 035 gating tests still pass). (maps to R4.1)
- [ ] **AC-5**: Ignored-cycle rate in a live validation run ≥ 20% (vs current ~1%); memory node growth per 20-min run drops from ~672 idle-tick nodes to ~0. (maps to R2.1, R4.1; manual/real-LLM validation, evidence attached to issue #149)
- [ ] **AC-6**: No regression — failed-action fallback memories are still stored (fixture test); `pnpm -r test && pnpm typecheck && pnpm lint` pass; CI green. (maps to R3.1, R3.2; regression guard)

## Constraints
- **Package boundaries**: only `packages/cognition` (`execute-service.ts`, `reflect-service.ts`) and its tests. `shared` types already carry `stepSkipped` — do NOT add fields. `engine` untouched.
- **Do NOT touch** `generateAutoFallbackMemory`'s non-skipped branches, the outcome recorder's label logic, or spec 025's fallback ordering (explicit memory → legacy → fallback).
- **Patterns**: follow spec 025's R5 structure and spec 037's 'wait' escape-hatch comments; keep the existing `[system1-narrative]`-style diagnostics intact.
- **Performance**: suppression must add zero LLM calls and zero per-cycle latency; it is a pure early-return in existing code paths.
- **What NOT to do**: do not suppress memories based on drive deltas, plan identity, or cycle count — only the `stepSkipped` flag. Do not "fix" this in the outcome recorder (that would mislabel genuinely active cycles that also write idle memories).
