# Feature: Outcome Recorder Consumes the Applied-DriveChanges Signal — Cycle-Length Decay Defeats Snapshot Diffing (Fourth System 1 Label Domino)

## Context
- Architecture: [§5 — Fast-Path Classifier / System 1](../architecture/05-fast-path-classifier.md), [§6 — PPER Loop](../architecture/06-pper-loop.md), [§3 — Agent State Schema (drive decay)](../architecture/03-agent-state-schema.md)
- Related specs: [035 — System 1 Trainable Heads (Req 9 outcome labeling)](035-system1-trainable-heads.md), [040 — Idle-Tick Memory Suppression (third domino, merged via #151)](040-idle-tick-memory-suppression.md), [019 — Configurable Drive Decay Rate](019-configurable-drive-decay-rate.md), [025 — Memory Entry Flatten & Fallback](025-memory-entry-flatten-and-fallback.md)
- Package: `shared`, `cognition`, `engine`
- Issue: [#152](https://github.com/Redna/evol-hive/issues/152)

## Problem

Spec 040 suppressed idle-tick memories (idle-node growth 0, verified live), but the ignore
rate is still 0.5% (2/399 in the AC-5 run) against the ≥20% target (spec 040 AC-5).

Root cause: `system1-outcome-recorder.ts` labels `drivesChanged` by **diffing drive
snapshots** (`drivesDiffer`, epsilon ±1.0) taken at cycle start and cycle end. Under
`ENGINE_MAX_CONCURRENT_LLM=1` with 3 agents, a cycle interval spans 60–90s of sim time —
at 0.1/s ambient decay that is **6–9 points of pure physics per interval**, far above the
epsilon. Every cycle is "drive-changing" again, so the wait-only refinement from spec 040
never produces an IGNORE label.

The epsilon approach cannot scale: cycle length varies with load, and real affordance
deltas (3–25 points) partially cancel against decay, so **no fixed threshold can separate
"the cycle acted" from "physics happened"** on diffed snapshots.

The fix is causal, not statistical: the execute/reflect phases already know exactly which
drive changes they applied (affordance `driveChanges`, sanitized `driveOverrides`). The
recorder must consume **what the cycle did**, not diffed state. Ambient decay becomes
invisible by construction; any applied affordance delta, however small, counts.

## Design Decisions

1. **Thread the signal through the orchestrator's return value, not the probe.**
   `PPEROrchestratorPort.runCycle` returns `Promise<void>`; it changes to return a
   `PPERCycleOutcome` (`{ appliedDriveChanges: boolean }`). The orchestrator computes it
   as: `execute.result?.driveChanges` non-empty **OR** `reflect.drivesUpdated === true`
   (reflect's sanitized `driveOverrides` path — the deviation-rejected reflect branch
   included). The scheduler passes it to `onCycleSettled(agentId, outcome?)`.
   *Alternative considered*: give the probe an `appliedDriveChanges` flag backed by a
   dataProvider-maintained "last applyDriveChanges" marker. Rejected — the probe would
   read shared mutable engine state written mid-cycle (race-prone with concurrent cycles),
   and it spreads causal information through a state side channel instead of the call
   graph. The return value is per-promise, so concurrent cycles for different agents
   cannot cross-contaminate.

2. **Drop the drives-diff dimension from labeling; keep the snapshot for bookkeeping.**
   `drivesDiffer(before, after)` is removed from the label computation. The recorder
   still snapshots drives and still calls `tracker.recordCycleCompleted(...)` with the
   after-drives — the trigger source (ticks-since, threshold crossings) depends on it.
   Only the *label dimension* changes: `drivesChanged` in the sample's `outcome` is now
   populated from `appliedDriveChanges`.

3. **Keep the JSONL field name `outcome.drivesChanged`.**
   Session samples are training data; renaming the field would break downstream parsers
   for a pure semantics change. The field remains, documented as "the cycle applied drive
   changes (affordance deltas or sanitized overrides)" — semantically it now means what
   it always should have. No `FEATURE_SCHEMA_VERSION` bump: the feature vector
   (`scalar`, `embedding`) is untouched; only label-derivation changes.

4. **All other label dimensions unchanged.** `planChanged` (+ spec 040 wait-only
   refinement), `memoryWritten`, `conversationContinued`, and the hard-trigger override
   behave exactly as before. A failed action still stores its `"Action failed: …"`
   fallback memory (spec 040 R3), so failed cycles stay REACT via `memoryWritten` —
   no regression on reactive/learning paths.

5. **`onCycleSettled` outcome parameter is optional.**
   `onCycleSettled(agentId, outcome?, error?)` — `outcome` absent (probe wiring gaps,
   legacy orchestrators) falls back to `appliedDriveChanges: false`, which is safe: such
   cycles can still label REACT via the other three dimensions and hard triggers.

## Requirements

### R1: Shared types carry the cycle outcome — `shared`
- **R1.1**: New `PPERCycleOutcome` interface in `packages/shared/src/types/` with `appliedDriveChanges: boolean`.
- **R1.2**: `PPEROrchestratorPort.runCycle` returns `Promise<PPERCycleOutcome>` instead of `Promise<void>` (doc comment updated; implementations in `packages/cognition` updated accordingly).
- **R1.3**: `System1OutcomeRecorderPort.onCycleSettled` accepts an optional `outcome?: PPERCycleOutcome` parameter (before `error?`).

### R2: Orchestrator computes `appliedDriveChanges` from what the phases did — `cognition`
- **R2.1**: `PPEROrchestratorImpl.runCycle` returns `{ appliedDriveChanges: true }` when the Execute phase's aggregate result has non-empty `driveChanges` (compound actions: the once-applied merged map) OR the Reflect phase reports `drivesUpdated === true`.
- **R2.2**: All early-return paths (plan failure, execute failure, cooldown skip, deviation-reflect) return the outcome consistent with what actually ran — `appliedDriveChanges: false` unless a phase applied drive changes (R2.1 covers the deviation-reflect branch).
- **R2.3**: No drive-change semantics change inside execute/reflect: `applyDriveChanges` call sites, sanitization (issue #134 clamping), and compound-action merge-once behavior are untouched.

### R3: Scheduler threads the outcome; recorder labels from it — `engine`
- **R3.1**: `PPERScheduler.startCycle` captures the resolved `PPERCycleOutcome` and passes it to `outcomeRecorder.onCycleSettled(agentId, outcome)` in the `finally` block (error path: `onCycleSettled(agentId, undefined, message)`).
- **R3.2**: `system1-outcome-recorder.ts` removes the `drivesDiffer` snapshot diff from label computation; `drivesChanged` in the sample is `outcome?.appliedDriveChanges ?? false`.
- **R3.3**: Before/after drive snapshots and `tracker.recordCycleCompleted` are unchanged — the trigger source keeps receiving pinned drive state and `mutationSeq`.

### R4: End-to-end labeling behavior — `engine` (verification)
- **R4.1**: A wait-only cycle with no applied drive changes labels IGNORE even when drives decayed ≥5 points during the cycle interval.
- **R4.2**: A cycle that applied ANY affordance `driveChanges` (≥1 point of any magnitude) labels REACT; the same holds for reflect-applied `driveOverrides`.
- **R4.3**: Failed-action and conversation paths still label REACT via `memoryWritten`/`conversationContinued`; hard triggers still force REACT.

## Acceptance Criteria

- [ ] **AC-1**: A wait-only cycle with no applied drive changes labels IGNORE even when the probe's before/after drive snapshots differ by ≥5 points (simulated long cycle). (maps to R3.2, R4.1)
- [ ] **AC-2**: A cycle whose Execute result carries any non-empty `driveChanges` — including a 1-point delta — labels REACT. (maps to R2.1, R4.2)
- [ ] **AC-3**: A cycle whose Reflect applies sanitized `driveOverrides` (`drivesUpdated: true`) labels REACT. (maps to R2.1, R4.2)
- [ ] **AC-4**: Ignore rate ≥ 20% in a live validation run (evidence attached to issue #149, per spec 040 AC-5's measurement protocol). (maps to R3.2, R4.1; manual/real-LLM validation)
- [ ] **AC-5**: No regressions — full suite green (`pnpm -r test && pnpm typecheck && pnpm lint`); failed-action cycles still store fallback memories and label REACT; hard-trigger samples still always REACT; spec 035/040 recorder tests pass after the `onCycleSettled` signature update. (maps to R1.3, R2.3, R3.3, R4.3)

## Constraints
- **Package boundaries**: `packages/shared` (types), `packages/cognition` (`orchestrator.ts` return values only), `packages/engine` (`pper-scheduler.ts`, `system1-outcome-recorder.ts`) + their tests. No engine scene/dataProvider changes.
- **Performance**: zero new LLM calls, zero added per-cycle latency — the signal is computed from values already in hand at return time.
- **Patterns**: follow the ADR-0001 port pattern — the outcome travels through the existing port signatures, not new shared mutable state.
- **What NOT to do**: do not tune the epsilon, do not normalize decay by cycle length, do not diff snapshots with any threshold, do not touch the hard-trigger override, `planChanged`/wait-only refinement, `memoryWritten`, or `conversationContinued` dimensions, and do not change what the probe snapshots (the trigger source depends on it).
