# 066 — Visualizer Live-Observation Defects — QA notes (leg 1)

- **PR:** [#258](https://github.com/Redna/evol-hive/pull/258) — `fix/066-leg1-camera-release`
- **Scope of this leg:** R2 / **AC-4, AC-5** only (leg 1 of four; D1/R1, D3/R3 and D4/R4 land in later legs per the approved serialized chain).
- **Spec:** `docs/specs/066-visualizer-live-observation-defects.md`
- **Design/implementation notes:** none exist for 066 (only the spec and the PR); the PR body carries the implementation rationale, so AC mapping was done against the spec's Test Seams.
- **Verdict:** ✅ All testable leg-1 acceptance criteria have tests; full suite, `typecheck`, `lint` and `prettier` are green.

## Coverage summary

| AC       | Requirement                                                                                                                                         | Covered by                                                                                                                                                                                             | Status |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **AC-4** | `cameraFor(null, layout, followCamera)` → `{scale:1, offsetX:0, offsetY:0}` with `previous` a **live follow camera**; same for an unknown selection | `packages/visualizer/tests/spec-066-camera-release.test.ts` (4 cases: live-follow release, unknown agent, whole-world-fits outcome + non-vacuous guard, never-selected)                                | ✅     |
| **AC-5** | Release converges to fit-all within a bounded time, and `scale` changes gradually rather than in one frame                                          | `spec-066-camera-release.test.ts` (pure `smoothCamera`: moves-not-snaps, converges in 240 frames, zero-dt no jump, default half-life) **+** `mobile-shell.integration.test.ts` (QA-added, served glue) | ✅     |

**2 / 2 leg-1 acceptance criteria tested.**

AC-11 (full suite green, typecheck, prettier) is satisfied by the run below. AC-12 (spec 062/063 amendment notes, INDEX status) belongs to the final leg and is **not** claimed here — see Gaps.

## Tests added by QA

`packages/visualizer/tests/mobile-shell.integration.test.ts`
— new describe block **“spec 066 leg 1 — the served release returns to fit-all and glides (AC-4, AC-5)”**.

**Why it was missing.** The Developer's AC-5 tests exercise the pure `smoothCamera` seam, which is the right place for the _policy_ (spec 062 discipline). But D2's defect was in the client glue: `main.ts` smoothed the offsets while assigning `scale: target.scale` outright. Reverting `main.ts` to that line leaves every pure `smoothCamera` test green — nothing asserted that the shipped client routes `scale` through the smoother. Spec 066's Test Seam 4 explicitly names the served bundle + mock-DOM harness for AC-5, so this closes the seam the Developer skipped.

The test reuses the existing `makeSandbox` harness from that file (the same `getClientBundle()` string the server inlines), observes the live camera through the `transformLayout`-scaled room-floor width, and drives the glide with the manually-advanced rAF — no real browser, no real timers.

## Red-first evidence

Temporarily restoring the pre-fix client line (`scale: target.scale`) and running only the new case:

```
× glides the scale back to fit-all on release instead of snapping (AC-5, shipped glue)
  → expected 1 to be greater than 1
```

The one-frame scale is exactly `1` (snapped) under the old glue and strictly between `1` and `FOLLOW_SCALE` under `smoothCamera`. Implementation was reverted immediately after (`git diff` on `main.ts` clean). The Developer's own red-first evidence (`3 failed | 1 passed → 13 passed`) is confirmed by inspection of the pure tests: the three live-`previous` cases discriminate, the no-`previous` case never did.

## Test results

- `pnpm test` — **all green**: shared 399, memory 101, **visualizer 102** (+1 QA integration test; 15 files), engine 922, cognition 1252, assembly 89, examples 253, cli 115.
- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `npx prettier --check` on the touched file — clean.
- Root `pnpm test` requires `pnpm build` first (shared resolves from `dist/`); built all packages before the run.

## Gaps / not tested here

- **AC-1, AC-2, AC-3 (R1, D1 co-located agents)** — deferred to leg 2. Not asserted by this PR, correctly so.
- **AC-6, AC-7 (R3, D3 motion aliasing)** — deferred to leg 3.
- **AC-8, AC-9, AC-10 (R4, D4 truthful controls)** — deferred to leg 4.
- **AC-12 (R5 docs)** — spec 062/063 amendment notes and `docs/specs/INDEX.md` status are the final leg's deliverable; not present yet, so not claimed.
- No design/implementation notes exist for spec 066; if the workflow expects them at `docs/specs/notes/066-…`, that is a process gap for the leg owner, not a test gap.
