# Design Decisions — Feature 020: Affordance Masking Leak Fix

## Decision 1: Dual fields (Option A) — `prunedAffordances` + `maskedAffordances`
**Why**: The issue proposed two options. Option A (dual fields) is preferred over Option B (passing unmasked affordances separately to the Plan service) because:
- `PerceptionResult` is already the single data carrier between PPER phases. Adding a separate parameter to `PlanServiceImpl.plan()` would break the clean `plan(agentId, perceptionResult)` signature and require changes in the orchestrator.
- The `maskedAffordances` field is optional, so existing code that constructs `PerceptionResult` without it continues to work (backward compatibility).
- The PerceptionBuilderImpl already has its own masking logic via `guardrailOptions` — making `maskedAffordances` the primary source and keeping the builder-level masking as a safety net provides defense-in-depth without breaking anything.

**Alternative considered**: Option B — Pass unmasked affordances directly to `PlanServiceImpl.plan(agentId, perceptionResult, unmaskedAffordances?)`. Rejected because it changes the service interface and adds complexity to the orchestrator wiring.

## Decision 2: `maskedAffordances` is set even when no guardrail is present
**Why**: When no guardrail engine is present, `PerceptionServiceImpl.perceive()` sets `maskedAffordances = prunedAffordances` (same reference). This means consumers can always read `maskedAffordances` without checking for `undefined`. The alternative — leaving it `undefined` when no guardrail — forces every consumer to handle two code paths (field present vs absent).

**Impact**: The `PerceptionResult` is slightly larger (an extra array reference) when no guardrail is present, but this is negligible. The simplification of consumer code is worth it.

## Decision 3: Retain builder-level masking as a safety net (do not remove)
**Why**: `PerceptionBuilderImpl.build()` currently applies its own masking via `guardrailOptions.maskingEnabled`. After the fix, the service-level `maskedAffordances` is the primary masking source. The builder-level masking becomes redundant when `maskedAffordances` is present (masked array already empty). However, removing it would break backward compatibility for callers who construct `PerceptionResult` without `maskedAffordances` and rely on the builder's own masking.

**Impact**: Double-masking is a no-op (`[] → []`), so there is no performance or correctness concern. The builder-level masking is retained with a comment explaining it is a secondary safety net.

## Decision 4: Stuck detection uses unmasked affordances (no change)
**Why**: The `stuck` flag means "no physical affordances exist in this room at all" — it is independent of guardrail masking. A room with affordances but an agent with no plan is NOT stuck (the agent should formulate a plan). Computing `stuck` from the masked array would incorrectly report "stuck" whenever the agent has no plan, even in a room full of affordances.

**Impact**: The existing code already computes `stuck` from the unmasked `prunedAffordances` (before masking is applied). No change needed — this decision documents that the existing behavior is correct and must be preserved.

## Decision 5: Do not modify PlanBuilderImpl
**Why**: `PlanBuilderImpl.build()` already reads `perceptionResult.prunedAffordances` and builds affordance tools from it. After the fix, `prunedAffordances` contains the correct (unmasked) value. No code change is needed — the fix is entirely in `PerceptionServiceImpl.perceive()` which now stores the unmasked array in `prunedAffordances` instead of the masked array.

**Impact**: This keeps the change surface minimal. The Plan phase was always correct in its reading of `prunedAffordances` — it was the Perceive phase that was incorrectly overwriting the field with the masked result.

## Decision 6: Update spec 016 in-place rather than creating a new spec for the clarification
**Why**: The masking scope clarification (Req 8) is a documentation fix to an existing spec, not a new feature. Updating spec 016 in-place keeps the spec as the single source of truth. The new spec 020 documents the code fix (dual fields) and references the spec 016 update.

**Alternative considered**: Create a separate "spec 016a" for the clarification. Rejected — it would fragment the guardrails spec and make it harder to follow. In-place update with a "clarified" tag is the established pattern (see spec 019's supersession of spec 011's choose_action portion).
