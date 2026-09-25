# 066 — Visualizer Live-Observation Defects — implementation notes

- **Spec:** `docs/specs/066-visualizer-live-observation-defects.md`
- **Issue:** [#257](https://github.com/Redna/evol-hive/issues/257)
- **Legs:** 1 of 4 (`#258`, merged `970e2ba`) · 2 of 4 · 3 pending · 4 pending
- These notes exist because the leg-1 QA pass flagged that spec 066 had **no design or
  implementation notes**, only a spec and PR bodies. Per ADR-003 the committed note *is*
  the handoff, so this file is the durable record rather than the PR text.

## How the defects were found (and how to reproduce the search)

Not by the suite. By a live real-LLM run observed through the **phone path** — spec 063's
own AC-9, the criterion that had been sitting unverified — plus a scripted browser session
against that running sim.

Recipe (environment values are operator-specific and deliberately not recorded in this
public repo — see the spec's Context note):

1. `pnpm build` — **mandatory**: examples and live sims resolve workspace packages to
   `dist/`, so a stale dist silently runs old code.
2. Launch the demo with a real LLM: `USE_REAL_LLM=true LLM_MODEL=<available model> npx tsx examples/visualizer-demo.ts`.
   Note the demo's default model is `llama3.1`, which is **not** installed by default — the
   model must be set explicitly or the run fails.
3. Open the served page through the environment's TLS endpoint, with `?debug=1` to expose
   `window.__viz` (`hitTest`, `select`, `snapshot()` → `{selected, camera, agents}`).
4. Probe with a browser session: scan the viewport through `__viz.hitTest` to find agents,
   read `__viz.snapshot().camera` before/after a release, and click controls while counting
   server-log lines per interval to measure whether they act.

**Three of the four defects were invisible to the test suite** because they live on code
paths no test executed (a default argument, a draw/select pair that was never compared, and
client glue smoothing policy). The probe approach is what made them measurable.

## Leg 1 — releasing follow returns to fit-all (`#258`)

- **Cause:** `cameraFor` returned `previous.scale` (the 1.6× follow zoom) with zeroed
  offsets on release → a magnified view anchored on the world origin.
- **Red-first evidence:** new tests passed `previous` explicitly (the production shape) and
  failed `3 | 1 passed` before the fix; the one that passed was the no-`previous` case the
  old suite already covered. That asymmetry *is* the defect: `renderer-camera.test.ts` called
  `cameraFor(null, layout)` with no third argument, so the buggy branch was only ever
  exercised with its `1` default.
- **Design:** the release target is history-independent. `_previous` is retained in the
  signature (the seam AC-4 names, and the client passes it) but deliberately not consulted,
  and documented as such — deleting it would have deviated from the AC approved at the gate.
- **AC-5:** the client smoothed offsets while assigning `scale` outright, so a release was a
  hard zoom-out then a slide. That policy lived inline in `client/main.ts`; it moved to a pure
  `smoothCamera()` in `renderer/camera.ts`, and `CAMERA_HALF_LIFE_S` moved out of the DOM
  glue, matching spec 062's rule that visual rules live in the renderer.
- **QA strengthened this leg:** CI's QA pass added a served-bundle test observing the camera
  scale through the rendered floor width, and demonstrated its own red-first evidence by
  restoring `scale: target.scale` (one pure frame reads exactly `1` — snapped — versus
  strictly between `1` and `FOLLOW_SCALE` when smoothed). That covers a regression the pure
  tests cannot: reverting the glue leaves every pure `smoothCamera` test green.

## Leg 2 — co-located agents are separately placed

- **Cause:** `layoutWorld` placed every agent at its raw cell centre, so agents sharing a
  cell received identical coordinates. The renderer paints in order (last on top) while
  `hitTestAgent` returns the nearest/first, so the two consumers disagreed — measured live, a
  probe at the drawn chip returned `agent-alice` where the chip was labelled **"Carol"**.
- **Red-first evidence:** `3 failed | 2 passed` before the fix. The two passes are honest
  non-cases (a lone agent, and an occupant of a *different* cell) — they do not involve
  co-location, so they should not discriminate. Verified by stashing the source change and
  re-running: the same three fail, the same two pass.
- **Design:** a deterministic ring inside the cell (`cellClusterSlot`), radius a fraction of
  the smaller cell dimension, only when a cell has more than one occupant — so the common
  case is byte-identical to before. Slots are assigned from a **sorted copy** of each cell's
  occupants, because the order of `state.agents` is a transport detail and a layout that
  agreed only by matching that order could still tear.
- **Uniqueness is the assertion, deliberately.** It is the invariant that makes both
  consumers agree *by construction*: positions live in the layout and both the renderer and
  the hit test read the layout, so no test has to re-derive a screen position to prove a tap
  lands on the right agent. A test that recomputed the hit-test maths would be tautological.
- **Honest limitation:** a cell (~26×38 px at phone sizes) is smaller than an agent chip, so
  co-located agents remain visually overlapping even when their points are distinct. The fix
  makes them *separately selectable and correctly labelled*, which is the reported defect
  (wrong card) and the D1 draw/select inversion. Fully separating the chips would require
  drawing outside the cell and colliding with neighbours — out of scope, and it would trade a
  correctness bug for a layout lie.

## Protocol finding — CI QA pushes to the PR branch, so the verified SHA is not the merged tree

Measured, not inferred. Leg 1's merge commit `970e2ba` contains **two files I did not author**:
`docs/specs/notes/066-visualizer-live-observation-defects-qa-notes.md` (+54) and **+62 lines
in `packages/visualizer/tests/mobile-shell.integration.test.ts`**. The QA workflow pushed them
during the merge window, and the squash merge carried them in.

This is the second time this has bitten; it was recorded as a lesson before and now has a
measurement. Two consequences worth carrying forward:

1. **A matrix run before a QA push does not describe the merged tree.** I verified
   "visualizer 101" and merged "visualizer 102". The discrepancy surfaced only because an
   unexplained +1 test count was chased down — the same class of mistake as trusting a count
   over a set. Re-verify the merged `main`, or diff the merge commit, rather than assuming the
   pre-push measurement still holds.
2. **Unreviewed code can merge under my name.** The QA additions here turned out to be good
   (they closed a seam I had skipped), but that was luck plus review *after* merging. The
   check belongs before: `git show --stat <merge>` or `git diff main...HEAD` immediately
   prior.

## What is left

- **Leg 3** — R3/AC-6/AC-7: motion paced against the snapshot interval (~60 ticks/s engine vs
  10 snapshots/s client ⇒ ~6 cells per snapshot on a fixed 0.09 s glide).
- **Leg 4** — R4/AC-8/AC-9/AC-10: scene-select sync, Fog initial state, and removal of the
  Save/Load controls (approved at the spec gate).
- **AC-12 (docs)** — specs 062/063 amendment notes and the INDEX status are the final leg's
  deliverable.
- Live validation after leg 2: rebuild, restart the sim, and re-probe the viewport to confirm
  that a probe at a drawn chip now returns that chip's agent (AC-3's real-device evidence).

## Live validation — legs 1 and 2 (real path, new code)

Rebuilt `dist` (mandatory: the sim resolves workspace packages to `dist/`), restarted the
demo with a real LLM, and probed the served page through its `?debug=1` hook.

| Check | Result |
| --- | --- |
| AC-3 — agents separately selectable | **3 of 3 hittable** (`agent-alice`, `agent-bob`, `agent-carol`). Before the fix only 1–2 were, because a co-located cell-mate was painted over and the first match won the hit test. |
| AC-4 — follow camera shape | `{scale 1.5978, offsetX -382.57, offsetY -61.84}` ≈ the 1.6× follow zoom |
| AC-5 — release glides, then converges | `200ms: 1.3278` · `600ms: 1.0621` · `1500ms: 1.0009` · `3000ms: 1.0000002`, offsets → `≈1e-4` |

Two things this proves that the unit tests could not. First, `scale` genuinely **glides**
(`1.3278` at 200 ms — neither snapped to `1` nor stuck at `1.6`), which is the glue
regression the pure `smoothCamera` tests cannot see. Second, the released camera **converges
to fit-all** on the real page, where before it settled at `{scale 1.6, offsetX -0.089}` —
the "dragged to nowhere" report.

### Incidental finding, out of scope here (belongs to #225)

The long run's log (26,770 lines) contained **566 precondition rejections**: `has_water_supply`
(51 + 35 + 26 + 21 …) and `has_cups` (30 + 25 …) across all three agents. The engine recovers
every time (`[step-skip] … advancing past it`), so nothing hangs — but agents are repeatedly
*offered* `pour_cup` / `refill_pitcher`, plan them, and are rejected. This is the #225
"offers that cannot be executed" family in the **precondition** channel, at a scale the
earlier audit sample did not show. Recorded, not fixed here: spec 066 is scoped to the view.

## Second instance of the QA-push pattern (now the standing check)

Leg 2's merge `e9dfcc7` again contained files I did not author: **+88 lines in
`mobile-shell.integration.test.ts`** and **+58 in the qa-notes**. So this is systematic, not a
one-off. The merged tree is **108 tests, all green**.

Worth stating plainly: the QA additions are *better than what I shipped*. For leg 1 they
covered the served-glue scale regression my pure tests cannot catch; for leg 2 they closed
**AC-3** at the served-bundle level (tapping a co-located agent's drawn chip selects that
agent), which I had left to the pure uniqueness invariant. The risk is not quality, it is
provenance: unreviewed code merging under my name, and a matrix run that describes a tree
that is not the merged one. **Standing check: `git show --stat <merge>` before closing a leg**,
and re-run the suite on merged `main` rather than trusting the pre-push number.

## Handoff — legs 3 and 4

State: `main` = legs 1–2 merged (`970e2ba`, `e9dfcc7`), visualizer 108 green, spec 066
📝 In Development in the INDEX, issue #257 open.

- **Leg 3 (R3, AC-6, AC-7) — motion aliasing.** Engine steps one cell per tick at ~60 ticks/s
  (`spatial/navigation.ts:243`, `loop/index.ts:111`); the client receives 10 snapshots/s, so
  ~6 cells advance between snapshots while the glide uses a fixed `GLIDE_HALF_LIFE_S = 0.09`.
  Seam: the motion function in `renderer/layout.ts` (clock-free: elapsed in, position out),
  with `client/main.ts` passing the interval. Must be self-adjusting at 5× without retuning a
  constant. No protocol change required.
- **Leg 4 (R4, AC-8, AC-9, AC-10) — truthful controls.** Sync `sceneSelect` to the snapshot's
  scene (it currently shows the first option, `minimal`, while coffee-shop runs); make Fog's
  `on` class reflect the initial `showFog = true` (it is only toggled on click — a stale class
  that invalidated one of my own diagnostics); **remove Save/Load**, decided at the spec gate.
- **AC-12 belongs to leg 4**: amendment notes in specs 062/063 and the INDEX status update.
