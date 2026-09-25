# 066 — Visualizer Live-Observation Defects — implementation notes

- **Spec:** `docs/specs/066-visualizer-live-observation-defects.md`
- **Issue:** [#257](https://github.com/Redna/evol-hive/issues/257)
- **Legs:** 1 of 4 (`#258`, merged `970e2ba`) · 2 of 4 (`#259`, merged `e9dfcc7`) · 3 of 4 (this branch) · 4 pending
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

## Leg 3 — motion is paced against the snapshot interval

- **Cause:** the engine steps one cell per game-loop tick at ~60 ticks/s
  (`spatial/navigation.ts:243`, `loop/index.ts:111`) while the client receives
  snapshots every `snapshotRateMs = 100`. The shipped glue smoothed each agent
  toward its new cell with a FIXED `GLIDE_HALF_LIFE_S = 0.09` (`client/main.ts`),
  so a delta delivered over a 0.1 s snapshot interval was never traversed over
  that interval — at 1× it closed the gap in a few hundred ms (and lagged), at 5×
  the lag was ~5× worse. The spec's D3 diagnosis (client-side aliasing, not engine
  stepping) is confirmed by the fix: nothing in `engine/**` was touched.
- **Red-first evidence:** the pure seam did not exist yet, so the six
  `spec-066-motion-aliasing.test.ts` cases failed with
  `TypeError: motionTowards is not a function`. The two served-bundle cases in
  `mobile-shell.integration.test.ts` failed on the *behaviour*, which is the
  stronger evidence: at the frame a new snapshot's delta was delivered the agent
  had already jumped **322 px** (drawn `488.90` where it should still be at
  `166.67`), and at half the interval the fixed half-life had closed **68.5%** of
  the delta (`91.34 px` of a `133.33 px` 2-cell delta) instead of the required
  **50%** (`66.67 px`). Counts before the fix: **8 failed | 10 passed (18)** across
  the two files; after: **18 passed**. Package total: **108 → 117**.
- **Design:** a new pure `motionTowards(from, to, elapsedSeconds, intervalSeconds)`
  in `renderer/layout.ts` linearly interpolates the delta, clamped so elapsed 0 is
  `from`, elapsed = interval is exactly `to`, and beyond that it holds — no
  overshoot. Pacing is the interval, not a half-life, so a larger delta over the
  same interval moves proportionally faster and 5× needs no retuned constant.
  `smoothTowards` stays where it belongs: the camera still uses it via
  `smoothCamera` (leg 1); only agent glide changed.
- **Glue:** `client/main.ts` keeps one `AgentGlide` per agent (the delta it is
  bridging, when it started, and the interval). The frame's rAF timestamp is the
  only clock: a snapshot is observed by the next frame, the **measured** interval
  since the previous observed snapshot paces every delta delivered since, and a
  changed layout target restarts the glide from the position currently on screen.
  So the pure function stays clock-free while the glue stays DOM/transport glue.
  `GLIDE_HALF_LIFE_S` is removed rather than left dead.
- **Measured cadence, not a hardcoded rate.** The interval comes from the actual
  snapshot arrivals, so a server configured with a different `snapshotRateMs` or
  a jittery mesh link is paced correctly without a protocol change. A min clamp
  (`1/60 s`) keeps coalesced snapshots from dividing by zero, and a max clamp
  (`1 s`) stops a stalled tab (rAF paused while snapshots keep arriving) from
  crawling across a multi-second gap on resume.
- **Honest limitations:**
  1. The interval is measured at frame granularity (~16 ms at 60 FPS), so a
     jittery arrival cadence produces a small speed wobble rather than a perfectly
     constant velocity. Deliberate: the alternative is a hardcoded protocol rate.
  2. `hitTestAgent` still resolves against the layout's *target* positions while
     the agent is drawn at its interpolated position, so a tap during a glide can
     miss by up to one interval. That divergence predates this leg and is out of
     its scope (the tap-accuracy AC is AC-3, co-located *static* agents); it is
     recorded here rather than silently widened.
  3. A tab stalled for more than the 1 s cap resumes by gliding from the last
     drawn position over 1 s — continuous, but a bounded catch-up rather than
     true pacing of the missed cadence.

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

- **Leg 4** — R4/AC-8/AC-9/AC-10: scene-select sync, Fog initial state, and removal of
  the Save/Load controls (approved at the spec gate).
- **AC-12 (docs)** — specs 062/063 amendment notes and the INDEX status are the final leg's
  deliverable. Leg 3's change contradicts 062 R2's fixed-half-life wording, so that
  amendment note is owed by leg 4.
- Live validation after leg 2: rebuild, restart the sim, and re-probe the viewport to confirm
  that a probe at a drawn chip now returns that chip's agent (AC-3's real-device evidence).
- Live validation after leg 3: a real run should be watched at 1× and 5× to confirm the
  observed speed scales with the sim's speed. This is the dispatcher's job after merge —
  leg 3 deliberately did not restart the running sim.

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

## Handoff — leg 4

State: `main` = legs 1–2 merged (`970e2ba`, `e9dfcc7`), leg 3 on `fix/066-leg3-motion-aliasing`
(visualizer 117 green), spec 066 📝 In Development in the INDEX, issue #257 open.

- **Leg 3 (R3, AC-6, AC-7) — DONE.** Pure `motionTowards(from, to, elapsed, interval)` in
  `renderer/layout.ts`, paced by the measured snapshot interval in `client/main.ts`;
  `GLIDE_HALF_LIFE_S` removed. See the Leg 3 section above for the red-first evidence and the
  three honest limitations (frame-granularity wobble; hit test still uses targets; 1 s stall
  cap). Nothing in `engine/**` changed.
- **Leg 4 (R4, AC-8, AC-9, AC-10) — truthful controls.** Sync `sceneSelect` to the snapshot's
  scene (it currently shows the first option, `minimal`, while coffee-shop runs); make Fog's
  `on` class reflect the initial `showFog = true` (it is only toggled on click — a stale class
  that invalidated one of my own diagnostics); **remove Save/Load**, decided at the spec gate.
- **AC-12 belongs to leg 4**: amendment notes in specs 062/063 and the INDEX status update.
  Leg 3 deliberately did not touch the specs.

## Leg 3 — live validation, and what it can and cannot prove

Rebuilt `dist`, restarted the sim on leg-3 code (page grew to 46,576 bytes), loaded the served
page and re-checked the earlier legs as a **regression** test — leg 3 rewrote the position
pipeline, and the leg itself flagged that `hitTestAgent` resolves layout *targets* while the
agent is drawn interpolated, so selection was the thing genuinely at risk.

| Check | Result |
| --- | --- |
| AC-3 regression — all agents selectable | **3 of 3 hittable** (`agent-alice`, `agent-bob`, `agent-carol`) |
| AC-4/AC-5 regression — follow, then release | follow mid-glide `1.5549`; after release `scale 1.0005`, offsets `≈0.3/0.05` → converged to fit-all |

**Honest boundary.** The live run does *not* prove the pacing. Two different smoothers both
produce intermediate positions, so sampling drawn pixels in a real browser cannot distinguish
interval-paced linear motion from the old exponential glide — at least not reliably at frame
granularity with a moving camera. The substantive evidence for R3 is the **deterministic
served-bundle test**, which drives the page's own rAF manually and asserts the *absolute*
half-interval fraction, exact arrival at the interval's end, and clamping beyond it. Those are
assertions the old fixed half-life cannot satisfy (it closed 68.5% at the half-interval mark).
What the live run adds is integration and regression: the page loads on the new code, agents
render and remain selectable, and follow/release still converge.

## Third instance of the QA-push pattern

Leg 3's merge `4c59c98` again carried files the leg did not author: **+58 lines of qa-notes**
and roughly **+67 further test lines** in `mobile-shell.integration.test.ts`. Merged `main` is
therefore **119 visualizer tests**, against the **117** verified before the push. The standing
check (`git show --stat <merge>` plus re-running the suite on merged `main`) caught it a third
time; it is now load-bearing rather than advisory. All 119 pass.
