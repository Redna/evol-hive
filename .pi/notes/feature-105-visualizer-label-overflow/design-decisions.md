# Design Decisions — Spec 029 (Visualizer State Label Overflow Fix, Issue #105)

## Decision 1: Round to 2 Decimal Places with Trailing-Zero Stripping
**Context:** The issue says "1–2 decimal places." `toFixed(1)` (as the status bar uses) would lose meaningful precision on values like `0.125` → `"0.1"`; `toFixed(2)` keeps trailing zeros (`"5.00"`), which is noisy.

**Decision:** Format finite numbers as `Number(value.toFixed(2)).toString()` — round to 2 decimals, then strip trailing zeros (`95.666666674` → `"95.67"`, `5.0` → `"5"`).

**Rationale:** Matches the issue's repro values, preserves enough precision to distinguish nearby state values, and produces clean integers. Trailing zeros carry no information in a 56 px label.

## Decision 2: Fix Both Renderers (Module + Server-Embedded Script)
**Context:** The visualizer has two renderers with the same bug: the typed `CanvasRenderer` module and a minified copy embedded as a template string in `visualizer-server.ts` (the browser client). The embedded copy cannot import from the module.

**Decision:** Apply the identical format/truncate logic in both places, with `// keep in sync` comments, and add a test asserting the embedded script contains the rounding + ellipsis markers (AC-9).

**Rationale:** Fixing only the module would leave the actual browser view (what the issue screenshot shows) broken. A build-time extraction of shared client code is disproportionate for ~15 lines; duplication with a sync test is the pragmatic guard.

## Decision 3: measureText + Ellipsis Truncation, Not Chip Resizing or Hard Clipping
**Context:** Options considered: (a) resize chips to fit text, (b) `ctx.clip()` / hard slice the string, (c) measure + ellipsis.

**Decision:** Option (c). Measure with `ctx.measureText` at the set font, truncate from the end until the string (plus `…`) fits within 56 px usable width.

**Rationale:** Chip geometry is a layout invariant other specs/tests rely on (60×30 box, 70 px grid); resizing risks cascading layout changes. Hard clipping loses information silently with no affordance that text continues; the `…` character signals elision. Canvas `measureText` is the only accurate width source (character-count heuristics break across fonts/glyphs).

## Decision 4: Display-Only Formatting — Never Mutate `SmartObject.state`
**Context:** Rounding could alternatively be applied when the engine updates object state (one place, fixes all consumers).

**Decision:** No engine/scene changes. Formatting happens only inside the renderer at draw time; the state snapshot must remain full-precision and unmutated.

**Rationale:** `SmartObject.state` feeds affordance conditions, `ObjectStateRule`s, and persistence (specs 018/022/017) — rounding there would corrupt game logic. The renderer is documented stateless/read-only (spec 023); this spec preserves that contract (AC-5).

## Decision 5: Only the First State Entry Is Formatted/Truncated (Scope)
**Context:** `drawObjects` renders only `stateEntries[0]`. A fuller fix might show all state pairs.

**Decision:** Keep the first-pair-only behavior; this spec fixes formatting/overflow only.

**Rationale:** Multi-pair display is a feature change (out of scope for a bug-fix issue) and would require chip layout redesign. Minimal-diff principle for a bugfix spec.

## Decision 6: Test Strategy — Deterministic `measureText` in MockContext
**Context:** `MockContext` records calls but doesn't implement `measureText`; without it, truncation can't be asserted deterministically.

**Decision:** Add `measureText(text) → { width: text.length * 6 }` to the mock (56 px ≈ 9 chars), keeping the strict "unknown method throws" behavior for everything else.

**Rationale:** A linear per-character width makes pass/fail thresholds deterministic in tests regardless of real font metrics, and follows the existing mock pattern (record, minimal surface, throw on unexpected usage).
