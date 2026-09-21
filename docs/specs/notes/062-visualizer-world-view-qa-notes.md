# QA Notes — Spec 062: Visualizer World View (1/2)

- **PR**: [#234](https://github.com/Redna/evol-hive/pull/234)
- **Issue**: [#231](https://github.com/Redna/evol-hive/issues/231)
- **Spec**: `docs/specs/062-visualizer-world-view.md`
- **Verdict**: ✅ Approve for review — 9/9 CI-testable acceptance criteria covered (AC-10 is live/issue-owned).

## Coverage map

| AC | Requirement | Existing test(s) | Status |
| -- | ----------- | ---------------- | ------ |
| AC-1 | Topology-scored 2×2 layout, 3 openings + 1 non-crossing corridor | `renderer-layout.test.ts` (coffee-shop fixture, corridor sampling, `adjacencyScore`) | ✅ |
| AC-2 | Rooms fit viewport + measured insets (360×640, 390×844, 1280×720) | `renderer-layout.test.ts` (viewport/inset fit, no desktop overflow) | ✅ |
| AC-3 | `doorway` excluded from objects; one door per connection; affordances agree | `renderer-layout.test.ts` (doorway exclusion, door count, fixture agreement) | ✅ |
| AC-4 | `smoothTowards` monotonic, partition-independent, snap, no overshoot | `renderer-layout.test.ts` | ✅ |
| AC-5 | Injected `Skin` observes room/object/agent/door draws; layout skin-independent | `renderer-layout.test.ts` (partial) **+ QA `qa-spec062-coverage.test.ts`** (full dispatch incl. agent/object/opening; determinism) | ✅ |
| AC-6 | Legible minimum; long object name/state truncated via fitting function | **QA `qa-spec062-coverage.test.ts`** (`truncate`/`initials`, chip truncation preserves value, ≥9px labels / ≥8px state floor) | ✅ |
| AC-7 | Fog semantics: unexplored shaded, out-of-fog hidden; no fog ⇒ all render; view toggle | `canvas-renderer-fog.test.ts` (existing) **+ QA `qa-spec062-coverage.test.ts`** (`showFog:false` lifts shading *and* hiding) | ✅ |
| AC-8 | Served page sandbox: (a) DPR backing store, (b) resize recompute, (c) DOM insets → `layoutWorld` | **QA `mobile-shell.integration.test.ts`** (5 tests, executes the real served bundle) | ✅ |
| AC-9 | spec-042 invariant relaxed to `src/renderer/**`; existing behaviour intact | `visualizer-server-html.test.ts` (invariant) + all pre-existing suites re-run | ✅ |
| AC-10 | Live run evidence on fresh `dist` | Issue-owned (screenshots on #231); not CI-testable | ⚪ |

## Tests added by QA

1. `packages/visualizer/tests/mobile-shell.integration.test.ts` — 5 tests. Executes the
   **served page bundle** (`getClientBundle()`, the exact string `GET /` inlines) against a
   mock canvas/DOM:
   - backing store = CSS px × DPR + `setTransform(dpr,…)`; DPR clamped at 3;
   - `resize` recomputes layout for the new viewport (guards the old cached-dimension bug);
   - measured top/bottom HUD insets reach the renderer and `layoutWorld` (room rect equals
     the pure seam's rect for the measured-inset viewport);
   - a single snapshot renders the agent exactly at its projected cell (no first-sight default).
2. `packages/visualizer/tests/qa-spec062-coverage.test.ts` — 7 tests for AC-5/6/7 (skin
   dispatch of every entity, chip truncation + value preservation, legible font floor, fog
   toggle flipping both shading and hiding).

## Results

- `pnpm --filter @evol-hive/visualizer test`: **76 passed** (12 files; was 62 before QA, +14).
- `pnpm test` (monorepo): green — shared, memory, engine, cognition, assembly, examples (253),
  cli (24), visualizer.
- `pnpm typecheck`: clean. `pnpm lint`: clean.
- `pnpm build`: green; `dist-bundle.e2e.test.ts` un-skips and passes against the built artifact.

## Gaps / observations (not blocking)

- **AC-3 mismatch guard not implemented.** R3 says the doorway `go_to_<roomId>` affordances are
  the authoritative door list and that a mismatch with `room.connections` "is asserted, not
  silently ignored". `layoutWorld` derives doors from `room.connections` only and ignores the
  doorway affordances; no runtime assertion compares the two. For the current engine-generated
  scenes they agree (asserted at the fixture level), so behaviour is correct today — but there
  is no drift guard. Recommended follow-up, not a blocker.
- **AC-6 "declared legible minimum" is not a token.** Font floors are inline literals in
  `skin.ts` (labels ≥ 9px, state line ≥ 8px). QA asserts the observed floor behaviourally; a
  named `THEME` constant would make the contract explicit.
- **AC-10 is live/issue-owned** (screenshots at 390×844 / 1280×720 on #231) and is out of CI scope.

## YAAM

No scratchpad workspace exists for spec 062 (`grep` of the restored `events.jsonl` found only
`feature-062-multi-agent-social`, which is spec 018). Architect/Developer notes for this spec
were not found; the report above is derived from the PR diff and spec directly. The QA tools
available to this run were `read/write/edit/bash`, so findings are recorded in this file rather
than via a YAAM scratchpad write.
