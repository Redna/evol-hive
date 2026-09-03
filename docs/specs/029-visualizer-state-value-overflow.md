# Feature: Visualizer State Value Overflow — Round Numeric Values & Truncate Label Text

## Context
- Architecture: [§2 — System Overview](../architecture/02-system-overview.md) (package boundaries — visualizer is a leaf package consuming `VisualizerState` snapshots), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (object `state` is `Record<string, unknown>` — values arrive with full float precision), [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (SmartObject deep state, e.g. `water_supply`, `bloom_count`)
- Related specs: [023 — Visual Output Canvas Renderer](023-visual-output-canvas-renderer.md) (CanvasRenderer, object chips: 60×30 box, 10px font — this spec amends its Req 12 rendering rules)
- Package: `@evol-hive/visualizer` only
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#105](https://github.com/Redna/evol-hive/issues/105)

## Problem

In the coffee-shop scene, object state values render with full floating-point precision and overflow their label boxes. `CanvasRenderer.drawObjects()` interpolates state values directly into the label string (`${key}: ${val}`), so a drive-decayed value like `95.666666674` renders as an unbroken digit run (`95.666666674`) that spills outside the 60×30 px object chip. Two independent defects compound:

1. **No numeric formatting** — numeric state values are rendered with `String(val)` precision; engine-computed floats (drive decay, gradual state updates) almost always carry long decimal expansions.
2. **No width constraint** — text is drawn without measuring; neither the state line nor any safeguard truncates to the object box width, so even a *correctly rounded* value (e.g. `water_supply: 1e+21` or a long key) can overflow.

## Design Rationale

**1. Format in the renderer (presentation layer), not in the data snapshot.** The `VisualizerDataAdapter` (spec 023) intentionally produces lossless snapshots — the engine's state is the source of truth and must not be rounded at the data layer (a downstream consumer or future overlay may want full precision; rounding there would also silently corrupt simulation introspection). Rounding is a *display* concern and belongs in `CanvasRenderer.drawObjects()`. This keeps `@evol-hive/shared` and `@evol-hive/engine` untouched, consistent with ADR-0001's dependency direction.

**2. Two decimal places, trailing zeros stripped (upper bound of the issue's "1–2" range).** `formatStateValue()` rounds numerics to 2 decimals and strips trailing zeros: `95.666666674 → "95.67"`, `95.5 → "95.5"`, `5 → "5"` (never `"5.00"` or `"5.0"`). Two decimals preserve meaningful differentiation for slowly-changing values (e.g. `bloom_count: 0.25`) that one decimal would flatten to `0.3`; stripping avoids the visual noise of `5.00` for integer-valued state, which is the common case for count-like keys. Booleans, strings, `null`, and other non-numbers pass through unchanged (`String(val)`).

**3. Character-wise truncation with an ellipsis, driven by `measureText()` — not a fixed character slice.** The existing `obj.name.slice(0, 8)` works only because the font is fixed at `10px sans-serif`, and even then it is fragile. The correct mechanism per the issue is *measure, then fit*: draw `key: value` with `ctx.measureText().width`, and if it exceeds the usable box width, remove characters from the end of the string until the string plus an appended `…` fits; if even one character plus `…` does not fit, render `…` alone (the box is 60 px wide with 2 px padding → 56 px usable). Character-wise removal with measurement beats `slice(0, N)` because glyph widths vary and the ellipsis consumes width.

**4. Truncate the composed state line, preserving the key when possible.** The truncation operates on the full `${key}: ${value}` string (never on the value alone), so the key remains visible — `water_supply: 95.67` degrades gracefully to `water_sup…` in the worst case. The object *name* line keeps its existing `slice(0, 8)` behavior; changing it is out of scope for this bug fix.

**5. `MockContext` in tests gains `measureText`.** The existing mock (`packages/visualizer/tests/canvas-renderer.test.ts`) implements only the methods the renderer currently uses and throws on unexpected usage — adding `measureText` to the renderer requires adding it to the mock (with a deterministic monospace-ish width function, e.g. `text.length * 6`) so tests can assert truncation deterministically.

## Requirements

### Visualizer Layer (`@evol-hive/visualizer`)

1. **`formatStateValue` helper** — A pure, exported function (module-level in `packages/visualizer/src/renderer/canvas-renderer.ts`, or a small `format.ts` sibling) `formatStateValue(value: unknown): string`. For `number` values it returns the value rounded to at most 2 decimal places with trailing zeros stripped (no scientific notation for finite numbers in the engine's expected ranges); `NaN`/`Infinity` render as `"NaN"`/`"∞"`/`"-∞"` (never a digit run). For non-numeric values it returns `String(value)` unchanged. The function must not mutate its input and must not depend on canvas APIs (unit-testable in isolation).

2. **Rounding applied in `drawObjects`** — `CanvasRenderer.drawObjects()` must format every state value through `formatStateValue()` before interpolation into the state label. No raw float is ever passed to `fillText`. Non-first state entries (currently only the first key/value pair is drawn) are unaffected; this spec does not change which entry is drawn.

3. **Width-bounded state text** — Before `fillText`, the renderer must measure the composed state line `${key}: ${formattedValue}` with `ctx.measureText(line).width` against the usable width of the object chip (box width 60 px minus 2×2 px padding = **56 px**, expressed as a constant, e.g. `OBJECT_BOX_W - 2 * OBJECT_TEXT_PAD`). If the line fits, draw it verbatim; if not, truncate per Req 4. The drawn text must never extend beyond the chip's horizontal extent.

4. **Ellipsis truncation** — When the state line exceeds the usable width, the renderer removes characters from the end of the line one at a time, re-measuring after each removal, until `line + "…"` fits within the usable width, and draws that string. If even a single remaining character plus `"…"` exceeds the usable width, it draws `"…"` alone. The truncation must terminate (no infinite loop for pathological zero-width measure results) and must not throw.

5. **Snapshot immutability** — Formatting and truncation are render-time operations on local copies of the label string. `VisualizerState`, its rooms/objects, and `obj.state` must not be mutated by the renderer (verified by deep-equality assertion in tests).

## Acceptance Criteria

- [ ] **AC-1**: `formatStateValue(95.666666674) === "95.67"`, `formatStateValue(5) === "5"`, `formatStateValue(95.5) === "95.5"`, `formatStateValue(0.25) === "0.25"`, `formatStateValue(-3.004999) === "-3"` (2-decimal rounding, trailing-zero stripping). *(Req 1)*
- [ ] **AC-2**: `formatStateValue` passes non-numbers through: `formatStateValue(true) === "true"`, `formatStateValue("milk") === "milk"`, `formatStateValue(null) === "null"`. *(Req 1)*
- [ ] **AC-3**: Rendering a room whose object state is `{ water_supply: 95.666666674 }` produces a `fillText` call whose text argument is exactly `water_supply: 95.67` — no `fillText` call in the object layer contains a numeric literal with more than 2 decimal places. *(Req 2)*
- [ ] **AC-4**: With a mock `measureText` returning `text.length * 6`, a state line of `"water_supply: 95.67"` (19 chars ≈ 114 px > 56 px usable) is drawn as a string whose measured width is ≤ 56 px and which ends with `…` (e.g. `water_su…`). The rendered line is never longer than the untruncated line. *(Req 3, 4)*
- [ ] **AC-5**: With a mock `measureText` returning `Infinity` (pathological), the renderer draws `"…"` and does not hang or throw. *(Req 4)*
- [ ] **AC-6**: A short state line that fits (e.g. `{ level: 5 }` → `level: 5`, 8 chars ≈ 48 px ≤ 56 px) is drawn verbatim with no `…`. *(Req 3)*
- [ ] **AC-7**: After `render(state)`, the input `VisualizerState` deep-equals a snapshot taken before the call (no mutation of `state`, `rooms[].objects[].state`). *(Req 5)*
- [ ] **AC-8**: Manual verification: run `npx tsx examples/visualizer-demo.ts`, open http://localhost:3000, switch to the coffee-shop scene, and confirm the Sink (`water_supply`) and Flower B (`bloom_count`) chips show values of at most 2 decimals fully contained within their chips. *(Req 2, 3)*
- [ ] **AC-9**: Unit tests for AC-1–AC-7 exist in `packages/visualizer/tests/canvas-renderer.test.ts` (new `MockContext.measureText`) and pass via `pnpm test --filter @evol-hive/visualizer`. *(Req 1–5)*

## Constraints
- **Package boundaries:** Only `packages/visualizer` (`src/renderer/` + `tests/`) may be modified. `shared`, `engine`, `memory`, `cognition`, and `examples` are untouched — the fix is display-only and the `VisualizerState` schema does not change.
- **No new dependencies:** Canvas 2D API only (`fillText`, `measureText`); per spec 023 the visualizer has zero external deps.
- **Performance:** `render()` runs every frame at up to 30 fps over all objects; the truncation loop re-measures per removed character, which is bounded by string length (< 40 chars here) — acceptable, but do not allocate per-frame helper arrays beyond what's needed.
- **Patterns to follow:** Keep the renderer stateless (spec 023); pure helpers exported for direct unit testing (mirrors the project's testability conventions); strict TS (`noUncheckedIndexedAccess`) — guard `line[i]` access in the truncation loop.
- **What NOT to do:** Do not round values in `VisualizerDataAdapter` or `shared` (data layer stays lossless — Design Rationale 1). Do not switch to `toFixed` alone (leaves `5.00` noise and does not fix overflow). Do not change the object chip geometry (60×30) or the name-line `slice(0, 8)` behavior. Do not add `measureText`-based truncation to other layers (agent names, room labels) in this fix — scope is the object state line per issue #105.
