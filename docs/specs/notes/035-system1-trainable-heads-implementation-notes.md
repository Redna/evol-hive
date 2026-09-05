# Implementation Notes — Spec 035 (System 1 Trainable Heads) — PR #136

> The YAAM daemon was available for this session: the full implementation
> record was appended to the `feature-035-system1-trainable-heads` workspace
> (notes 1–3). This file is the repo-level summary, per the notes-directory
> convention.

## Branch / PR

- Branch: `feature/035-system1-trainable-heads`
- PR: [#136](https://github.com/Redna/evol-hive/pull/136) — closes [#132](https://github.com/Redna/evol-hive/issues/132)
- Discipline: tests committed first (`2646e1f` — the red suite) before any
  implementation, per spec-035's TDD requirement.

## What landed

| Requirement | Where | Tests |
|---|---|---|
| Req 1–2 feature schema + extractor (AC-1) | `shared/src/types/system1.ts`, `cognition/src/system1/feature-service.ts` | `spec-035-feature-extractor.test.ts`, `spec-035-system1-types.test.ts` |
| Req 3–6 gate head + fail-open (AC-2) | `cognition/src/system1/react-gate.ts`, `gate-service.ts` | `spec-035-react-gate.test.ts` |
| Req 5, 7, 8 scheduler gating (AC-3) | `engine/src/systems/pper-scheduler.ts`, `system1-trigger-source.ts` | `spec-035-system1-gating.test.ts` |
| Req 9 outcome labeling (AC-4) | `engine/src/systems/system1-outcome-recorder.ts`, `cognition/src/system1/session-log.ts` | `spec-035-system1-gating.test.ts`, `spec-035-session-log.test.ts` |
| Req 10 offline trainer (AC-5) | `training/` | `spec-035-training-artifact.test.ts` (+ onnxruntime-node parity check, diff ≈ 4e-9) |
| Req 11–13 dream updates (AC-6) | `cognition/src/system1/dream-update.ts` | `spec-035-dream-update.test.ts` |
| Req 14–15 composite importance (AC-7) | `cognition/src/system1/composite-importance.ts`, `memory/src/store/index.ts` | `spec-035-importance-head.test.ts`, `spec-035-importance-write.test.ts`, frozen-retrieval regression still green |
| Req 16–17 salience identity hook (AC-8) | `cognition/src/system1/identity-salience.ts` (+ `maxDeltasOverride` on `IdentityConsolidationServiceImpl`) | `spec-035-identity-salience.test.ts` |
| Req 18 ADR + §5 (AC-10) | `docs/adr/0002…` (Proposed → Accepted), `docs/architecture/05-fast-path-classifier.md` | — |
| AC-11 | full workspace | 2,054 passed / 0 failed; typecheck, lint, format:check, build clean |

## Key design decisions

1. **Ports in `shared`** (ADR-0001): engine↔cognition never import each other —
   the gate, outcome recorder, identity trigger, and feature refresher cross
   the boundary exactly like `PPEROrchestratorPort`.
2. **Pure schema math in `shared`**: `computeNovelty`, `computeDriveDeltas`,
   `detectThresholdCrossings` are part of the Req-2 contract, so the engine's
   trigger source and the cognition extractor share one implementation.
3. **Fail-open everywhere**: no artifact → single warning → every tick cycles;
   malformed hot-swaps are rejected (current weights stay); non-finite probe
   output → fail-open. A broken System 1 degrades to today's behavior.
4. **Scheduler belt-and-braces**: the scheduler re-checks hard triggers even
   if a buggy gate returns `react=false` — System 1 never suppresses alarms.
5. **Conversation activity folds into `conversationInvite`** (participant or
   open-invite): keeps `HardTriggerFlags` at the spec's four triggers while
   honoring "never suppress cycles during conversations".
6. **Composition at write time**: `MemoryStoreImpl.importanceComposer`
   (function type in `shared`, implemented in cognition, clamped 1–10);
   retrieval scoring untouched.
7. **`training/` is stdlib-only Python** (Gauss-Jordan ridge, hand-rolled ONNX
   protobuf) — trivially pinned env, never in CI's runtime path.

## Supersession note

A prior interrupted session had pushed partial commits
(`c84c069`–`a83f268`) to the same branch. This session's complete,
fully-green implementation was force-pushed (`--force-with-lease`) over them;
the old commits remain recoverable via SHA `a83f268`.

## Follow-ups

- AC-9: manual real-LLM A/B run, evidence on issue #132.
- Per-agent heads (Req 13), MLP fallback (ADR-0002 last resort).
- `update_self_model`-style LLM plumbing for the mid-session identity pass
  (the deterministic salience machinery is wired; examples default to a
  zero-proposal provider).