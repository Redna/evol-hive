# Feature: Visualizer Live-Observation Defects (3/3) — Co-located Agents, Camera Release, Motion Aliasing & Truthful Controls

## Context

- Architecture: [§2 — System Overview (visualizer transport)](../architecture/02-system-overview.md), [§3 — Agent State Schema (`position`)](../architecture/03-agent-state-schema.md)
- Related specs: [062 — Visualizer World View (1/2)](062-visualizer-world-view.md) (the pure `layoutWorld` seam, motion as a separate pure function, measured HUD insets), [063 — Visualizer Mobile Shell (2/2)](063-visualizer-mobile-shell.md) (follow-camera as a pure function, PWA, mobile observation workflow — **amended here**), [023 — Canvas 2D Visualizer](023-visual-output-canvas-renderer.md) (browser contract, control channel), [027 — Real-LLM Visualizer Demo](027-real-llm-visualizer-demo.md) (launch path)
- Package: `visualizer` (pure renderer modules, client shell, server-served page). `shared`/`engine`/`memory`/`cognition` **untouched**.
- Status: 📝 Drafted
- Supersedes nothing; **amends specs 062 and 063** where they are quoted below.

## Problem Summary

Specs 062 and 063 were verified by tests, a served-bundle sandbox and screenshots — but never by *using* the thing on a phone for a sustained run. Doing that (a live real-LLM run observed through the phone path, AC-9 of spec 063) produced four defects that the suite could not have caught, because three of them live on code paths the tests never execute.

All four are reproduced below with measurements taken from a live run. Nothing here is inferred from reading: each cause is stated with the file and line that produces it, and each was confirmed against the running system.

### D1 — Co-located agents render on top of each other, and tapping one selects another

`packages/visualizer/src/renderer/layout.ts:464` places every agent at its raw grid cell centre:

```ts
const at =
  a.position !== undefined ? cellCenter(rl.rect, a.position) : legacySlot(rl.rect, index);
```

Two agents in the same cell therefore receive **byte-identical coordinates**. Because the renderer paints agents in order (last on top) while `hitTestAgent` (`client/main.ts`) returns the **first** agent within `TAP_RADIUS`, the two consumers disagree:

- Measured: a probe over the whole viewport returned **`agent-alice`** at the position where the chip **drawn on top was labelled "Carol"**.
- Consequence: **tapping the agent you can see opens the detail card for a different agent.** The user reported this as "they are standing on top of each other"; the selection inversion was not reported but is the same defect.

The codebase already has the right idea for cell-less agents — `legacySlot(rect, index)` spreads by index — it is simply not applied to grid positions.

### D2 — Releasing follow leaves the camera at the follow zoom, parked on the world origin

`packages/visualizer/src/renderer/camera.ts:91`:

```ts
if (selection === null) return { scale: previous?.scale ?? 1, offsetX: 0, offsetY: 0 };
```

Fit-all is `{ scale: 1, offsetX: 0, offsetY: 0 }` (`FIT_ALL_CAMERA`); `layoutWorld` already centres the world at scale 1. Releasing a follow therefore returns the **follow scale (1.6)** with zeroed offsets — a 1.6× view anchored at the world origin, which is mostly empty space. Measured on the live page via its `?debug=1` hook:

| state | camera |
| --- | --- |
| following an agent | `{ scale: 1.6, offsetX: -382.69, offsetY: -61.86 }` |
| ~3 s after release | `{ scale: 1.6, offsetX: -0.089, offsetY: -0.014 }` |
| fit-all (expected) | `{ scale: 1, offsetX: 0, offsetY: 0 }` |

The client glides the offsets with `smoothTowards` but assigns `scale` **instantly**, so the release is a zoom-in-place plus a slide to an empty corner. Reported as "when I release the focus I get dragged to nowhere".

**The trigger is any tap on the canvas**: `canvas` `pointerdown` calls `select(hitTestAgent(...))`, so a tap that misses an agent clears the selection — and on a phone that happens constantly.

**Why the suite missed it.** `packages/visualizer/tests/renderer-camera.test.ts:58` calls `cameraFor(null, layout)` with **no `previous` argument**, so `previous` is `null` and the `previous?.scale ?? 1` branch is only ever exercised with its `1` default. Production always passes the live camera (`scale: 1.6`). The failing path is the production path, and no test touches it.

### D3 — Motion aliases into teleporting, because the glide rate ignores the snapshot interval

The engine moves agents **one cell per game-loop tick** (`packages/engine/src/spatial/navigation.ts:243`, in `advance`), and the loop runs on `setTimeout(..., 16)` (`packages/engine/src/loop/index.ts:111`) — **~60 ticks/s**, confirmed by the run's own HUD: 37,618 ticks in 627 s ≈ 60/s.

The client, however, receives snapshots every `snapshotRateMs = 100` (10/s) and glides toward each new position with a **fixed** `GLIDE_HALF_LIFE_S = 0.09` (`client/main.ts`). So at 1× roughly **6 cells advance between snapshots**, and at 5× roughly 30; the glide traverses each gap as a straight line in a few hundred milliseconds, cutting corners and reading as a teleport.

The defect is therefore **aliasing, not engine stepping** — an earlier reading of the log ("a walk completes in a single execute step") was wrong and is corrected here. The glide must be paced against the interval it is actually interpolating.

### D4 — Two controls do not tell the truth

The control bar works — pause/play/speed were measured against the live sim (log lines per 4 s: baseline 17, **paused 4**, **play 32**, **5× 39**, back to 1× 18) — but two controls misreport state:

- **The scene selector shows the wrong scene.** It renders `'minimal'` (the first appended option) while the **coffee-shop** scene is running, because the client never syncs the select to the scene actually in the snapshot. Touching it silently reloads a different scene. **Resolved by removal at the human gate** (Decision 6), because the truth was not reachable in scope — see R4 and the Notes.
- **The Fog button's initial state is inverted.** `showFog` initialises to `true` (agents hidden) while the `on` class is only ever toggled *on click*, so the view starts fogged with the button looking off. This one is worth noting because it **invalidated a diagnostic**: a conditional click keyed off that class never fired, leaving fog enabled while the probe assumed it was off.
- **Save/Load are unverified as functional.** Both route through `this.persistence?.` in the adapter, so without a persistence object they no-op silently, and `load` opens a `prompt()` dialog — poor on mobile. **Decision (approved): remove them** rather than wire persistence. Unused controls cost scarce screen space on a phone, and a `prompt()` dialog is a poor mobile affordance.

## Requirements

### R1 — Co-located agents are separately placed, and what is drawn is what is selected (`visualizer`)

- `layoutWorld` must assign **distinct positions** to agents occupying the same grid cell, via a deterministic spread that depends only on the layout inputs (never on time, iteration order of a `Map`, or randomness), so a snapshot always lays out identically.
- The spread must stay **inside the agent's cell neighbourhood** so placement still reads as "in that cell", and must not collide with a neighbouring cell's occupant.
- **Drawn and selectable must be the same agent.** The renderer and the hit test must derive positions from one source of truth, so the tap that lands on a visible chip selects *that* chip's agent.
- A single-agent cell must keep its current centred position (no regression for the common case).

### R2 — Releasing follow returns to fit-all, smoothly (`visualizer`)

- `cameraFor(null, …)` must return the **fit-all camera regardless of `previous`** — scale 1, zero offsets — since the layout is already centred at scale 1.
- The same must hold for a selection that is not present in the layout (an agent that left the scene).
- The **scale transition must be smooth**, not instant: the client currently snaps `scale` while gliding offsets, so releasing follow would otherwise be a hard zoom-out. Scale must use the same time-based smoother as the offsets.
- Clearing the selection by tapping empty canvas stays the behaviour (it is a legitimate way to release) — the fix is that it must *land somewhere sensible*.

### R3 — Motion is paced against the snapshot interval (`visualizer`)

- Agent motion must interpolate **across the interval it is bridging**, not with a fixed half-life: a position delta delivered in one snapshot must be traversed over that snapshot's duration, so observed speed matches simulated speed.
- The pacing must be **self-adjusting to speed changes**: at 5× the delta is larger and the interval unchanged, so the agent must move proportionally faster without changing any constant.
- Interpolation must be **pure and clock-free** at its seam (elapsed time in, position out) so it is testable without timers, matching the spec-062 R2 discipline.
- Motion must remain continuous — no frame may jump the agent to a target it has not traversed.
- The snapshot push rate may be raised if the leg shows it is needed, but the fix must not *depend* on a protocol change; bandwidth to a phone over a mesh network is a real constraint.

### R4 — The control bar reports the true state (`visualizer`)

- **The scene selector is removed from the control bar** (Decision 6). It cannot report the running scene: `VisualizerState` carries no scene id, and this spec's Constraints forbid adding one, so no in-scope implementation can make it truthful. A selector that opens on a value it cannot verify is worse than no selector — and it silently reloads a different scene when touched.
- The Fog button's active state must reflect the actual fog state **at startup**, not only after a click.
- **Save/Load are removed from the control bar** (Decision 6). A control that cannot act must not be presented; if a future spec wires persistence into a served run, the controls return with it.
- Controls that only work in some configurations must be visible exactly when they work.

### R5 — Regression discipline (`visualizer`)

- Specs 062 and 063 are **amended in place** where this spec contradicts them (063 R3's release semantics; 062 R2's fixed-half-life motion), with the amendment noted in each spec's Notes.
- Every defect above gets a **red-first** test: the test must be shown failing on current `main` for the reason stated in the Problem Summary, then passing after the fix.
- The D2 test must exercise the case production actually runs (`previous` = a live follow camera) — the omission that let it ship.
- The phone walk that found these is recorded as evidence, and **spec 063's AC-9 is closed** or explicitly re-scoped against what was observed.

## Acceptance Criteria

- [ ] **AC-1 (R1)** — two agents with an identical `position` in one room produce **different** `x`/`y` from `layoutWorld`, and a third agent in a different cell does not land on either.
- [ ] **AC-2 (R1)** — `layoutWorld` is deterministic for co-located agents: identical input yields identical positions across repeated calls.
- [ ] **AC-3 (R1)** — a probe at the screen position of a drawn agent selects **that agent's id** (the inversion in D1 is gone), asserted through the served client bundle with the mock-DOM harness.
- [ ] **AC-4 (R2)** — `cameraFor(null, layout, followCamera)` returns `{ scale: 1, offsetX: 0, offsetY: 0 }` **with `previous` a live follow camera** (the case the existing suite omits), and the same for an unknown selection.
- [ ] **AC-5 (R2)** — releasing follow converges to fit-all within a bounded time, and `scale` changes gradually rather than in one frame.
- [ ] **AC-6 (R3)** — given a delta delivered over a known interval, the interpolated position is proportional to elapsed time within that interval and **arrives at the target as the interval completes**; asserted as a pure function with no timers.
- [ ] **AC-7 (R3)** — a larger delta over the same interval moves the agent proportionally faster (no constant retuning needed for 5×).
- [ ] **AC-8 (R4)** — the scene selector is absent from the served page, and the client no longer hardcodes a scene list nor sends `selectScene`.
- [ ] **AC-9 (R4)** — the Fog button's active state matches the fog state at startup, and matches it after each toggle.
- [ ] **AC-10 (R4)** — the Save and Load controls are absent from the served page, and no `prompt()`-based load path remains in the client.
- [ ] **AC-11 (R5)** — the full `visualizer` suite is green, `pnpm typecheck` is clean, and touched files pass `npx prettier --check`.
- [ ] **AC-12 (R5)** — specs 062/063 carry the amendment notes, and `docs/specs/INDEX.md` reflects this spec's status.

## Constraints

- **Package boundary**: `packages/visualizer/**` only. The engine's stepping, tick rate and co-location tolerance are **not** changed — the sim legitimately allows agents to share a cell, and it is the *view* that must distinguish them. No new dependencies.
- **Purity stays intact** (spec 062, R1/R2): visual rules live in `renderer/**` as pure, DOM-free, clock-free functions; `client/main.ts` stays DOM/WebSocket glue. No test may require a real browser or a real timer.
- **Single source of truth for positions**: the fix for D1 must not duplicate layout maths into the hit test or the renderer. Two consumers deriving the same thing independently is what produced the inversion.
- **No protocol change required**: R3 must be satisfied without raising the snapshot rate, though raising it is permitted if measured necessary. If the rate changes, bandwidth to a phone over a mesh network is the budget to respect.
- **Phone-first**: 44 px minimum targets, safe-area insets respected, no layout that overflows a 390 px-wide viewport.
- **Deterministic rendering**: no `Math.random`, no dependence on `Map` iteration order, no clock in the pure modules.
- **No protocol change to make the control bar truthful.** Removing the controls that cannot tell the truth (Decision 6) is chosen over widening the snapshot: a `sceneId` on `VisualizerState` would touch `shared` and `engine`, outside this spec's scope, and a fully truthful selector deserves its own spec rather than a rider on a bug-fix change.
- **Do not chase**: `pnpm typecheck` excludes `tests/`; a tests-inclusive run has ~703 known errors and is not a target. Do not edit `dist/` or goldens in spec-021/spec-055.

## Test Seams

Pre-agreed boundaries only; these are the seams the legs write tests at.

1. **`renderer/layout.ts` — `layoutWorld` agent placement** (pure function, no DOM): co-location spread, determinism, and no cross-cell collision (AC-1, AC-2).
2. **`renderer/layout.ts` — the motion function** (pure, clock-free): interval-paced interpolation and speed scaling (AC-6, AC-7). Spec 062 R2 already places motion here; this extends, not relocates it.
3. **`renderer/camera.ts` — `cameraFor(selection, layout, previous)`** (pure): release-to-fit-all **with a live follow camera as `previous`** (AC-4). The existing file's default-argument gap is the seam to close.
4. **Served client bundle + mock DOM** (`getClientBundle()` in the existing `mobile-shell.integration.test.ts` harness): tap-selects-what-is-drawn, control absence, and fog initial state (AC-3, AC-5, AC-8, AC-9). This exercises the shipped glue, not a copy.
5. **Adapter/shell capability** — Save/Load truthfulness (AC-10): assert visibility against whether persistence is wired, rather than mocking a persistence object into existence.

## Design Decisions

1. **Amend, do not supersede.** Specs 062/063 are partially wrong, not obsolete: the pure-seam architecture is sound and is what makes these fixes cheap. The two contradictory statements are corrected in place so the ledger does not carry a silent contradiction.
2. **Fix the view, not the sim.** Agents sharing a cell is legitimate simulation state (the engine steps one cell per tick without reserving cells). Changing the engine to forbid co-location would change agent behaviour to suit a rendering limitation — the wrong direction. The view must reveal what is true.
3. **Aliasing is an interpolation-pacing bug, not a speed bug.** The renderer must show the simulation's real speed (≈60 cells/s at 1×). If the *pacing of the simulation itself* is unsatisfying to watch, that is a simulation question and belongs in its own spec — deliberately out of scope here so the fix cannot quietly become "slow the renderer down until it looks nice".
4. **Fidelity over prettiness in motion.** Interval-paced interpolation is chosen over a longer fixed half-life because a longer half-life would still cut corners and would misreport speed; it treats the symptom.
5. **One position source.** D1 is fixed in layout, where both consumers already read from, rather than by teaching the hit test about de-collision — that keeps the invariant true by construction instead of by agreement.
6. **Remove controls that cannot tell the truth (approved by the human at the spec gate).** Two controls failed this test for different reasons, and both are deleted rather than repaired:
   - **Save/Load** route through `this.persistence?.`, so absent a persistence object they no-op silently while still occupying the phone's scarcest resource — screen height — and offering a `prompt()` dialog. Wiring persistence is real scope with no user story behind it here.
   - **The scene selector** could not be made truthful *in scope*: reporting the running scene needs a scene id in the snapshot, `VisualizerState` has none, and this spec's Constraints put `shared`/`engine` out of bounds. The alternative — widen the protocol — is a different change with its own justification.
   Deliberately **not** replaced with a disabled state: a greyed-out control is still a promise.

## Out of Scope

- Any change to engine movement, tick rate, pathfinding, or cell reservation (Decision 2).
- Simulation pacing, plan timing, LLM latency, or agent idleness ("doing nothing" observed while agents wait on LLM cycles is sim behaviour, not a rendering defect).
- New visual features: user zoom, camera easing curves, animation of doors/objects, alternate skins.
- The iOS home-screen icon (`apple-touch-icon` as SVG) and `apple-mobile-web-app-capable` — real AC-9 findings, deliberately left to a separate change so this spec stays about defects that break *use*, not polish.
- Save-file format, persistence design, or offline behaviour. The Save/Load controls are **removed** rather than wired (Decision 6), so persistence in a served run is not pursued here.

## Notes

- **How these were found.** Not by the suite: by a live real-LLM run viewed through the phone path, plus a scripted browser session against the running sim (viewport probe over the canvas, the page's own `?debug=1` camera hook, and control clicks measured against the server log). Three of the four defects are on code paths the tests never execute, which is why they survived review.
- **Diagnostic correction recorded.** An intermediate reading held that the engine resolves a walk in one execute step; `navigation.ts:243` shows one cell per tick, so the defect is client-side aliasing. The wrong reading is recorded here because it shaped the first version of R3.
- **A defect can invalidate a diagnosis.** The Fog button's stale `on` class caused a probe to run with fog enabled while assuming it was disabled, briefly producing a false "two agents are dropped from the layout" conclusion. Test instrumentation must not key off the state it is meant to be measuring.
- **Spec drift caught during implementation: an AC asked for state the protocol never carried.** AC-8 originally required the scene selector to equal *the snapshot's* scene. `VisualizerState` has no scene id — the only `sceneId` in the shared types is on the outbound `selectScene` command — and this spec's own Constraints forbid adding one. The AC was written from the symptom ("the dropdown lies") without checking that the data existed, which is exactly the drift the spec gate exists to catch; it survived because the same session authored *and* approved the spec. Caught when leg 4 was scoped against the code, and resolved by removal at the gate.
  **The general form worth checking for: an AC that reads state must name the field that carries it.** An AC phrased as "the UI reflects X" is only implementable if X is in the payload; otherwise it is a wish, not a criterion.
- **Evidence lives in** `docs/specs/notes/066-*-notes.md` per ADR-003 (local memory is not CI's; committed notes are the handoff).
- **Environment values stay out.** The reproduction recipe in the implementation notes uses placeholders only (this is a public repository), consistent with spec 063's rule.
