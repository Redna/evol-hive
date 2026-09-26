# Implementation Notes — Spec 065 (Reachable Area Offers) — Issue #225 (slice 2)

> Durable session record (`docs/specs/notes/*.md`, spec-045/050/051 convention).
> Branch `fix/065-reachable-area-offers`. Engine-only change; no `shared`
> protocol/type changes, no new dependencies.

## Verdict

R1, R2, R3, R5 and the AC-6 guard are implemented and green. Red-first was
captured before the source change (9 failing / 5 passing on `main`); after the
change the same file is 14/14. The full engine suite is 936 passed + 141 todo
across 76 files (baseline 922 passed + 141 todo across 75 files). AC-7's
adjacent suites are green.

## What was built

### R4 seam — one reachability decision, injected

- `packages/engine/src/spatial/navigation.ts`
  - New private `openRoute(agentId, toRoomId)`: the **single** "passable"
    decision (open route from the agent's current room; `[]` = none). It is now
    the only path to `WorldGrid.route` inside the navigator — `requestWalk`,
    `navigateToArea`'s object branch and `navigateToArea`'s room branch all call
    it, so the walk and the offer query cannot diverge (R4: no second BFS).
  - New public `canReachArea(agentId, areaId): boolean` — the narrow port.
    `areaId` may be a room id or an object anchor (resolved through the
    corrected `observedObjects` map). Standing in the target room returns
    `true`; otherwise the shared `openRoute` decides.
- `packages/engine/src/agents/perception/index.ts`
  - New exported `AreaReachabilityPort { canReachArea(agentId, areaId): boolean }`.
  - `PerceptionDataProviderImpl` gains an **optional** port: a 5th positional
    constructor argument and `setReachabilityPort(port)`. Absent port = today's
    projection (degrade), so all 18 existing construction sites keep compiling.
- `packages/engine/src/assembly.ts`
  - `core.bridges.perception.setReachabilityPort(navigation)` right after the
    navigator is built. A setter (not the constructor) because the perception
    bridge is constructed earlier in `createEngineCore`, before `navigation`
    exists. Both objects are in the same function scope at the call site.
  - `PerceptionDataProviderOptions` gains the optional `reachability` field.
    Caveat: that interface is currently **unused** by the positional
    constructor, so the field is documentation/forward-compat only — the wired
    path is the setter. Noted rather than hidden.

### R1/R3 — knowledge ≠ offer in `getKnownAreas`

Order contract preserved: visited rooms → `knownDoors` endpoints →
`observedObjects` keys.

- A room that appears **only** through `knownDoors` is added **only if** the
  injected port says `canReachArea`. Door knowledge itself (`knownDoors`) is
  never mutated (R3); reopening the door re-offers the neighbour with no
  re-observation.
- A personally visited room is added unconditionally (AC-2), so it outlives any
  door state. This is deliberate and is the one place where the offer is not
  strictly "routable this cycle" — see the R5 tension below.
- No port wired → door-derived rooms are added as before.
- `getUnexploredAreas` / `doorAdjacentRooms` are untouched: they describe
  knowledge ("known but not crossed"), not an offer.

### R2 — stale anchors corrected, never offered

- New private `reconcileObservedAnchors(agentId, mem)` runs before anchors are
  folded in. For each `observedObjects` entry:
  - object missing from `smartObjectRegistry` → **prune** (false memory);
  - object present in a different room → **re-point** at `object.roomId`
    (so `navigateToArea` routes to where the object actually is);
  - otherwise keep.
  - Insertion order is preserved; the write is a single `updateState` only when
    something actually changed, so repeated `getKnownAreas` calls are
    idempotent and do not churn state each tick.
- `getVisibleObjectsInRoom` continues to refresh anchors for live objects, so a
  pruned anchor re-appears only if the object is genuinely observed again.

### AC-6 guard

`packages/engine/tests/spec-065-reachable-area-offers.test.ts` helper
`expectEnumNavigationAgreement` builds the enum and asks the **same cycle's
navigation** for every offered area. Every offered area must be routable, or be
knowledge the spec exempts (a visited room, AC-2; a live object anchor, R1). A
second test drives the guard against a port-less provider (the pre-065
projection) and asserts it **throws** — so the guard is demonstrably not
vacuous.

## Red-first evidence

Final test file run against pre-change `main` (engine `src` stashed):

```
Test Files  1 failed (1)
     Tests  9 failed | 5 passed (14)
```

Failing for the stated reasons (not missing-method crashes for the projection
tests): door-only neighbour still offered while `knownDoors` present; removed
anchor still offered and still in memory; relocated anchor not re-pointed;
`canReachArea`/the 5-arg constructor not yet wired (the port-wiring tests); the
enum/navigation guard catching the re-admitted stale area; the assembled enum
not following `setConnectionOpen`. The port-wiring tests use an optional call /
extra positional arg precisely so the file remains runnable on `main` and the
projection tests fail behaviourally. After the change: **14 passed (14)**.

## Verification (exact)

Run per package from the package directory (root-relative vitest is known to
break a cognition dynamic import):

| package    | result                                       | baseline                  |
| ---------- | -------------------------------------------- | ------------------------- |
| shared     | 399 passed / 34 files                        | 399                       |
| memory     | 101 passed + 24 todo / 13 files              | 101                       |
| visualizer | 125 passed / 17 files                        | 125                       |
| engine     | 936 passed + 141 todo / 76 files             | 922 + 141 todo / 75 files |
| cognition  | 1252 passed + 1 skipped + 26 todo / 81 files | 1252                      |
| assembly   | 89 passed / 11 files                         | 89                        |
| examples   | 253 passed + 3 todo / 23 files               | 253                       |
| cli        | 119 passed / 14 files                        | 115 (stale — see below)   |

- `pnpm build` clean; `pnpm typecheck` clean (tests excluded); `pnpm lint`
  clean; `npx prettier --check` clean on every touched file.
- **cli baseline note:** the charter's listed baseline (115) was measured
  before commit `cfe3945` ("spec 066 leg 4") added
  `packages/cli/tests/spec-066-ledger-qa.test.ts` with exactly 4 tests. On this
  branch's merge base `b3e9590` the true count is 119; nothing in this leg
  touches `cli`. Flagging the mismatch rather than silently reporting it.
- engine delta is exactly the 14 new spec-065 tests (922 → 936).

## Honest limitations / deviations

1. **R5 vs AC-2 tension (spec wording, not code).** R5 says "a test MUST fail
   if the enum contains an area for which navigation returns `'no-route'`".
   AC-2 says "a visited room stays offered even with the door closed". In a
   two-room world a closed door makes a visited room unroutable, so those two
   statements are mutually exclusive if R5 is read over the whole enum. I
   implemented the ACs as resolved in R1's narrowing clause — the reachability
   filter applies to **door-only** areas, with visited rooms exempt — and
   scoped the guard to non-exempt knowledge. A broad "every enum value is
   routable" guard would fail on the AC-2 fixture by design.
2. **Live anchors are not route-filtered.** R1 says current object anchors stay
   offered "exactly as today"; only door-derived rooms are gated. A live anchor
   whose room sits behind a closed door is therefore still offered while
   navigation reports `'no-route'` for it. This is the literal spec, but it is a
   residual instance of the same defect class; a future slice may want anchors
   gated too (or may decide anchors are knowledge like visited rooms).
3. **`spec-039-spatial-phase2.test.ts` fixture correction.** The talk_to
   transfer test ("the listener's targetArea enum picks up the transferred area
   automatically") builds a provider over an **empty** `SmartObjectRegistryImpl`
   yet expects the `workbench-1` anchor to be offered. Under R2 that anchor is
   false memory (the object does not exist), so the test would fail. I
   registered the workbench in that fixture — the world must contain the object
   for the anchor to be true. The test's own assertion (transfer lifts the fog
   and the anchor is targetable) is unchanged; only the fixture became a
   truthful world. This is a deliberate touch of an existing spec-039 test and
   is called out for review.
4. **`PerceptionDataProviderOptions.reachability` is documentation-only** while
   the constructor stays positional for back-compat (the seam wires via
   `setReachabilityPort`). If the provider is ever refactored to an options
   object, the field becomes live.
5. No live-sim validation was run (dispatcher-owned); no `dist` committed.

## Reviewer notes

- Check that `openRoute` is the only `grid.route` call inside `navigation.ts`
  (`grep` it) — that is the R4 "one decision" evidence.
- The guard test's exemption set is the honest encoding of AC-2; if the spec is
  ever amended to drop the visited-room exemption, tighten
  `expectEnumNavigationAgreement` accordingly.
- R2 writes to `spatialMemory` from a method that used to be a pure read. It
  only writes when a correction is needed, but any new caller that treats
  `getKnownAreas` as side-effect-free should be aware.
