# Design Decisions — Feature 041: Applied-DriveChanges Outcome Labeling (Spec 041)

## Decision 1: Thread the signal via the orchestrator's return value, not the probe
**Why**: The causal fact ("this cycle applied drive changes") exists only inside
`runCycle` — `execute.result.driveChanges` and `reflect.drivesUpdated`. Changing
`PPEROrchestratorPort.runCycle` to return `PPERCycleOutcome` and passing it through
`onCycleSettled(agentId, outcome?)` keeps the information in the call graph. The return
value is per-promise, so with `maxConcurrentCycles=1` round-robin and multi-agent runs,
concurrent cycles can never cross-contaminate labels.
**Alternative considered**: probe gains `appliedDriveChanges` backed by a
dataProvider "last applyDriveChanges" marker. Rejected — mid-cycle shared mutable state
is race-prone across agents and hides causality behind a side channel.

## Decision 2: Drop `drivesDiffer` from labeling; keep the snapshot for the trigger source
**Why**: The epsilon (±1.0) cannot separate action from physics — ambient decay is
6–9 points per 60–90s cycle interval under `ENGINE_MAX_CONCURRENT_LLM=1`, and cycle
length varies with load. Diffing is unfixable by threshold. But the after-snapshot is
still needed for `tracker.recordCycleCompleted` (ticks-since, threshold crossings), so
only the label dimension changes; probe behavior is untouched.

## Decision 3: Keep the `outcome.drivesChanged` JSONL field name
**Why**: Session samples are training data; renaming breaks downstream parsers for a
pure semantics change. The field now means "the cycle applied drive changes" — no
`FEATURE_SCHEMA_VERSION` bump since the feature vector (scalar/embedding) is unchanged.

## Decision 4: Optional `outcome` parameter defaults to false
**Why**: `onCycleSettled(agentId, outcome?, error?)` — absent outcome (legacy callers,
probe-wiring gaps) falls back to `appliedDriveChanges: false`, which is safe: such
cycles can still label REACT via plan/memory/conversation dimensions and hard triggers.

## Decision 5: Failed actions stay REACT
**Why**: Spec 040 R3 keeps `"Action failed: …"` fallback memories, so failed cycles
still trip `memoryWritten` → REACT. AC-4 (no regressions on failed/reactive paths) holds
without special-casing failures in the recorder.
