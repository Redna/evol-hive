# Feature: Fix Affordance Masking Leak — Separate Unmasked and Masked Affordances in PerceptionResult

## Context
- Architecture: [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (affordance masking), [§6 — PPER Loop](../architecture/06-pper-loop.md) (Perceive → Plan → Execute → Reflect data flow)
- Related specs: [016 — Cognitive Guardrails](016-cognitive-guardrails.md) (Req 8, Req 10 — masking in Perceive phase), [019 — Affordance-as-Tools](019-affordance-as-tools.md) (Req 7, Req 8 — affordance tools in builders)
- Package: `shared`, `cognition`
- Issue: [#83](https://github.com/Redna/evol-hive/issues/83)

## Bug Summary

Affordance masking (spec 016, Req 8) is applied during the **Perceive phase** but leaks into the **Plan phase** through the `PerceptionResult.prunedAffordances` field. When the agent has no plan, the guardrail masks affordances to `[]` and stores the masked array as `prunedAffordances`. The Plan phase reads `prunedAffordances` to build affordance tool definitions — it gets an empty array, so the LLM sees no affordance tools and hallucinates affordance names in plan steps. Every plan step fails to resolve in Execute, the plan is marked "complete" with zero actions executed, and the cycle repeats forever.

### Root Cause

In `PerceptionServiceImpl.perceive()` (`packages/cognition/src/pper/index.ts`):

```typescript
maskedAffordances = guardrail.maskAffordances(prunedAffordances, hasPlan);
return {
  prunedAffordances: maskedAffordances,  // ← BUG: masked array stored as prunedAffordances
};
```

The `prunedAffordances` field in `PerceptionResult` is consumed by both:
- **PerceptionBuilderImpl** (Perceive/Choose phase) — should see masked affordances (hide physical actions when no plan)
- **PlanBuilderImpl** (Plan phase) — should see unmasked affordances (LLM needs exact affordance IDs to put in plan steps)

Storing the masked array in `prunedAffordances` means the Plan phase gets an empty affordance list.

## Design Decision — Option A: Dual Fields

Store **both** the unmasked and masked affordances in `PerceptionResult`:

- `prunedAffordances` — UNMASKED classifier output (for Plan builder)
- `maskedAffordances` — MASKED result after guardrail masking (for Perception builder)

This is the approach proposed in the issue (Option A). It is preferred over Option B (passing unmasked affordances separately to the Plan phase) because:
1. It keeps the `PerceptionResult` as the single data carrier between phases (no new constructor parameters on services)
2. It is backward compatible — `maskedAffordances` is optional; when absent, builders fall back to `prunedAffordances`
3. It matches the existing pattern where `PerceptionResult` carries all data the phases need

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **Add `maskedAffordances` field to `PerceptionResult`** — The `PerceptionResult` interface in `packages/shared/src/types/cognition.ts` must be extended with an optional `maskedAffordances?: Affordance[]` field. This field holds the guardrail-masked affordance array (empty when masking is active and the agent has no plan; identical to `prunedAffordances` when masking is inactive or the agent has a plan). When `maskedAffordances` is `undefined`, consumers should treat it as equivalent to `prunedAffordances` (backward compatibility for code paths that do not use guardrails).

### Cognition Layer — PerceptionServiceImpl (`@evol-hive/cognition`)

2. **Store unmasked affordances in `prunedAffordances`** — `PerceptionServiceImpl.perceive()` must store the **unmasked** classifier output in the returned `PerceptionResult.prunedAffordances`. The variable currently named `maskedAffordances` (the result of `guardrail.maskAffordances(...)`) must NOT overwrite `prunedAffordances`. Instead, `prunedAffordances` retains the classifier output.

3. **Store masked affordances in `maskedAffordances`** — `PerceptionServiceImpl.perceive()` must store the guardrail-masked result in the returned `PerceptionResult.maskedAffordances`. When a guardrail engine is present, this is `guardrail.maskAffordances(prunedAffordances, hasPlan)`. When no guardrail engine is present, `maskedAffordances` is set to `prunedAffordances` (same reference — no masking applied) so consumers can always read `maskedAffordances` without checking for `undefined`.

4. **Stuck detection uses unmasked affordances** — The `stuck` flag (`prunedAffordances.length === 0`) must be computed from the **unmasked** `prunedAffordances`. This is already the case in the current code (the check happens before masking) and must not change. Stuck means "no affordances exist in the room at all" — it is independent of masking.

### Cognition Layer — PerceptionBuilderImpl (`@evol-hive/cognition`)

5. **PerceptionBuilderImpl uses `maskedAffordances`** — `PerceptionBuilderImpl.build()` must read `maskedAffordances` from `perceptionResult` instead of `prunedAffordances` when constructing affordance tools and the `availableAffordances` field. When `maskedAffordances` is `undefined` (backward compatibility — e.g., `PerceptionResult` constructed without the field), the builder falls back to `prunedAffordances`.

6. **Remove redundant double-masking in PerceptionBuilderImpl** — The existing code applies masking twice: once in the service (overwriting `prunedAffordances`) and once in the builder (`noPlan && maskingEnabled ? [] : prunedAffordances`). After the fix, the service already provides `maskedAffordances` with masking applied. The builder's `guardrailOptions.maskingEnabled` flag becomes a **secondary safety net**: when `maskedAffordances` is already masked (i.e., `[]`), the builder's own masking check is a no-op (`[] → []`). When `maskedAffordances` is `undefined` and the builder falls back to `prunedAffordances`, the builder's own masking check applies. The builder's masking logic is retained for backward compatibility but the primary masking source is now the service-level `maskedAffordances` field.

### Cognition Layer — PlanBuilderImpl (`@evol-hive/cognition`)

7. **PlanBuilderImpl uses `prunedAffordances` (unmasked) — no change** — `PlanBuilderImpl.build()` already reads `perceptionResult.prunedAffordances` to build affordance tool definitions. After the fix, `prunedAffordances` contains the **unmasked** classifier output, so the LLM sees all available affordance IDs as tool names during plan formulation. No code change is needed in `PlanBuilderImpl` — the fix is in `PerceptionServiceImpl` which now stores the correct (unmasked) value in `prunedAffordances`.

### Spec 016 Update

8. **Clarify masking scope in spec 016** — Spec 016, Req 8 must be updated to clarify that affordance masking is applied to the `maskedAffordances` field only (consumed by the Perception/Choose phase), NOT to the `prunedAffordances` field (consumed by the Plan phase). The updated requirement text:

   > **Req 8 (clarified)**: After classifier pruning, if a guardrail engine is present, `PerceptionServiceImpl.perceive()` calls `guardrail.maskAffordances(prunedAffordances, hasPlan)` and stores the result in `PerceptionResult.maskedAffordances`. The `PerceptionResult.prunedAffordances` field retains the **unmasked** classifier output — it is consumed by the Plan phase, where the LLM must see all available affordance IDs to reference them in plan steps. The `maskedAffordances` field is consumed by the Perception/Choose phase, where affordance tools are hidden when the agent has no plan.

9. **Update spec 016 AC-15** — Spec 016, AC-15 currently asserts `prunedAffordances` is `[]` when no plan and masking enabled. After the fix, AC-15 must assert `maskedAffordances` is `[]` (not `prunedAffordances`). The `prunedAffordances` field must retain the unmasked classifier output in all cases. A new AC-15a must assert `prunedAffordances` is unchanged from classifier output regardless of masking state.

### Tests

10. **Update guardrails.test.ts AC-15 test** — The test `AC-15: prunedAffordances is [] when no plan and masking enabled` must be updated to assert `maskedAffordances` is `[]` and `prunedAffordances` is unchanged from classifier output.

11. **Update guardrails.test.ts AC-16 test** — The test `AC-16: prunedAffordances is unchanged when agent has a plan and masking enabled` must additionally assert `maskedAffordances` equals `prunedAffordances` (since masking is a no-op when `hasPlan === true`).

12. **Add integration test: Plan phase sees affordance tools when no plan** — A new test must verify the end-to-end fix: when the agent has no plan and masking is enabled, `PerceptionServiceImpl.perceive()` returns a `PerceptionResult` where `prunedAffordances` contains the full classifier output (non-empty) and `maskedAffordances` is `[]`. `PlanBuilderImpl.build(perceptionResult)` produces a payload whose `tools` array includes affordance tool definitions (non-empty). `PerceptionBuilderImpl.build(perceptionResult, { hasPlan: false, maskingEnabled: true })` produces a payload whose `tools` array has NO affordance tools.

13. **All existing tests pass** — All existing tests in `packages/cognition/tests/` and `packages/shared/tests/` must pass after the fix. Tests that construct `PerceptionResult` objects manually (without `maskedAffordances`) must continue to work because the field is optional.

## Acceptance Criteria

- [ ] **AC-1**: The `PerceptionResult` interface in `packages/shared/src/types/cognition.ts` includes an optional `maskedAffordances?: Affordance[]` field. *(Req 1)*
- [ ] **AC-2**: `PerceptionServiceImpl.perceive()` returns a `PerceptionResult` where `prunedAffordances` contains the **unmasked** classifier output (not the masked array), regardless of guardrail state. *(Req 2)*
- [ ] **AC-3**: `PerceptionServiceImpl.perceive()` returns a `PerceptionResult` where `maskedAffordances` contains the guardrail-masked array when a guardrail is present. *(Req 3)*
- [ ] **AC-4**: `PerceptionServiceImpl.perceive()` returns a `PerceptionResult` where `maskedAffordances` equals `prunedAffordances` (same content) when no guardrail engine is present. *(Req 3)*
- [ ] **AC-5**: The `stuck` flag is computed from the unmasked `prunedAffordances` and is `true` only when the classifier returns zero affordances (not when masking hides them). *(Req 4)*
- [ ] **AC-6**: `PerceptionBuilderImpl.build()` reads `maskedAffordances` from `perceptionResult` when available, producing affordance tools from the masked array. *(Req 5)*
- [ ] **AC-7**: When `maskedAffordances` is `undefined` on the `PerceptionResult`, `PerceptionBuilderImpl.build()` falls back to `prunedAffordances` and applies its own masking logic via `guardrailOptions`. *(Req 5, Req 6)*
- [ ] **AC-8**: When the agent has no plan and masking is enabled, `PerceptionBuilderImpl.build()` returns a payload whose `tools` array contains NO affordance tool definitions (only cognitive tools + social tools). *(Req 5, Req 6)*
- [ ] **AC-9**: `PlanBuilderImpl.build()` returns a payload whose `tools` array includes affordance tool definitions from `prunedAffordances` — even when the agent has no plan and masking is enabled (the Plan phase is NOT masked). *(Req 7)*
- [ ] **AC-10**: Spec 016 is updated: Req 8 clarifies that `prunedAffordances` retains unmasked classifier output and `maskedAffordances` stores the masked result. AC-15 asserts `maskedAffordances` is `[]` (not `prunedAffordances`). *(Req 8, Req 9)*
- [ ] **AC-11**: The test `AC-15` in `guardrails.test.ts` asserts `maskedAffordances` is `[]` and `prunedAffordances` equals the classifier output when no plan and masking is enabled. *(Req 10)*
- [ ] **AC-12**: The test `AC-16` in `guardrails.test.ts` asserts both `prunedAffordances` and `maskedAffordances` equal the classifier output when the agent has a plan. *(Req 11)*
- [ ] **AC-13**: A new integration test verifies: when agent has no plan and masking is enabled, `PlanBuilderImpl.build(perceptionResult)` produces a `tools` array with non-empty affordance tools, while `PerceptionBuilderImpl.build(perceptionResult, { hasPlan: false, maskingEnabled: true })` produces a `tools` array with zero affordance tools. *(Req 12)*
- [ ] **AC-14**: All existing tests in `packages/cognition/tests/` and `packages/shared/tests/` pass without modification (except the updated AC-15 and AC-16 tests in `guardrails.test.ts`). *(Req 13)*

## Constraints

- **Package boundaries** (per ADR-0001): Changes are confined to `packages/shared/src/types/cognition.ts` (new optional field), `packages/cognition/src/pper/index.ts` (PerceptionServiceImpl — store both fields), `packages/cognition/src/pper/perception-builder.ts` (read `maskedAffordances`), `docs/specs/016-cognitive-guardrails.md` (spec update), and `packages/cognition/tests/guardrails.test.ts` (test updates). No changes to `packages/engine/` or `packages/memory/`. No new npm dependencies.
- **Backward compatibility**: The `maskedAffordances` field is optional. Existing code that constructs `PerceptionResult` without `maskedAffordances` continues to work. The `PlanBuilderImpl` is unchanged — it already reads `prunedAffordances`. The `PerceptionBuilderImpl` falls back to `prunedAffordances` when `maskedAffordances` is `undefined`.
- **No new bridge interfaces**: No changes to `PerceptionDataProvider`, `ExecuteDataProvider`, or `PlanDataProvider`. The fix is entirely within the cognition package's data flow — `PerceptionResult` is an internal cognition data structure passed between phases.
- **Masking scope**: Affordance masking applies ONLY to the Perceive/Choose phase (PerceptionBuilderImpl). The Plan phase (PlanBuilderImpl) must always see unmasked affordances. This is the core fix.
- **What NOT to do**:
  - Do not remove the `guardrailOptions` masking logic from `PerceptionBuilderImpl` — it serves as a backward-compatibility safety net when `maskedAffordances` is `undefined`.
  - Do not modify `PlanBuilderImpl` — it already reads `prunedAffordances` and the fix is in the service that populates that field.
  - Do not modify `ExecuteServiceImpl` or `PPEROrchestratorImpl` — the fix is in the data flow between Perceive and Plan, not in execution or orchestration.
  - Do not modify the `GuardrailEngineImpl` or `GuardrailEngine` interface — the masking logic itself is correct; the bug is in how the masked result is stored.
  - Do not add new npm dependencies.
  - Do not change the `LLMClient` interface or any LLM client implementation.
  - Do not modify the `PerceptionBuilder` or `PlanBuilder` interfaces — only the internal implementation of `PerceptionBuilderImpl` changes (reading `maskedAffordances` instead of `prunedAffordances`).
