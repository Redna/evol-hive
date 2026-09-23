# Feature: Context Correctness (1/N) — Executable Offers: `conversation_contribute`, and Naming Un-Offered `talk_to`

## Context

- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md)
- Related specs: [033 — Conversations & Identity Evolution](033-conversations-identity-evolution.md) (defines `contribute`; **amended here**, see Decision D1), [024 — Social Tool Invocation Fix](024-social-tool-invocation-fix.md) (the social directive blocks), [051 — Enum-Bound Talk Targets](051-enum-bound-talk-targets.md) (talk_to omitted when no valid target), [061 — Plan-Context Budget](061-plan-context-budget.md) (block ids/ordering/required flags)
- Issue: [#225](https://github.com/Redna/evol-hive/issues/225) — **this spec is slice 1 of 10 confirmed findings**; the rest are listed under Out of Scope
- Package: `engine` (offer construction), `cognition` (plan context blocks)
- Status: 📝 Drafted

## Problem Summary

The defect class proven by the spec-061 R5 probe and #212: **an agent's context must be (a) true, (b) executable, and (c) consistent with the phase's contract.** This spec fixes the two *verified* non-executable-offer instances from #225. Both are "the context advertises an action that cannot happen" — not prompt-length problems.

### Finding 1 — `conversation_contribute` is offered to participants and always fails (verified)

The handler returns an unconditional failure:

```ts
// packages/engine/src/assembly.ts:644-654
affordanceRegistry.registerHandler('conversation_contribute', async (objectId, agentId) => {
  void agentId;
  const conversation = conversationManager.getConversation(objectId);
  if (conversation === null) return { success: false, failureReason: 'Conversation not found.' };
  return { success: false,
    failureReason: `Use talk_to with an agent in this conversation to contribute to '${conversation.topic}'.` };
});
```

Yet `contribute` is in the offered set: `CONVERSATION_AFFORDANCES = ['join','contribute','leave','observe']` (`packages/engine/src/social/conversation-manager.ts:97`) is mapped into the object's affordances (`:737`). So a participant is offered an affordance that can only ever fail.

**This is a spec/implementation divergence, not a simple bug.** Spec 033 says `contribute` "carries the message text plus an LLM-tagged `sentiment`" and AC-2 states *"participants see `contribute`/`leave`"* — while the implementation deliberately routes message-carrying through `talk_to` ("open-or-contribute", spec 033 R3). Both cannot be true. The spec must pick one and amend 033 accordingly (Decision D1).

### Finding 2 — the context names `talk_to` in cycles where it is not offered (verified)

`buildPlanTools` omits the tool when no target is valid:

```ts
// packages/cognition/src/pper/plan-builder.ts:478
const talkTool = talkValidTargets.length > 0 ? [talkToToolFor(talkValidTargets)] : [];
```

but the two blocks that instruct it are gated on *co-presence*, not on that same predicate:

```ts
// plan-builder.ts:229 — gated on isSocialPrimary only
text: 'Your social drive is your most urgent need. Interact with another agent in this room by calling the talk_to tool directly (or observe_agent / help).'
// plan-builder.ts:246 — gated on hasAgentsPresent only
text: 'IMPORTANT: Other agents are present. If you want to interact with them, call the talk_to, observe_agent, or help tool directly …'
```

So when agents are present but `computeTalkEnum(...).valid` is empty, the model is instructed to call a tool that is **not in its tool list** — the same class as #212 (which the comments at `:241-245` record was itself a botched fix). The two predicates have no shared source, so they can diverge again.

## Requirements

### R1 — The offered set must equal the executable set for conversation affordances

- While `conversation_contribute` cannot execute, it MUST NOT be offered to any agent. Resolve by Decision D1 (implement it, or withdraw it), and update the offer construction so no affordance is offered whose every call path returns `success: false`.
- The remaining conversation affordances (`join`, `leave`, `observe`) must keep their current eligibility behaviour (spec 033 AC-2) and stay executable.

### R2 — No context block may name a tool absent from the turn's tool list

- `social-primary-hint` and `social-directive` MUST NOT instruct a call to `talk_to` in a cycle where `talk_to` is not offered. Either gate them on the same predicate that builds the tool list, or rephrase them to name only tools actually present.
- Their block ids, ordering and `required` flags MUST NOT change (spec 061 R2 owns those).

### R3 — One source of truth for "is talk_to offered this cycle"

- The predicate MUST be computed once per plan cycle and consumed by both the tool list and the context blocks, so the two cannot drift. A single `talkValidTargets` value threaded to both sites satisfies this.

### R4 — A guard against the general class

- A test MUST fail if a plan-context block names a tool that the same cycle does not offer. At minimum it must cover the `talk_to` pair; the assertion must read both from the cycle's outputs rather than from literals.

## Acceptance Criteria

- [ ] **AC-1** (R1) — Under D1, no offered conversation affordance returns an unconditional failure: for each offered id, either an execution path exists or the id is absent from the offered set. Asserted on the offer set for a participant.
- [ ] **AC-2** (R1, D1) — Spec 033 is amended to match the chosen option (its `contribute` semantics line and AC-2), and no statement in 033 contradicts the implementation.
- [ ] **AC-3** (R2) — With agents present and zero valid talk targets, the produced plan context contains **no** `talk_to` instruction; with ≥1 valid target, it does.
- [ ] **AC-4** (R2) — Block ids, order and `required` flags are unchanged in both cases (spec 061 regression).
- [ ] **AC-5** (R3) — The tool list and the context blocks derive from one computed value; changing that value flips both together in a single test.
- [ ] **AC-6** (R4) — The guard test exists and **fails** when a block names an absent tool (verified red before green).
- [ ] **AC-7** — Existing suites stay green, explicitly including `spec-024-social-tool-invocation-fix`, `spec-051-enum-bound-talk-targets`, `spec-058-legacy-path-byte-identity`, `spec-061-plan-context-budget`, and the ten test files that reference `conversation_contribute`.

## Decision

**D1 — `conversation_contribute`: withdraw it. Decided** (operator-confirmed 2026-09-23). The alternative is recorded for the trail:

- **Withdraw (recommended).** `talk_to` already owns open-or-contribute and message-carrying (spec 033 R3); `contribute` is args-free by construction, so implementing it means inventing a second message write path that spec 033 explicitly consolidated. Withdrawing removes an offer the phase can never honour and needs no new surface.
- **Implement (rejected for now).** Closer to 033's literal text, but re-opens the args question (message text + sentiment must come from somewhere) and re-creates the two-path problem R3 resolved.

Either way this is an **amendment to spec 033**, which is why the decision belongs in a spec rather than a commit.

## Constraints

- Package boundaries: `engine` (offer construction) and `cognition` (context blocks) only. No new dependencies.
- Spec 024's directive intent (route social action to the tools it is, not to a rejected plan step) MUST be preserved — this spec narrows *when* it is said, never reverses it.
- Spec 061's block contract (ids, order, `required`) and spec 021's KV-cache stable/dynamic split MUST NOT change.
- Do not silently drop `talk_to` from the tool list in cycles where a target *is* valid (spec 051 R1/R2 behaviour is correct already).
- Byte-identity tests must keep passing: no change to prompt text in cycles that name only offered tools.

## Test Seams

1. **Offer set** — `packages/engine` conversation affordances as constructed in `conversation-manager.ts` (per-participant), asserted as data. Primary seam for R1/AC-1.
2. **Plan context blocks** — via `PlanBuilderImpl` (the seam `spec-024-social-tool-invocation-fix.test.ts` already uses), asserting presence/absence of the `talk_to` instruction alongside the tool list from the same cycle. Primary seam for R2–R4.
3. **Guard** — a new test asserting *no* block names a tool absent from that cycle's tool list; red-first verified by temporarily re-gating a block on co-presence.

## Out of Scope

The remaining eight confirmed findings in #225, each its own slice: stale object anchors in `knownAreas` (no pruning path), unpruned `knownDoors`, `formatPlanDriveHint`/`formatPlanChainHint` contradicting the plan contract (same class as #212, spec 034), a cognitive tool executing mid-loop while `completePlan` still fails the plan, `LLMError` bypassing `failFormation`, `budgetPlanContext` truncating an instruction mid-sentence, `listConversationsInRoom` contradicting its docstring, and closed conversations remaining perceived. Also out of scope: the refuted reflect-contract item (recorded in #225 so nobody re-chases it) and the `checkPlanBinding` legality question.
