# Feature: Visualizer State Label Overflow Fix — Round Numeric State Values & Truncate Overflowing Text

## Context
- Architecture: [§2 — System Overview](../architecture/02-system-overview.md) (package boundaries — `@evol-hive/visualizer` is a standalone render layer), [§4 — Smart Objects](../architecture/04-smart-objects.md) (`SmartObject.state: Record<string, unknown>` — deep state such as `{ water_level, bean_count }` that the renderer displays)
- Related specs: [023 — Visual Output Canvas Renderer](023-visual-output-canvas-renderer.md) (defines `CanvasRenderer`, the object chip layout, and the object state text rendering this spec amends — **this spec amends the Req 12 layer-2 object drawing behavior**), [027 — Real-LLM Visualizer Demo](027-real-llm-visualizer-demo.md) (the demo where the bug is reproduced)
- Package: `@evol-hive/visualizer` only (`packages/visualizer/src/renderer/canvas-renderer.ts`, `packages/visualizer/src/server/visualizer-server.ts` embedded client script, `packages/visualizer/tests/`)
- Issue: [#105](https://github.com/Redna/evol-hive/issues/105)

## Problem Statement

In the coffee-shop scene, object state values render with full floating-point precision and overflow their label boxes. The object chip is a fixed 60×30 px rectangle, and the state text (`${key}: ${val}`) is drawn at 10 px sans-serif with **no numeric formatting and no width measurement**. Values like `95.666666674` (produced by repeated fractional decay/increment arithmetic on `water_supply` and `bloom_count`) render as `"5666666674"`-length strings that spill outside the chip, collide with neighboring chips in the 70 px horizontal grid, and become unreadable.

### Root Cause in Code

Both renderers concatenate the raw state value into the label string:

```typescript
// packages/visualizer/src/renderer/canvas-renderer.ts — drawObjects()
const [key, val] = stateEntries[0]!;
ctx.fillText(`${key}: ${val}`, ox + 2, oy + 16);   // ← raw float, unmeasured

// packages/visualizer/src/server/visualizer-server.ts — embedded client script
var e = Object.entries(obj.state)[0]; if (e) ctx.fillText(e[0] + ': ' + e[1], ox + 2, oy + 16);  // ← same bug
```

Note the bug exists in **two** places: the TypeScript `CanvasRenderer` module and the minified client-side copy of the renderer embedded as a template string in `visualizer-server.ts`. Fixing only one would leave the browser view broken (or vice versa).

## Requirements

### Value Formatting (`CanvasRenderer` + embedded client script)

1. **Numeric state values are rounded to at most 2 decimal places** — When the drawn state value is a finite `number`, the renderer must format it with `Number(value.toFixed(2))` semantics (round to 2 decimals, then strip trailing zeros): `95.666666674` → `"95.67"`, `5.0` → `"5"`, `0.125` → `"0.13"`, `-3.999` → `"-4"`. The formatted value replaces `String(val)` in the `fillText` argument. Non-finite numbers (`NaN`, `Infinity`) are rendered via `String(value)` (`"NaN"`, `"Infinity"`) — still compact.

2. **Non-numeric state values render unchanged** — String and boolean state values (`"brewing"`, `true`) pass through `String(val)` with no formatting applied. Only `typeof val === 'number'` triggers rounding.

3. **Object state is not mutated** — Formatting happens at render time only. The `VisualizerState` snapshot, `SmartObject.state`, and any object passed into `render()` must not be modified by the renderer (the renderer is documented as stateless and read-only — spec 023).

### Overflow Truncation

4. **State text is measured and truncated to fit the object chip** — Before drawing the state text, the renderer must measure it with `ctx.measureText(text).width` (with the 10 px sans-serif font set) and, when the width exceeds the usable chip width of 56 px (60 px box minus 2 px padding on each side), progressively remove characters from the end and append a single ellipsis character (`…`) until the rendered width fits or only the ellipsis remains. Example: `"water_supply: 95.67"` (wider than 56 px) → `"water_supply: …"` or similar prefix that fits.

5. **Truncation uses the ellipsis character, not hard clipping** — The truncated string must end in `…` (U+2026) whenever any characters were removed. The object name label (line 1 of the chip, already hard-sliced to 8 chars) is out of scope and unchanged.

### Dual-Renderer Consistency

6. **The embedded client script in `visualizer-server.ts` receives the same fix** — The minified client-side `CanvasRenderer` copy in the `EMBEDDED_RENDERER_JS` template string must implement identical formatting (Req 1–2) and truncation (Req 4–5) behavior, so the browser-rendered view matches the module-rendered output. The logic is small enough that duplication in the embedded script is acceptable (see Constraints); a comment must note the mirror requirement.

### Tests (`packages/visualizer/tests`)

7. **Mock context gains `measureText`** — The `MockContext` in `canvas-renderer.test.ts` must implement `measureText(text)` returning `{ width: text.length * N }` (a deterministic per-character width, e.g. `N = 6`, so 56 px ≈ 9.33 characters) so truncation is testable. The mock must keep rejecting unexpected method usage otherwise.

8. **Rendering tests for formatting and truncation** — New tests must assert: (a) a state value of `95.666666674` produces `fillText` text containing `"95.67"` and not `"5666666674"` or any long decimal run; (b) an integer value renders with no decimal point; (c) a string value renders unchanged; (d) a state label wider than the chip produces exactly one `fillText` ending in `…`; (e) a short label is drawn verbatim with no `…`.

## Acceptance Criteria

- [ ] AC-1: Given object state `{ water_supply: 95.666666674 }`, the rendered object state text contains `water_supply: 95.67` and contains no digit run longer than 2 decimal places. *(Maps to Req 1)*
- [ ] AC-2: Given object state `{ water_supply: 5.0 }`, the rendered text is `water_supply: 5` (no trailing `.00`). *(Maps to Req 1)*
- [ ] AC-3: Given object state `{ bloom_count: -3.999 }`, the rendered text contains `-4` (rounding, not truncation, of the decimal). *(Maps to Req 1)*
- [ ] AC-4: Given object state `{ mode: "brewing" }` or `{ active: true }`, the rendered text is `mode: brewing` / `active: true` — non-numeric values are not reformatted. *(Maps to Req 2)*
- [ ] AC-5: After `render(state)`, the input `VisualizerState` object is deep-equal to the snapshot passed in (renderer performs no mutation of `obj.state`). *(Maps to Req 3)*
- [ ] AC-6: Given a state label whose measured width exceeds 56 px, the drawn text ends with `…` and `ctx.measureText(drawnText).width <= 56` under the mock's width function. *(Maps to Req 4, 5)*
- [ ] AC-7: Given a state label that fits within 56 px, the drawn text contains no `…` character. *(Maps to Req 4, 5)*
- [ ] AC-8: The object chip geometry is unchanged: the state text is still drawn at the first state entry, at offset `(ox + 2, oy + 16)` within the 60×30 box. *(Maps to Req 4 — layout invariants preserved)*
- [ ] AC-9: The embedded client script in `visualizer-server.ts` contains the same numeric-rounding expression and ellipsis truncation logic as `canvas-renderer.ts` (verified by a test asserting the embedded script source includes both the rounding and `…` truncation markers). *(Maps to Req 6)*
- [ ] AC-10: `MockContext.measureText(text)` returns `{ width: text.length * 6 }` and all existing renderer tests pass unchanged in behavior (only the new `measureText` capability is added). *(Maps to Req 7)*
- [ ] AC-11: New tests cover: long-decimal rounding (AC-1/AC-2), integer rendering, string passthrough, ellipsis truncation of an over-wide label, and verbatim rendering of a fitting label. *(Maps to Req 8)*
- [ ] AC-12: Manual repro from the issue no longer reproduces: `npx tsx examples/visualizer-demo.ts` → coffee-shop scene → Sink (`water_supply`) and Flower B (`bloom_count`) state text stays inside its chip, showing at most 2 decimal places. *(Maps to Reqs 1, 4, 6 — end-to-end fix verification)*
- [ ] AC-13: All existing `packages/visualizer` tests pass with no regressions. *(Maps to Reqs 1–8 — backward compatibility)*

## Constraints

- **Package boundary**: Only `@evol-hive/visualizer` may be modified. No changes to `shared`, `engine`, `cognition`, or `memory`. In particular, `VisualizerState` / `SmartObject` types are unchanged — this is a pure view-layer fix.
- **Read-only renderer**: The renderer must not mutate the state snapshot (spec 023 documents `render()` as stateless). Formatting is applied to a local copy of the value/label, never written back.
- **Duplicated logic is accepted**: The client-side renderer lives as a template string inside `visualizer-server.ts` and cannot import from the module. Duplicating the ~15-line format/truncate logic there is preferable to introducing a build step that extracts shared client code. Add a `// keep in sync with canvas-renderer.ts` comment at both sites.
- **No dependency additions**: The fix uses only the Canvas 2D API (`measureText`, `fillText`). No new npm dependencies in the visualizer package.
- **Layout stability**: Do not change chip dimensions (60×30), the 70 px grid pitch, or the drive-bar/name-label layout. The fix is text-only; resizing chips is explicitly out of scope for this issue.
- **Performance**: `measureText` is called once per drawn object state label (≤ a few dozen per frame). Truncation loop is O(label length). No measurable frame-time impact at 60 fps.
- **Do NOT**: Round values inside the engine or scenes — `SmartObject.state` must keep full precision for game logic (drive decay, affordance conditions). Rounding is strictly a display concern.
- **Do NOT**: Change `simulationTime.toFixed(1)` in `drawStatus`/status bar — it is already correctly formatted and out of scope.
