# Feature: Visualizer World View (1/2) — Topology-Aware Layout, Real Doors, Legible Entities, Interpolated Motion

## Context

- Architecture: [§2 — System Overview (visualizer transport)](../architecture/02-system-overview.md), [§3 — Agent State Schema (`position`, `spatialMemory`)](../architecture/03-agent-state-schema.md), [§4 — Smart Objects (affordances, `doorway` objects)](../architecture/04-smart-objects.md), [§6 — PPER Loop (`pperPhase`)](../architecture/06-pper-loop.md)
- Related specs: [023 — Canvas 2D Visualizer](023-visual-output-canvas-renderer.md) (the browser contract: single inline HTML), [042 — Visualizer Single Renderer](042-visualizer-single-renderer.md) (the "drawing only in `canvas-renderer.ts`" invariant this spec amends), [038 — Spatial Navigation & Fog of War](038-spatial-navigation-fog-of-war.md) (grid cells, `position`), [039 — Spatial Phase 2 (cell-level fog, anchor cells, out-of-fog hiding)](039-spatial-phase2-targetarea-fog.md), [033 — Conversation Chips](033-conversations-identity-evolution.md) (`conversation.sentimentTint`), [029 — State-Line Rounding/Truncation](029-visualizer-state-text-overflow.md), [027 — Real-LLM Visualizer Demo](027-real-llm-visualizer-demo.md) (the launch path used for live verification)
- Package: `visualizer` (renderer, client glue, served page). `shared` and `engine` are **untouched** (Decision 5).
- Issue: [#231](https://github.com/Redna/evol-hive/issues/231)
- Blocks: [#232](https://github.com/Redna/evol-hive/issues/232) (spec 063 — mobile shell: follow-camera + installable PWA)
- Status: 📝 Drafted

## Problem Summary

The visualizer is the only window onto a live sim, and the window is broken in ways that read as "ugly" but are actually defects. A throwaway prototype (`examples/visualizer-prototype/`, run with `npx tsx examples/visualizer-prototype/serve.mts`) was built first and each claim below was reproduced against the real code:

| # | Symptom | Root cause (verified in code) |
| - | ------- | ----------------------------- |
| P1 | A "giant X" of lines crosses the canvas | `CanvasRenderer.layoutRooms` places rooms in **array insertion order** (`i % cols`), ignoring `room.connections`, so coffee-shop's `kitchen↔garden` and `living_room↔bathroom` land on diagonals; doors are then stroked **centre-to-centre** across the whole canvas |
| P2 | Layout is stale/wrong after a resize or rotation | `client/main.ts` updates `canvas.width/height` on `resize`, but `CanvasRenderer` caches `canvasWidth/canvasHeight` **in its constructor** and never re-reads them |
| P3 | Blurry on every phone | `canvas.width = window.innerWidth` ignores `devicePixelRatio`; the backing store is CSS-pixel sized and upscaled |
| P4 | Overflow on a 360px-wide screen | `Math.max(cellW - 20, 200)` room minimums plus a fixed `sqrt` column count |
| P5 | "Doorway" chips clutter every room | `SceneDefinition` auto-generates a `doorway` smart object per connected room (spec 022 loader); the renderer draws **every** object as a 60×30 chip, so doors render as furniture |
| P6 | Illegible text; no hierarchy | 10px labels, 4px drive bars, 9px thought bubbles, emoji in canvas, flat navy-on-navy (`#16213e` on `#1a1a2e`) |
| P7 | Agents teleport between cells | Snapshots arrive at 10 FPS; the renderer is stateless and draws each frame's absolute cell with no interpolation |
| P8 | HUD fights the world | Controls are `position: fixed; top: 8px` at 13px, with no `env(safe-area-inset-*)` and sub-44px tap targets; the status overlay collides on narrow widths |

All eight were fixed and verified at 1280×720, 390×844 and 360×640 in the prototype. This spec ports those fixes into the package, behind a **pure layout seam** so the geometry is testable as data rather than canvas call-recording. What the prototype did *not* establish (camera, PWA) is spec 063.

## Requirements

### R1 — One pure layout seam (`visualizer`)

Add `layoutWorld(state: VisualizerState, viewport: Viewport): WorldLayout` — **pure and synchronous**: no canvas, no DOM, no clock, no I/O. Equal inputs yield deep-equal outputs. Prototype-derived shape (trim to the decision-rich part):

```ts
interface ViewportInsets { top: number; right: number; bottom: number; left: number }
interface Viewport { width: number; height: number; insets: ViewportInsets }

type DoorLayout =
  | { kind: 'opening'; fromRoom: string; toRoom: string; rect: Rect; axis: 'h' | 'v' }
  | { kind: 'corridor'; fromRoom: string; toRoom: string; points: Point[] };

interface WorldLayout {
  columns: number;
  rows: number;
  rooms: RoomLayout[];    // roomId, rect, col, row
  doors: DoorLayout[];
  objects: EntityLayout[]; // id, roomId, x, y  — doorways excluded (R3)
  agents: EntityLayout[];  // agentId, roomId, x, y — from state.position
}
```

- **Column choice is topology-scored.** For each candidate column count compute the room placement, score it by how many `connections` land on **edge-adjacent** cells, and prefer the highest score; break ties by the larger room size. Placement itself walks the connection graph breadth-first from the highest-degree room into free adjacent cells (deterministic tie-break: neighbour order, then first free cell row-major).
- **Rooms fit the viewport by construction.** A room never exceeds the cell the viewport allows (the prototype's asymmetric clamp made desktop rooms overflow — do not repeat it). Rooms may be modestly taller than wide, but never outside `[1/1.4, 1.4]` aspect.
- **Doors are geometry, not centre-to-centre lines.** An edge-adjacent connection becomes an `'opening'` centred on the shared wall with a floor bridge across the gutter; a non-adjacent connection becomes a `'corridor'` polyline routed through the empty gutters. **No door geometry may intersect a room interior.**
- **Fog cell rects are derived here too** (R6), so fog shading is assertable as data.

### R2 — Motion is a separate pure function, not part of layout (`visualizer` client/renderer)

- Add a pure frame-rate-independent smoother, e.g. `smoothTowards(current, target, dtSeconds, halfLifeSeconds)`, and apply it to agents' projected screen positions between snapshots.
- Layout remains a pure function of the **current** state; the smoother owns the time dimension. A single snapshot (no history) renders exactly at its projected position — never a jump to a default.
- Interpolation is **client-side only**: the WebSocket payload and the snapshot rate are unchanged (no new `velocity` field, no server tick change).

### R3 — Doorway objects become doors, not chips (`visualizer`)

- Objects with `type === 'doorway'` are **excluded** from the object-chip layer.
- Where a room carries doorway objects, their `affordances` (`go_to_<roomId>`) are the authoritative door list; otherwise doors are derived from `room.connections`. The two must agree for the current scenes (a mismatch is asserted, not silently ignored).

### R4 — A skin seam so sprites can drop in later (`visualizer`)

- Introduce a `Skin` interface dispatching entity drawing (`room`, `object`, `agent`, `door`) with a default canvas implementation. **No assets are added in this spec**; the canvas primitives are the default skin.
- **Layout is skin-independent**: `layoutWorld` output must be deep-equal regardless of which skin renders it.

### R5 — Legible, hierarchical rendering (`visualizer`)

- A single theme-token object owns the palette (rooms, floors, borders, doors, text, fog, per-agent identity colours, PPER phase colours, drive colours). No colour literals scattered through draw calls.
- Agents: identity colour + gradient avatar, PPER phase arc, name pill, five drive bars. Objects: type glyph + primary state value, text **measured and truncated to the chip** (no overflow). Rooms: header band, name, subtle inner grid.
- All text scales with the viewport and has a legible minimum; the renderer never draws below it.

### R6 — Fog stays correct, looks soft (`visualizer`)

- Preserve spec-039 R8 semantics exactly: unexplored cells are shaded and out-of-fog agents/objects are **not drawn** for the fog viewer (`agent.fog.exploredCells`).
- The unexplored fill is softened (lower alpha / rounded per-cell) and a fog toggle is available in the HUD (a view, not a state change).

### R7 — Client shell fixes: DPR, resize, measured insets (`visualizer`)

- The canvas backing store is sized `cssPixels × devicePixelRatio` (clamped, e.g. ≤ 3) with `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`.
- Layout is recomputed from the **current** viewport every frame (or on resize), never cached at construction. The renderer's constructor no longer captures dimensions as authoritative.
- HUD insets are **measured from the DOM** (`getBoundingClientRect` of the top status and bottom control sheet) and passed into `layoutWorld` as `viewport.insets`, so the world never hides behind the controls. Touch targets are ≥44px and respect `env(safe-area-inset-*)`.

### R8 — Regression discipline (`visualizer`)

- All existing visualizer tests pass; the spec-042 invariant test is updated per Decision 3 (drawing allowed under `src/renderer/**`, nowhere else).
- `shared`/`engine`/`memory` have **no source changes**. `pnpm build && pnpm typecheck && pnpm lint && pnpm test` pass.

## Acceptance Criteria

- [ ] **AC-1** (R1): for the coffee-shop fixture (4 unique connections), `layoutWorld` returns a 2×2 placement with **3 edge-adjacent** connections and **1 corridor** — the proven optimum, since `living_room` is connected to all three others while a 2×2 corner cell has only two neighbours. The corridor's polyline does not intersect any room rect. (The old insertion-order grid produced **two** diagonals — the "giant X".)
- [ ] **AC-2** (R1): for 360×640, 390×844 and 1280×720 viewports with measured insets, every room rect lies fully inside `viewport` and clear of `viewport.insets` — no room extends past the viewport edge or under the HUD.
- [ ] **AC-3** (R1, R3): no object with `type === 'doorway'` appears in `layout.objects`; every `room.connections` entry yields exactly one `DoorLayout`; where doorway objects exist their `go_to_*` affordances agree with `room.connections`.
- [ ] **AC-4** (R2): `smoothTowards` is unit-tested — monotonic approach to the target, frame-rate independent (equal elapsed time ⇒ equal result for different `dt` partitions), exact snap on first sight, and no overshoot.
- [ ] **AC-5** (R4): the renderer dispatches drawing to an injected `Skin` (a recording skin observes room/agent/status draws), and `layoutWorld` takes no skin parameter — layout is skin-independent by construction. The default `CanvasSkin` satisfies the `Skin` interface.
- [ ] **AC-6** (R5): agent, object and room labels are rendered at ≥ the declared legible minimum for the viewport; a long object name/state is truncated to fit its chip (asserted via the text-fitting function, not pixels).
- [ ] **AC-7** (R6): with a fog payload, an agent/object outside `exploredCells` is not drawn for the viewer and unexplored cells receive the softened fill; with no fog payload, everything renders (legacy parity).
- [ ] **AC-8** (R7): executing the **served page** in a sandbox with a mock canvas and a mock DOM shows (a) the backing store equals CSS size × DPR, (b) after a resize event the layout is recomputed for the new viewport (not the constructor-time size), and (c) insets measured from the DOM reach `layoutWorld`.
- [ ] **AC-9** (R8): the spec-042 invariant test is updated so drawing is permitted only under `src/renderer/**`; **all existing behavioural assertions still pass** (fog shading counts, out-of-fog hiding, conversation tint, drive bars, legacy-slot fallback, state-line formatting). Tests whose expectations encode the *replaced* layout or the old bundled formula strings (absolute legacy-slot coordinates in `legacy-slot-fallback.test.ts`, the formula greps in `visualizer-server-html.test.ts` / `client-bundle.test.ts` / `dist-bundle.e2e.test.ts`) are updated to assert the new seam; the layout-coupled integration assertions now derive their expected positions from `layoutWorld` rather than hardcoded old coordinates. `pnpm -r test && pnpm typecheck && pnpm lint` pass.
- [ ] **AC-10** (live, issue-owned): a live run on a **freshly built `dist`** (`pnpm build`, then `tsx examples/visualizer-demo.ts` or the prototype harness) opened at a phone viewport shows: no diagonal door X, doors as openings/corridors, no "Doorway" chips, agents gliding between cells, and the world clear of the HUD. Evidence (screenshots + viewport sizes) attached to [#231](https://github.com/Redna/evol-hive/issues/231).

## Constraints

- **Package boundary**: only `packages/visualizer` changes. `shared`/`engine`/`memory` are untouched (Decision 5). No new runtime dependency; `esbuild` stays a devDependency.
- **Browser contract (spec 023)**: still a single HTML response with inline CSS/JS and **no external script requests**. (Spec 063 amends this for explicitly-linked PWA resources.)
- **Determinism**: `layoutWorld` and `smoothTowards` are pure; no clock, I/O or env reads inside them; placement tie-breaks are total orders so the same scene always lays out the same way.
- **Grid semantics are inherited, not re-derived**: agent cell projection keeps the `(position.x + 0.5) / 12`, `(position.y + 0.5) / 8` cell-to-room mapping (spec 038); object anchors keep `obj.cell` (spec 038).
- **No minification** of the client bundle (spec 042 keeps parity greps readable and stack traces debuggable).
- **Performance**: the target is a smooth 60 FPS on a mid-range phone; per-frame work must stay O(rooms + objects + agents) with no per-frame layout of the full room graph beyond what the viewport change requires.
- **What NOT to do**:
  - Do **not** change the WebSocket payload, `VisualizerState`, or the snapshot rate.
  - Do **not** add sprite assets or an asset pipeline (the seam is prepared, art is out of scope).
  - Do **not** re-implement engine grid/pathfinding or move layout into the engine.
  - Do **not** regress spec-039 R8 fog semantics while "softening" the fog.
  - Do **not** reintroduce a hand-maintained second copy of drawing rules (the spec-042 bug); the skin seam is the only extension point.
  - Do **not** edit `dist/` by hand — rebuild before any live verification (spec 037 Evidence).

## Design Decisions

**Decision 1 — Replace `canvas-renderer.ts`; do not ship a second renderer.** The spec-042 lesson is that two copies diverge and the untested one wins. The polished renderer *is* `canvas-renderer.ts` after this spec; the dense debug layout is not preserved.

**Decision 2 — A pure `layoutWorld` seam is the primary test surface.** Canvas call-recording cannot express "the door does not cross the room" or "the grid is 2×2 with four adjacent edges" readably. Extracting layout as data makes every topology/door/inset/size AC a plain assertion, and keeps the drawing layer thin. All layout is computed from the current viewport per frame, which also fixes the stale-dimension bug by construction.

**Decision 3 — Split `src/renderer/**` and relax the spec-042 invariant test.** The agreed split: `renderer/layout.ts` (pure), `renderer/skin.ts` (skin contract + default canvas skin), `renderer/canvas-renderer.ts` (orchestration). The spec-042 test asserted drawing appears *only* in `canvas-renderer.ts`; it is updated to assert drawing appears **only under `src/renderer/`**, preserving the anti-duplication intent while allowing the split.

**Decision 4 — A skin seam now, sprites later.** Entity drawing is dispatched through a `Skin`, with a canvas-primitives default. No art is added; when sprites exist they are a new skin, and layout is untouched because it is skin-independent (AC-5).

**Decision 5 — Renderer-only mapping, with a named hybrid trigger.** `VisualizerState` already carries topology (`room.connections`), object cells (`object.cell`), agent cells (`agent.position`) and fog (`agent.fog.exploredCells`), so no schema change is needed. The engine's `RoomGrid` additionally holds a per-room `doorCell` (and per-object anchors) that `VisualizerState` does **not** expose; if inference ever disagrees with engine routing, exposing `doorCell` is the follow-up change — it is not done speculatively here.

**Decision 6 — Promote doorway objects from chips to doors.** The scene loader deliberately auto-generates a `doorway` object per connected room with `go_to_<roomId>` affordances (spec 022). Those affordances are the engine's own door list and are used as such; the chip layer must not render them.

**Decision 7 — Interpolate on the client; leave the wire alone.** The snapshot rate (10 FPS) and payload are a spec-023 contract shared with tests. Glide is therefore a client-side smoother over consecutive snapshots; raising the push rate or adding velocity to the payload is rejected as a protocol change for a presentation problem.

## Out of Scope

- **Follow-camera and installable PWA** — spec 063 ([#232](https://github.com/Redna/evol-hive/issues/232)).
- **Sprite assets / art pipeline** — the seam is prepared, no assets land.
- **Exposing `RoomGrid.doorCell` / per-connection door cells in `VisualizerState`** — only if layout inference drifts from routing (Decision 5).
- **Engine-side changes** to grid, fog, pathfinding or the snapshot payload.
- **Pan/zoom camera beyond follow** — spec 063 owns camera interaction.

## Notes

- **Prototype**: `examples/visualizer-prototype/index.html` + `serve.mts` (a spike, deliberately outside `packages/visualizer/src` so the spec-042 invariant test was not broken). Synthetic world by default; `--live` attaches to the real sim. It is the reference for the look and for the layout algorithms, not a merge candidate.
- **Measured evidence** (prototype, iPhone-class 390×844): 2×2 topology-scored placement, 3/4 connections edge-adjacent with the fourth routed through the gutter; no room outside the viewport at 1280×720 / 390×844 / 360×640; object text clipped to its chip. Before the fix the same code produced a 1-column strip on portrait and desktop overflow.
- **Live ACs** (AC-10) are issue-owned and run outside the implementation PR, on a freshly built `dist`.
- Verification commands: `pnpm --filter @evol-hive/visualizer test`, then `pnpm -r test && pnpm typecheck && pnpm lint`.
- **Amended by [066](066-visualizer-live-observation-defects.md) (R2/R3, leg 3 — merged).** This spec's R2 named a fixed half-life smoother (`smoothTowards(current, target, dtSeconds, halfLifeSeconds)`) and applied it to agent screen positions between snapshots. A live phone run showed that a fixed half-life cannot bridge the delta a snapshot actually delivers: the engine steps ~1 cell/tick at ~60 ticks/s while snapshots arrive every 100 ms, so at 1× the client was already ~6 cells behind and at 5× ~30, and the glide cut corners and read as a teleport (spec 066, D3). Agent motion now uses a pure **interval-paced** `motionTowards(from, to, elapsedSeconds, intervalSeconds)`, and the client paces each delta by the *measured* snapshot interval. `smoothTowards` remains, but only for the camera pan (spec 063 R3). The R2 half-life formula is **not** rewritten here — it is amended in place so the ledger carries the correction, not a silent contradiction.
