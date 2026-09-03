# Design Decisions — Feature 105: Visualizer State Text Overflow (Spec 029)

## Decision 1: Fix in the renderer, not the data layer
**Why**: `CanvasRenderer.drawObjects()` stringifies object state for display with raw
`String(val)` interpolation. The float error (e.g. 95.666666674) originates in engine
state-rule/drive-decay arithmetic and is expected and harmless there. Rounding in the
adapter/engine/shared types would corrupt simulation state for every consumer; the
display concern belongs at the single rendering call site.

**Alternative considered**: Round in `VisualizerDataAdapter` snapshots. Rejected — the
adapter is also a data boundary; mutating numbers there would leak display formatting
into anything else that consumes snapshots.

## Decision 2: At most 2 decimals, trailing zeros trimmed (not blind toFixed(2))
**Why**: `toFixed(2)` would render `5` as `5.00` and `95.5` as `95.50`, adding churn to
every existing scene and widening text for no information gain. Format rule:
round to 2 decimals, strip trailing zeros and a trailing dot → `95.67`, `95.5`, `5`.
Strings/booleans pass through untouched (never overflowed; coercion could mangle IDs).

## Decision 3: Clip with ctx.measureText, not a character count
**Why**: The existing `obj.name.slice(0, 8)` truncation is font-dependent and already
imprecise. The renderer has a real CanvasRenderingContext2D in production and a
MockContext in tests, so `measureText()` is available and deterministically testable.
Shrink the state line character-by-character with a single trailing `…` until measured
width ≤ 56px (60px chip minus padding). Testable by giving MockContext a linear
width model (text.length * 5px).

**Scope note**: Chip size (60×30), grid layout, and the name `slice(0, 8)` behavior are
unchanged — widening chips or reflowing the grid is explicitly out of scope (issue asks
for rounding + truncation, not layout work).

## Decision 4: Test strategy — extend the existing MockContext harness
**Why**: `canvas-renderer.test.ts` records every draw call, so ACs assert on recorded
`fillText` arguments: rounded decimals (AC-1..3), passthrough (AC-4), data immutability
(AC-5), ellipsis only when over width (AC-6/7), and measureText-driven truncation
(AC-8). No browser canvas or new dependency needed (spec 023 constraint: Canvas 2D only).
