# Feature: PPER Mask Leak Fix — Separate Unmasked and Masked Affordances in PerceptionResult

## Context
- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md) (Perceive → Plan → Execute → Reflect data flow), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (affordance masking, Req 10)
- Related specs: [016 — Cognitive Guardrails](016-cognitive-guardrails.md) (defines affordance masking, `GuardrailEngineImpl.maskAffordances`, `PerceptionResult.prunedAffordances` — **this spec amends Reqs 8, 10, 15, 16 and AC-15, AC-16**), [019 — Affordance-as-Tools](019-affordance-as-tools.md) (per-affordance tool definitions, plan builder reads `prunedAffordances` for tool construction), [001 — Perceive Phase](001-perceive-phase.md) (classifier pruning produces `prunedAffordances`)
- Package: `shared` (type extension), `cognition` (perception service, perception builder, plan builder, tests)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#83](https://github.com/Redna/evol-hive/issues/83)

## Problem Statement

`PerceptionServiceImpl.perceive()` applies affordance masking (spec 016, Req 8) and stores the **masked** result in the `prunedAffordances` field of `PerceptionResult`. When the agent has no plan and masking is enabled, this field becomes `[]`. The Plan phase reads `perceptionResult.prunedAffordances` to build affordance tool definitions — it gets an empty array, so the LLM sees no affordance tools during planning and hallucinates affordance IDs in plan steps. All hallucinated steps are skipped during Execute, the plan is marked complete, and the cycle repeats forever — burning ~40,000 tokens per minute with zero actions executed.

### Root Cause in Code

```typescript
// packages/cognition/src/pper/index.ts — PerceptionServiceImpl.perceive()

maskedAffordances = guardrail.maskAffordances(prunedAffordances, hasPlan);

return {
  prunedAffordances: maskedAffordances,  // ← BUG: masked array stored as prunedAffordances
  // ...
};
```

The `prunedAffordances` field is consumed by **two** builders with different masking requirements:

| Consumer | Purpose | Needs masked? | Currently gets |
|---|---|---|---|
| `PerceptionBuilderImpl` | Action-choice LLM context (Perceive/Choose phase) | **Yes** — hide affordances when no plan | `prunedAffordances` (already masked — works by accident, double-masks harmlessly) |
| `PlanBuilderImpl` | Plan-formulation LLM context (Plan phase) | **No** — LLM must see exact affordance IDs | `prunedAffordances` (masked to `[]` when no plan — **broken**) |

### Contradiction with Spec 016 Design Decision 2

Spec 016's design decisions (`.pi/notes/016-design-decisions.md`, Decision 2) explicitly state:

> "By running masking after pruning, we can pass the full pruned list to the plan builder while hiding it from the action-choice LLM context. **The masking specifically targets the `LLMContextPayload.availableAffordances` and `tools` — not the `PerceptionResult` itself.**"

The implementation violates this decision: masking overwrites `PerceptionResult.prunedAffordances` instead of being applied only at the builder level.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **Add `maskedAffordances` field to `PerceptionResult`** — The `PerceptionResult` interface in `packages/shared/src/types/cognition.ts` must be extended with an optional `maskedAffordances?: Affordance[]` field. This field holds the **masked** affordances (output of `guardrail.maskAffordances`) for use by the Perception/Action-choice builder. When no guardrail engine is configured, `maskedAffordances` is `undefined` and consumers fall back to `prunedAffordances`.

2. **`prunedAffordances` semantics clarified** — The JSDoc comment on `PerceptionResult.prunedAffordances` must be updated to state: "Top-K affordances retained by the System 0 classifier. **Unmasked** — this is the classifier output before guardrail masking. Used by the Plan builder to construct affordance tool definitions." The field type and name remain unchanged (`Affordance[]`).

### Cognition Layer (`@evol-hive/cognition`)

3. **`PerceptionServiceImpl.perceive()` returns unmasked `prunedAffordances`** — The return statement of `perceive()` must store the **unmasked** classifier output in `prunedAffordances` (not the masked result). The masked result must be stored in `maskedAffordances`:

   ```typescript
   return {
     passive,
     prunedAffordances,                    // ← UNMASKED (classifier output, for Plan builder)
     ...(guardrail !== undefined ? { maskedAffordances: maskedAffordances } : {}),
     primaryDriveLabel,
     // ... other fields unchanged
   };
   ```

   When no guardrail engine is present, `maskedAffordances` is omitted (undefined), preserving backward compatibility. When a guardrail is present but masking is disabled (`affordanceMasking === false`), `maskedAffordances` equals `prunedAffordances` (masking returns unchanged — spec 016, Req 6).

4. **`PerceptionBuilderImpl.build()` uses `maskedAffordances`** — The `PerceptionBuilderImpl.build()` method must read `maskedAffordances` from `perceptionResult` (falling back to `prunedAffordances` when `maskedAffordances` is `undefined`):

   ```typescript
   const sourceAffordances = perceptionResult.maskedAffordances ?? perceptionResult.prunedAffordances;
   const availableAffordances = noPlan && maskingEnabled ? [] : sourceAffordances;
   ```

   This replaces the current `const availableAffordances = noPlan && maskingEnabled ? [] : prunedAffordances;` line. When masking is active and no plan exists, `maskedAffordances` is `[]`, so `availableAffordances` is `[]` — same result as before. When masking is active and a plan exists, `maskedAffordances` equals `prunedAffordances` — same result. The behavioral change is that the Perception builder no longer depends on `prunedAffordances` being pre-masked; it uses the explicitly masked field.

5. **`PlanBuilderImpl.build()` uses `prunedAffordances` (unmasked)** — The `PlanBuilderImpl.build()` method must continue to read `prunedAffordances` from `perceptionResult`. No code change is required in the plan builder itself — the fix is that `prunedAffordances` now contains the **unmasked** classifier output (Req 3). The LLM sees all affordance tools during planning and can reference exact affordance IDs in plan steps.

6. **`PerceptionBuilderImpl` JSDoc updated** — The PerceptionBuilder's source code comments must be updated to reflect that it reads `maskedAffordances` (not `prunedAffordances`) for tool construction. The existing "double-masking" pattern (reading `prunedAffordances` which was already masked, then applying `noPlan && maskingEnabled` again) is replaced with a single, explicit read of the masked field.

### Test Layer (`packages/cognition/tests`)

7. **Update `guardrails.test.ts` AC-15** — The test `AC-15: prunedAffordances is [] when no plan and masking enabled` must be updated to assert on `maskedAffordances` (not `prunedAffordances`):

   ```typescript
   expect(result.maskedAffordances).toEqual([]);
   expect(result.prunedAffordances).toEqual(affordances); // UNMASKED — classifier output preserved
   ```

8. **Update `guardrails.test.ts` AC-16** — The test `AC-16: prunedAffordances is unchanged when agent has a plan and masking enabled` must assert both fields:

   ```typescript
   expect(result.prunedAffordances).toEqual(affordances); // UNMASKED
   expect(result.maskedAffordances).toEqual(affordances);  // MASKED (no-op when hasPlan)
   ```

9. **Update `guardrails.test.ts` backward-compat tests** — The tests `without guardrail: prunedAffordances unchanged (backward compat)` and `masking disabled: prunedAffordances unchanged even without plan` must assert that `maskedAffordances` is `undefined` (no guardrail) or equal to `prunedAffordances` (masking disabled), respectively. `prunedAffordances` must always equal the classifier output.

10. **Update `spec-016-coverage.test.ts` AC-15/AC-16 todos** — The `it.todo` placeholders for AC-15 and AC-16 in `spec-016-coverage.test.ts` must be updated to reference `maskedAffordances` for the masking assertion and `prunedAffordances` for the unmasked preservation assertion.

11. **Add integration test: plan builder sees affordance tools when no plan** — A new test must verify that when the agent has no plan and masking is enabled, `PlanBuilderImpl.build()` produces a `LLMContextPayload` whose `tools` array contains affordance tool definitions built from the **unmasked** `prunedAffordances`. This is the critical regression test for the bug — the plan builder must always see affordance tools regardless of masking state.

12. **Add integration test: perception builder hides affordance tools when no plan** — A new test must verify that when the agent has no plan and masking is enabled, `PerceptionBuilderImpl.build()` produces a `LLMContextPayload` whose `tools` array contains only cognitive tools (no affordance tool definitions). This verifies that masking still works correctly after the fix — the Perception/Action-choice phase is still masked.

### Spec 016 Amendment

13. **Amend spec 016, Req 8** — The requirement text in `docs/specs/016-cognitive-guardrails.md` (Req 8) must be updated: "The masked result replaces `prunedAffordances` in the returned `PerceptionResult`" must be changed to "The masked result is stored in a new `maskedAffordances` field on `PerceptionResult`. The `prunedAffordances` field retains the **unmasked** classifier output for use by the Plan builder."

14. **Amend spec 016, Req 10** — The requirement text must be clarified: "When `hasPlan === false` and `affordanceMasking === true`, the `availableAffordances` in the `LLMContextPayload` are set to `[]`" must specify that the Perception builder reads from `maskedAffordances` (not `prunedAffordances`). Add a note: "Affordance masking applies **only** to the Perceive/Choose phase. The Plan phase always sees unmasked affordances via `prunedAffordances` so the LLM can reference exact affordance IDs in plan steps."

15. **Amend spec 016, AC-15** — Change from "When the agent has no plan and affordance masking is enabled, the `PerceptionResult.prunedAffordances` is an empty array" to "When the agent has no plan and affordance masking is enabled, the `PerceptionResult.maskedAffordances` is an empty array and `PerceptionResult.prunedAffordances` retains the unmasked classifier output."

16. **Amend spec 016, AC-16** — Change from "When the agent has a plan and affordance masking is enabled, the `PerceptionResult.prunedAffordances` is unchanged from classifier output" to "When the agent has a plan and affordance masking is enabled, both `PerceptionResult.prunedAffordances` and `PerceptionResult.maskedAffordances` are unchanged from classifier output (masking is a no-op when a plan exists)."

## Acceptance Criteria

- [ ] AC-1: `PerceptionResult` interface includes an optional `maskedAffordances?: Affordance[]` field. *(Maps to Req 1)*
- [ ] AC-2: `PerceptionResult.prunedAffordances` JSDoc states it is the unmasked classifier output used by the Plan builder. *(Maps to Req 2)*
- [ ] AC-3: When no guardrail engine is configured, `PerceptionServiceImpl.perceive()` returns `prunedAffordances` equal to the classifier output and `maskedAffordances` is `undefined` (omitted from the return object). *(Maps to Req 3)*
- [ ] AC-4: When a guardrail engine is configured with `affordanceMasking: true` and the agent has no plan, `PerceptionServiceImpl.perceive()` returns `prunedAffordances` equal to the classifier output (non-empty) and `maskedAffordances` equal to `[]`. *(Maps to Req 3)*
- [ ] AC-5: When a guardrail engine is configured with `affordanceMasking: true` and the agent has a plan, `PerceptionServiceImpl.perceive()` returns both `prunedAffordances` and `maskedAffordances` equal to the classifier output (masking is a no-op when `hasPlan === true`). *(Maps to Req 3, spec 016 Req 6)*
- [ ] AC-6: When a guardrail engine is configured with `affordanceMasking: false` and the agent has no plan, `PerceptionServiceImpl.perceive()` returns both `prunedAffordances` and `maskedAffordances` equal to the classifier output (masking disabled — no-op). *(Maps to Req 3, spec 016 Req 6)*
- [ ] AC-7: `PerceptionBuilderImpl.build()` reads `maskedAffordances ?? prunedAffordances` for constructing the `availableAffordances` and `tools` in the `LLMContextPayload`. *(Maps to Req 4)*
- [ ] AC-8: When the agent has no plan and masking is enabled, `PerceptionBuilderImpl.build()` produces `LLMContextPayload.tools` containing only cognitive tool definitions (no affordance tools). *(Maps to Req 4, 12)*
- [ ] AC-9: When the agent has a plan (or masking is disabled), `PerceptionBuilderImpl.build()` produces `LLMContextPayload.tools` containing affordance tool definitions built from `maskedAffordances` (or `prunedAffordances` when `maskedAffordances` is undefined). *(Maps to Req 4)*
- [ ] AC-10: `PlanBuilderImpl.build()` produces `LLMContextPayload.tools` containing affordance tool definitions built from `prunedAffordances` (unmasked) regardless of masking state or plan presence. *(Maps to Req 5, 11)*
- [ ] AC-11: When the agent has no plan and masking is enabled, `PlanBuilderImpl.build()` produces `LLMContextPayload.tools` that includes the `brew_coffee` affordance tool (assuming `brew_coffee` is in the classifier output). This is the critical regression test — the plan builder must see affordance tools even when masking is active. *(Maps to Req 5, 11)*
- [ ] AC-12: `guardrails.test.ts` AC-15 test asserts `result.maskedAffordances` is `[]` AND `result.prunedAffordances` equals the classifier output (non-empty) when no plan and masking enabled. *(Maps to Req 7)*
- [ ] AC-13: `guardrails.test.ts` AC-16 test asserts both `result.prunedAffordances` and `result.maskedAffordances` equal the classifier output when agent has a plan and masking enabled. *(Maps to Req 8)*
- [ ] AC-14: `guardrails.test.ts` backward-compat test asserts `result.maskedAffordances` is `undefined` when no guardrail engine is configured. *(Maps to Req 9)*
- [ ] AC-15: `guardrails.test.ts` masking-disabled test asserts `result.maskedAffordances` equals `result.prunedAffordances` (both equal to classifier output) when `affordanceMasking: false`. *(Maps to Req 9)*
- [ ] AC-16: `spec-016-coverage.test.ts` AC-15 and AC-16 `it.todo` entries updated to reference `maskedAffordances` for masking assertions and `prunedAffordances` for unmasked preservation. *(Maps to Req 10)*
- [ ] AC-17: Spec 016 Req 8 text updated to reference `maskedAffordances` field instead of replacing `prunedAffordances`. *(Maps to Req 13)*
- [ ] AC-18: Spec 016 Req 10 text clarified to state masking applies only to Perceive/Choose phase, with Plan phase always seeing unmasked affordances. *(Maps to Req 14)*
- [ ] AC-19: Spec 016 AC-15 updated to assert on `maskedAffordances` (empty) and `prunedAffordances` (unmasked). *(Maps to Req 15)*
- [ ] AC-20: Spec 016 AC-16 updated to assert both fields equal classifier output when plan exists. *(Maps to Req 16)*
- [ ] AC-21: All existing tests pass (no regressions in guardrails, perception, plan, affordance-as-tools, or PPER error recovery test suites). *(Maps to Reqs 3, 4, 5 — backward compatibility)*
- [ ] AC-22: Real LLM validation: agent with no plan sees `brew_coffee` tool in Plan phase → formulates plan with `brew_coffee` step → Execute phase resolves and runs the affordance → agent energy increases. Token count per cycle drops from 3 LLM calls (all wasted) to 2 LLM calls (plan + reflect, both useful). *(Maps to Reqs 3, 5 — end-to-end fix verification)*

## Constraints

- **Backward compatibility**: The `maskedAffordances` field is optional on `PerceptionResult`. All existing code that constructs `PerceptionResult` without a `maskedAffordances` field must continue to compile and function. The `PerceptionBuilderImpl` falls back to `prunedAffordances` when `maskedAffordances` is `undefined`, so callers that don't set the new field get the same behavior as before (if they also don't pre-mask `prunedAffordances`, which is the bug — but callers that were masking via the guardrail path will now get correct behavior).

- **No new bridge interfaces**: This fix does not require any new data provider interfaces. The `PerceptionDataProvider.getAgentState` method (added by spec 016) is already in place for `hasPlan` determination.

- **Single source of truth for masking**: The `GuardrailEngineImpl.maskAffordances()` method remains the sole source of masking logic. The fix only changes **where** the masked result is stored — in `maskedAffordances` instead of overwriting `prunedAffordances`. No new masking logic is introduced.

- **Plan builder unchanged**: `PlanBuilderImpl.build()` does not require code changes — it already reads `prunedAffordances`. The fix is that `prunedAffordances` now contains the correct (unmasked) value. This is verified by a new test (AC-11) but the plan builder source code is not modified.

- **Performance**: No performance impact. The fix adds one field to `PerceptionResult` (already allocated) and changes which variable is destructured in the perception builder (zero-cost). No additional LLM calls, no additional classifier runs.

- **Spec 016 amendment scope**: Only Reqs 8, 10 and ACs 15, 16 of spec 016 are amended. All other requirements and acceptance criteria in spec 016 remain unchanged. The `GuardrailEngineImpl` class, `GuardrailConfig`, `PlanValidationResult`, and all execute-phase guardrails are untouched.

- **Do NOT**: Remove the `noPlan && maskingEnabled` check from `PerceptionBuilderImpl`. Even though `maskedAffordances` is already `[]` when masking is active, the builder must still apply the check to handle the case where `maskedAffordances` is `undefined` (no guardrail configured) and the builder is called with `maskingEnabled: true` from external code. The check is a defense-in-depth that costs nothing.

- **Do NOT**: Add masking logic to `PlanBuilderImpl`. The Plan phase must always see unmasked affordances. If a future guardrail needs to restrict plan-phase tools, it should be a separate mechanism, not a reuse of affordance masking.

- **Do NOT**: Rename `prunedAffordances`. The name is used across the codebase and in tests. Its semantic is now clarified (unmasked classifier output) but the name remains for backward compatibility.
