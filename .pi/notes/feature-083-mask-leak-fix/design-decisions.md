# Design Decisions — Spec 020 (PPER Mask Leak Fix, Issue #83)

## Decision 1: Separate `maskedAffordances` Field (Option A from Issue)
**Context:** The issue proposes two options — Option A adds a `maskedAffordances` field to `PerceptionResult`, Option B applies masking in the Perception builder instead of the service. 

**Decision:** Option A — add an optional `maskedAffordances?: Affordance[]` field to `PerceptionResult`.

**Rationale:** Option A is the minimal change. The masking logic stays in `GuardrailEngineImpl.maskAffordances()` (single source of truth). The perception service stores both arrays — the unmasked classifier output in `prunedAffordances` (for the plan builder) and the masked output in `maskedAffordances` (for the perception builder). This aligns with spec 016 Design Decision 2, which explicitly stated masking should target `LLMContextPayload`, not `PerceptionResult` — but the implementation violated that decision. This fix restores the intended design.

**Alternative considered:** Option B — move masking into the Perception builder. Rejected because it would require passing `hasPlan` and `maskingEnabled` into the builder call, which is already done via `PerceptionBuilderGuardrailOptions`. However, this would mean the builder re-applies masking on `prunedAffordances`, duplicating the logic that `GuardrailEngineImpl.maskAffordances()` already performs. Keeping masking in the service and storing the result in a separate field is cleaner.

## Decision 2: `maskedAffordances` Is Optional (undefined When No Guardrail)
**Context:** When no guardrail engine is configured, there is no masking to apply. Should `maskedAffordances` be `[]` or `undefined`?

**Decision:** `undefined` (omitted from the return object). The `PerceptionBuilderImpl` falls back to `prunedAffordances` via `maskedAffordances ?? prunedAffordances`.

**Rationale:** `undefined` clearly signals "no guardrail was applied, use the raw classifier output." An empty array `[]` would be ambiguous — it could mean "masking produced zero affordances" (wrong — no guardrail was configured) or "classifier returned zero affordances" (also wrong). `undefined` is the correct semantic for "not applicable."

## Decision 3: Plan Builder Requires No Code Change
**Context:** The plan builder already reads `prunedAffordances`. The fix is that `prunedAffordances` now contains the unmasked value.

**Decision:** No source change to `PlanBuilderImpl.build()`. The fix is entirely in `PerceptionServiceImpl.perceive()` (which value it stores) and `PerceptionBuilderImpl.build()` (which field it reads). 

**Rationale:** The plan builder's code is already correct — it destructures `prunedAffordances` from `PerceptionResult` and passes it to `affordancesToToolDefinitions()`. The bug was upstream: the perception service was poisoning `prunedAffordances` with the masked value. Fixing the upstream source is the right fix; the consumer code is already correct.

## Decision 4: Spec 016 Amendment Instead of New Spec Section
**Context:** The fix changes the semantics of `prunedAffordances` in spec 016 (Req 8) and clarifies the masking scope (Req 10).

**Decision:** Amend spec 016 in-place (Reqs 8, 10, ACs 15, 16) rather than adding a new section. The amendments are clearly marked in spec 020.

**Rationale:** Spec 016 is the authoritative source for affordance masking. Creating a separate spec for a bug fix would fragment the documentation. Amending the spec in-place, with clear before/after text, keeps the guardrail specification coherent. Spec 020 serves as the change specification that records what was amended and why.

## Decision 5: Double-Masking Check Retained in Perception Builder
**Context:** The perception builder currently does `const availableAffordances = noPlan && maskingEnabled ? [] : prunedAffordances;`. After the fix, `maskedAffordances` is already `[]` when masking is active. Is the `noPlan && maskingEnabled` check still needed?

**Decision:** Retain the check. The builder reads `maskedAffordances ?? prunedAffordances`, then applies `noPlan && maskingEnabled ? [] : sourceAffordances`.

**Rationale:** Defense-in-depth. If `maskedAffordances` is `undefined` (no guardrail configured) but the builder is called with `maskingEnabled: true` (e.g., from a test or external wiring), the check still hides affordances. The cost is a single boolean check — negligible. Removing it would create a subtle coupling where the builder assumes the service already masked, which is fragile if the builder is ever called directly with a `PerceptionResult` that wasn't produced by the service.
