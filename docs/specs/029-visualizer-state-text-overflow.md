# Feature: Visualizer Object State Text — Round Decimals and Truncate Overflow (Spec 029)

## Context
- Architecture: [§2 — System Overview](../architecture/02-system-overview.md) (visualizer as presentation-only package reading engine state via the `VisualizerDataAdapter`), [§4 — Smart Objects](../architecture/04-smart-objects.md) (object `state` maps carry numeric counters like `water_supply`, `bloom_count` mutated by affordance state rules)
- Related specs: [023 — Visual Output Canvas Renderer](023-visual-output-canvas-renderer.md) (`CanvasRenderer.drawObjects()` — 60×30px object chips, `10px sans-serif` text, `MockContext` test harness)
- Package: `@evol-hive/visualizer` only (`packages/visualizer`). No changes to `@evol-hive/shared`, `@evol-hive/engine`, `@evol-hive/cognition`, `@evol-hive/memory`, or `examples/`.
- Issue: [#105](https://github.com/Redna/evol-hive/issues/105)

## Problem

In the coffee-shop scene, object state values render with full floating-point precision and overflow their label boxes. In `CanvasRenderer.drawObjects()` (`packages/visualizer/src/renderer/canvas-renderer.ts`, spec 023), the first `{key}: {value}` pair of each object's state map is drawn with `ctx.fillText(\`${key}: ${val}\`, ...)`:

1. **No numeric rounding** — a value like `95.666666674` (produced by repeated drive-decay / state-rule arithmetic) is stringified raw, rendering as `95.666666674` (or, without the decimal point visible in a narrow font, a digit soup like `5666666674`).
2. **No width constraint** — the object chip is 60px wide with 2px left padding, so any text wider than ~56px spills outside the chip and over neighboring chips.

## Design Rationale

**1. Formatting is a display concern; do not touch the data.** Object state values in the engine are `number`s mutated by affordance state rules (spec 022) and drive decay — accumulating float error is expected and harmless there. Rounding at the data layer (adapter, engine, or shared types) would corrupt simulation state and ripple through every consumer. The fix belongs in the renderer, at the single call site that stringifies object state for display.

**2. One formatting rule: round to at most 2 decimal places, trim trailing zeros.** `95.666666674 → "95.67"`, `95.5 → "95.5"`, `5 → "5"`, `0.125 → "0.13"` (banker's-precision is unnecessary for a label; standard `toFixed`-style rounding is fine and predictable). Integers and already-short values render unchanged, so no churn on existing scenes. Non-numeric values (strings, booleans) pass through untouched — they never had the overflow problem, and coercing them could mangle IDs or labels.

**3. Width enforcement via `measureText`, not character counting.** Character-count truncation (like the existing `obj.name.slice(0, 8)`) is font- and DPI-dependent and already fails for wide glyphs. The renderer already receives a real `CanvasRenderingContext2D` in production and a `MockContext` in tests, so `ctx.measureText()` is available and testable. The state line is shrunk character-by-character with a single trailing ellipsis until it fits the 56px usable width. This is deterministic, unit-testable via a mock `measureText`, and matches canvas conventions.

**4. Keep the change minimal.** The object-name truncation (`slice(0, 8)`) and chip layout stay as they are; this spec only changes how the state line is formatted and clipped. A unified "fitText" helper extracted for the state line may optionally be reused by the name, but renaming/altering existing name behavior is out of scope.

## Requirements

### Numeric Formatting (`packages/visualizer`)

1. **Round numeric state values** — In `drawObjects()`, when a state value is a `number`, it must be rendered with at most 2 decimal places and trailing zeros trimmed: `95.666666674 → "95.67"`, `95.5 → "95.5"`, `5 → "5"`. The rounding must apply to the displayed string only; the underlying `obj.state` value must not be mutated.
2. **Pass through non-numeric values** — State values that are strings or booleans must be rendered exactly as before (raw `String(value)` interpolation), with no rounding applied.

### Overflow Protection (`packages/visualizer`)

3. **Fit state text to the object chip** — The composed state line (`${key}: ${formattedValue}`) must be clipped to the usable width of the object chip (60px box minus 2px left padding and ~2px right margin → 56px): if `ctx.measureText(text).width` exceeds the usable width, the renderer must drop trailing characters and append a single ellipsis (`…`) so the final measured width is within the usable width. A text that already fits must be rendered unmodified, with no ellipsis.
4. **Use `measureText`, not fixed character counts** — The clipping decision must be based on `ctx.measureText(...).width` under the currently set font (`10px sans-serif`), so it adapts to the font actually in effect. No hardcoded maximum character count may replace the measurement.

### Non-Regression

5. **No behavioral change outside the state line** — Room, agent, drive-bar, relationship, and status rendering, object chip positions and sizes, and object-name truncation must remain unchanged. All existing `packages/visualizer` tests pass without modification to their assertions.

## Acceptance Criteria

- [ ] **AC-1 (Req 1)** — Rendering a state value of `95.666666674` records a `fillText` call whose text argument is `water_supply: 95.67` (no long decimal tail; matches `/^water_supply: 95\.6\d?$/` exactly as `95.67`).
- [ ] **AC-2 (Req 1)** — Rendering state value `5` (integer) records `bloom_count: 5` — no `.0`/`.00` suffix, no trailing zeros.
- [ ] **AC-3 (Req 1)** — Rendering state value `95.5` records `water_supply: 95.5` — one decimal place preserved, not padded to two.
- [ ] **AC-4 (Req 2)** — Rendering string state value `"blooming"` and boolean value `true` records the raw strings `"status: blooming"` / `"open: true"` verbatim.
- [ ] **AC-5 (Req 1)** — After `render(state)`, the source `obj.state` object in the caller's `VisualizerState` still holds the original full-precision number (`95.666666674`), proving display-only rounding.
- [ ] **AC-6 (Req 3)** — With a mock `measureText` returning `text.length * 5` px, a state line that would exceed 56px is rendered with a trailing `…` and its rendered text's measured width is ≤ 56px.
- [ ] **AC-7 (Req 3)** — With the same mock, a state line measuring ≤ 56px is rendered verbatim with no `…`.
- [ ] **AC-8 (Req 4)** — The renderer calls `ctx.measureText` under the `10px sans-serif` font for the state line; changing the mock's measure function changes the truncation point (no fixed char count).
- [ ] **AC-9 (Req 5)** — The full existing `packages/visualizer` test suite (`canvas-renderer.test.ts`, `visualizer-server.test.ts`) passes unmodified; `drawObjects` still draws 60×30 chips at the same grid positions.

## Constraints
- Package boundaries — only `packages/visualizer` may be modified. Do not change `VisualizerState` / `VisualizerAgent` types in `@evol-hive/shared`, the `VisualizerDataAdapter`, or any engine state-rule semantics.
- Performance — `measureText` runs once per object chip per frame (≤ dozens of calls per scene); the shrink loop is bounded by string length. No caching infrastructure is warranted.
- Patterns to follow — extend the existing `MockContext` in `packages/visualizer/tests/canvas-renderer.test.ts` (it already records every draw call; add a `measureText` that defaults to a linear width model and is overridable per test). Keep the renderer stateless and Canvas-2D-only (spec 023: "no external dependencies").
- What NOT to do — do not round in `VisualizerDataAdapter`, engine state rules, or scene YAML values; do not introduce a text-layout/emoji dependency; do not widen the object chips or change the 3-per-row grid to "solve" the overflow; do not apply fixed-width `toFixed(2)` blindly (it would render integers as `5.00` and pad `95.5` to `95.50`).
