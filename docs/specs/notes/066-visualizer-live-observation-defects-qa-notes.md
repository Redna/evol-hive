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

---

# 066 — Visualizer Live-Observation Defects — QA notes (leg 2)

- **PR:** [#259](https://github.com/Redna/evol-hive/pull/259) — `fix/066-leg2-co-located-agents`
- **Scope of this leg:** R1 / **AC-1, AC-2, AC-3** (leg 2 of four; D2/R2 landed in leg 1, D3/R3 and D4/R4 land in later legs per the approved serialized chain).
- **Spec:** `docs/specs/066-visualizer-live-observation-defects.md`
- **Design/implementation notes:** `docs/specs/notes/066-…-implementation-notes.md` (added by this PR — closes the leg-1 gap where 066 had no notes).
- **Verdict:** ✅ All testable leg-2 acceptance criteria now have tests; full suite, `typecheck`, `lint` and `prettier` are green.

## Coverage summary

| AC       | Requirement                                                                                                                                                              | Covered by                                                                                                                                                                     | Status |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **AC-1** | Two co-located agents produce different `x`/`y` from `layoutWorld`; a third agent in a different cell lands on neither                                                   | `packages/visualizer/tests/spec-066-co-located-agents.test.ts` (2-agent, 3-agent, different-cell cases)                                                                          | ✅ dev |
| **AC-2** | `layoutWorld` is deterministic for co-located agents: identical input → identical positions across repeated calls                                                          | `spec-066-co-located-agents.test.ts` — "assigns the same slot regardless of the order of `state.agents`" invokes `layoutWorld` repeatedly and asserts per-agent equality; order-independence is the strictly stronger form of this AC | ✅ dev |
| **AC-3** | A probe at the screen position of a **drawn** agent selects **that agent's id** (the D1 inversion is gone), asserted through the served client bundle with the mock-DOM harness | **QA added** — `packages/visualizer/tests/mobile-shell.integration.test.ts`, "spec 066 leg 2 — the served tap selects the agent it drew (AC-3)"                                  | ✅ QA  |

**3 / 3 leg-2 acceptance criteria tested.**

AC-11 (full suite green, typecheck, prettier) is satisfied by the run below. AC-12 (spec 062/063 amendment notes, INDEX status) belongs to the final leg and is **not** claimed here — see Gaps.

## Tests added by QA

`packages/visualizer/tests/mobile-shell.integration.test.ts`
— new describe block **"spec 066 leg 2 — the served tap selects the agent it drew (AC-3)"**, plus a small `coLocatedAgent` fixture helper.

**Why it was missing.** The Developer's AC-1/AC-2 tests assert the *layout invariant* — co-located agents get distinct points. That is the right unit seam, and the implementation notes argue (correctly) that uniqueness makes the two consumers agree *by construction*. But D1 was not a layout-only failure: it was an **inversion between two consumers of the layout** — the renderer paints in order (last drawn on top) while `hitTestAgent` returns the nearest/first. A regression that decoupled the hit test from the layout (for example, re-deriving positions inside `hitTestAgent`) would leave every pure `layoutWorld` test green while re-opening the measured bug. Spec 066's Test Seam 4 explicitly names the served bundle + mock-DOM harness for AC-3, and issue #257's leg 2 is worded "the tap that lands on a chip selects that chip's agent". This closes the seam the Developer skipped.

The test feeds a snapshot with **Alice and Bob in one cell** (Alice first, so the renderer paints Bob's chip on top), locates each agent's drawn name pill in the recorded canvas calls (proving the tap coordinates are the *drawn* positions, not a second derivation), then drives the shipped `pointerdown` glue. The card must open for Bob when Bob's chip is tapped, and for Alice when Alice's is.

## Red-first evidence

Reverting only `packages/visualizer/src/renderer/layout.ts` to its pre-leg-2 revision (`git show HEAD~1:… > layout.ts`) and running the new case:

```
× spec 066 leg 2 — the served tap selects the agent it drew (AC-3)
  > tapping a co-located agent's drawn chip selects that agent, not its cell-mate
  → expected 'Alice' to be 'Bob' // Object.is equality
```

Exactly the measured D1 symptom: a tap on the chip drawn on top (Bob) selected the agent whose chip was underneath (Alice). The source was restored immediately after (`git diff` on `layout.ts` clean). The Developer's own red-first evidence (`3 failed | 2 passed`) is unchanged.

## Test results

- `pnpm test` — **all green**: shared 399, memory 101, **visualizer 108** (+1 QA integration test; 16 files), engine 922, cognition 1252, assembly 89, examples 253, cli 115.
- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `npx prettier --check` on the touched file — clean.
- Root `pnpm test` requires `pnpm build` first (shared resolves from `dist/`); built all packages before the run.

## Gaps / not tested here

- **AC-6, AC-7 (R3, D3 motion aliasing)** — deferred to leg 3.
- **AC-8, AC-9, AC-10 (R4, D4 truthful controls)** — deferred to leg 4.
- **AC-12 (R5 docs)** — spec 062/063 amendment notes and `docs/specs/INDEX.md` status are the final leg's deliverable; not present yet, so not claimed.
- **AC-3 real-device evidence.** The served-bundle test proves the glue is tap-correct against the shipped bundle; a live phone re-probe (the implementation notes' "What is left") remains the human close-out for AC-3 and is not automatable here.

---

# 066 — Visualizer Live-Observation Defects — QA notes (leg 3)

- **PR:** [#262](https://github.com/Redna/evol-hive/pull/262) — `fix/066-leg3-motion-aliasing`
- **Scope of this leg:** R3 / **AC-6, AC-7** (leg 3 of four; D1/R1 landed in leg 2, D4/R4 lands in leg 4 per the approved serialized chain).
- **Spec:** `docs/specs/066-visualizer-live-observation-defects.md`
- **Design/implementation notes:** `docs/specs/notes/066-…-implementation-notes.md` (updated by this PR with the Leg 3 section: cause, red-first evidence, design, three honest limitations).
- **Verdict:** ✅ All testable leg-3 acceptance criteria have tests; full suite, `typecheck`, `lint` and `prettier` are green.

## Coverage summary

| AC       | Requirement                                                                                                                                                                                | Covered by                                                                                                                                                                                                       | Status |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **AC-6** | Delta delivered over a known interval interpolates proportionally to elapsed time and arrives at the target as the interval completes; asserted as a pure function with no timers               | `packages/visualizer/tests/spec-066-motion-aliasing.test.ts` (proportional / arrives / clamps / no-frame-jump) **+** `mobile-shell.integration.test.ts` (served glue bridges each delta) **+ QA added** measured-cadence cases | ✅     |
| **AC-7** | A larger delta over the same interval moves proportionally faster (no constant retuning for 5×)                                                                                            | `spec-066-motion-aliasing.test.ts` (pure 5× ratio + absolute half-interval fraction + reported 60 cells/s) **+** `mobile-shell.integration.test.ts` (served-glue 2-vs-10 cell case)                                 | ✅     |

**2 / 2 leg-3 acceptance criteria tested.**

AC-11 (full suite green, typecheck, prettier) is satisfied by the run below. AC-12 (spec 062/063 amendment notes, INDEX status) belongs to the final leg and is **not** claimed here — see Gaps.

## Tests added by QA

`packages/visualizer/tests/mobile-shell.integration.test.ts`
— new describe block **"spec 066 leg 3 — the glide interval is measured from snapshot arrivals (AC-6)"**, two cases (slower 0.2 s cadence and faster 0.05 s cadence).

**Why it was missing.** The Developer's served-glue cases all observe snapshots **exactly 0.1 s apart** — which is `DEFAULT_SNAPSHOT_INTERVAL_S`. They prove the delta is bridged over *a* 0.1 s interval, but they cannot distinguish a **measured** cadence from a hardcoded default, because both are 0.1. The implementation notes' headline claim is explicitly the opposite ("measured cadence, not a hardcoded rate… a server configured with a different `snapshotRateMs` or a jittery mesh link is paced correctly"), and spec 066 R3 requires the delta be traversed over *that snapshot's duration*. A regression that replaced `glide.intervalS = snapshotIntervalS` with the default constant — the original D3 aliasing in a new coat — leaves every existing test green. The two QA cases drive non-default cadences (0.2 s and 0.05 s) and assert the delta is half-traversed at half of *that* interval; both fail on a hardcoded default.

## Red-first evidence

Temporarily reverting the measured wiring (`glide.intervalS = snapshotIntervalS` → `= DEFAULT_SNAPSHOT_INTERVAL_S`) and running only the new cases:

```
× spec 066 leg 3 — the glide interval is measured from snapshot arrivals (AC-6)
  > paces a slower 0.2 s cadence over 0.2 s, not the 0.1 s default
  → expected 766.6666666666666 to be close to 466.66666666666663 (already arrived)
× ... > paces a faster 0.05 s cadence over 0.05 s, not the 0.1 s default
  → expected 316.66666666666663 to be close to 466.66666666666663 (only a quarter moved)
```

The source was restored immediately after (`git diff src/client/main.ts` clean). The Developer's own red-first evidence (`8 failed | 10 passed → 18 passed`) is confirmed by inspection: the pure `motionTowards` cases and the served-glue 0.1 s cases all discriminate against the pre-fix fixed-half-life glide.

## Test results

- `pnpm test` — **all green**: shared 399, memory 101, **visualizer 119** (+2 QA integration cases; 17 files), engine 922, cognition 1252, assembly 89, examples 253, cli 115.
- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `npx prettier --check` on the touched test file — clean.
- Root `pnpm test` requires `pnpm build` first (shared resolves from `dist/`); built all packages before the run.

## Gaps / not tested here

- **AC-8, AC-9, AC-10 (R4, D4 truthful controls)** — deferred to leg 4.
- **AC-12 (R5 docs)** — spec 062/063 amendment notes and `docs/specs/INDEX.md` status are the final leg's deliverable; not present yet, so not claimed.
- **`hitTestAgent` vs interpolated draw position.** The implementation notes record (honestly) that a tap during a glide resolves against the layout *target* while the agent is drawn interpolated, so it can miss by up to one interval. This predates leg 3 and is outside AC-6/AC-7; recorded rather than silently widened.
- **Frame-granularity speed wobble.** The measured interval is sampled at frame granularity (~16 ms at 60 FPS), so a jittery arrival cadence yields a small speed wobble rather than perfectly constant velocity. Deliberate (the alternative is a hardcoded protocol rate); not an AC and not automatable without a real clock.
- **Live validation at 1× and 5×.** The implementation notes assign the real-run watch (observed speed scales with `timeScale`) to the dispatcher after merge; leg 3 deliberately did not restart the running sim. Not automatable here.

---

# 066 — Visualizer Live-Observation Defects — QA notes (leg 4)

- **PR:** [#265](https://github.com/Redna/evol-hive/pull/265) — `fix/066-leg4-truthful-controls`
- **Scope of this leg:** R4 / **AC-8, AC-9, AC-10** plus **AC-12** (the amendment notes and INDEX
  status this spec owes). Leg 4 of 4 — the whole spec closes here.
- **Spec:** `docs/specs/066-visualizer-live-observation-defects.md`
- **Design/implementation notes:** `docs/specs/notes/066-…-implementation-notes.md` (the Leg 4
  section was added by this PR).
- **Verdict:** ✅ All four leg-4 acceptance criteria now have tests; the full matrix, `typecheck`,
  `lint` and `prettier` are green.

## Coverage summary

| AC       | Requirement                                                                                                                                                          | Covered by                                                                                                                                                                                                                                                                     | Status |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **AC-8** | The scene selector is absent from the served page, and the client no longer hardcodes a scene list nor sends `selectScene`                                            | dev — `visualizer-server-html.test.ts` (served HTML has no `sceneSelect`/`selectScene`); `mobile-shell.integration.test.ts` leg-4 (the bundle has no `sceneSelect`, `selectScene`, `coffee-shop`, `morning-routine`)                                                               | ✅     |
| **AC-9** | The Fog button's active state matches the fog state at startup, and after each toggle                                                                                 | dev — `mobile-shell.integration.test.ts` leg-4 (`on` at startup; toggles off/on) **+ QA added** — the class↔view lockstep case across off→on→off; **+ QA added** — `dist-bundle.e2e.test.ts` pins the startup class wiring in the built artifact                                  | ✅     |
| **AC-10** | The Save and Load controls are absent from the served page, and no `prompt()`-based load path remains in the client                                                   | dev — `visualizer-server-html.test.ts` (served HTML has no `btnSave`/`btnLoad`/`prompt(`); `mobile-shell.integration.test.ts` leg-4 (bundle has no `btnSave`, `btnLoad`, `prompt(`, `save`/`load` commands)                                                                     | ✅     |
| **AC-12** | Specs 062/063 carry the amendment notes, and `docs/specs/INDEX.md` reflects this spec's status                                                                        | **QA added** — `packages/cli/tests/spec-066-ledger-qa.test.ts` (amendment links in 062/063; INDEX row = ✅ Done; spec header = ✅ Done; 0 unticked / 12 ticked ACs), underpinned by the existing `spec-index-integrity` guard (sets + tally)                                       | ✅     |

**4 / 4 leg-4 acceptance criteria tested.** AC-11 (suite green, `typecheck`, prettier) is satisfied
by the run below.

## Tests added by QA

1. `packages/visualizer/tests/mobile-shell.integration.test.ts` — new case **“the Fog button’s
   active class tracks the actual fog view at startup and after each toggle (AC-9)”**.
   **Why it was missing.** The Developer’s cases assert the `on` class in isolation, and an older
   spec-063 case asserts fog hit-testing in isolation — but nothing pinned the class and the view
   together across a full off→on→off cycle. D4’s harm was a diagnostic keyed off the class, so the
   class and the actual fog state must stay in lockstep. **Red-first:** mutating the handler to
   re-enable the `on` class *without* re-enabling `showFog` (the class and the view decoupled) makes
   the final assertion fail (`expected false to be true`) while the Developer’s class-only toggle
   case stays green. Source restored immediately.

2. `packages/visualizer/tests/dist-bundle.e2e.test.ts` — new E2E case **“serves the spec-066 leg-4
   truthful controls from the built artifact (AC-8, AC-9, AC-10)”**.
   **Why it was missing.** Every other leg-4 test imports `src/`, so a stale `dist/` — the exact trap
   `AGENTS.md` records (live sims resolve `@evol-hive/visualizer` to built `dist/`, not source) —
   would pass the whole suite while the running sim still served the removed controls. **Red-first:**
   injecting `<button id="btnSave">` into `dist/index.js` fails `not to contain 'btnSave'`; dist was
   restored byte-for-byte (never committed). The case also asserts the startup `fogClass?.toggle("on",
   showFog)` wiring reaches the served page.

3. `packages/cli/tests/spec-066-ledger-qa.test.ts` — four policy cases pinning **AC-12**, same
   precedent as `spec-index-integrity-qa.test.ts`: the amendment links in 062/063, the INDEX 066 row
   = `✅ Done` matching the spec header, and no unticked ACs (12 checked / 0 open). It asserts
   existence and linkage, not prose, so wording changes do not rot it.

## Red-first evidence

| Added test | Mutation (temporary, all reverted) | Result |
| --- | --- | --- |
| AC-9 class↔view lockstep | Fog handler re-enables the class but not `showFog` (view) | × `expected false to be true` (final tap re-hides the view) — Developer class-only case stays green |
| AC-8/10 dist E2E | `<button id="btnSave">` injected into `dist/index.js` | × `expected '<!DOCTYPE html>…' not to contain 'btnSave'` |
| AC-12 ledger guard | (positive control; asserts current tree) | ✓ 4/4 |

No implementation file was modified; each source mutation was restored and verified clean
(`git diff --quiet`) before proceeding.

## Test results

- `pnpm test` (repo root, after `pnpm build`) — **all green**: shared 399 · memory 101 · engine 922 ·
  cognition 1252 · assembly 89 · examples 253 · **cli 119** · **visualizer 125**.
- Delta from the Developer’s legs: **visualizer 123 → 125** (+2 QA), **cli 115 → 119** (+4 QA).
- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `npx prettier --check` on the three touched test files — clean.
- Root `pnpm test` requires `pnpm build` first (shared resolves from `dist/`); built all packages
  before the run.

## Gaps / not tested here

- **No phone observation.** AC-8/9/10 are asserted through the served page and the exact inlined
  bundle (from `src` and from the built `dist/`), not a real device. The implementation notes record
  that this leg deliberately did not restart the running sim; the live walk remains the dispatcher’s
  post-merge close-out, as for legs 1–3.
- **AC-12 amendment prose.** The guard asserts that the amendment notes exist and link to 066, and
  that the ledger status is truthful. It does not assert their wording — that would be a brittle
  content test and the prose is reviewed at the PR gate instead.
- **iOS home-screen icon / `apple-mobile-web-app-capable`.** A real spec-063 AC-9 finding, explicitly
  left out of spec 066 (documented in 063’s amendment); not tested here.
- **A truthful scene selector remains untestable by design.** It would require a `sceneId` on
  `VisualizerState` (touching `shared`/`engine`), which this spec’s Constraints forbid; the
  deliverable is removal, which is asserted.
